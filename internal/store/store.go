package store

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/davecgh/go-spew/spew"
	"gopkg.in/d4l3k/messagediff.v1"

	"github.com/tilt-dev/tilt/pkg/logger"
	"github.com/tilt-dev/tilt/pkg/model"
)

// Allow actions to batch together a bit.
const actionBatchWindow = time.Millisecond

// maxQueuedLogBytes bounds log payloads that have entered the Store but have
// not reached the reducer. A firehose from `tilt up --stream=true` previously
// accumulated this queue until Tilt was OOM-killed. LogStore's 2 MiB limit is
// applied only after reduction, so it cannot protect this ingress queue.
const maxQueuedLogBytes int64 = 32 * 1024 * 1024

// Read-only store
type RStore interface {
	Dispatch(action Action)
	RLockState() EngineState
	RUnlockState()
	StateMutex() *sync.RWMutex
}

// A central state store, modeled after the Reactive programming UX pattern.
// Terminology is borrowed liberally from Redux. These docs in particular are helpful:
// https://redux.js.org/introduction/threeprinciples
// https://redux.js.org/basics
type Store struct {
	sleeper     Sleeper
	state       *EngineState
	subscribers *subscriberList
	actionQueue []Action
	actionCh    chan []Action
	actionReady chan struct{}
	// ingressMu exclusively protects ingress state. Dispatch deliberately does
	// not take mu: Store tests and callers use mu to coordinate broadcasting,
	// and making enqueue contend on it can deadlock a dispatcher.
	ingressMu       sync.Mutex
	logBudget       *sync.Cond
	closedStore     bool
	workerStopped   bool
	mu              sync.Mutex
	closeOnce       sync.Once
	workerCtx       context.Context
	cancelWorker    context.CancelFunc
	workerStartOnce sync.Once
	workerStopOnce  sync.Once
	stateMu         sync.RWMutex
	reduce          Reducer
	logActions      bool

	// queuedLogBytes is observability for log payloads accepted by Dispatch
	// but not yet reduced.
	queuedLogBytes atomic.Int64

	// drainStarts is observability for drain goroutines started by Dispatch.
	drainStarts atomic.Int64

	// TODO(nick): Define Subscribers and Reducers.
	// The actionChan is an intermediate representation to make the transition easier.
}

func NewStore(reducer Reducer, logActions LogActionsFlag) *Store {
	workerCtx, cancelWorker := context.WithCancel(context.Background())
	s := &Store{
		sleeper:      DefaultSleeper(),
		state:        NewState(),
		reduce:       reducer,
		actionCh:     make(chan []Action),
		actionReady:  make(chan struct{}, 1),
		subscribers:  &subscriberList{},
		logActions:   bool(logActions),
		workerCtx:    workerCtx,
		cancelWorker: cancelWorker,
	}
	s.logBudget = sync.NewCond(&s.ingressMu)
	return s
}

// Returns a Store with a fake reducer that saves observed actions and makes
// them available via the return value `getActions`.
//
// Tests should only use this if they:
// 1) want to test the Store itself, or
// 2) want to test subscribers with the particular async behavior of a real Store
// Otherwise, use NewTestingStore().
func NewStoreWithFakeReducer() (st *Store, getActions func() []Action) {
	var mu sync.Mutex
	actions := []Action{}
	reducer := Reducer(func(ctx context.Context, s *EngineState, action Action) {
		mu.Lock()
		defer mu.Unlock()
		actions = append(actions, action)

		errorAction, isErrorAction := action.(ErrorAction)
		if isErrorAction {
			s.FatalError = errorAction.Error
		}
	})

	getActions = func() []Action {
		mu.Lock()
		defer mu.Unlock()
		return append([]Action{}, actions...)
	}
	return NewStore(reducer, false), getActions
}

func (s *Store) StateMutex() *sync.RWMutex {
	return &s.stateMu
}

func (s *Store) AddSubscriber(ctx context.Context, sub Subscriber) error {
	return s.subscribers.Add(ctx, s, sub)
}

