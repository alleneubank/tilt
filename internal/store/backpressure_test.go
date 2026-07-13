package store

import (
	"context"
	"io"
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tilt-dev/tilt/pkg/logger"
	"github.com/tilt-dev/tilt/pkg/model"
	"github.com/tilt-dev/tilt/pkg/model/logstore"
)

const (
	maxAdditionalDrainGoroutines      = 8
	retentionLogActionCount           = 9_000
	logActionPayloadSize              = 8 * 1024
	goroutineAmplificationActionCount = 500
	goroutineTestQueuedBytes          = 2 * 1024 * 1024
)

type stalledReducerAction struct{}

func (stalledReducerAction) Action() {}

type stalledStore struct {
	store      *Store
	release    chan struct{}
	allReduced chan struct{}
	loopDone   chan error
	cancel     context.CancelFunc
}

func newStalledStore(t *testing.T, logActionCount int) *stalledStore {
	t.Helper()

	started := make(chan struct{})
	stalled := &stalledStore{
		release:    make(chan struct{}),
		allReduced: make(chan struct{}),
		loopDone:   make(chan error, 1),
	}
	var reduced int
	stalled.store = NewStore(Reducer(func(ctx context.Context, state *EngineState, action Action) {
		switch action.(type) {
		case stalledReducerAction:
			close(started)
			<-stalled.release
		case LogAction:
			reduced++
			if reduced == logActionCount {
				close(stalled.allReduced)
			}
		}
	}), false)

	ctx, cancel := context.WithCancel(context.Background())
	stalled.cancel = cancel
	go func() {
		stalled.loopDone <- stalled.store.Loop(ctx)
	}()
	stalled.store.Dispatch(stalledReducerAction{})
	<-started

	t.Cleanup(func() {
		stalled.releaseReducer()
		receive(t, stalled.allReduced, "all queued actions to be reduced")
		stalled.cancel()
		require.ErrorIs(t, receive(t, stalled.loopDone, "the store loop to stop"), context.Canceled)
	})

	return stalled
}

func (s *stalledStore) releaseReducer() {
	select {
	case <-s.release:
	default:
		close(s.release)
	}
}

func receive[T any](t *testing.T, ch <-chan T, description string) T {
	t.Helper()

	select {
	case value := <-ch:
		return value
	case <-time.After(10 * time.Second):
		t.Fatalf("timed out waiting for %s", description)
		var zero T
		return zero
	}
}

func waitForQueuedLogBytes(t *testing.T, store *Store, minimum int64, progress <-chan struct{}) {
	t.Helper()

	timeout := time.NewTimer(10 * time.Second)
	defer timeout.Stop()
	for store.QueuedLogBytesForTesting() < minimum {
		select {
		case <-progress:
		case <-timeout.C:
			t.Fatalf("timed out waiting for at least %d queued log bytes; observed %d", minimum, store.QueuedLogBytesForTesting())
		}
	}
}

