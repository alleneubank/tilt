import React, { Component } from "react"
import { useNavigate, useLocation } from "react-router-dom"
import styled, { keyframes } from "styled-components"
import {
  FilterLevel,
  FilterSet,
  FilterSource,
  TermState,
  filterSetsEqual,
} from "./logfilters"
import "./LogLine.scss"
import "./LogPane.scss"
import LogStore, {
  LogUpdateAction,
  LogUpdateEvent,
  useLogStore,
} from "./LogStore"
import { DISPLAY_LOG_PROLOGUE_LENGTH, LogDisplay } from "./logs"
import PathBuilder, { usePathBuilder } from "./PathBuilder"
import { RafContext, useRaf } from "./raf"
import { useStarredResources } from "./StarredResourcesContext"
import { Color, FontSize, SizeUnit } from "./style-helpers"
import Anser from "./third-party/anser/index.js"
import { LogLine, ResourceName } from "./types"

// The number of lines to display before an error.
export const PROLOGUE_LENGTH = DISPLAY_LOG_PROLOGUE_LENGTH

type OverviewLogComponentProps = {
  manifestName: string
  pathBuilder: PathBuilder
  logStore: LogStore
  raf: RafContext
  filterSet: FilterSet
  navigate: ReturnType<typeof useNavigate>
  scrollToStoredLineIndex: number | null
  starredResources: string[]
}

let LogPaneRoot = styled.section`
  padding: 0 0 ${SizeUnit(0.25)} 0;
  background-color: ${Color.gray10};
  width: 100%;
  height: 100%;
  overflow-y: auto;
  box-sizing: border-box;
  font-size: ${FontSize.smallest};
`

const blink = keyframes`
0% {
  opacity: 1;
}
50% {
  opacity: 0;
}
100% {
  opacity: 1;
}
`

let LogEnd = styled.div`
  animation: ${blink} 1s infinite;
  animation-timing-function: ease;
  padding-top: ${SizeUnit(0.25)};
  padding-left: ${SizeUnit(0.625)};
  font-size: var(--log-font-scale);
`

let anser = new Anser()

function reusableLineContent(
  lineEl: HTMLSpanElement,
  ownedContents: WeakSet<HTMLElement>
): HTMLElement | null {
  for (let child of Array.from(lineEl.children)) {
    const content = child as HTMLElement
    if (
      child.tagName === "CODE" &&
      child.classList.contains("LogLine-content") &&
      ownedContents.has(content)
    ) {
      return content
    }
  }
  return null
}

function updateLineContent(code: HTMLElement, text: string) {
  // Compare Anser's escaped representation, not raw log text. User-supplied
  // angle brackets and quotes are plain content, but must never be treated as
  // a signal that assigning raw text would preserve a markup representation.
  const plainText = text + "\n"
  const escapedText = anser.escapeForHtml(plainText)
  const renderedText = anser.linkify(
    anser.ansiToHtml(escapedText, {
      // Let anser colorize the html as it appears from various consoles.
      use_classes: false,
    })
  )

  if (renderedText === escapedText) {
    const existingText = code.firstChild
    if (code.childNodes.length === 1 && existingText instanceof Text) {
      existingText.data = plainText
    } else {
      code.replaceChildren(document.createTextNode(plainText))
    }
    return
  }

  // Anser receives escaped source text above, so its ANSI/link rendering is
  // safe to install while still replacing stale decorated descendants.
  code.innerHTML = renderedText
}

function newLineEl(
  line: LogLine,
  showManifestPrefix: boolean,
  extraClasses: string[],
  ownedContents: WeakSet<HTMLElement>,
  lineEl: HTMLSpanElement = document.createElement("span")
): HTMLSpanElement {
  let text = line.text
  let level = line.level
  let buildEvent = line.buildEvent
  let classes = ["LogLine"]
  classes.push(...extraClasses)
  if (level === "WARN") {
    classes.push("is-warning")
  } else if (level === "ERROR") {
    classes.push("is-error")
  }
  if (buildEvent === "init") {
    classes.push("is-buildEvent")
    classes.push("is-buildEvent-init")

    if (showManifestPrefix) {
      // For build event lines, we put the manifest name is a suffix
      // rather than a prefix, because it looks nicer.
      text += ` • ${line.manifestName}`
    } else {
      // If we're viewing a single resource, we should make the build event log
      // lines sticky, so that we always know context of the current logs.
      classes.push("is-sticky")
    }
  }
  if (buildEvent === "fallback") {
    classes.push("is-buildEvent")
    classes.push("is-buildEvent-fallback")
  }

  // Retain only a direct code child created by this component. A recycled
  // outer element otherwise drops its former prefix, alert-button handlers,
  // and any child from another root before it receives this logical line.
  let code = reusableLineContent(lineEl, ownedContents)
  if (!code) {
    code = document.createElement("code")
    code.classList.add("LogLine-content")
    ownedContents.add(code)
  }
  lineEl.replaceChildren(code)
  lineEl.setAttribute("data-sl-index", String(line.storedLineIndex))
  lineEl.className = classes.join(" ")

  if (showManifestPrefix && buildEvent !== "init") {
    let prefix = document.createElement("span")
    let name = line.manifestName
    if (!name) {
      name = "(global)"
    }
    prefix.title = name
    prefix.className = "logLinePrefix"
    prefix.innerHTML = anser.escapeForHtml(name)
    lineEl.insertBefore(prefix, code)
  }

  // A newline ensures this takes up at least one line.
  updateLineContent(code, text)
  return lineEl
}

// An index of lines such that lets us find:
// - The next line
// - The previous line
// - The line by stored line index.
type LineHashListEntry = {
  prev?: LineHashListEntry | null
  next?: LineHashListEntry | null
  line: LogLine
  el?: HTMLSpanElement
}

type OrderedLineIndexNode = {
  storedLineIndex: number
  entry: LineHashListEntry
  height: number
  left: OrderedLineIndexNode | null
  right: OrderedLineIndexNode | null
}

class LineHashList {
  private first: LineHashListEntry | null = null
  private last: LineHashListEntry | null = null
  private byStoredLineIndex: { [key: number]: LineHashListEntry } = {}
  // The linked list owns iteration and DOM entry identity. This AVL tree only
  // finds a new identity's neighbors, giving deterministic O(log n) inserts
  // for history hydration and out-of-order checkpoint patches.
  private orderedIndex: OrderedLineIndexNode | null = null

  lookup(line: LogLine): LineHashListEntry | null {
    return this.byStoredLineIndex[line.storedLineIndex]
  }

  lookupByStoredLineIndex(storedLineIndex: number): LineHashListEntry | null {
    return this.byStoredLineIndex[storedLineIndex]
  }

  append(line: LogLine) {
    let storedLineIndex = line.storedLineIndex
    let existing = this.byStoredLineIndex[storedLineIndex]
    if (existing) {
      existing.line = line
      return
    }

    // Checkpoint patches can revise an old progress line after newer lines
    // have already arrived. Logical line order belongs to LogStore identity,
    // never patch arrival order.
    let before: LineHashListEntry | null = null
    let previous: LineHashListEntry | null = null
    let indexNode = this.orderedIndex
    while (indexNode) {
      if (storedLineIndex < indexNode.storedLineIndex) {
        before = indexNode.entry
        indexNode = indexNode.left
      } else {
        previous = indexNode.entry
        indexNode = indexNode.right
      }
    }

    let newEntry: LineHashListEntry = { prev: previous, next: before, line }
    this.byStoredLineIndex[storedLineIndex] = newEntry
    this.orderedIndex = this.insertOrderedIndexNode(this.orderedIndex, {
      storedLineIndex,
      entry: newEntry,
      height: 1,
      left: null,
      right: null,
    })
    if (previous) {
      previous.next = newEntry
    } else {
      this.first = newEntry
    }
    if (before) {
      before.prev = newEntry
    } else {
      this.last = newEntry
    }
  }

