import { render, RenderOptions, screen } from "@testing-library/react"
import { Component } from "react"
import { findRenderedComponentWithType } from "react-dom/test-utils"
import { MemoryRouter } from "react-router"
import {
  createFilterTermState,
  EMPTY_FILTER_TERM,
  FilterLevel,
  FilterSource,
} from "./logfilters"
import LogStore, { LogUpdateAction, LogStoreProvider } from "./LogStore"
import OverviewLogPane, {
  isNearScrollBottom,
  leaveFollowHysteresisPx,
  liveLogReadIntervalMs,
  OverviewLogComponent,
  PROLOGUE_LENGTH,
  renderedLineLimit,
  renderWindow,
  returnToTailProximityPx,
  shouldLeaveFollowOnScrollUp,
  tailLineLimit,
} from "./OverviewLogPane"
import { LogDisplay } from "./logs"
import {
  BuildLogAndRunLog,
  ManyLines,
  StyledLines,
  ThreeLines,
  ThreeLinesAllLog,
  StarredResourcesLog,
} from "./OverviewLogPane.stories"
import { newFakeRaf, RafProvider, SyncRafProvider, TestRafContext } from "./raf"
import { renderTestComponent } from "./test-helpers"
import { appendLines } from "./testlogs"
import { LogLine } from "./types"