func testBoundedLogRetention(t *testing.T) {
	stalled := newStalledStore(t, retentionLogActionCount)
	payload := make([]byte, logActionPayloadSize)
	progress := make(chan int)
	continueDispatch := make(chan struct{})
	dispatched := make(chan struct{})

	go func() {
		defer close(dispatched)
		for i := 1; i <= retentionLogActionCount; i++ {
			stalled.store.Dispatch(NewLogAction(
				model.ManifestName("firehose"),
				logstore.SpanID("backpressure"),
				logger.InfoLvl,
				nil,
				payload,
			))
			progress <- i
			<-continueDispatch
		}
	}()

	// Dispatch admits the action that crosses the limit so a reducer-originated
	// log dispatch cannot deadlock. The following producer is backpressured.
	actionsBeforeBackpressure := int(maxQueuedLogBytes/int64(logActionPayloadSize)) + 1
	for expected := 1; expected <= actionsBeforeBackpressure; expected++ {
		require.Equal(t, expected, receive(t, progress, "the next log action to be accepted"))
		continueDispatch <- struct{}{}
	}

	// Green after phase 2: accepting the next action blocks the producer at the
	// soft byte budget while this reducer is stalled. The unbounded implementation
	// instead reports that action and can be driven through the entire firehose.
	extraActionAccepted := false
	for range 1_000 {
		select {
		case accepted := <-progress:
			require.Equal(t, actionsBeforeBackpressure+1, accepted)
			extraActionAccepted = true
		default:
			runtime.Gosched()
		}
		if extraActionAccepted {
			break
		}
	}
	if extraActionAccepted {
		continueDispatch <- struct{}{}
		for expected := actionsBeforeBackpressure + 2; expected <= retentionLogActionCount; expected++ {
			require.Equal(t, expected, receive(t, progress, "the next unbounded log action to be accepted"))
			continueDispatch <- struct{}{}
		}
		receive(t, dispatched, "the unbounded log producer to finish")
	}

	retained := stalled.store.QueuedLogBytesForTesting()
	assert.LessOrEqualf(t, retained, maxQueuedLogBytes+logActionPayloadSize,
		"retained %d queued bytes after attempting %d log actions; soft limit is %d bytes",
		retained, retentionLogActionCount, maxQueuedLogBytes+logActionPayloadSize)

	stalled.releaseReducer()
	for {
		select {
		case <-dispatched:
			goto producerFinished
		case <-progress:
			continueDispatch <- struct{}{}
		}
	}

producerFinished:
	receive(t, stalled.allReduced, "every dispatched log action to be reduced")
}

func TestDispatchDoesNotAmplifyDrainGoroutines(t *testing.T) {
	stalled := newStalledStore(t, goroutineAmplificationActionCount)
	payload := make([]byte, logActionPayloadSize)
	progress := make(chan struct{}, 1)
	dispatched := make(chan struct{})
	before := stalled.store.DrainStartsForTesting()

	go func() {
		defer close(dispatched)
		for range goroutineAmplificationActionCount {
			stalled.store.Dispatch(NewLogAction(
				model.ManifestName("firehose"),
				logstore.SpanID("backpressure"),
				logger.InfoLvl,
				nil,
				payload,
			))
			select {
			case progress <- struct{}{}:
			default:
			}
		}
	}()

	// Green after phase 2: the stalled reducer leaves queued bytes observable,
	// while one bounded drain worker keeps the goroutine delta below this limit.
	waitForQueuedLogBytes(t, stalled.store, goroutineTestQueuedBytes, progress)
	receive(t, dispatched, "the control-size log producer to finish")
	after := stalled.store.DrainStartsForTesting()
	delta := after - before
	require.LessOrEqualf(t, delta, int64(maxAdditionalDrainGoroutines),
		"dispatching %d actions started %d drains while the reducer was stalled; limit is %d",
		goroutineAmplificationActionCount, delta, maxAdditionalDrainGoroutines)
}

func TestBoundedLogRetention(t *testing.T) {
	testBoundedLogRetention(t)
}

type reducerDispatchAction struct{}

func (reducerDispatchAction) Action() {}

type reducerLogRoutingAction struct{}

func (reducerLogRoutingAction) Action() {}

type capturedLogWrite struct {
	level   logger.Level
	fields  logger.Fields
	message []byte
}

type logWriteCapture struct {
	writes chan capturedLogWrite
}

func (c logWriteCapture) Write(level logger.Level, fields logger.Fields, message []byte) error {
	c.writes <- capturedLogWrite{level: level, fields: fields, message: append([]byte{}, message...)}
	return nil
}

func logActionWithPayload(payload []byte) LogAction {
	return NewLogAction(
		model.ManifestName("firehose"),
		logstore.SpanID("backpressure"),
		logger.InfoLvl,
		nil,
		payload,
	)
}