  private orderedIndexHeight(node: OrderedLineIndexNode | null): number {
    return node ? node.height : 0
  }

  private updateOrderedIndexHeight(node: OrderedLineIndexNode) {
    node.height =
      Math.max(
        this.orderedIndexHeight(node.left),
        this.orderedIndexHeight(node.right)
      ) + 1
  }

  private rotateOrderedIndexLeft(
    node: OrderedLineIndexNode
  ): OrderedLineIndexNode {
    let right = node.right
    if (!right) {
      throw new Error(
        "Cannot rotate an ordered line index without a right child"
      )
    }
    node.right = right.left
    right.left = node
    this.updateOrderedIndexHeight(node)
    this.updateOrderedIndexHeight(right)
    return right
  }

  private rotateOrderedIndexRight(
    node: OrderedLineIndexNode
  ): OrderedLineIndexNode {
    let left = node.left
    if (!left) {
      throw new Error(
        "Cannot rotate an ordered line index without a left child"
      )
    }
    node.left = left.right
    left.right = node
    this.updateOrderedIndexHeight(node)
    this.updateOrderedIndexHeight(left)
    return left
  }

  private rebalanceOrderedIndexNode(
    node: OrderedLineIndexNode
  ): OrderedLineIndexNode {
    this.updateOrderedIndexHeight(node)
    let balance =
      this.orderedIndexHeight(node.left) - this.orderedIndexHeight(node.right)

    if (balance > 1) {
      if (
        node.left &&
        this.orderedIndexHeight(node.left.left) <
          this.orderedIndexHeight(node.left.right)
      ) {
        node.left = this.rotateOrderedIndexLeft(node.left)
      }
      return this.rotateOrderedIndexRight(node)
    }
    if (balance < -1) {
      if (
        node.right &&
        this.orderedIndexHeight(node.right.right) <
          this.orderedIndexHeight(node.right.left)
      ) {
        node.right = this.rotateOrderedIndexRight(node.right)
      }
      return this.rotateOrderedIndexLeft(node)
    }
    return node
  }

  private insertOrderedIndexNode(
    node: OrderedLineIndexNode | null,
    insertedNode: OrderedLineIndexNode
  ): OrderedLineIndexNode {
    if (!node) {
      return insertedNode
    }
    if (insertedNode.storedLineIndex < node.storedLineIndex) {
      node.left = this.insertOrderedIndexNode(node.left, insertedNode)
    } else {
      node.right = this.insertOrderedIndexNode(node.right, insertedNode)
    }
    return this.rebalanceOrderedIndexNode(node)
  }

  lines(): LogLine[] {
    let result: LogLine[] = []
    let entry = this.first
    while (entry) {
      result.push(entry.line)
      entry = entry.next || null
    }
    return result
  }
}

// The number of lines to render at a time.
export const renderWindow = 250

// Keep enough surrounding context for smooth scrolling without allowing the
// raw log DOM to grow with the full store-held history.
export const renderedLineLimit = 3 * renderWindow

// A 900px pane displays fewer than 100 lines at the smallest supported log
// font. Follow mode keeps that viewport plus overscan instead of paying to
// render the larger history window on every update.
export const tailLineLimit = 64

// A pinned tail can only expose its newest window. Coalesce busy store
// notifications for at most one second so intermediate chunks are retained in
// history without being materialized only to be evicted before a user sees
// them. The bound keeps the latest tail line visibly fresh.
export const liveLogReadIntervalMs = 1000

// How much taller than the viewport the follow-mode tail is kept. Below ~1.2 the
// tail lands flush against the pane and cursor/padding rounding reopens a sliver
// of blank space; well above it spends DOM and burst work with nothing visible
// to show for it.
export const followTailOverscan = 1.25

// Slack (px) when deciding whether the rendered content overflows the viewport.
// Below this, the pane is treated as underfilled and reclaims older history.
export const viewportFillEpsilon = 4

// Guard bound on consecutive geometry-driven fill passes. History drains into
// the rendered window in at most renderedLineLimit / renderWindow steps; this
// is a safety ceiling, not an expected count.
export const maxViewportFillPasses = 8

type RenderDirection = "forward" | "backward"

// The same top geometry has two different meanings: reader movement leaves
// follow mode after its anchor is valid, while upward wheel intent only asks
// whether another history window exists.
type TopBoundaryIntent = "reader-movement" | "history-request"

type VisibleAnchor = {
  el: HTMLSpanElement
  offset: number
}

// React is not a great system for rendering logs.
// React has to build a virtual DOM, diffs the virtual DOM, and does
// spot updates of the actual DOM.
//
// But logs are append-only, so this wastes a lot of CPU doing diffs
// for things that never change. Other components (like xtermjs) manage
// rendering directly, but have a thin React wrapper to mount the component.
// So we use that rendering strategy here.
//
// This means that we can't use other react components (like styled-components)
// and have to use plain css + HTML.
export class OverviewLogComponent extends Component<OverviewLogComponentProps> {
  autoscroll: boolean = true
  needsScrollToLine: boolean = false

  // The element containing all the log lines.
  rootRef: React.RefObject<any> = React.createRef()

  // The blinking cursor at the end of the component.
  private cursorRef: React.RefObject<HTMLParagraphElement> = React.createRef()

  // Track the scrollTop of the root element to see if the user is scrolling upwards.
  scrollTop: number = -1

  // Timer for tracking autoscroll.
  autoscrollRafId: number | null = null

  // Timer for tracking render
  renderBufferRafId: number | null = null

  // Timer for coalescing rapid LogStore update notifications.
  logReadTimerId: number | null = null

  // Observers that detect a geometry change which shrinks the rendered content
  // below the viewport without emitting a scroll event: window resize (root
  // box) and log-font-scale change (per-line height, set on <html>).
  private viewportResizeObserver: ResizeObserver | null = null
  private fontScaleObserver: MutationObserver | null = null
  private viewportFillRafId: number | null = null
  private viewportFillPasses: number = 0

  // Set when a geometry refill is requested while a render is already pending;
  // renderBuffer re-schedules the check on completion so the request is never
  // lost to the race.
  private viewportFillDeferred: boolean = false

  // Remaining rendered-line capacity for an in-flight geometry refill, or null
  // when the pending render is ordinary traversal. A refill exists to cover
  // freed space, so it must never evict — makeRoomFor would drop the opposite
  // edge, which for a disengaged reader can be the lines they are looking at.
  // Bounding the batch by real capacity lets a partial fill use every safe slot
  // instead of refusing the whole batch and stranding the reader
  // (REQ-LOGPANE-005).
  private viewportFillBudget: number | null = null

  // The direction the budget above was computed for. A scroll or wheel landing
  // before the scheduled frame runs can retarget renderDirection, and a capacity
  // measured for a refill says nothing about the deliberate traversal that
  // replaced it — honouring it there would silently shorten the reader's window.
  private viewportFillDirection: RenderDirection | null = null

