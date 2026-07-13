package store

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tilt-dev/tilt/pkg/logger"
	"github.com/tilt-dev/tilt/pkg/model"
	"github.com/tilt-dev/tilt/pkg/model/logstore"
)

// These are the ingress limits the bounded implementation will enforce in
// phase 2. Keeping them here makes this phase a regression harness only.
const (
	maxQueuedLogBytes                 = 32 * 1024 * 1024
	maxAdditionalDrainGoroutines      = 8
	retentionLogActionCount           = 9_000
	logActionPayloadSize              = 8 * 1024
	goroutineAmplificationActionCount = 500
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
		close(stalled.release)
		<-stalled.allReduced
		stalled.cancel()
		require.ErrorIs(t, <-stalled.loopDone, context.Canceled)
	})

	return stalled
}

func TestBoundedLogRetention(t *testing.T) {
	t.Skip("red until bounded ingress lands — see backpressure design in this file")

	stalled := newStalledStore(t, retentionLogActionCount)
	payload := make([]byte, logActionPayloadSize)
	dispatched := make(chan struct{})

	go func() {
		defer close(dispatched)
		for range retentionLogActionCount {
			stalled.store.Dispatch(NewLogAction(
				model.ManifestName("firehose"),
				logstore.SpanID("backpressure"),
				logger.InfoLvl,
				nil,
				payload,
			))
		}
	}()

	<-dispatched
	retained := stalled.store.QueuedLogBytesForTesting()
	require.LessOrEqualf(t, retained, int64(maxQueuedLogBytes),
		"retained %d bytes after dispatching %d log actions; limit is %d bytes",
		retained, retentionLogActionCount, maxQueuedLogBytes)
}

type blockedDrainSleeper struct {
	entered chan<- struct{}
	release <-chan struct{}
}

func (s blockedDrainSleeper) Sleep(ctx context.Context, d time.Duration) {
	s.entered <- struct{}{}
	<-s.release
}

func TestDispatchDoesNotAmplifyDrainGoroutines(t *testing.T) {
	t.Skip("red until bounded ingress lands — see backpressure design in this file")

	stalled := newStalledStore(t, goroutineAmplificationActionCount)
	entered := make(chan struct{}, goroutineAmplificationActionCount)
	releaseDrains := make(chan struct{})
	stalled.store.sleeper = blockedDrainSleeper{entered: entered, release: releaseDrains}
	t.Cleanup(func() { close(releaseDrains) })

	for range goroutineAmplificationActionCount {
		stalled.store.Dispatch(NewLogAction(
			model.ManifestName("firehose"),
			logstore.SpanID("backpressure"),
			logger.InfoLvl,
			nil,
			[]byte("log"),
		))
	}
	for range goroutineAmplificationActionCount {
		<-entered
	}
	activeDrains := stalled.store.ActiveDrainsForTesting()

	require.LessOrEqualf(t, activeDrains, int64(maxAdditionalDrainGoroutines),
		"dispatching %d actions created %d active drain goroutines while the reducer was stalled; limit is %d",
		goroutineAmplificationActionCount, activeDrains, maxAdditionalDrainGoroutines)
}