func TestLoopLoggerPreservesContextLogHandler(t *testing.T) {
	writes := make(chan capturedLogWrite, 1)
	ctx := logger.WithLogger(context.Background(), logger.NewTestLogger(io.Discard))
	ctx = logger.CtxWithLogHandler(ctx, logWriteCapture{writes: writes})
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	loopDone := make(chan error, 1)
	store := NewStore(Reducer(func(ctx context.Context, state *EngineState, action Action) {
		if _, ok := action.(reducerLogRoutingAction); ok {
			logger.Get(ctx).WithFields(logger.Fields{"source": "reducer"}).Write(logger.ErrorLvl, []byte("preserve this route"))
		}
	}), false)
	go func() { loopDone <- store.Loop(ctx) }()

	store.Dispatch(reducerLogRoutingAction{})
	write := receive(t, writes, "the context log handler to receive reducer output")
	assert.Equal(t, logger.ErrorLvl, write.level)
	assert.Equal(t, logger.Fields{"source": "reducer"}, write.fields)
	assert.Equal(t, []byte("preserve this route"), write.message)

	cancel()
	require.ErrorIs(t, receive(t, loopDone, "the canceled store loop to stop"), context.Canceled)
}

func fillLogBudget(t *testing.T, store *Store, payload []byte) {
	t.Helper()
	for range maxQueuedLogBytes / int64(len(payload)) {
		store.Dispatch(logActionWithPayload(payload))
	}
	require.Equal(t, maxQueuedLogBytes, store.QueuedLogBytesForTesting())
}

func TestLogBudgetDoesNotBlockControlOrReducerDispatch(t *testing.T) {
	payload := make([]byte, logActionPayloadSize)
	started := make(chan struct{})
	releaseReducer := make(chan struct{})
	reducerLogReturned := make(chan struct{})
	loopDone := make(chan error, 1)
	var store *Store
	store = NewStore(Reducer(func(ctx context.Context, state *EngineState, action Action) {
		if _, ok := action.(reducerDispatchAction); !ok {
			return
		}
		close(started)
		<-releaseReducer
		// Loop wraps reducer contexts with the only non-blocking log handler.
		// The root NewLogActionLogger remains blocking so external producers
		// cannot bypass the budget.
		logger.Get(ctx).Write(logger.InfoLvl, payload)
		close(reducerLogReturned)
	}), false)

	baseCtx := logger.WithLogger(context.Background(), logger.NewTestLogger(io.Discard))
	ctx, cancel := context.WithCancel(baseCtx)
	ctx = logger.WithLogger(ctx, NewLogActionLogger(ctx, store.Dispatch))
	defer cancel()
	go func() { loopDone <- store.Loop(ctx) }()

	store.Dispatch(reducerDispatchAction{})
	receive(t, started, "the reducer to stall")
	fillLogBudget(t, store, payload)
	store.Dispatch(logActionWithPayload(payload)) // admit the soft-cap overage
	require.Equal(t, maxQueuedLogBytes+int64(len(payload)), store.QueuedLogBytesForTesting())

	// The CLI uses this logger as its process-wide root logger. It is an
	// external producer, so it must wait for the same capacity as direct
	// Dispatch callers rather than inheriting the reducer-only bypass.
	externalLogReturned := make(chan struct{})
	externalLogger := NewLogActionLogger(ctx, store.Dispatch)
	go func() {
		externalLogger.Write(logger.InfoLvl, payload)
		close(externalLogReturned)
	}()
	select {
	case <-externalLogReturned:
		t.Fatal("the root logger bypassed the exhausted ingress budget")
	case <-time.After(50 * time.Millisecond):
	}

	controlReturned := make(chan struct{})
	go func() {
		store.Dispatch(CompletedBuildAction{})
		close(controlReturned)
	}()
	receive(t, controlReturned, "a control action to bypass the log budget")

	close(releaseReducer)
	receive(t, reducerLogReturned, "a reducer-originated log dispatch to return")
	receive(t, externalLogReturned, "the root logger to unblock after reduction")
	store.Close()
	require.NoError(t, receive(t, loopDone, "the closed store loop to stop"))
}