  // How many lines the follow-mode tail must hold to cover the viewport at the
  // current font scale. Captured once per render and then held, because the
  // compact-retention and live-read paths run outside a render and must size
  // themselves by the same number — a tail read that never supplies the lines
  // the target wants can never render them. Starts at the floor so the value is
  // defined before the first render measures anything.
  private tailLimitSnapshot: number = tailLineLimit

  // Stable handler for the window-resize fallback used when ResizeObserver is
  // unavailable; a field so removeEventListener matches the same reference.
  private onViewportResize = () => this.scheduleViewportFill()

  // Lines to render at the end of the pane.
  forwardBuffer: LogLine[] = []

  // Lines to render at the start of the pane.
  backwardBuffer: LogLine[] = []

  // A render request moves the bounded window in one direction. Keeping this
  // explicit prevents live tail updates from draining history while the user
  // is reading an older window.
  private renderDirection: RenderDirection | null = null

  private logCheckpoint: number = 0

  // Compact follow mode owns only its visible tail. The first deliberate
  // upward-boundary gesture promotes that tail to a full store-backed index;
  // returning to the true tail compacts it again.
  private historyHydrated: boolean = false

  private lineHashList: LineHashList = new LineHashList()

  // Detached nodes are retained only long enough to fill this component's
  // bounded rendered window. They are cleared on reset and unmount so log
  // history can never keep DOM nodes alive through the recycler.
  private recycledLineEls: HTMLSpanElement[] = []

  // Ownership is per pane so a recycled outer line can never adopt content
  // created by another pane or React root.
  private ownedLineContents = new WeakSet<HTMLElement>()

  private logDisplay: LogDisplay

  constructor(props: OverviewLogComponentProps) {
    super(props)

    this.logDisplay = new LogDisplay(props.filterSet)
    this.onScroll = this.onScroll.bind(this)
    this.onWheel = this.onWheel.bind(this)
    this.onLogUpdate = this.onLogUpdate.bind(this)
    this.renderBuffer = this.renderBuffer.bind(this)
  }

  scrollCursorIntoView() {
    let root = this.rootRef.current
    if (this.cursorRef.current?.scrollIntoView) {
      this.cursorRef.current.scrollIntoView()

      // scrollIntoView moves the scroll owner before its asynchronous browser
      // scroll event. Record that component-owned movement so the event is not
      // mistaken for a subsequent user scroll upward out of follow mode.
      if (root) {
        this.scrollTop = root.scrollTop
      }
    }
  }

  onLogUpdate(e: LogUpdateEvent) {
    if (!this.rootRef.current || !this.cursorRef.current) {
      return
    }

    if (e.action === LogUpdateAction.truncate) {
      this.resetRender()
      this.readLogsFromLogStore()
      return
    }

    if (this.logReadTimerId === null) {
      this.logReadTimerId = window.setTimeout(() => {
        this.logReadTimerId = null
        this.readLogsFromLogStore()
      }, liveLogReadIntervalMs)
    }
  }

  componentDidUpdate(prevProps: OverviewLogComponentProps) {
    if (prevProps.logStore !== this.props.logStore) {
      prevProps.logStore.removeUpdateListener(this.onLogUpdate)
      this.props.logStore.addUpdateListener(this.onLogUpdate)
    }

    if (
      prevProps.manifestName !== this.props.manifestName ||
      !filterSetsEqual(prevProps.filterSet, this.props.filterSet)
    ) {
      this.resetRender()

      if (typeof this.props.scrollToStoredLineIndex === "number") {
        this.needsScrollToLine = true
      }
      this.autoscroll = !this.needsScrollToLine

      this.readLogsFromLogStore()
    } else if (prevProps.logStore !== this.props.logStore) {
      this.resetRender()
      this.readLogsFromLogStore()
    }
  }

  componentDidMount() {
    let rootEl = this.rootRef.current
    if (!rootEl) {
      return
    }

    if (typeof this.props.scrollToStoredLineIndex == "number") {
      this.needsScrollToLine = true
    }
    this.autoscroll = !this.needsScrollToLine

    rootEl.addEventListener("scroll", this.onScroll, {
      passive: true,
    })
    rootEl.addEventListener("wheel", this.onWheel, {
      passive: true,
    })
    this.observeViewportFillTriggers(rootEl)
    this.resetRender()
    this.readLogsFromLogStore()

    this.props.logStore.addUpdateListener(this.onLogUpdate)
  }