function customRender(component: JSX.Element, options?: RenderOptions) {
  return render(component, {
    wrapper: ({ children }) => (
      <MemoryRouter
        initialEntries={["/"]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <SyncRafProvider>{children}</SyncRafProvider>
      </MemoryRouter>
    ),
    ...options,
  })
}

describe("return-to-tail geometry helpers", () => {
  it("isNearScrollBottom is true within proximity of max scroll", () => {
    expect(isNearScrollBottom(952, 1000, 40, returnToTailProximityPx)).toBe(
      true
    )
    expect(isNearScrollBottom(900, 1000, 40, returnToTailProximityPx)).toBe(
      false
    )
    // Non-overflow (underfill) is never "near bottom" for return-to-tail.
    expect(isNearScrollBottom(0, 40, 40, returnToTailProximityPx)).toBe(false)
    expect(isNearScrollBottom(0, 0, 0, returnToTailProximityPx)).toBe(false)
  })

  it("shouldLeaveFollowOnScrollUp ignores sub-hysteresis upward deltas", () => {
    expect(
      shouldLeaveFollowOnScrollUp(100, 100 - (leaveFollowHysteresisPx - 1))
    ).toBe(false)
    expect(
      shouldLeaveFollowOnScrollUp(100, 100 - leaveFollowHysteresisPx)
    ).toBe(true)
    expect(shouldLeaveFollowOnScrollUp(50, 0)).toBe(true)
  })
})

describe("OverviewLogPane", () => {
  it("renders all log lines associated with a specific resource", () => {
    const { container } = customRender(<ThreeLines />)
    expect(container.querySelectorAll(".LogLine")).toHaveLength(3)
  })

  it("renders all log lines in the all log view", () => {
    const { container } = customRender(<ThreeLinesAllLog />)
    expect(container.querySelectorAll(".LogLine")).toHaveLength(3)
  })

  it("renders log lines of starred resources", () => {
    const { container } = customRender(<StarredResourcesLog />)
    expect(container.querySelectorAll(".LogLine")).toHaveLength(9)
  })

  it("escapes html and linkifies", () => {
    customRender(<StyledLines />)
    expect(screen.getAllByRole("link")).toHaveLength(3)
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("properly escapes ansi chars", () => {
    let defaultFilter = {
      source: FilterSource.all,
      level: FilterLevel.all,
      term: EMPTY_FILTER_TERM,
    }
    let logStore = new LogStore()
    appendLines(logStore, "fe", "[32m➜[39m  [1mLocal[22m:   [36mhttp://localhost:[1m5173[22m/[39m\n")
    const { container } = customRender(
      <LogStoreProvider value={logStore}>
        <OverviewLogPane manifestName="fe" filterSet={defaultFilter} />
      </LogStoreProvider>
    )
    expect(container.querySelectorAll(".LogLine")).toHaveLength(1)
    expect(container.querySelector(".LogLine")).toHaveTextContent(
      "➜ Local: http://localhost:5173/"
    )
  })

  it("displays all logs when there are no filters", () => {
    const { container } = customRender(<BuildLogAndRunLog />)
    expect(container.querySelectorAll(".LogLine")).toHaveLength(40)
  })

  describe("filters by source", () => {
    it("displays only runtime logs when runtime source is specified", () => {
      const { container } = customRender(
        <BuildLogAndRunLog
          level=""
          source={FilterSource.runtime}
          term={EMPTY_FILTER_TERM}
        />
      )
      expect(container.querySelectorAll(".LogLine")).toHaveLength(20)
      expect(screen.getAllByText(/Vigoda pod line/)).toHaveLength(18)
      expect(screen.queryByText(/Vigoda build line/)).toBeNull()
    })

    it("displays only build logs when build source is specified", () => {
      const { container } = customRender(
        <BuildLogAndRunLog
          level=""
          source={FilterSource.build}
          term={EMPTY_FILTER_TERM}
        />
      )
      expect(container.querySelectorAll(".LogLine")).toHaveLength(20)
      expect(screen.getAllByText(/Vigoda build line/)).toHaveLength(18)
      expect(screen.queryByText(/Vigoda pod line/)).toBeNull()
    })
  })

  describe("filters by level", () => {
    it("displays only warning logs when warning log level is specified", () => {
      const { container } = customRender(
        <BuildLogAndRunLog
          level={FilterLevel.warn}
          source=""
          term={EMPTY_FILTER_TERM}
        />
      )
      expect(container.querySelectorAll(".LogLine")).toHaveLength(
        2 * (1 + PROLOGUE_LENGTH)
      )
      const alerts = container.querySelectorAll(".is-endOfAlert")
      const lastAlert = alerts[alerts.length - 1]
      expect(lastAlert).toHaveTextContent("Vigoda pod warning line")
      expect(screen.queryByText(/Vigoda pod error line/)).toBeNull()
    })

    it("displays only error logs when error log level is specified", () => {
      const { container } = customRender(
        <BuildLogAndRunLog
          level={FilterLevel.error}
          source=""
          term={EMPTY_FILTER_TERM}
        />
      )

      expect(container.querySelectorAll(".LogLine")).toHaveLength(
        2 * (1 + PROLOGUE_LENGTH)
      )
      const alerts = container.querySelectorAll(".is-endOfAlert")
      const lastAlert = alerts[alerts.length - 1]
      expect(lastAlert).toHaveTextContent("Vigoda pod error line")
    })
  })

  describe("filters by term", () => {
    it("displays log lines that match the specified filter term", () => {
      const termWithResults = createFilterTermState("line 5")
      const { container } = customRender(
        <BuildLogAndRunLog source="" level="" term={termWithResults} />
      )

      expect(container.querySelectorAll(".LogLine")).toHaveLength(2)
      expect(screen.getAllByText(/line 5/)).toHaveLength(2)
      expect(screen.queryByText(/line 15/)).toBeNull()
    })

    it("displays zero log lines when no logs match the specified filter term", () => {
      const termWithResults = createFilterTermState("spaghetti")
      const { container } = customRender(
        <BuildLogAndRunLog source="" level="" term={termWithResults} />
      )

      expect(container.querySelectorAll(".LogLine")).toHaveLength(0)
    })
  })

  /**
   * The following tests rely on testing React component state directly,
   * which is not possible to do with React Testing Library.
   */

  describe("log rendering", () => {
    function getLogElements(container: HTMLElement) {
      return container.querySelectorAll(".LogLine")
    }

    const initLineCount = 2 * renderWindow

    let fakeRaf: TestRafContext
    let rootTree: Component<any>
    let container: HTMLDivElement
    let component: OverviewLogComponent

    function renderAllScheduledFrames(maxFrames: number = 20) {
      let renderedFrames = 0
      while (component.renderBufferRafId) {
        if (renderedFrames++ >= maxFrames) {
          throw new Error(
            `log rendering did not settle within ${maxFrames} frames`
          )
        }
        fakeRaf.invoke(component.renderBufferRafId)
      }
    }

    function appendIncrementalLines(count: number) {
      let lines = []
      for (let i = 0; i < count; i++) {
        lines.push(`incremental line ${i}\n`)
      }
      appendLines(component.props.logStore, "fe", ...lines)
      component.onLogUpdate({ action: LogUpdateAction.append })
      jest.advanceTimersByTime(liveLogReadIntervalMs)
    }

    function indexedLineCount() {
      let internals = component as unknown as {
        lineHashList: { byStoredLineIndex: Record<number, unknown> }
      }
      return Object.keys(internals.lineHashList.byStoredLineIndex).length
    }

    function trackStoredLineIndexReads() {
      let readCount = 0
      let trackedLines = new Set<LogLine>()

      return {
        add(lines: LogLine[]) {
          for (let line of lines) {
            if (trackedLines.has(line)) {
              continue
            }
            trackedLines.add(line)
            let storedLineIndex = line.storedLineIndex
            Object.defineProperty(line, "storedLineIndex", {
              configurable: true,
              get: () => {
                readCount++
                return storedLineIndex
              },
              set: (nextStoredLineIndex: number) => {
                storedLineIndex = nextStoredLineIndex
              },
            })
          }
        },
        reset() {
          readCount = 0
        },
        readCount() {
          return readCount
        },
      }
    }

    function renderedIndices(testContainer: HTMLElement): number[] {
      return Array.from(getLogElements(testContainer)).map((lineEl) => {
        let storedLineIndex = Number(lineEl.getAttribute("data-sl-index"))
        if (!Number.isInteger(storedLineIndex)) {
          throw new Error("expected every rendered line to have an identity")
        }
        return storedLineIndex
      })
    }

    function exposeSmallFontGeometry(
      testComponent: OverviewLogComponent,
      testContainer: HTMLElement
    ) {
      Object.defineProperty(testComponent.rootRef.current, "clientHeight", {
        configurable: true,
        value: 731,
      })
      Array.from(getLogElements(testContainer)).forEach((lineElement, i) => {
        jest.spyOn(lineElement, "getBoundingClientRect").mockImplementation(
          () =>
            ({
              top: i * 7.8,
              bottom: (i + 1) * 7.8,
            } as DOMRect)
        )
      })
    }

    function renderLogStore(logStore: LogStore) {
      let localRaf = newFakeRaf()
      class LocalStoreWrapper extends Component {
        render() {
          return (
            <MemoryRouter
              initialEntries={["/"]}
              future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
            >
              <RafProvider value={localRaf}>
                <LogStoreProvider value={logStore}>
                  <OverviewLogPane
                    manifestName="fe"
                    filterSet={{
                      source: FilterSource.all,
                      level: FilterLevel.all,
                      term: EMPTY_FILTER_TERM,
                    }}
                  />
                </LogStoreProvider>
              </RafProvider>
            </MemoryRouter>
          )
        }
      }
      let testHelpers = renderTestComponent(<LocalStoreWrapper />)
      let localComponent = findRenderedComponentWithType(
        testHelpers.rootTree,
        OverviewLogComponent
      )

      while (localComponent.renderBufferRafId) {
        localRaf.invoke(localComponent.renderBufferRafId)
      }

      return { localComponent, localRaf, logStore, ...testHelpers }
    }

    function renderStoreLines(
      lines: Array<string | { text: string; fields: any }>
    ) {
      let logStore = new LogStore()
      appendLines(logStore, "fe", lines)
      return renderLogStore(logStore)
    }

    beforeEach(() => {
      jest.useFakeTimers()
      fakeRaf = newFakeRaf()

      class ManyLinesWrapper extends Component {
        render() {
          return (
            <MemoryRouter
              initialEntries={["/"]}
              future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
            >
              <RafProvider value={fakeRaf}>
                <ManyLines count={initLineCount} />
              </RafProvider>
            </MemoryRouter>
          )
        }
      }

      const testHelpers = renderTestComponent(<ManyLinesWrapper />)
      rootTree = testHelpers.rootTree
      container = testHelpers.container
      component = findRenderedComponentWithType(rootTree, OverviewLogComponent)
    })

    afterEach(() => {
      jest.restoreAllMocks()
      jest.useRealTimers()
    })

    it("disconnects viewport-fill observers and listeners on unmount", () => {
      const disconnect = jest.spyOn(MutationObserver.prototype, "disconnect")
      const removeListener = jest.spyOn(window, "removeEventListener")
      component.componentWillUnmount()
      expect(disconnect).toHaveBeenCalled()
      expect(removeListener).toHaveBeenCalledWith(
        "resize",
        expect.any(Function)
      )
    })

    it("grows a settled follow-mode tail without waiting for new logs", () => {
      renderAllScheduledFrames()
      component.autoscroll = true
      exposeSmallFontGeometry(component, container)
      let startCheckpoint = (component as any).logCheckpoint
      expect(startCheckpoint).toBeGreaterThan(0)
      expect(getLogElements(container)).toHaveLength(tailLineLimit)
      let tailRead = jest.spyOn(
        component.props.logStore,
        "manifestLogTailPatchSet"
      )
      let incrementalRead = jest.spyOn(
        component.props.logStore,
        "manifestLogPatchSet"
      )

      // No append occurs after the settled checkpoint. Growing through the
      // ordinary incremental reader therefore returns no older lines; the
      // geometry recovery must explicitly refresh the bounded tail snapshot.
      ;(component as any).handleGeometryChange()
      renderAllScheduledFrames()

      let grownTailLimit = (component as any).currentTailLimit()
      expect(grownTailLimit).toBeGreaterThan(tailLineLimit)
      expect(tailRead).toHaveBeenCalledWith("fe", grownTailLimit + 1)
      expect(incrementalRead).not.toHaveBeenCalled()
      expect(getLogElements(container)).toHaveLength(grownTailLimit)
      expect((component as any).logCheckpoint).toBe(startCheckpoint)
    })

    it("retains the measured follow tail while geometry is temporarily unmeasurable", () => {
      renderAllScheduledFrames()
      component.autoscroll = true
      exposeSmallFontGeometry(component, container)
      component.renderBuffer()
      let measuredTailLimit = (component as any).currentTailLimit()
      expect(measuredTailLimit).toBeGreaterThan(tailLineLimit)

      // Compaction can briefly leave no usable pane geometry. That absence is
      // not evidence that the viewport shrank, so the last measurement stands.
      Object.defineProperty(component.rootRef.current, "clientHeight", {
        configurable: true,
        value: 0,
      })
      component.renderBuffer()
      expect((component as any).currentTailLimit()).toBe(measuredTailLimit)
    })

    it("does not re-read the live tail when the follow-mode limit is unchanged", () => {
      renderAllScheduledFrames()
      component.autoscroll = true
      // Unmeasurable geometry holds the limit at the floor; re-reading on every
      // observer callback would churn the tail for no visible gain.
      let reread = jest
        .spyOn(component, "readLogsFromLogStore")
        .mockImplementation(() => {})
      ;(component as any).handleGeometryChange()
      expect((component as any).currentTailLimit()).toBe(tailLineLimit)
      expect(reread).not.toHaveBeenCalled()
    })

    it("refills a disengaged reader rather than re-reading the tail", () => {
      renderAllScheduledFrames()
      component.autoscroll = true
      // A real clientHeight with jsdom's scrollHeight of 0 would look
      // underfilled, but follow mode owns its tail through the live read path
      // and must not be refilled here.
      Object.defineProperty(component.rootRef.current, "clientHeight", {
        configurable: true,
        value: 900,
      })
      let before = component.renderBufferRafId
      ;(component as any).fillUnderfilledViewport()
      expect(component.renderBufferRafId).toBe(before)
    })

    it("schedules a fill for a disengaged pane that no longer covers the viewport", () => {
      renderAllScheduledFrames()
      let root = component.rootRef.current
      // Scroll to the top boundary: disengages follow and hydrates history so
      // older lines are available to reclaim the freed space.
      component.scrollTop = 1000
      root.scrollTop = 0
      component.onScroll()
      renderAllScheduledFrames()
      expect(component.autoscroll).toBe(false)
      // jsdom scrollHeight stays 0, so a real clientHeight reads as underfilled.
      Object.defineProperty(root, "clientHeight", {
        configurable: true,
        value: 900,
      })
      ;(component as any).fillUnderfilledViewport()
      expect(component.renderBufferRafId).toBeTruthy()
    })

    it("refills partially up to remaining capacity near the cap", () => {
      renderAllScheduledFrames()
      let root = component.rootRef.current
      // Scroll to the top boundary: disengages follow and hydrates history.
      component.scrollTop = 1000
      root.scrollTop = 0
      component.onScroll()
      renderAllScheduledFrames()
      expect(component.autoscroll).toBe(false)
      Object.defineProperty(root, "clientHeight", {
        configurable: true,
        value: 900,
      })
      // Capacity is smaller than the batch waiting in history: 50 slots free
      // against 186 buffered lines. Bounding the decision by the batch size
      // refuses the whole fill and strands the reader with a permanent gap; the
      // fill must take the safe remainder instead (REQ-LOGPANE-005).
      let capacity = 50
      expect(component.backwardBuffer.length).toBeGreaterThan(capacity)
      jest
        .spyOn(component as any, "renderedLineCount")
        .mockReturnValue(renderedLineLimit - capacity)
      component.renderBufferRafId = 0
      ;(component as any).fillUnderfilledViewport()
      expect(component.renderBufferRafId).toBeTruthy()
    })

    it("does not refill once the rendered window is at the cap", () => {
      renderAllScheduledFrames()
      component.autoscroll = false
      Object.defineProperty(component.rootRef.current, "clientHeight", {
        configurable: true,
        value: 900,
      })
      // No capacity left: any addition forces makeRoomFor to evict the opposite
      // edge, which for a disengaged reader can be visible/focused nodes.
      jest
        .spyOn(component as any, "renderedLineCount")
        .mockReturnValue(renderedLineLimit)
      let before = component.renderBufferRafId
      ;(component as any).fillUnderfilledViewport()
      expect(component.renderBufferRafId).toBe(before)
    })

    it("carries the no-eviction budget into a continuation pass", () => {
      renderAllScheduledFrames()
      let root = component.rootRef.current
      component.scrollTop = 1000
      root.scrollTop = 0
      component.onScroll()
      renderAllScheduledFrames()
      expect(component.autoscroll).toBe(false)
      Object.defineProperty(root, "clientHeight", {
        configurable: true,
        value: 900,
      })
      // Hold capacity well below the buffered history so the first pass is
      // partial and leaves lines behind — that is what produces a continuation.
      jest
        .spyOn(component as any, "renderedLineCount")
        .mockReturnValue(renderedLineLimit - 50)
      expect(component.backwardBuffer.length).toBeGreaterThan(50)
      // Start a geometry refill, then run the render it scheduled. The pane is
      // still underfilled afterwards, so renderBuffer queues a continuation
      // pass. That pass must inherit a capacity bound: without one it takes the
      // ordinary full-window batch and makeRoomFor evicts the opposite edge,
      // which can be visible, selected, or focused lines (REQ-LOGPANE-005).
      component.renderBufferRafId = 0
      ;(component as any).fillUnderfilledViewport()
      expect(component.renderBufferRafId).toBeTruthy()
      component.renderBuffer()
      expect(component.renderBufferRafId).toBeTruthy()
      expect((component as any).viewportFillBudget).not.toBeNull()
    })

    it("fills a near-cap pane when the remaining history is shorter than a window", () => {
      renderAllScheduledFrames()
      let root = component.rootRef.current
      // Scroll to the top boundary: disengages follow and hydrates history.
      component.scrollTop = 1000
      root.scrollTop = 0
      component.onScroll()
      renderAllScheduledFrames()
      expect(component.autoscroll).toBe(false)
      Object.defineProperty(root, "clientHeight", {
        configurable: true,
        value: 900,
      })
      // Near the cap, but only a handful of lines remain to reclaim. A render
      // adds min(renderWindow, buffer.length), so the real increment here is 5:
      // the window lands at renderedLineLimit - 5 and makeRoomFor evicts
      // nothing. Bounding the guard by a full renderWindow instead of the
      // actual increment strands this reader with a permanent gap.
      component.forwardBuffer = []
      component.backwardBuffer = component.backwardBuffer.slice(-5)
      expect(component.backwardBuffer.length).toBe(5)
      jest
        .spyOn(component as any, "renderedLineCount")
        .mockReturnValue(renderedLineLimit - 10)
      component.renderBufferRafId = 0
      ;(component as any).fillUnderfilledViewport()
      expect(component.renderBufferRafId).toBeTruthy()
    })

    it("grows the follow-mode tail to cover a small-font viewport", () => {
      renderAllScheduledFrames()
      component.autoscroll = true
      Object.defineProperty(component.rootRef.current, "clientHeight", {
        configurable: true,
        value: 731,
      })
      // jsdom has no layout, so stand in for the mounted-line geometry with the
      // measured 40%-font case: 64 lines at 7.8px. The viewport then needs ~94
      // lines, so a tail fixed at tailLineLimit leaves ~30% of the pane blank.
      jest
        .spyOn(component as any, "renderedLineElements")
        .mockImplementation(() =>
          Array.from({ length: 64 }, (_, i) => ({
            getBoundingClientRect: () => ({
              top: i * 7.8,
              bottom: (i + 1) * 7.8,
            }),
          }))
        )
      component.renderBuffer()
      expect((component as any).renderedLineTarget()).toBeGreaterThan(
        tailLineLimit
      )
    })

    it("keeps the follow-mode tail at the floor when geometry is unmeasurable", () => {
      renderAllScheduledFrames()
      component.autoscroll = true
      // jsdom reports zero height and empty rects. An unmeasurable pane must
      // resolve to exactly tailLineLimit — a defined value, not a guess.
      component.renderBuffer()
      expect((component as any).renderedLineTarget()).toBe(tailLineLimit)
    })

    it("ignores a refill budget when the render was retargeted", () => {
      renderAllScheduledFrames()
      let root = component.rootRef.current
      component.scrollTop = 1000
      root.scrollTop = 0
      component.onScroll()
      renderAllScheduledFrames()
      expect(component.autoscroll).toBe(false)
      Object.defineProperty(root, "clientHeight", {
        configurable: true,
        value: 900,
      })
      // Arm a forward refill with a small capacity, then let a scroll retarget
      // the pending render to a deliberate backward traversal before the frame
      // runs. The traversal must take a full window: the budget was computed for
      // a different direction and says nothing about this render.
      component.forwardBuffer = component.backwardBuffer.slice(-10)
      component.renderBufferRafId = 0
      jest
        .spyOn(component as any, "renderedLineCount")
        .mockReturnValue(renderedLineLimit - 5)
      ;(component as any).fillUnderfilledViewport()
      let buffered = component.backwardBuffer.length
      let fullWindow = Math.min(renderWindow, buffered)
      expect(fullWindow).toBeGreaterThan(5)
      ;(component as any).renderDirection = "backward"
      component.renderBuffer()
      expect(buffered - component.backwardBuffer.length).toBe(fullWindow)
    })

    it("engages autoscrolls on scroll down", () => {
      component.autoscroll = false
      component.scrollTop = 0
      component.rootRef.current.scrollTop = 1000
      component.onScroll()
      expect(component.scrollTop).toEqual(1000)

      // The scroll has been scheduled, but not engaged yet.
      expect(component.autoscrollRafId).toBeGreaterThan(0)
      expect(component.autoscroll).toEqual(false)

      fakeRaf.invoke(component.autoscrollRafId as number)
      expect(component.autoscroll).toEqual(true)
    })

    it("renders a compact tail first", () => {
      // Make sure no logs have been rendered yet.
      let getLogElements = () => container.querySelectorAll(".LogLine")

      expect(component.renderBufferRafId).toBeGreaterThan(0)
      expect(component.forwardBuffer.length).toEqual(tailLineLimit)
      expect(component.backwardBuffer).toHaveLength(0)
      expect(getLogElements().length).toEqual(0)

      // Follow mode records only the newest visible tail before the first
      // frame; older store history remains available for a boundary hydrate.
      fakeRaf.invoke(component.renderBufferRafId as number)
      expect(component.forwardBuffer).toHaveLength(0)
      expect(component.backwardBuffer).toHaveLength(0)
      expect(getLogElements().length).toEqual(tailLineLimit)
      expect(getLogElements()[0].innerHTML).toEqual(
        expect.stringContaining(">line 436\n<")
      )

      expect(component.renderBufferRafId).toEqual(0)
    })

    it("uses a bounded store tail for the default follow-mode mount", () => {
      let logStore = new LogStore()
      appendLines(
        logStore,
        "fe",
        Array.from({ length: 2 * tailLineLimit }, (_, i) => `tail ${i}\n`)
      )
      let fullReadSpy = jest.spyOn(logStore, "manifestLogPatchSet")
      let tailReadSpy = jest.spyOn(logStore, "manifestLogTailPatchSet")

      let { container: localContainer } = renderLogStore(logStore)
      expect(tailReadSpy).toHaveBeenCalledWith("fe", tailLineLimit + 1)
      expect(fullReadSpy).not.toHaveBeenCalled()
      expect(Object.keys(logStore.lineCache)).toHaveLength(tailLineLimit + 1)
      expect(getLogElements(localContainer)).toHaveLength(tailLineLimit)
    })

    it("ignores an upward wheel before its initial tail render", () => {
      const initialRenderRafId = component.renderBufferRafId
      const readSpy = jest.spyOn(
        component.props.logStore,
        "manifestLogPatchSet"
      )

      // The browser can deliver wheel intent while the initial tail is queued
      // but before it has mounted a line that history hydration can anchor.
      expect(() => {
        component.onWheel(new WheelEvent("wheel", { deltaY: -1 }))
      }).not.toThrow()

      expect(component.autoscroll).toBe(true)
      expect(component.backwardBuffer).toHaveLength(0)
      expect(component.renderBufferRafId).toBe(initialRenderRafId)
      expect(readSpy).not.toHaveBeenCalled()

      // An ignored gesture is transient: the queued tail and later updates
      // must continue in normal follow mode.
      fakeRaf.invoke(initialRenderRafId as number)
      appendIncrementalLines(1)
      renderAllScheduledFrames()
      expect(component.autoscroll).toBe(true)
      expect(getLogElements(container)[tailLineLimit - 1]).toHaveTextContent(
        "incremental line 0"
      )
    })

    it("ignores an upward wheel when a settled pane has no rendered anchor", () => {
      const logStore = new LogStore()
      const {
        localComponent,
        localRaf,
        container: localContainer,
      } = renderLogStore(logStore)
      const readSpy = jest.spyOn(logStore, "manifestLogPatchSet")

      expect(getLogElements(localContainer)).toHaveLength(0)
      expect(() => {
        localComponent.onWheel(new WheelEvent("wheel", { deltaY: -1 }))
      }).not.toThrow()

      expect(localComponent.autoscroll).toBe(true)
      expect(localComponent.backwardBuffer).toHaveLength(0)
      expect(localComponent.renderBufferRafId).toBeNull()
      expect(readSpy).not.toHaveBeenCalled()

      // Empty panes stay ready to follow a later tail update.
      appendLines(logStore, "fe", "first log line\n")
      localComponent.onLogUpdate({ action: LogUpdateAction.append })
      jest.advanceTimersByTime(liveLogReadIntervalMs)
      while (localComponent.renderBufferRafId) {
        localRaf.invoke(localComponent.renderBufferRafId)
      }
      expect(localComponent.autoscroll).toBe(true)
      expect(getLogElements(localContainer)).toHaveLength(1)
    })

    it("coalesces an unrendered startup tail with newer logs", () => {
      expect(component.renderBufferRafId).toBeGreaterThan(0)
      expect(component.forwardBuffer).toHaveLength(tailLineLimit)
      expect(component.backwardBuffer).toHaveLength(0)
      expect(getLogElements(container).length).toEqual(0)

      // append new lines on top of the lines we already have.
      let newLineCount = 1.5 * renderWindow
      let lines = []
      for (let i = 0; i < newLineCount; i++) {
        lines.push(`incremental line ${i}\n`)
      }
      appendLines(component.props.logStore, "fe", ...lines)
      component.onLogUpdate({ action: LogUpdateAction.append })
      jest.advanceTimersByTime(liveLogReadIntervalMs)
      expect(component.forwardBuffer).toHaveLength(tailLineLimit)
      expect(component.backwardBuffer).toHaveLength(0)

      // The first render receives only the latest user-visible tail.
      fakeRaf.invoke(component.renderBufferRafId as number)
      expect(component.forwardBuffer.length).toEqual(0)
      expect(component.backwardBuffer).toHaveLength(0)

      const logElements = getLogElements(container)
      expect(logElements.length).toEqual(tailLineLimit)
      expect(logElements[0].innerHTML).toEqual(
        expect.stringContaining(">incremental line 311\n<")
      )
      expect(logElements[logElements.length - 1].innerHTML).toEqual(
        expect.stringContaining(">incremental line 374\n<")
      )
      expect(component.renderBufferRafId).toEqual(0)
    })

    it("batches rapid store notifications into one tail read", () => {
      renderAllScheduledFrames()
      let readSpy = jest.spyOn(component, "readLogsFromLogStore")

      appendLines(component.props.logStore, "fe", "first batched line\n")
      appendLines(component.props.logStore, "fe", "second batched line\n")
      component.onLogUpdate({ action: LogUpdateAction.append })
      component.onLogUpdate({ action: LogUpdateAction.append })

      expect(readSpy).not.toHaveBeenCalled()
      jest.advanceTimersByTime(liveLogReadIntervalMs)
      expect(readSpy).toHaveBeenCalledTimes(1)

      renderAllScheduledFrames()
      let logElements = getLogElements(container)
      expect(logElements[logElements.length - 1]).toHaveTextContent(
        "second batched line"
      )
    })

    it("coalesces a busy pinned tail into one fresh render window", () => {
      renderAllScheduledFrames()
      const settledTail = Array.from(getLogElements(container))
      const settledContentByLine = new Map(
        settledTail.map((lineEl) => {
          const content = lineEl.querySelector(
            ":scope > code.LogLine-content"
          ) as HTMLElement | null
          if (!content || content.childNodes.length !== 1) {
            throw new Error(
              "expected a plain log line with one content text node"
            )
          }

          const textNode = content.firstChild
          if (!(textNode instanceof Text)) {
            throw new Error("expected plain log content to use a text node")
          }
          return [lineEl, { content, textNode }] as const
        })
      )
      let materializeSpy = jest.spyOn(component, "renderLineHelper")

      // The production profile observed append notifications four times per
      // second. Each chunk is individually smaller than the pinned tail, but
      // the complete second is larger than the user-visible window.
      for (let chunk = 0; chunk < 4; chunk++) {
        let lines = Array.from(
          { length: tailLineLimit / 2 },
          (_, line) => `busy chunk ${chunk} line ${line}\n`
        )
        appendLines(component.props.logStore, "fe", ...lines)
        component.onLogUpdate({ action: LogUpdateAction.append })
        jest.advanceTimersByTime(250)
        renderAllScheduledFrames()
      }

      // Only the tail that can remain visible may be materialized. The final
      // notification is visible at the one-second freshness boundary.
      expect(materializeSpy).toHaveBeenCalledTimes(tailLineLimit)
      const logElements = getLogElements(container)
      expect(logElements).toHaveLength(tailLineLimit)
      Array.from(logElements).forEach((lineEl, i) => {
        expect(settledTail).toContain(lineEl)
        const settledContent = settledContentByLine.get(lineEl)
        if (!settledContent) {
          throw new Error("expected recycled log line to have settled content")
        }
        const content = lineEl.querySelector(
          ":scope > code.LogLine-content"
        ) as HTMLElement | null
        expect(content).toBe(settledContent.content)
        expect(content?.firstChild).toBe(settledContent.textNode)
        expect(content).toHaveTextContent(
          `busy chunk ${i < tailLineLimit / 2 ? 2 : 3} line ${
            i % (tailLineLimit / 2)
          }`
        )
        expect(lineEl).toHaveAttribute(
          "data-sl-index",
          String(initLineCount + tailLineLimit + i)
        )
      })
      expect(logElements[0]).toHaveTextContent("busy chunk 2 line 0")
      expect(logElements[logElements.length - 1]).toHaveTextContent(
        "busy chunk 3 line 31"
      )
    })

    it("reinitializes recycled tail nodes for plain and decorated lines", () => {
      const warningFilter = {
        source: FilterSource.all,
        level: FilterLevel.warn,
        term: EMPTY_FILTER_TERM,
      }
      const allFilter = {
        source: FilterSource.all,
        level: FilterLevel.all,
        term: EMPTY_FILTER_TERM,
      }
      const logStore = new LogStore()
      const appendSegments = (
        segments: Array<{
          spanId: string
          text: string
          level?: string
          fields?: { buildEvent?: string }
        }>
      ) => {
        const fromCheckpoint = logStore.checkpoint
        logStore.append({
          spans: {
            alpha: { manifestName: "alpha" },
            beta: { manifestName: "beta" },
            plain: { manifestName: "plain" },
          },
          segments,
          fromCheckpoint,
          toCheckpoint: fromCheckpoint + segments.length,
        })
      }
      const decoratedSegments = (label: string) => {
        const segments: Array<{
          spanId: string
          text: string
          level?: string
          fields?: { buildEvent?: string }
        }> = [
          {
            spanId: "alpha",
            text: `${label} build \u001b[31mstart\u001b[39m http://example.com/${label}\n`,
            fields: { buildEvent: "init" },
          },
          {
            spanId: "beta",
            text: `${label} build fallback\n`,
            level: "ERROR",
            fields: { buildEvent: "fallback" },
          },
        ]
        for (let i = 0; i < 31; i++) {
          const spanId = i % 2 === 0 ? "alpha" : "beta"
          segments.push(
            { spanId, text: `${label} context ${i}\n` },
            { spanId, text: `${label} warning ${i}\n`, level: "WARN" }
          )
        }
        return segments
      }

      appendSegments(decoratedSegments("initial"))

      class DecoratedLogsWrapper extends Component {
        render() {
          return (
            <MemoryRouter
              initialEntries={["/"]}
              future={{
                v7_startTransition: true,
                v7_relativeSplatPath: true,
              }}
            >
              <RafProvider value={fakeRaf}>
                <LogStoreProvider value={logStore}>
                  <OverviewLogPane manifestName="" filterSet={warningFilter} />
                </LogStoreProvider>
              </RafProvider>
            </MemoryRouter>
          )
        }
      }

      const decoratedTest = renderTestComponent(<DecoratedLogsWrapper />)
      const decoratedComponent = findRenderedComponentWithType(
        decoratedTest.rootTree,
        OverviewLogComponent
      )
      const renderDecoratedFrames = () => {
        let renderedFrames = 0
        while (decoratedComponent.renderBufferRafId) {
          if (renderedFrames++ >= 20) {
            throw new Error("decorated log rendering did not settle")
          }
          fakeRaf.invoke(decoratedComponent.renderBufferRafId)
        }
      }

      renderDecoratedFrames()
      const initialElements = Array.from(
        decoratedTest.container.querySelectorAll<HTMLSpanElement>(".LogLine")
      )
      expect(initialElements).toHaveLength(tailLineLimit)
      expect(
        decoratedTest.container.querySelector(".is-warning.is-endOfAlert")
      ).not.toBeNull()
      expect(
        decoratedTest.container.querySelector(
          ".is-error.is-buildEvent-fallback"
        )
      ).not.toBeNull()
      expect(
        decoratedTest.container.querySelector(".is-contextChange")
      ).not.toBeNull()
      expect(
        decoratedTest.container.querySelector(".LogLine-alertNav")
      ).not.toBeNull()
      expect(
        decoratedTest.container.querySelector(".LogLine-content a")
      ).not.toBeNull()
      expect(
        decoratedTest.container.querySelector(".LogLine-content span")
      ).not.toBeNull()

      // Changing only the display projection models a recycled slot receiving
      // a normal line without tearing down the component-local recycler.
      ;(
        decoratedComponent as unknown as { logDisplay: LogDisplay }
      ).logDisplay = new LogDisplay(allFilter)
      appendSegments(
        Array.from({ length: 2 * tailLineLimit }, (_, i) => ({
          spanId: "plain",
          text: `plain tail ${i} <safe-${i}> & "quoted"\n`,
        }))
      )
      decoratedComponent.onLogUpdate({ action: LogUpdateAction.append })
      jest.advanceTimersByTime(liveLogReadIntervalMs)
      renderDecoratedFrames()

      const plainElements = Array.from(
        decoratedTest.container.querySelectorAll<HTMLSpanElement>(".LogLine")
      )
      expect(plainElements).toHaveLength(tailLineLimit)
      for (let lineEl of plainElements) {
        expect(initialElements).toContain(lineEl)
        expect(lineEl).not.toHaveClass(
          "is-warning",
          "is-error",
          "is-buildEvent",
          "is-startOfAlert",
          "is-endOfAlert"
        )
        expect(lineEl.querySelector(".LogLine-alertNav")).toBeNull()
        expect(lineEl.querySelector(".logLinePrefix")).toHaveTextContent(
          "plain"
        )
        const content = lineEl.querySelector(
          ":scope > code.LogLine-content"
        ) as HTMLElement | null
        expect(content?.children).toHaveLength(0)
        expect(content?.childNodes).toHaveLength(1)
        expect(content?.firstChild).toBeInstanceOf(Text)
        expect(content).toHaveTextContent(
          `plain tail ${Number(lineEl.dataset.slIndex) - 64} <safe-${
            Number(lineEl.dataset.slIndex) - 64
          }> & "quoted"`
        )
      }

      ;(
        decoratedComponent as unknown as { logDisplay: LogDisplay }
      ).logDisplay = new LogDisplay(warningFilter)
      appendSegments(decoratedSegments("next"))
      decoratedComponent.onLogUpdate({ action: LogUpdateAction.append })
      jest.advanceTimersByTime(liveLogReadIntervalMs)
      renderDecoratedFrames()

      const nextElements = Array.from(
        decoratedTest.container.querySelectorAll<HTMLSpanElement>(".LogLine")
      )
      expect(nextElements).toHaveLength(tailLineLimit)
      for (let lineEl of nextElements) {
        expect(plainElements).toContain(lineEl)
      }
      expect(
        decoratedTest.container.querySelector(".is-warning.is-endOfAlert")
      ).not.toBeNull()
      expect(
        decoratedTest.container.querySelector(
          ".is-error.is-buildEvent-fallback"
        )
      ).not.toBeNull()
      expect(
        decoratedTest.container.querySelector(".is-contextChange")
      ).not.toBeNull()
      expect(
        decoratedTest.container.querySelector<HTMLButtonElement>(
          ".LogLine-alertNav"
        )?.onclick
      ).not.toBeNull()
      expect(
        decoratedTest.container.querySelector(".LogLine-content a")
      ).not.toBeNull()
      expect(
        decoratedTest.container.querySelector(".LogLine-content span")
      ).not.toBeNull()
    })

    it("keeps checkpoint updates pending while history remains deliberate", () => {
      renderAllScheduledFrames()
      appendIncrementalLines(4 * renderWindow)
      renderAllScheduledFrames()

      // Move into history, then retain that exact window while live updates
      // continue to be read incrementally from the store checkpoint.
      component.scrollTop = 1
      component.rootRef.current.scrollTop = 0
      component.onScroll()
      renderAllScheduledFrames()
      const historyWindow = Array.from(getLogElements(container)).map((el) =>
        el.getAttribute("data-sl-index")
      )
      let readSpy = jest.spyOn(component, "readLogsFromLogStore")

      appendLines(component.props.logStore, "fe", "history stays put\n")
      component.onLogUpdate({ action: LogUpdateAction.append })
      jest.advanceTimersByTime(liveLogReadIntervalMs)

      expect(readSpy).toHaveBeenCalledTimes(1)
      expect(component.forwardBuffer).toHaveLength(1)
      expect(
        Array.from(getLogElements(container)).map((el) =>
          el.getAttribute("data-sl-index")
        )
      ).toEqual(historyWindow)

      // Re-engaging follow mode renders that checkpoint without rebuilding
      // history or leaving the user at an older window.
      component.scrollTop = 0
      component.rootRef.current.scrollTop = 1000
      component.onScroll()
      fakeRaf.invoke(component.autoscrollRafId as number)
      renderAllScheduledFrames()

      const logElements = getLogElements(container)
      expect(component.autoscroll).toBe(true)
      expect(logElements).toHaveLength(tailLineLimit)
      expect(logElements[logElements.length - 1]).toHaveTextContent(
        "history stays put"
      )
    })

    it("freezes a non-boundary history window after follow mode disengages", () => {
      renderAllScheduledFrames()
      const root = component.rootRef.current as HTMLElement
      const before = Array.from(getLogElements(container))
      const beforeIndices = renderedIndices(container)
      let readSpy = jest.spyOn(component.props.logStore, "manifestLogPatchSet")

      // This is a real upward scroll away from the current DOM boundary, not
      // the top-boundary gesture that requests another older window.
      component.scrollTop = 100
      root.scrollTop = 50
      root.dispatchEvent(new Event("scroll"))

      expect(component.autoscroll).toBe(false)
      expect(readSpy).toHaveBeenCalledWith("fe", 0)

      appendLines(component.props.logStore, "fe", "waiting in history\n")
      component.onLogUpdate({ action: LogUpdateAction.append })
      jest.advanceTimersByTime(liveLogReadIntervalMs)
      renderAllScheduledFrames()

      expect(component.forwardBuffer).toHaveLength(1)
      expect(renderedIndices(container)).toEqual(beforeIndices)
      expect(Array.from(getLogElements(container))).toEqual(before)
    })

    it("hydrates once when horizontal movement disengages follow mode", () => {
      renderAllScheduledFrames()
      const root = component.rootRef.current as HTMLElement
      let readSpy = jest.spyOn(component.props.logStore, "manifestLogPatchSet")

      component.scrollTop = 100
      root.scrollTop = 100
      root.scrollLeft = 1
      root.dispatchEvent(new Event("scroll"))
      root.dispatchEvent(new Event("scroll"))

      expect(component.autoscroll).toBe(false)
      expect(readSpy).toHaveBeenCalledTimes(1)
      expect(readSpy).toHaveBeenCalledWith("fe", 0)
    })

    it("loads an older window at the horizontal top boundary", () => {
      renderAllScheduledFrames()
      const root = component.rootRef.current as HTMLElement

      // Vertical traversal remains reachable while the user is reading a
      // long line horizontally. The compact tail can already be at the top,
      // so horizontal motion must hydrate it and mount the first older window
      // without any vertical movement.
      component.scrollTop = 0
      root.scrollTop = 0
      root.scrollLeft = 1
      root.dispatchEvent(new Event("scroll"))

      expect(component.autoscroll).toBe(false)
      expect(component.backwardBuffer.length).toBeGreaterThan(0)
      expect(component.renderBufferRafId).toBeGreaterThan(0)

      renderAllScheduledFrames()
      expect(getLogElements(container)).toHaveLength(
        tailLineLimit + renderWindow
      )
    })

    it("keeps compact progress rewrites ordered for upward hydration", () => {
      let logStore = new LogStore()
      let tailSegments = Array.from({ length: 70 }, (_, i) => ({
        spanId: "tail",
        text: `tail ${i}\n`,
      }))
      logStore.append({
        spans: {
          progress: { manifestName: "fe" },
          tail: { manifestName: "fe" },
        },
        segments: [
          {
            spanId: "progress",
            text: "progress pending\n",
            fields: { progressID: "old-progress" },
          },
          ...tailSegments,
        ],
        fromCheckpoint: 0,
        toCheckpoint: tailSegments.length + 1,
      })
      let {
        localComponent,
        localRaf,
        container: localContainer,
      } = renderLogStore(logStore)

      logStore.append({
        spans: { progress: { manifestName: "fe" } },
        segments: [
          {
            spanId: "progress",
            text: "progress complete\n",
            fields: { progressID: "old-progress" },
          },
        ],
        fromCheckpoint: logStore.checkpoint,
        toCheckpoint: logStore.checkpoint + 1,
      })
      localComponent.onLogUpdate({ action: LogUpdateAction.append })
      jest.advanceTimersByTime(liveLogReadIntervalMs)
      while (localComponent.renderBufferRafId) {
        localRaf.invoke(localComponent.renderBufferRafId)
      }

      expect(renderedIndices(localContainer)).toEqual(
        Array.from({ length: tailLineLimit }, (_, i) => i + 7)
      )
      localComponent.scrollTop = 1
      localComponent.rootRef.current.scrollTop = 0
      expect(() => localComponent.onScroll()).not.toThrow()
      while (localComponent.renderBufferRafId) {
        localRaf.invoke(localComponent.renderBufferRafId)
      }
      expect(renderedIndices(localContainer)).toEqual(
        Array.from({ length: 71 }, (_, i) => i)
      )
      expect(localContainer.querySelector(".LogLine")).toHaveTextContent(
        "progress complete"
      )
    })

    it("refreshes a mounted compact progress rewrite during upward hydration", () => {
      let logStore = new LogStore()
      let leadingSegments = Array.from({ length: 7 }, (_, i) => ({
        spanId: "tail",
        text: `leading ${i}\n`,
      }))
      let trailingSegments = Array.from({ length: 62 }, (_, i) => ({
        spanId: "tail",
        text: `tail ${i}\n`,
      }))
      logStore.append({
        spans: {
          progress: { manifestName: "fe" },
          tail: { manifestName: "fe" },
        },
        segments: [
          ...leadingSegments,
          {
            spanId: "progress",
            text: "progress pending\n",
            fields: { progressID: "mounted-progress" },
          },
          { spanId: "tail", text: "retained https://tilt.dev/\n" },
          ...trailingSegments,
        ],
        fromCheckpoint: 0,
        toCheckpoint: leadingSegments.length + trailingSegments.length + 2,
      })
      let {
        localComponent,
        localRaf,
        container: localContainer,
      } = renderLogStore(logStore)
      document.body.appendChild(localContainer)

      let progressOuter = localContainer.querySelector<HTMLSpanElement>(
        '[data-sl-index="7"]'
      )
      let retainedOuter = localContainer.querySelector<HTMLSpanElement>(
        '[data-sl-index="8"]'
      )
      let retainedCode = retainedOuter?.querySelector<HTMLElement>(
        ":scope > code.LogLine-content"
      )
      let retainedLink = retainedCode?.querySelector<HTMLAnchorElement>("a")
      let retainedText = retainedLink?.firstChild
      if (
        !progressOuter ||
        !retainedOuter ||
        !retainedCode ||
        !retainedLink ||
        !retainedText
      ) {
        throw new Error(
          "expected mounted progress and retained compact-tail lines"
        )
      }

      retainedLink.focus()
      let range = document.createRange()
      range.selectNodeContents(retainedText)
      let selection = document.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)

      logStore.append({
        spans: { progress: { manifestName: "fe" } },
        segments: [
          {
            spanId: "progress",
            text: "progress complete\n",
            fields: { progressID: "mounted-progress" },
          },
        ],
        fromCheckpoint: logStore.checkpoint,
        toCheckpoint: logStore.checkpoint + 1,
      })
      localComponent.onLogUpdate({ action: LogUpdateAction.append })

      // The deferred checkpoint read is still pending when an upward gesture
      // transfers compact-tail nodes into the full-history index.
      localComponent.scrollTop = 1
      localComponent.rootRef.current.scrollTop = 0
      localComponent.onScroll()

      let progressAfterHydration = localContainer.querySelector(
        '[data-sl-index="7"]'
      )
      expect(progressAfterHydration).toBe(progressOuter)
      expect(progressAfterHydration).toHaveTextContent("progress complete")
      expect(localContainer.querySelector('[data-sl-index="8"]')).toBe(
        retainedOuter
      )
      expect(retainedOuter.querySelector("code.LogLine-content")).toBe(
        retainedCode
      )
      expect(retainedLink.firstChild).toBe(retainedText)
      expect(document.activeElement).toBe(retainedLink)
      expect(document.getSelection()?.toString()).toContain("tilt.dev")

      jest.advanceTimersByTime(liveLogReadIntervalMs)
      while (localComponent.renderBufferRafId) {
        localRaf.invoke(localComponent.renderBufferRafId)
      }
      expect(
        localContainer.querySelector('[data-sl-index="7"]')
      ).toHaveTextContent("progress complete")
      localContainer.remove()
    })

    it("keeps existing and unseen interior identities ordered", () => {
      type LineIndex = {
        append(line: LogLine): void
        lines(): LogLine[]
        lookupByStoredLineIndex(storedLineIndex: number): {
          el?: HTMLSpanElement
          line: LogLine
        } | null
      }
      const line = (storedLineIndex: number, text: string): LogLine => ({
        text,
        level: "INFO",
        manifestName: "fe",
        spanId: "fe",
        storedLineIndex,
      })
      const getLineIndex = () =>
        (component as unknown as { lineHashList: LineIndex }).lineHashList

      // A progress rewrite updates its existing entry in place so retained
      // rendered-node ownership cannot be lost.
      component.resetRender()
      let indexedProgress = line(20, "progress pending")
      getLineIndex().append(indexedProgress)
      let progressEntry = getLineIndex().lookupByStoredLineIndex(20)
      if (!progressEntry) {
        throw new Error("expected progress entry")
      }
      let progressElement = document.createElement("span")
      progressEntry.el = progressElement
      let completedProgress = line(20, "progress complete")
      getLineIndex().append(completedProgress)
      expect(getLineIndex().lookupByStoredLineIndex(20)).toBe(progressEntry)
      expect(progressEntry.line).toBe(completedProgress)
      expect(progressEntry.el).toBe(progressElement)

      // A patch can arrive with a previously unseen interior identity and
      // must insert it ahead of a retained newer line rather than append it.
      component.resetRender()
      getLineIndex().append(line(20, "retained progress"))
      getLineIndex().append(line(30, "newer line"))
      getLineIndex().append(line(25, "late interior line"))
      expect(
        getLineIndex()
          .lines()
          .map((line) => line.storedLineIndex)
      ).toEqual([20, 25, 30])
    })

    it("keeps full-history identity indexing near-linear and hydrated tail appends bounded", () => {
      const historySizes = [1021, 2039, 4093]
      // Each AVL level needs at most one descent and one rebalance check in
      // each ordered-index phase; the fixed allowance covers hydration's
      // rendered-tail anchor validation rather than scaling with history.
      const orderedIndexReadsPerLevel = 4
      const hydrationFixedReadAllowance = 20

      for (let historySize of historySizes) {
        let logStore = new LogStore()
        appendLines(
          logStore,
          "fe",
          Array.from({ length: historySize }, (_, i) => `history ${i}\n`)
        )
        let storedLineIndexReads = trackStoredLineIndexReads()
        storedLineIndexReads.add(logStore.manifestLogPatchSet("fe", 0).lines)
        let { localComponent } = renderLogStore(logStore)

        storedLineIndexReads.reset()
        localComponent.scrollTop = 1
        localComponent.rootRef.current.scrollTop = 0
        localComponent.onScroll()
        let hydrationReads = storedLineIndexReads.readCount()

        // This includes every ordered-index probe plus the one complete
        // rendered-tail anchor lookup. The logarithmic term keeps the bound
        // structural: a head scan violates it at every larger history size.
        let maxHydrationReads =
          historySize *
          (orderedIndexReadsPerLevel * Math.ceil(Math.log2(historySize)) +
            hydrationFixedReadAllowance)
        expect(hydrationReads).toBeLessThanOrEqual(maxHydrationReads)

        appendLines(logStore, "fe", "hydrated tail\n")
        storedLineIndexReads.add(logStore.manifestLogPatchSet("fe", 0).lines)
        storedLineIndexReads.reset()
        localComponent.onLogUpdate({ action: LogUpdateAction.append })
        jest.advanceTimersByTime(liveLogReadIntervalMs)

        // A live tail update may probe the ordered index logarithmically, but
        // it must never reread every identity from the hydrated history.
        let maxTailAppendReads =
          orderedIndexReadsPerLevel * Math.ceil(Math.log2(historySize)) +
          hydrationFixedReadAllowance
        expect(storedLineIndexReads.readCount()).toBeLessThanOrEqual(
          maxTailAppendReads
        )
      }
    })

    it("keeps retained compact tail nodes selected and focused", () => {
      let lines = Array.from({ length: 100 }, (_, i) => `line ${i}\n`)
      lines[90] = "retained https://tilt.dev/\n"
      let {
        localComponent,
        localRaf,
        logStore,
        container: localContainer,
      } = renderStoreLines(lines)
      // Selection is a document-owned browser state, so attach this imperative
      // renderer before asserting that a retained node preserves it.
      document.body.appendChild(localContainer)
      let retainedOuter = localContainer.querySelector<HTMLSpanElement>(
        '[data-sl-index="90"]'
      )
      let evictedOuter = localContainer.querySelector<HTMLSpanElement>(
        '[data-sl-index="36"]'
      )
      let retainedCode = retainedOuter?.querySelector<HTMLElement>(
        ":scope > code.LogLine-content"
      )
      let retainedLink = retainedCode?.querySelector<HTMLAnchorElement>("a")
      let retainedText = retainedLink?.firstChild
      if (
        !retainedOuter ||
        !evictedOuter ||
        !retainedCode ||
        !retainedLink ||
        !retainedText
      ) {
        throw new Error(
          "expected the compact tail fixture to render its retained link"
        )
      }

      retainedLink.focus()
      let range = document.createRange()
      range.selectNodeContents(retainedText)
      let selection = document.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      expect(selection?.toString()).toContain("tilt.dev")

      appendLines(logStore, "fe", "new tail line\n")
      localComponent.onLogUpdate({ action: LogUpdateAction.append })
      jest.advanceTimersByTime(liveLogReadIntervalMs)
      while (localComponent.renderBufferRafId) {
        localRaf.invoke(localComponent.renderBufferRafId)
      }

      let retainedAfter = localContainer.querySelector('[data-sl-index="90"]')
      expect(retainedAfter).toBe(retainedOuter)
      expect(retainedAfter?.querySelector("code.LogLine-content")).toBe(
        retainedCode
      )
      expect(retainedLink.firstChild).toBe(retainedText)
      expect(document.activeElement).toBe(retainedLink)
      expect(document.getSelection()?.toString()).toContain("tilt.dev")
      // The outer may immediately be recycled for the new tail line, but the
      // evicted stored-line identity itself must no longer be attached.
      expect(localContainer.querySelector('[data-sl-index="36"]')).toBeNull()
      expect(evictedOuter).not.toHaveAttribute("data-sl-index", "36")
      expect(
        localContainer.querySelector('[data-sl-index="100"]')
      ).toHaveTextContent("new tail line")
      localContainer.remove()
    })

    it("bounds live log rendering while keeping the current tail", () => {
      renderAllScheduledFrames()
      appendIncrementalLines(4 * renderWindow)
      renderAllScheduledFrames()

      const logElements = getLogElements(container)
      expect(logElements.length).toBeLessThanOrEqual(renderedLineLimit)
      expect(logElements[0]).toHaveTextContent("incremental line 936")
      expect(logElements[logElements.length - 1]).toHaveTextContent(
        "incremental line 999"
      )
    })

    it("coalesces a pinned live tail to viewport-sized context", () => {
      renderAllScheduledFrames()
      appendIncrementalLines(4 * renderWindow)
      renderAllScheduledFrames()

      const logElements = getLogElements(container)
      expect(logElements).toHaveLength(tailLineLimit)
      expect(logElements[0]).toHaveTextContent("incremental line 936")
      expect(logElements[logElements.length - 1]).toHaveTextContent(
        "incremental line 999"
      )
    })

    it("keeps pinned follow state bounded across live tail intervals", () => {
      renderAllScheduledFrames()
      appendIncrementalLines(4 * renderWindow)
      renderAllScheduledFrames()

      expect(component.forwardBuffer).toHaveLength(0)
      expect(component.backwardBuffer).toHaveLength(0)
      expect(indexedLineCount()).toBeLessThanOrEqual(tailLineLimit + 1)
      expect(getLogElements(container)).toHaveLength(tailLineLimit)

      appendIncrementalLines(4 * renderWindow)
      renderAllScheduledFrames()

      expect(component.forwardBuffer).toHaveLength(0)
      expect(component.backwardBuffer).toHaveLength(0)
      expect(indexedLineCount()).toBeLessThanOrEqual(tailLineLimit + 1)
      expect(getLogElements(container)).toHaveLength(tailLineLimit)
      expect(getLogElements(container)[tailLineLimit - 1]).toHaveTextContent(
        "incremental line 999"
      )
    })

    it("hydrates complete history only at the upward boundary", () => {
      renderAllScheduledFrames()
      appendIncrementalLines(4 * renderWindow)
      renderAllScheduledFrames()
      let readSpy = jest.spyOn(component.props.logStore, "manifestLogPatchSet")

      // A compact tail can fit without overflowing its owner, leaving both
      // cached and live positions at the upper boundary. Native upward wheel
      // intent must still enter history even though it cannot produce scroll.
      component.scrollTop = 0
      component.rootRef.current.scrollTop = 0
      component.rootRef.current.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -1 })
      )
      renderAllScheduledFrames()

      expect(readSpy).toHaveBeenCalledTimes(1)
      expect(readSpy).toHaveBeenCalledWith("fe", 0)
      expect(component.backwardBuffer.length).toBeGreaterThan(0)
      expect(getLogElements(container)).toHaveLength(
        tailLineLimit + renderWindow
      )
      expect(indexedLineCount()).toBeGreaterThan(renderedLineLimit)

      // Continue requesting older windows until the store's earliest retained
      // line is reachable. The DOM stays virtualized while the history index
      // supplies the complete traversal.
      while (component.backwardBuffer.length) {
        component.scrollTop = 1
        component.rootRef.current.scrollTop = 0
        component.onScroll()
        renderAllScheduledFrames()
      }
      expect(getLogElements(container)[0]).toHaveTextContent("line 0")
      expect(getLogElements(container).length).toBeLessThanOrEqual(
        renderedLineLimit
      )

      // Deliberate traversal may use the larger window, but its tail remains
      // recoverable after live checkpoints arrive without moving this view.
      const historyWindow = Array.from(getLogElements(container)).map((el) =>
        el.getAttribute("data-sl-index")
      )
      appendLines(component.props.logStore, "fe", "history checkpoint line\n")
      component.onLogUpdate({ action: LogUpdateAction.append })
      jest.advanceTimersByTime(liveLogReadIntervalMs)
      expect(
        Array.from(getLogElements(container)).map((el) =>
          el.getAttribute("data-sl-index")
        )
      ).toEqual(historyWindow)

      component.scrollTop = 0
      component.rootRef.current.scrollTop = 1000
      component.onScroll()
      fakeRaf.invoke(component.autoscrollRafId as number)
      renderAllScheduledFrames()

      expect(getLogElements(container)).toHaveLength(tailLineLimit)
      expect(component.forwardBuffer).toHaveLength(0)
      expect(component.backwardBuffer).toHaveLength(0)
      expect(getLogElements(container)[tailLineLimit - 1]).toHaveTextContent(
        "history checkpoint line"
      )
    })

    it("holds short-tail checkpoints after horizontal reader movement", () => {
      let {
        localComponent,
        logStore,
        container: localContainer,
      } = renderStoreLines(["short tail first\n", "short tail second\n"])
      let root = localComponent.rootRef.current as HTMLElement
      let scrollCursorIntoViewSpy = jest.spyOn(
        localComponent,
        "scrollCursorIntoView"
      )

      // Horizontal reader movement is distinct from a wheel history request:
      // even without older lines, it must preserve the reader's position by
      // leaving follow mode before the next checkpoint arrives.
      root.scrollTop = 0
      root.scrollLeft = 24
      root.dispatchEvent(new Event("scroll"))
      expect(localComponent.autoscroll).toBe(false)

      appendLines(logStore, "fe", "held short-tail checkpoint\n")
      localComponent.onLogUpdate({ action: LogUpdateAction.append })
      jest.advanceTimersByTime(liveLogReadIntervalMs)

      expect(localComponent.forwardBuffer).toHaveLength(1)
      expect(localContainer).not.toHaveTextContent("held short-tail checkpoint")
      expect(scrollCursorIntoViewSpy).not.toHaveBeenCalled()
      expect(root.scrollLeft).toBe(24)
    })

    it("keeps following after an upward wheel at a short tail with no history", () => {
      let {
        localComponent,
        localRaf,
        logStore,
        container: localContainer,
      } = renderStoreLines(["short tail first\n", "short tail second\n"])
      let root = localComponent.rootRef.current as HTMLElement

      // A short tail cannot scroll downward to recover follow mode. An upward
      // wheel still probes history, but with no older line it must remain
      // pinned so the next live checkpoint can reach the DOM.
      root.scrollTop = 0
      root.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }))
      expect(localComponent.autoscroll).toBe(true)

      appendLines(logStore, "fe", "short tail live checkpoint\n")
      localComponent.onLogUpdate({ action: LogUpdateAction.append })
      jest.advanceTimersByTime(liveLogReadIntervalMs)
      while (localComponent.renderBufferRafId) {
        localRaf.invoke(localComponent.renderBufferRafId)
      }

      expect(localComponent.forwardBuffer).toHaveLength(0)
      expect(
        localContainer.querySelector(".LogLine:last-of-type")
      ).toHaveTextContent("short tail live checkpoint")

      // Repeated upward intent remains a no-op rather than stranding follow
      // mode after the hydrated short tail has compacted again.
      root.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }))
      expect(localComponent.autoscroll).toBe(true)
    })

    it("removes its wheel listener on unmount", () => {
      const root = component.rootRef.current as HTMLElement
      const removeListenerSpy = jest.spyOn(root, "removeEventListener")

      component.componentWillUnmount()

      expect(removeListenerSpy).toHaveBeenCalledWith("wheel", component.onWheel)
    })

    it("does not leave follow mode on a sub-hysteresis upward flick", () => {
      renderAllScheduledFrames()
      expect(component.autoscroll).toBe(true)
      const root = component.rootRef.current as HTMLElement
      component.scrollTop = 100
      root.scrollTop = 100 - (leaveFollowHysteresisPx - 1)
      component.onScroll()
      expect(component.autoscroll).toBe(true)
    })

    it("pages forward and rejoins live tail after a history excursion", () => {
      renderAllScheduledFrames()
      appendIncrementalLines(4 * renderWindow)
      renderAllScheduledFrames()

      for (let i = 0; i < 3; i++) {
        component.scrollTop = 1
        component.rootRef.current.scrollTop = 0
        component.onScroll()
        renderAllScheduledFrames()
      }
      expect(component.autoscroll).toBe(false)
      // History walks leave newer lines off-DOM in the forward buffer.
      expect(component.forwardBuffer.length).toBeGreaterThan(0)

      // Live lines that arrive while reading history stay buffered until rejoin.
      appendIncrementalLines(30)
      expect(component.forwardBuffer.length).toBeGreaterThan(30)

      const root = component.rootRef.current as HTMLElement
      Object.defineProperty(root, "clientHeight", {
        configurable: true,
        value: 400,
      })
      Object.defineProperty(root, "scrollHeight", {
        configurable: true,
        value: 2000,
      })
      // Near the bottom edge of the current rendered window.
      component.scrollTop = 1000
      root.scrollTop = 2000 - 400 - 10
      component.onScroll()
      if (component.autoscrollRafId) {
        fakeRaf.invoke(component.autoscrollRafId as number)
      }
      renderAllScheduledFrames()

      expect(component.autoscroll).toBe(true)
      let logElements = getLogElements(container)
      expect(logElements.length).toBeLessThanOrEqual(renderedLineLimit)
      // Second append reuses "incremental line N" labels from zero; the live
      // store tail is the last of that batch (N = 29).
      expect(logElements[logElements.length - 1]).toHaveTextContent(
        "incremental line 29"
      )
      expect(
        container.querySelector<HTMLElement>(".logEnd")?.style.visibility
      ).toBe("")
    })

    it("engageLiveTail forces follow and restores the live cursor", () => {
      renderAllScheduledFrames()
      appendIncrementalLines(2 * renderWindow)
      renderAllScheduledFrames()

      // Leave follow via a deliberate upward scroll (hysteresis satisfied).
      component.scrollTop = 100
      component.rootRef.current.scrollTop = 50
      component.onScroll()
      expect(component.autoscroll).toBe(false)
      const liveBefore = container.querySelector<HTMLButtonElement>(
        '[aria-label="Jump to live logs"]'
      )
      expect(liveBefore?.hidden).toBe(false)

      // Parent re-renders (HUD view stream) must not re-hide Live while still
      // disengaged — visibility is imperative and restored on didUpdate.
      component.forceUpdate()
      expect(
        container.querySelector<HTMLButtonElement>(
          '[aria-label="Jump to live logs"]'
        )?.hidden
      ).toBe(false)

      // Buffered live growth while disengaged (does not auto-render).
      appendIncrementalLines(40)
      expect(component.forwardBuffer.length).toBeGreaterThan(0)

      component.engageLiveTail()
      renderAllScheduledFrames()

      expect(component.autoscroll).toBe(true)
      let logElements = getLogElements(container)
      expect(logElements.length).toBeLessThanOrEqual(renderedLineLimit)
      // Labels restart at 0 per appendIncrementalLines batch; live tail is 39.
      expect(logElements[logElements.length - 1]).toHaveTextContent(
        "incremental line 39"
      )
      const live = container.querySelector<HTMLButtonElement>(
        '[aria-label="Jump to live logs"]'
      )
      expect(live).not.toBeNull()
      expect(live?.hidden).toBe(true)
    })

    it("keeps peak rendered lines within the 750 cap after return-to-tail", () => {
      renderAllScheduledFrames()
      appendIncrementalLines(6 * renderWindow)
      renderAllScheduledFrames()
      for (let i = 0; i < 5; i++) {
        component.scrollTop = 1
        component.rootRef.current.scrollTop = 0
        component.onScroll()
        renderAllScheduledFrames()
        expect(getLogElements(container).length).toBeLessThanOrEqual(
          renderedLineLimit
        )
      }
      component.engageLiveTail()
      renderAllScheduledFrames()
      expect(getLogElements(container).length).toBeLessThanOrEqual(
        renderedLineLimit
      )
    })

    it("moves the bounded window into history and back to the tail", () => {
      renderAllScheduledFrames()
      appendIncrementalLines(4 * renderWindow)
      renderAllScheduledFrames()

      // A user scroll to the top must replace the newest window with the next
      // older chunk instead of growing the live DOM.
      for (let i = 0; i < 3; i++) {
        component.scrollTop = 1
        component.rootRef.current.scrollTop = 0
        component.onScroll()
        renderAllScheduledFrames()
      }

      let logElements = getLogElements(container)
      expect(logElements.length).toBeLessThanOrEqual(renderedLineLimit)
      expect(logElements[0]).toHaveTextContent("incremental line 186")
      expect(logElements[logElements.length - 1]).toHaveTextContent(
        "incremental line 935"
      )
      expect(
        container.querySelector<HTMLElement>(".logEnd")?.style.visibility
      ).toBe("hidden")

      // Returning to the bottom must refill all newer chunks and restore the
      // current tail without materializing the full store history.
      component.scrollTop = 0
      component.rootRef.current.scrollTop = 1000
      component.onScroll()
      fakeRaf.invoke(component.autoscrollRafId as number)
      renderAllScheduledFrames()

      logElements = getLogElements(container)
      expect(logElements.length).toBeLessThanOrEqual(renderedLineLimit)
      expect(logElements[0]).toHaveTextContent("incremental line 936")
      expect(logElements[logElements.length - 1]).toHaveTextContent(
        "incremental line 999"
      )
      expect(
        container.querySelector<HTMLElement>(".logEnd")?.style.visibility
      ).toBe("")
    })

    it("keeps following after its cursor scroll, while later user scrolls still load history", () => {
      renderAllScheduledFrames()
      appendIncrementalLines(4 * renderWindow)
      renderAllScheduledFrames()

      // Deliberately walk into history so the return-to-tail render has a
      // substantial forward buffer and an older window to request later.
      for (let i = 0; i < 3; i++) {
        component.scrollTop = 1
        component.rootRef.current.scrollTop = 0
        component.onScroll()
        renderAllScheduledFrames()
      }

      const root = component.rootRef.current as HTMLElement
      const cursor = container.querySelector<HTMLElement>(".logEnd")
      if (!cursor) {
        throw new Error("expected the log tail cursor to be rendered")
      }

      // Chromium dispatches a scroll event after scrollIntoView moves the
      // owner. Model that browser-owned event with real element state.
      const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
        cursor,
        "scrollIntoView"
      )
      try {
        Object.defineProperty(cursor, "scrollIntoView", {
          configurable: true,
          value: () => {
            root.scrollTop = 523
          },
        })

        component.scrollTop = 0
        root.scrollTop = 13900
        root.dispatchEvent(new Event("scroll"))
        fakeRaf.invoke(component.autoscrollRafId as number)
        fakeRaf.invoke(component.renderBufferRafId as number)

        root.dispatchEvent(new Event("scroll"))
        expect(component.autoscroll).toBe(true)

        appendLines(component.props.logStore, "fe", "tail after return\n")
        component.onLogUpdate({ action: LogUpdateAction.append })
        jest.advanceTimersByTime(liveLogReadIntervalMs)
        renderAllScheduledFrames()
        expect(getLogElements(container)).toHaveLength(tailLineLimit)
        expect(getLogElements(container)[tailLineLimit - 1]).toHaveTextContent(
          "tail after return"
        )

        // A later user scroll is still authoritative: moving up away from the
        // DOM boundary disengages follow mode without requesting history.
        root.scrollTop = 100
        root.dispatchEvent(new Event("scroll"))
        expect(component.autoscroll).toBe(false)
        expect(component.renderBufferRafId).toBe(0)

        // Reaching the boundary requests exactly one older history window.
        root.scrollTop = 0
        root.dispatchEvent(new Event("scroll"))
        expect(component.renderBufferRafId).toBeGreaterThan(0)
      } finally {
        if (scrollIntoViewDescriptor) {
          Object.defineProperty(
            cursor,
            "scrollIntoView",
            scrollIntoViewDescriptor
          )
        } else {
          delete (cursor as { scrollIntoView?: unknown }).scrollIntoView
        }
      }
    })
  })
})