func (s *Store) RemoveSubscriber(ctx context.Context, sub Subscriber) error {
	return s.subscribers.Remove(ctx, sub)
}

// Sends messages to all the subscribers asynchronously.
func (s *Store) NotifySubscribers(ctx context.Context, summary ChangeSummary) {
	s.subscribers.NotifyAll(ctx, s, summary)
}

// TODO(nick): Clone the state to ensure it's not mutated.
// For now, we use RW locks to simulate the same behavior, but the
// onus is on the caller to RUnlockState.
func (s *Store) RLockState() EngineState {
	s.stateMu.RLock()
	return *(s.state)
}

func (s *Store) RUnlockState() {
	s.stateMu.RUnlock()
}

func (s *Store) LockMutableStateForTesting() *EngineState {
	s.stateMu.Lock()
	return s.state
}

func (s *Store) UnlockMutableState() {
	s.stateMu.Unlock()
}

func (s *Store) Dispatch(action Action) {
	logBytes := logActionPayloadBytes(action)

	s.ingressMu.Lock()
	// Logger actions are dispatched from the reducer's context. They must never
	// wait for bytes that only that reducer can release, or a full ingress queue
	// would deadlock the control loop. They still count toward the budget, which
	// makes external log producers apply backpressure until the reducer catches up.
	//
	// External producers use a soft limit: the payload that crosses the cap is
	// admitted, then later producers wait. This bounds overshoot to one external
	// payload without dropping any logs.
	for logBytes > 0 && !logActionBypassesBudget(action) && s.queuedLogBytes.Load() > maxQueuedLogBytes && !s.closedStore && !s.workerStopped {
		s.logBudget.Wait()
	}
	if s.closedStore || s.workerStopped {
		s.ingressMu.Unlock()
		return
	}
	s.queuedLogBytes.Add(logBytes)
	s.actionQueue = append(s.actionQueue, action)
	s.workerStartOnce.Do(func() {
		go s.drainActions()
	})
	s.ingressMu.Unlock()

	select {
	case s.actionReady <- struct{}{}:
	default:
	}
}

func (s *Store) stopDrainWorker() {
	s.workerStopOnce.Do(func() {
		s.ingressMu.Lock()
		s.workerStopped = true
		s.logBudget.Broadcast()
		s.ingressMu.Unlock()
		s.cancelWorker()
	})
}

// QueuedLogBytesForTesting reports the payload bytes that have been accepted
// by Dispatch but not yet reduced.
func (s *Store) QueuedLogBytesForTesting() int64 {
	return s.queuedLogBytes.Load()
}

// DrainStartsForTesting reports the long-lived drain workers that have started.
func (s *Store) DrainStartsForTesting() int64 {
	return s.drainStarts.Load()
}

func (s *Store) Close() {
	s.closeOnce.Do(func() {
		s.ingressMu.Lock()
		s.closedStore = true
		s.logBudget.Broadcast()
		if !s.workerStopped {
			s.workerStartOnce.Do(func() {
				go s.drainActions()
			})
		}
		s.ingressMu.Unlock()
		select {
		case s.actionReady <- struct{}{}:
		default:
		}
	})
}

func (s *Store) SetUpSubscribersForTesting(ctx context.Context) error {
	return s.subscribers.SetUp(ctx, s)
}