  // A font-scale change or window resize can leave a disengaged reader with a
  // rendered window shorter than the viewport. Such a pane no longer overflows,
  // so it cannot emit the scroll event that normally pulls older history — the
  // gap would persist until the next scroll/append. Observe both geometry
  // signals and reclaim the freed space directly.
  //
  // Known limitation: a content-only height change with neither a root resize
  // nor a --log-font-scale mutation (e.g. a progress line rewriting a tall
  // wrapped row into a short one) is not observed here. That shrink is rare and
  // self-heals on the next resize, font change, or appended line; catching it
  // would require observing mounted-line geometry on every render, a hot-path
  // cost not justified for the case.
  private observeViewportFillTriggers(rootEl: HTMLElement) {
    if (typeof ResizeObserver !== "undefined") {
      this.viewportResizeObserver = new ResizeObserver(() =>
        this.scheduleViewportFill()
      )
      this.viewportResizeObserver.observe(rootEl)
    } else {
      // ResizeObserver is unavailable on some declared targets (e.g. iOS
      // Safari 11). Window resize is coarser but still fires on viewport
      // changes, so the resize-underfill case keeps a working fallback.
      window.addEventListener("resize", this.onViewportResize)
    }
    // --log-font-scale lives on <html>; changing it resizes every log line but
    // not the pane box, so ResizeObserver on the root alone would miss it.
    if (typeof MutationObserver !== "undefined") {
      this.fontScaleObserver = new MutationObserver(() =>
        this.scheduleViewportFill()
      )
      this.fontScaleObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["style"],
      })
    }
  }

  // Coalesce geometry signals to one check per frame.
  private scheduleViewportFill() {
    if (this.viewportFillRafId) {
      return
    }
    this.viewportFillRafId = this.props.raf.requestAnimationFrame(() => {
      this.viewportFillRafId = null
      this.handleGeometryChange()
    })
  }

  // Reclaim unused viewport space after a geometry change (font scale / window
  // resize) that shrank the rendered window below the pane without emitting a
  // scroll event. Handles both follow mode (grow the pinned tail) and a
  // disengaged reader (fill toward the gap).
  // A font-scale or resize change invalidates the measured tail size, so
  // re-measure before deciding anything with it.
  //
  // Follow mode owns its tail through a checkpoint-zero compact snapshot, not
  // the refill path, and nothing else re-enters renderBuffer on a pure geometry
  // change while following. Left alone, the snapshot keeps whatever the last
  // render measured — at the previous font scale — and the next compaction
  // faithfully re-applies that stale, too-small tail, which is the
  // blank-viewport defect itself. Only a grown limit needs action: a shrunk one
  // costs nothing to leave rendered, and re-reading on every shrink would churn
  // the tail for no visible gain.
  private handleGeometryChange() {
    let previousTailLimit = this.tailLimitSnapshot
    this.retainMeasuredTailLimit()
    if (!this.autoscroll) {
      this.fillUnderfilledViewport()
      return
    }
    if (this.tailLimitSnapshot > previousTailLimit) {
      this.refreshCompactTailForGeometry()
    }
  }

  private fillUnderfilledViewport() {
    let root = this.rootRef.current
    // Follow mode is untouched: its live read/render path keeps the pinned tail
    // fresh, so only a disengaged reader is refilled here. An unmeasured pane
    // (detached / zero-height / jsdom) cannot be underfilled.
    if (!root || this.autoscroll || root.clientHeight <= 0) {
      return
    }
    // Never race a pending render: maybeScheduleRender would overwrite its
    // direction, dropping an explicit history-nav ("backward") request. Defer
    // instead of dropping, so renderBuffer re-runs this check on completion.
    if (this.renderBufferRafId) {
      this.viewportFillDeferred = true
      return
    }
    // The disengaged reader only ever gains history to close a gap; it keeps
    // the larger window for smooth traversal, so it is never shrunk here.
    if (root.scrollHeight > root.clientHeight + viewportFillEpsilon) {
      return
    }
    this.viewportFillPasses = 0
    // Hydration populates the history buffers, so the fillable increment is
    // only knowable after it runs — the cap check has to follow, not precede.
    if (!this.hydrateHistoryForDisengagement()) {
      return
    }
    let direction = this.underfillDirection()
    let capacity = this.underfillCapacity()
    if (!direction || capacity <= 0) {
      return
    }
    this.viewportFillBudget = capacity
    this.viewportFillDirection = direction
    this.maybeScheduleRender(direction)
  }

  // Slots left before the rendered window reaches its cap. A refill is bounded
  // by this rather than by the batch size: refusing a whole batch because it
  // would not fit entirely leaves the safe remainder unused and strands the
  // reader with a permanent gap.
  private underfillCapacity(): number {
    return Math.max(0, renderedLineLimit - this.renderedLineCount())
  }

  // Continuation of a geometry-driven refill, evaluated after each render:
  // the direction still worth filling, or null once the pane covers its
  // viewport, hits the rendered cap, exhausts history, or trips the pass
  // ceiling. The ceiling is a non-convergence guard, not an expected count.
  private continuedUnderfillDirection(
    root: HTMLElement
  ): RenderDirection | null {
    if (
      this.autoscroll ||
      root.clientHeight <= 0 ||
      root.scrollHeight > root.clientHeight + viewportFillEpsilon ||
      this.viewportFillPasses >= maxViewportFillPasses ||
      this.underfillCapacity() <= 0
    ) {
      return null
    }
    return this.underfillDirection()
  }

  // Fill toward the gap. Newer lines (forward) extend below the current window
  // to cover a bottom gap without shifting the anchored reader; older lines
  // (backward) cover a top gap. Prefer forward so a mid-history reader sees the
  // freed space fill with the lines that follow their position, not precede it.
  private underfillDirection(): RenderDirection | null {
    if (this.forwardBuffer.length) {
      return "forward"
    }
    if (this.backwardBuffer.length) {
      return "backward"
    }
    return null
  }

  componentWillUnmount() {
    this.props.logStore.removeUpdateListener(this.onLogUpdate)

    if (this.logReadTimerId !== null) {
      window.clearTimeout(this.logReadTimerId)
      this.logReadTimerId = null
    }

    let rootEl = this.rootRef.current
    if (!rootEl) {
      return
    }
    rootEl.removeEventListener("scroll", this.onScroll)
    rootEl.removeEventListener("wheel", this.onWheel)

    this.viewportResizeObserver?.disconnect()
    this.viewportResizeObserver = null
    this.fontScaleObserver?.disconnect()
    this.fontScaleObserver = null
    window.removeEventListener("resize", this.onViewportResize)
    if (this.viewportFillRafId) {
      this.props.raf.cancelAnimationFrame(this.viewportFillRafId)
      this.viewportFillRafId = null
    }

    if (this.autoscrollRafId) {
      this.props.raf.cancelAnimationFrame(this.autoscrollRafId)
    }

    if (this.renderBufferRafId) {
      this.props.raf.cancelAnimationFrame(this.renderBufferRafId)
    }

    this.recycledLineEls = []
  }

  onScroll() {
    let rootEl = this.rootRef.current
    if (!rootEl) {
      return
    }

    let scrollTop = rootEl.scrollTop
    let oldScrollTop = this.scrollTop
    let autoscroll = this.autoscroll

    this.scrollTop = scrollTop
    // If we're scrolled horizontally, cancel the autoscroll.
    if (rootEl.scrollLeft > 0) {
      if (this.autoscroll) {
        // A compact tail can fit entirely above the vertical boundary. In
        // that case horizontal motion leaves scrollTop unchanged at zero, so
        // hydrate its visible anchor before the unchanged-scroll exit.
        if (scrollTop === 0) {
          this.hydrateAndScheduleHistoryAtTopBoundary("reader-movement")
        } else {
          this.disengageFollowMode()
        }
      }

      // Horizontal reading must not suppress vertical history traversal.
      // Continue below so arrival at the upper boundary can mount the next
      // older window just as it does when the pane is horizontally aligned.
    }

    if (oldScrollTop === -1 || oldScrollTop === scrollTop) {
      return
    }

    // Upward movement disengages follow mode and, at the current DOM boundary,
    // requests exactly one older window.
    if (scrollTop < oldScrollTop) {
      // History is loaded one window at a time only when the user reaches the
      // current DOM boundary. The visible anchor is restored after prepending.
      if (scrollTop === 0) {
        this.hydrateAndScheduleHistoryAtTopBoundary("reader-movement")
      } else {
        this.disengageFollowMode()
      }
      return
    }

    // If we're not autoscrolling, and the user scrolled down,
    // we may have to re-engage the autoscroll.
    if (!autoscroll && scrollTop > oldScrollTop) {
      this.maybeEngageAutoscroll()
    }
  }

  onWheel(e: WheelEvent) {
    let rootEl = this.rootRef.current
    if (!rootEl || e.deltaY >= 0 || rootEl.scrollTop !== 0) {
      return
    }

    // An underfilled pane cannot emit a scroll event at its top boundary.
    // Wheel intent is the only signal that the reader wants older history.
    this.hydrateAndScheduleHistoryAtTopBoundary("history-request")
  }

  private disengageFollowMode(): boolean {
    if (!this.autoscroll) {
      return true
    }

    // A compact tail is first mounted on the next RAF. Until then (and in an
    // empty result) there is no DOM identity that can anchor a history window,
    // so leave follow mode untouched for a later deliberate gesture.
    if (!this.hydrateHistoryForDisengagement()) {
      return false
    }

    this.autoscroll = false
    return true
  }

  private hydrateAndScheduleHistoryAtTopBoundary(intent: TopBoundaryIntent) {
    if (this.autoscroll && !this.hydrateHistoryForDisengagement()) {
      return
    }

    let hasOlderHistory = this.backwardBuffer.length > 0
    if (intent === "history-request" && !hasOlderHistory) {
      // A short full tail cannot scroll back down to recover from a no-history
      // wheel probe, so retain follow mode and keep accepting live updates.
      return
    }

    // Reader movement is authoritative once its visible anchor is valid, even
    // when the compact tail contains the store's full history.
    this.autoscroll = false

    if (hasOlderHistory) {
      this.maybeScheduleRender("backward")
    }
  }

  private maybeEngageAutoscroll() {
    // We don't expect new log lines in snapshots. So when we scroll down, we don't need
    // to worry about re-engaging autoscroll.
    if (this.props.pathBuilder.isSnapshot()) {
      return
    }

    if (this.needsScrollToLine) {
      return
    }

    if (this.autoscrollRafId) {
      this.props.raf.cancelAnimationFrame(this.autoscrollRafId)
    }

    this.autoscrollRafId = this.props.raf.requestAnimationFrame(() => {
      this.autoscrollRafId = 0
      let autoscroll = this.computeAutoScroll()
      if (autoscroll) {
        this.autoscroll = true
        this.maybeScheduleRender("forward")
      }
    })
  }

  // Compute whether we should auto-scroll from the state of the DOM.
  // This forces a layout, so should be used sparingly.
  private computeAutoScroll(): boolean {
    let rootEl = this.rootRef.current
    if (!rootEl) {
      return true
    }

    // Always auto-scroll when we're recovering from a loading screen.
    let cursorEl = this.cursorRef.current
    if (!cursorEl) {
      return true
    }

    // Never auto-scroll if we're horizontally scrolled.
    if (rootEl.scrollLeft) {
      return false
    }

    let lastElInView =
      cursorEl.getBoundingClientRect().bottom <=
      rootEl.getBoundingClientRect().bottom
    return lastElInView
  }

  resetRender() {
    let root = this.rootRef.current
    let cursor = this.cursorRef.current
    if (root) {
      while (root.firstChild != cursor) {
        root.removeChild(root.firstChild)
      }
    }

    this.lineHashList = new LineHashList()
    this.logDisplay = new LogDisplay(this.props.filterSet)
    this.logCheckpoint = 0
    this.historyHydrated = false
    this.scrollTop = -1
    this.forwardBuffer = []
    this.backwardBuffer = []
    this.renderDirection = null
    this.recycledLineEls = []
    this.updateCursorVisibility()

    if (this.logReadTimerId !== null) {
      window.clearTimeout(this.logReadTimerId)
      this.logReadTimerId = null
    }

    if (this.renderBufferRafId) {
      this.props.raf.cancelAnimationFrame(this.renderBufferRafId)
      this.renderBufferRafId = 0
    }

    if (this.autoscrollRafId) {
      this.props.raf.cancelAnimationFrame(this.autoscrollRafId)
      this.autoscrollRafId = 0
    }
  }

  private logPatchSet(checkpoint: number) {
    let mn = this.props.manifestName
    let logStore = this.props.logStore
    return mn
      ? mn === ResourceName.starred
        ? logStore.starredLogPatchSet(this.props.starredResources, checkpoint)
        : logStore.manifestLogPatchSet(mn, checkpoint)
      : logStore.allLogPatchSet(checkpoint)
  }

  private tailLogPatchSet(limit: number) {
    let mn = this.props.manifestName
    let logStore = this.props.logStore
    return mn
      ? mn === ResourceName.starred
        ? logStore.starredLogTailPatchSet(this.props.starredResources, limit)
        : logStore.manifestLogTailPatchSet(mn, limit)
      : logStore.allLogTailPatchSet(limit)
  }

  private shouldReadBoundedTail(startCheckpoint: number): boolean {
    let { filterSet } = this.props
    return (
      startCheckpoint === 0 &&
      this.autoscroll &&
      !this.needsScrollToLine &&
      !this.historyHydrated &&
      filterSet.level === FilterLevel.all &&
      filterSet.source === FilterSource.all &&
      filterSet.term.state === TermState.Empty
    )
  }

  private compactTailLines(lines: LogLine[]): LogLine[] {
    // A patch can revise a stored line. Keep the most recent representation
    // without allocating index entries for the lines that cannot remain in
    // the pinned viewport.
    let byStoredLineIndex = new Map<number, LogLine>()
    for (let line of lines) {
      byStoredLineIndex.set(line.storedLineIndex, line)
    }
    return Array.from(byStoredLineIndex.values())
      .sort((left, right) => left.storedLineIndex - right.storedLineIndex)
      .slice(-(this.currentTailLimit() + 1))
  }

  private replaceCompactTail(incomingLines: LogLine[]) {
    let compactLines = this.compactTailLines(
      this.lineHashList.lines().concat(incomingLines)
    )
    let tailLines = compactLines.slice(-this.currentTailLimit())
    let nextTailByStoredLineIndex = new Map<number, LogLine>()
    let previousStoredLineIndex = -1
    for (let line of tailLines) {
      if (line.storedLineIndex <= previousStoredLineIndex) {
        throw new Error(
          "Compact log tail identities must be strictly ascending"
        )
      }
      previousStoredLineIndex = line.storedLineIndex
      nextTailByStoredLineIndex.set(line.storedLineIndex, line)
    }

    let renderedEntries = new Map<number, LineHashListEntry>()
    let previousRenderedStoredLineIndex = -1
    for (let lineEl of this.renderedLineElements()) {
      let storedLineIndex = Number(lineEl.getAttribute("data-sl-index"))
      if (
        !Number.isInteger(storedLineIndex) ||
        storedLineIndex <= previousRenderedStoredLineIndex ||
        renderedEntries.has(storedLineIndex)
      ) {
        throw new Error(
          "Rendered compact tail has an invalid, duplicate, or non-monotonic identity"
        )
      }
      previousRenderedStoredLineIndex = storedLineIndex
      let entry = this.lineHashList.lookupByStoredLineIndex(storedLineIndex)
      if (!entry || entry.el !== lineEl) {
        throw new Error(
          `Cannot retain rendered log line at stored index ${storedLineIndex}`
        )
      }
      renderedEntries.set(storedLineIndex, entry)
    }

    // Recycle only logical lines that truly left the bounded tail. Retained
    // nodes never leave the DOM, preserving native selection and focus.
    for (let [storedLineIndex, entry] of Array.from(
      renderedEntries.entries()
    )) {
      if (!nextTailByStoredLineIndex.has(storedLineIndex)) {
        if (!entry.el) {
          throw new Error(
            `Cannot evict compact log line at stored index ${storedLineIndex}`
          )
        }
        this.unrenderLines([entry.el])
        renderedEntries.delete(storedLineIndex)
      }
    }

    let nextLineHashList = new LineHashList()
    compactLines.forEach((line) => nextLineHashList.append(line))
    for (let [storedLineIndex, previousEntry] of Array.from(
      renderedEntries.entries()
    )) {
      let entry = nextLineHashList.lookupByStoredLineIndex(storedLineIndex)
      if (!entry || !previousEntry.el) {
        throw new Error(
          `Cannot bind retained compact log line at stored index ${storedLineIndex}`
        )
      }
      entry.el = previousEntry.el
    }

    this.lineHashList = nextLineHashList
    this.backwardBuffer = []
    this.forwardBuffer = tailLines.filter((line) => {
      let previousEntry = renderedEntries.get(line.storedLineIndex)
      return !previousEntry || previousEntry.line !== line
    })
    this.historyHydrated = false
    this.updateCursorVisibility()

    if (tailLines.length) {
      this.maybeScheduleRender("forward")
    }
  }

  private hydrateHistoryForDisengagement(): boolean {
    if (this.historyHydrated) {
      return true
    }

    let renderedElements = this.renderedLineElements()
    if (renderedElements.length === 0) {
      return false
    }

    let patch = this.logPatchSet(0)
    // Filtering from checkpoint zero also reconstructs prologue context.
    // This is the only full-history materialization owned by an excursion;
    // boundary arrival merely decides when to render another older window.
    this.logDisplay = new LogDisplay(this.props.filterSet)
    let lines = this.logDisplay.filterLines(patch.lines)
    let fullIndex = new LineHashList()
    lines.forEach((line) => fullIndex.append(line))
    let compactIndex = this.lineHashList
    let changedMountedLines: LogLine[] = []

    let renderedIndices = renderedElements.map((el) => {
      let storedLineIndex = Number(el.getAttribute("data-sl-index"))
      if (!Number.isInteger(storedLineIndex)) {
        throw new Error("Rendered log line has no stored-line identity")
      }
      return storedLineIndex
    })
    let firstRenderedLine = renderedIndices[0]
    let firstRenderedOffset = lines.findIndex(
      (line) => line.storedLineIndex === firstRenderedLine
    )
    if (firstRenderedOffset < 0) {
      throw new Error(
        `Cannot hydrate history: rendered line ${firstRenderedLine} is absent from LogStore`
      )
    }
    for (let i = 0; i < renderedIndices.length; i++) {
      let line = lines[firstRenderedOffset + i]
      if (!line || line.storedLineIndex !== renderedIndices[i]) {
        throw new Error(
          "Cannot hydrate history: rendered identities are not contiguous"
        )
      }
      let compactEntry = compactIndex.lookupByStoredLineIndex(
        line.storedLineIndex
      )
      if (!compactEntry || compactEntry.el !== renderedElements[i]) {
        throw new Error(
          `Cannot hydrate history: rendered compact line ${line.storedLineIndex} is not retained`
        )
      }
      let entry = fullIndex.lookup(line)
      if (!entry || entry.el) {
        throw new Error(
          `Cannot hydrate history: duplicate rendered line ${line.storedLineIndex}`
        )
      }
      entry.el = renderedElements[i]
      if (compactEntry.line !== line) {
        changedMountedLines.push(line)
      }
    }

    this.lineHashList = fullIndex
    this.logCheckpoint = patch.checkpoint
    this.backwardBuffer = lines.slice(0, firstRenderedOffset)
    this.forwardBuffer = lines.slice(
      firstRenderedOffset + renderedElements.length
    )
    this.historyHydrated = true

    // The compact tail retains one logical predecessor, so its mounted lines
    // already have the same neighboring relationships in the full index. Do
    // not rewrite them just because history ownership changed: browser-owned
    // selections and focused descendants survive only while these contents
    // remain untouched. A checkpoint rewrite that raced the deferred tail
    // read is the exception: update only that mounted identity in place.
    for (let line of changedMountedLines) {
      this.renderLineHelper(line)
    }
    this.updateCursorVisibility()
    return true
  }

  private compactHistoryAtTail() {
    // Reuse compact replacement so a return-to-tail retains the nodes whose
    // logical identities survive the smaller tail window.
    this.replaceCompactTail([])
  }

  // A geometry change needs an older snapshot, not an incremental patch after
  // the current checkpoint. The ordinary patch API cannot grow a settled tail:
  // with no new logs it returns no lines at all. Reuse the bounded first-mount
  // path when its unfiltered compact-tail preconditions hold; filtered or
  // otherwise non-compact readers need a checkpoint-zero snapshot so filtering
  // remains complete.
  private refreshCompactTailForGeometry() {
    let patch = this.shouldReadBoundedTail(0)
      ? this.tailLogPatchSet(this.currentTailLimit() + 1)
      : this.logPatchSet(0)
    this.logDisplay = new LogDisplay(this.props.filterSet)
    let lines = this.logDisplay.filterLines(patch.lines)
    this.logCheckpoint = patch.checkpoint
    this.replaceCompactTail(lines)
  }

  // Render new logs that have come in since the current checkpoint.
  readLogsFromLogStore() {
    let startCheckpoint = this.logCheckpoint
    let patch = this.shouldReadBoundedTail(startCheckpoint)
      ? this.tailLogPatchSet(this.currentTailLimit() + 1)
      : this.logPatchSet(startCheckpoint)

    let lines = this.logDisplay.filterLines(patch.lines)

    this.logCheckpoint = patch.checkpoint

    if (startCheckpoint) {
      if (!this.historyHydrated) {
        this.replaceCompactTail(lines)
        return
      }

      // History owns a full logical index for this deliberate excursion, so
      // checkpoint patches can remain incremental without moving the reader.
      lines.forEach((line) => this.lineHashList.append(line))
      this.forwardBuffer.push(...lines)
      this.updateCursorVisibility()

      // Keep receiving updates while the user reads history, but do not move
      // their window until they explicitly return to the bottom.
      if (this.autoscroll) {
        this.maybeScheduleRender("forward")
      }
    } else {
      if (this.needsScrollToLine) {
        // A deep link starts in a non-follow state, so it needs the complete
        // index immediately to land on the requested stored-line identity.
        lines.forEach((line) => this.lineHashList.append(line))
        this.backwardBuffer = lines
        this.historyHydrated = true
        this.maybeScheduleRender("backward")
      } else {
        this.replaceCompactTail(lines)
      }
    }
  }

  // Schedule a render job if there's not one already scheduled.
  maybeScheduleRender(direction?: RenderDirection) {
    if (direction) {
      this.renderDirection = direction
    } else if (!this.renderDirection) {
      this.renderDirection = this.autoscroll ? "forward" : "backward"
    }

    if (this.renderBufferRafId) return
    this.renderBufferRafId = this.props.raf.requestAnimationFrame(
      this.renderBuffer
    )
  }

  shouldRenderForwardBuffer(): boolean {
    return this.renderDirection === "forward" && this.forwardBuffer.length > 0
  }

  // When we're in autoscrolling mode, rendering the backwards buffer makes the
  // screen jiggle, because we have to render a few rows, then scroll down, then
  // render a few rows, then scroll down.
  //
  // So when in autoscrol mode, only render until we have the "last window" of logs.
  shouldRenderBackwardBuffer(): boolean {
    if (this.backwardBuffer.length == 0) {
      // Skip rendering if there's no lines in the buffer.
      return false
    }

    if (this.renderDirection === "backward") {
      return true
    }

    // While following the tail, fill unused window capacity with recent
    // history, but never evict newer lines merely to render older ones.
    return (
      this.autoscroll &&
      this.forwardBuffer.length === 0 &&
      this.renderedLineCount() < this.renderedLineTarget()
    )
  }

  private renderedLineElements(): HTMLSpanElement[] {
    let root = this.rootRef.current
    return root
      ? (Array.from(root.querySelectorAll(".LogLine")) as HTMLSpanElement[])
      : []
  }

  // Lines needed to cover the viewport at the current font scale, floored at
  // tailLineLimit and clamped to the rendered cap so follow mode can never
  // breach the bounded-DOM contract (REQ-LOGPANE-005) even at the smallest
  // supported scale in a tall pane.
  //
  // Geometry comes from the pane box plus the span of the first and last mounted
  // line — one query and two rect reads, not a rect per line, and the span
  // includes ordinary inter-line spacing. Anything unmeasurable (detached pane,
  // zero height, no mounted lines, degenerate span) returns null: it contributes
  // no new information, so the caller retains the last known-good size rather
  // than guessing at a layout that does not exist yet.
  private measureTailLimit(): number | null {
    let root = this.rootRef.current
    if (!root || root.clientHeight <= 0) {
      return null
    }
    let elements = this.renderedLineElements()
    if (elements.length === 0) {
      return null
    }
    let span =
      elements[elements.length - 1].getBoundingClientRect().bottom -
      elements[0].getBoundingClientRect().top
    let averageLineHeight = span / elements.length
    if (!Number.isFinite(averageLineHeight) || averageLineHeight <= 0) {
      return null
    }
    let needed = Math.ceil(
      Math.ceil(root.clientHeight / averageLineHeight) * followTailOverscan
    )
    return Math.min(renderedLineLimit, Math.max(tailLineLimit, needed))
  }

  // Adopt a fresh measurement, and only a fresh one. Geometry is routinely
  // unmeasurable for an instant — mid-compaction the pane holds no mounted lines
  // at all — and treating that as "shrink back to the floor" would clobber a
  // good measurement with a value carrying no information, then hold the pane at
  // the stale floor until something happened to re-measure. Absent evidence, the
  // last known-good size stands.
  private retainMeasuredTailLimit() {
    let measured = this.measureTailLimit()
    if (measured !== null) {
      this.tailLimitSnapshot = measured
    }
  }

  // The tail size every follow-mode decision in flight agrees on.
  private currentTailLimit(): number {
    return this.tailLimitSnapshot
  }

  private renderedLineCount(): number {
    return this.renderedLineElements().length
  }

  private renderedLineTarget(): number {
    // Follow mode needs only the current tail. The larger cap is reserved for
    // deliberate history traversal, where overlap keeps scrolling smooth.
    return this.autoscroll ? this.currentTailLimit() : renderedLineLimit
  }

  private updateCursorVisibility() {
    let cursor = this.cursorRef.current
    if (cursor) {
      // The cursor denotes the true store tail, not merely the end of the
      // currently rendered history window.
      cursor.style.visibility = this.forwardBuffer.length ? "hidden" : ""
    }
  }

  private captureVisibleAnchor(): VisibleAnchor | null {
    let root = this.rootRef.current
    if (!root) {
      return null
    }

    let rootTop = root.getBoundingClientRect().top
    for (let el of this.renderedLineElements()) {
      let rect = el.getBoundingClientRect()
      if (rect.bottom > rootTop) {
        return { el, offset: rect.top - rootTop }
      }
    }
    return null
  }

  private restoreVisibleAnchor(anchor: VisibleAnchor | null) {
    let root = this.rootRef.current
    if (!root || !anchor?.el.isConnected) {
      return
    }

    let offset =
      anchor.el.getBoundingClientRect().top - root.getBoundingClientRect().top
    root.scrollTop += offset - anchor.offset
    this.scrollTop = root.scrollTop
  }

  private recycleLineEl(lineEl: HTMLSpanElement) {
    if (this.recycledLineEls.length < renderedLineLimit) {
      this.recycledLineEls.push(lineEl)
    }
  }

  private takeRecycledLineEl(): HTMLSpanElement | undefined {
    return this.recycledLineEls.pop()
  }

  private unrenderLines(elements: HTMLSpanElement[]): LogLine[] {
    let root = this.rootRef.current
    if (!root) {
      return []
    }

    return elements.map((el) => {
      let storedLineIndex = Number(el.getAttribute("data-sl-index"))
      let entry = this.lineHashList.lookupByStoredLineIndex(storedLineIndex)
      if (!entry || entry.el !== el) {
        throw new Error(
          `Cannot evict rendered log line at stored index ${storedLineIndex}`
        )
      }

      root.removeChild(el)
      entry.el = undefined
      this.recycleLineEl(el)
      return entry.line
    })
  }

  private makeRoomFor(lines: LogLine[], direction: RenderDirection) {
    let additions = lines.filter(
      (line) => !this.lineHashList.lookup(line)?.el
    ).length
    let rendered = this.renderedLineElements()
    let excess = Math.max(
      0,
      rendered.length + additions - this.renderedLineTarget()
    )
    if (!excess) {
      return
    }

    if (direction === "forward") {
      let evicted = this.unrenderLines(rendered.slice(0, excess))
      this.backwardBuffer.push(...evicted)
    } else {
      let evicted = this.unrenderLines(rendered.slice(rendered.length - excess))
      this.forwardBuffer = evicted.concat(this.forwardBuffer)
    }
  }

  private coalesceForwardBufferForTail() {
    if (!this.autoscroll) {
      return
    }

    let unrendered = this.forwardBuffer.filter(
      (line) => !this.lineHashList.lookup(line)?.el
    )
    if (unrendered.length <= this.currentTailLimit()) {
      return
    }

    // A replay frame or reconnect can deliver thousands of lines at once. In
    // follow mode, rendering those intermediate lines only to evict them in
    // the next frame creates the same layout work as an unbounded pane. Move
    // the current DOM and every skipped line straight into history, retaining
    // only the newest render window for the user-visible tail.
    let split = unrendered.length - this.currentTailLimit()
    let skipped = unrendered.slice(0, split)
    let retained = unrendered.slice(split)
    let evicted = this.unrenderLines(this.renderedLineElements())
    this.backwardBuffer.push(...evicted, ...skipped)
    this.forwardBuffer = retained
  }

  // We have two render buffers:
  // - a buffer of newer logs that we haven't rendered yet.
  // - a buffer of older logs that we haven't rendered yet.
  // First, process the newer logs.
  // If we're out of new logs to render, go back through the old logs.
  //
  // Each invocation of this method renders up to 2x renderWindow logs.
  // If there are still logs left to render, it yields the thread and schedules
  // another render.
  renderBuffer() {
    this.renderBufferRafId = 0

    // A geometry refill's capacity bound applies to exactly this render. Take
    // it and clear the field up front so an early return below cannot leak the
    // bound into a later, unrelated traversal render.
    let pendingFillBudget = this.viewportFillBudget
    let pendingFillDirection = this.viewportFillDirection
    this.viewportFillBudget = null
    this.viewportFillDirection = null

    // Measure once, before any coalescing or eviction decision reads it, so a
    // font change landing mid-render cannot make this render size two of its
    // decisions differently.
    this.retainMeasuredTailLimit()

    let root = this.rootRef.current
    let cursor = this.cursorRef.current
    if (!root || !cursor) {
      return
    }

    let direction = this.renderDirection
    if (!direction) {
      return
    }

    // Only a render still going the way the refill intended inherits its bound.
    let fillBudget =
      pendingFillDirection === direction ? pendingFillBudget : null

    if (direction === "forward") {
      this.coalesceForwardBufferForTail()
    }

    let anchor = direction === "backward" ? this.captureVisibleAnchor() : null

    if (direction === "forward" && this.shouldRenderForwardBuffer()) {
      let forwardCount =
        fillBudget === null ? renderWindow : Math.min(renderWindow, fillBudget)
      let forwardLines = this.forwardBuffer.slice(0, forwardCount)
      this.forwardBuffer = this.forwardBuffer.slice(forwardCount)
      this.makeRoomFor(forwardLines, "forward")
      for (let line of forwardLines) {
        this.renderLineHelper(line)
      }
    }

    if (this.shouldRenderBackwardBuffer()) {
      let available = this.autoscroll
        ? this.renderedLineTarget() - this.renderedLineCount()
        : fillBudget ?? renderWindow
      let backwardCount = Math.min(renderWindow, Math.max(0, available))
      let backwardStart = Math.max(
        0,
        this.backwardBuffer.length - backwardCount
      )
      let backwardLines = this.backwardBuffer.slice(backwardStart)
      this.backwardBuffer = this.backwardBuffer.slice(0, backwardStart)
      this.makeRoomFor(backwardLines, "backward")

      for (let i = backwardLines.length - 1; i >= 0; i--) {
        let line = backwardLines[i]
        this.renderLineHelper(line)
      }
    }

    this.updateCursorVisibility()
    this.restoreVisibleAnchor(anchor)

    // Once a deliberate history reader reaches the real tail and all pending
    // checkpoint work has rendered, release the full excursion index before
    // the next follow interval can retain it.
    if (
      this.autoscroll &&
      this.historyHydrated &&
      this.forwardBuffer.length === 0
    ) {
      this.compactHistoryAtTail()
    }

    if (this.autoscroll) {
      this.scrollCursorIntoView()
    }

    if (this.needsScrollToLine) {
      let entry = this.lineHashList.lookupByStoredLineIndex(
        this.props.scrollToStoredLineIndex as number
      )
      if (entry?.el) {
        entry.el.scrollIntoView({ block: "center" })
        this.needsScrollToLine = false
        this.scrollTop = root.scrollTop
      }
    }

    this.renderDirection = null
    if (this.autoscroll && this.forwardBuffer.length > 0) {
      this.maybeScheduleRender("forward")
    } else if (this.needsScrollToLine && this.backwardBuffer.length > 0) {
      this.maybeScheduleRender("backward")
    } else if (
      this.autoscroll &&
      this.backwardBuffer.length > 0 &&
      this.renderedLineCount() < this.renderedLineTarget() &&
      root.scrollTop === 0
    ) {
      this.maybeScheduleRender("backward")
    } else {
      // A geometry change (font shrink / window resize) left the disengaged
      // window shorter than the viewport. Keep reclaiming history toward the
      // gap until it covers the space or history is exhausted.
      let continuation = this.continuedUnderfillDirection(root)
      if (continuation) {
        this.viewportFillPasses++
        // Re-arm the no-eviction bound for the next pass. renderBuffer cleared
        // it on entry, and a continuation that inherits no budget falls back to
        // the ordinary full window — makeRoomFor would then evict the opposite
        // edge, which is exactly the visible/focused content this refill exists
        // to preserve (REQ-LOGPANE-005). Recomputed, not carried over, because
        // this render just changed the rendered count.
        this.viewportFillBudget = this.underfillCapacity()
        this.viewportFillDirection = continuation
        this.maybeScheduleRender(continuation)
      }
    }

    // A refill deferred because a render was in flight re-runs now that this
    // render has completed and the geometry it produced is final.
    if (this.viewportFillDeferred) {
      this.viewportFillDeferred = false
      this.scheduleViewportFill()
    }
  }

  // Creates a DOM element with a permalink to an alert.
  newAlertNavEl(line: LogLine) {
    let div = document.createElement("button")
    div.className = "LogLine-alertNav"
    div.innerHTML = "… (more) …"
    div.onclick = (e) => {
      let storedLineIndex = line.storedLineIndex
      this.props.navigate(
        this.props.pathBuilder.encpath`/r/${line.manifestName}/overview`,
        { state: { storedLineIndex } }
      )
    }
    return div
  }

  // Helper function for rendering lines. Returns true if the line was
  // successfully rendered.
  //
  // If the line has already been rendered, replace the rendered line.
  //
  // If it hasn't been rendered, but the next line has, put it before the next line.
  //
  // If it hasn't been rendered, but the previous line has, put it after the previous line.
  //
  // Otherwise, iterate through the lines until we find a place to put it.
  renderLineHelper(line: LogLine) {
    let entry = this.lineHashList.lookup(line)
    if (!entry) {
      // If the entry has been removed from the hash list for some reason,
      // just ignore it.
      return
    }

    let shouldDisplayPrologues = this.logDisplay.shouldDisplayPrologues()
    let mn = this.props.manifestName
    let showManifestName = !mn || mn === ResourceName.starred
    let prevManifestName = entry.prev?.line.manifestName || ""

    let extraClasses = []
    let isContextChange = !!entry.prev && prevManifestName !== line.manifestName
    if (isContextChange) {
      extraClasses.push("is-contextChange")
    }

    let isEndOfAlert =
      shouldDisplayPrologues &&
      this.logDisplay.matchesLevelFilter(line) &&
      (!entry.next || entry.next?.line.level !== line.level)
    if (isEndOfAlert) {
      extraClasses.push("is-endOfAlert")
    }

    let isStartOfAlert =
      shouldDisplayPrologues &&
      !line.buildEvent &&
      !this.logDisplay.matchesLevelFilter(line) &&
      (!entry.prev ||
        this.logDisplay.matchesLevelFilter(entry.prev.line) ||
        entry.prev.line.buildEvent)
    if (isStartOfAlert) {
      extraClasses.push("is-startOfAlert")
    }

    let root = this.rootRef.current
    let existingLineEl = entry.el
    let lineEl = newLineEl(
      entry.line,
      showManifestName,
      extraClasses,
      this.ownedLineContents,
      existingLineEl || this.takeRecycledLineEl()
    )
    if (isStartOfAlert) {
      lineEl.appendChild(this.newAlertNavEl(entry.line))
    }

    if (existingLineEl) {
      // Store updates can revise a logical line. Its outer element remains in
      // place while its complete line representation is refreshed.
      return
    }

    let nextEl = entry.next?.el
    if (nextEl) {
      root.insertBefore(lineEl, nextEl)
      entry.el = lineEl
      return
    }

    let prevEl = entry.prev?.el
    if (prevEl) {
      root.insertBefore(lineEl, prevEl.nextSibling)
      entry.el = lineEl
      return
    }

    // In the worst case scenario, we iterate through all lines to find a suitable place.
    let cursor = this.cursorRef.current
    for (let i = 0; i < root.children.length; i++) {
      let child = root.children[i]
      if (
        child == cursor ||
        Number(child.getAttribute("data-sl-index")) > line.storedLineIndex
      ) {
        root.insertBefore(lineEl, child)
        entry.el = lineEl
        return
      }
    }
  }

  render() {
    return (
      <LogPaneRoot ref={this.rootRef} aria-label="Log pane">
        <LogEnd key="logEnd" className="logEnd" ref={this.cursorRef}>
          &#9608;
        </LogEnd>
      </LogPaneRoot>
    )
  }
}

type OverviewLogPaneProps = {
  manifestName: string
  filterSet: FilterSet
}

export default function OverviewLogPane(props: OverviewLogPaneProps) {
  const navigate = useNavigate()
  let location = useLocation() as any
  let pathBuilder = usePathBuilder()
  let logStore = useLogStore()
  let raf = useRaf()
  let starredContext = useStarredResources()

  return (
    <OverviewLogComponent
      manifestName={props.manifestName}
      pathBuilder={pathBuilder}
      logStore={logStore}
      raf={raf}
      filterSet={props.filterSet}
      navigate={navigate}
      scrollToStoredLineIndex={location?.state?.storedLineIndex}
      starredResources={starredContext.starredResources}
    />
  )
}