func TestLogBudgetReleaseBeforeStateLockUnblocksReadLockedDispatcher(t *testing.T) {
	payload := make([]byte, logActionPayloadSize)
	loopDone := make(chan error, 1)
	store := NewStore(Reducer(func(ctx context.Context, state *EngineState, action Action) {}), false)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { loopDone <- store.Loop(ctx) }()

	// Gate the worker's actionCh send so the queue reaches the byte budget
	// before Loop can receive and release it.
	store.mu.Lock()
	readerLocked := make(chan struct{})
	dispatchStarted := make(chan struct{})
	dispatchReturned := make(chan struct{})
	releaseReader := make(chan struct{})
	readerDone := make(chan struct{})
	go func() {
		store.RLockState()
		close(readerLocked)
		<-dispatchStarted
		store.Dispatch(logActionWithPayload(payload))
		close(dispatchReturned)
		<-releaseReader
		store.RUnlockState()
		close(readerDone)
	}()
	receive(t, readerLocked, "the reader to hold the state lock")

	fillLogBudget(t, store, payload)
	store.Dispatch(logActionWithPayload(payload)) // admit the soft-cap overage
	close(dispatchStarted)

	select {
	case <-dispatchReturned:
		t.Fatal("log dispatch returned while the ingress budget was exhausted")
	case <-time.After(50 * time.Millisecond):
	}

	// The receive releases the budget before Loop waits for the state write
	// lock. The reader therefore completes its dispatch while still holding the
	// lock that would otherwise form the deadlock triangle.
	store.mu.Unlock()
	receive(t, dispatchReturned, "the read-locked log dispatch to unblock")
	close(releaseReader)
	receive(t, readerDone, "the reader to release the state lock")

	store.Close()
	require.NoError(t, receive(t, loopDone, "the closed store loop to stop"))
}

func TestCloseUnblocksBackpressuredLogDispatch(t *testing.T) {
	payload := make([]byte, logActionPayloadSize)
	started := make(chan struct{})
	releaseReducer := make(chan struct{})
	loopDone := make(chan error, 1)
	store := NewStore(Reducer(func(ctx context.Context, state *EngineState, action Action) {
		if _, ok := action.(stalledReducerAction); ok {
			close(started)
			<-releaseReducer
		}
	}), false)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { loopDone <- store.Loop(ctx) }()
	store.Dispatch(stalledReducerAction{})
	receive(t, started, "the reducer to stall")
	fillLogBudget(t, store, payload)
	store.Dispatch(logActionWithPayload(payload)) // the one-payload soft-cap overage

	returned := make(chan struct{})
	go func() {
		store.Dispatch(logActionWithPayload(payload))
		close(returned)
	}()

	select {
	case <-returned:
		t.Fatal("log dispatch returned despite the exhausted byte budget")
	case <-time.After(50 * time.Millisecond):
	}

	store.Close()
	receive(t, returned, "the blocked log dispatch to unblock during Close")
	close(releaseReducer)
	require.NoError(t, receive(t, loopDone, "the closed store loop to stop"))
}

func TestLoopCancellationUnblocksBackpressuredLogDispatch(t *testing.T) {
	payload := make([]byte, logActionPayloadSize)
	started := make(chan struct{})
	loopDone := make(chan error, 1)
	store := NewStore(Reducer(func(ctx context.Context, state *EngineState, action Action) {
		if _, ok := action.(stalledReducerAction); ok {
			close(started)
			<-ctx.Done()
		}
	}), false)

	ctx, cancel := context.WithCancel(context.Background())
	go func() { loopDone <- store.Loop(ctx) }()
	store.Dispatch(stalledReducerAction{})
	receive(t, started, "the reducer to stall")
	fillLogBudget(t, store, payload)
	store.Dispatch(logActionWithPayload(payload)) // the one-payload soft-cap overage

	returned := make(chan struct{})
	go func() {
		store.Dispatch(logActionWithPayload(payload))
		close(returned)
	}()

	select {
	case <-returned:
		t.Fatal("log dispatch returned despite the exhausted byte budget")
	case <-time.After(50 * time.Millisecond):
	}

	cancel()
	receive(t, returned, "the blocked log dispatch to unblock during cancellation")
	require.ErrorIs(t, receive(t, loopDone, "the canceled store loop to stop"), context.Canceled)
}