func (s *Store) Loop(ctx context.Context) error {
	err := s.subscribers.SetUp(ctx, s)
	if err != nil {
		return err
	}
	defer s.subscribers.TeardownAll(context.Background())
	defer s.stopDrainWorker()

	// Set up a defer handler, and make sure to unlock the state
	// if the control loop is interrupted by a panic.
	hasStateLock := false
	defer func() {
		if hasStateLock {
			s.stateMu.Unlock()
		}
	}()

	for {
		summary := ChangeSummary{}

		select {
		case <-ctx.Done():
			return ctx.Err()

		case actions, ok := <-s.actionCh:
			if !ok {
				return nil
			}
			s.stateMu.Lock()
			hasStateLock = true

			logCheckpoint := s.state.LogStore.Checkpoint()

			for _, action := range actions {
				var oldState EngineState
				if s.logActions {
					oldState = s.cheapCopyState()
				}

				s.reduce(ctx, s.state, action)
				logBytes := logActionPayloadBytes(action)
				if logBytes > 0 {
					s.ingressMu.Lock()
					s.queuedLogBytes.Add(-logBytes)
					s.logBudget.Broadcast()
					s.ingressMu.Unlock()
				}

				if summarizer, ok := action.(Summarizer); ok {
					summarizer.Summarize(&summary)
				} else {
					summary.Legacy = true
				}

				if s.logActions {
					newState := s.cheapCopyState()
					action := action
					go func() {
						diff, equal := messagediff.PrettyDiff(oldState, newState)
						if !equal {
							logger.Get(ctx).Infof("action %T:\n%s\ncaused state change:\n%s\n", action, spew.Sdump(action), diff)
						}
					}()
				}
			}

			// if one of the actions logged, but didn't report it via Summarizer,
			// include it in the summary anyway
			if logCheckpoint != s.state.LogStore.Checkpoint() {
				summary.Log = true
			}

			s.stateMu.Unlock()
			hasStateLock = false
		}

		// Subscribers
		done, err := s.maybeFinished()
		if done {
			return err
		}
		s.NotifySubscribers(ctx, summary)
	}
}

func logActionPayloadBytes(action Action) int64 {
	switch action := action.(type) {
	case LogAction:
		return int64(len(action.msg))
	case *LogAction:
		return int64(len(action.msg))
	default:
		return 0
	}
}

func logActionBypassesBudget(action Action) bool {
	switch action := action.(type) {
	case LogAction:
		return action.nonBlockingIngress
	case *LogAction:
		return action.nonBlockingIngress
	default:
		return false
	}
}

func (s *Store) maybeFinished() (bool, error) {
	state := s.RLockState()
	defer s.RUnlockState()

	if state.FatalError == context.Canceled {
		return true, state.FatalError
	}

	if state.UserExited {
		return true, nil
	}

	if state.PanicExited != nil {
		return true, state.PanicExited
	}

	if state.FatalError != nil && state.TerminalMode != TerminalModeHUD {
		return true, state.FatalError
	}

	if state.ExitSignal {
		return true, state.ExitError
	}

	return false, nil
}

func (s *Store) drainActions() {
	s.drainStarts.Add(1)
	for {
		// Coalesce a burst so the established batching window is retained while
		// a single worker preserves action order without a goroutine per dispatch.
		select {
		case <-s.actionReady:
		case <-s.workerCtx.Done():
			return
		}
		s.sleeper.Sleep(s.workerCtx, actionBatchWindow)
		if s.workerCtx.Err() != nil {
			return
		}

		s.ingressMu.Lock()
		actions := s.actionQueue
		s.actionQueue = nil
		closed := s.closedStore
		s.ingressMu.Unlock()

		if len(actions) > 0 {
			select {
			case s.actionCh <- actions:
			case <-s.workerCtx.Done():
				return
			}
		}

		s.ingressMu.Lock()
		closed = closed || s.closedStore
		empty := len(s.actionQueue) == 0
		s.ingressMu.Unlock()
		if closed && empty {
			close(s.actionCh)
			return
		}
	}
}

type Action interface {
	Action()
}

type LogActionsFlag bool

// This does a partial deep copy for the purposes of comparison
// i.e., it ensures fields that will be useful in action logging get copied
// some fields might not be copied and might still point to the same instance as s.state
// and thus might reflect changes that happened as part of the current action or any future action
func (s *Store) cheapCopyState() EngineState {
	ret := *s.state
	targets := ret.ManifestTargets
	ret.ManifestTargets = make(map[model.ManifestName]*ManifestTarget)
	for k, v := range targets {
		ms := *(v.State)
		target := &ManifestTarget{
			Manifest: v.Manifest,
			State:    &ms,
		}

		ret.ManifestTargets[k] = target
	}
	return ret
}
