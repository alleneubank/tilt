# SPEC — M5: Log-pane virtualization (HUD perf pass)

M5 makes the Tilt HUD responsive under canton-scale log load by bounding the log
pane's rendered DOM. It is a perf pass on the existing UX, not a redesign
(decided 2026-07-13, see Decisions). Verification is owned by the
[tilt-web-perf](https://github.com/alleneubank/tilt-web-perf) harness; every
REQ below traces to a floor in its `BRIEF.md` / `src/bench.ts` `FLOORS`.

## Problem

Profiling the cold-start cell (replay server, CDP tracing, 15 s window,
2026-07-13) measured 3470 ms of main-thread work: rendering pipeline ≈ 1945 ms
(Paint 773, PrePaint 350, UpdateLayoutTree 377, Layerize 284, Layout 158) plus
EventDispatch 757 ms (log-pane scroll handlers: `shouldRenderBackwardBuffer`,
`scrollCursorIntoView`, `onScroll`), against JS FunctionCall 1063 ms with no
hot spot (hottest single fn 126 ms). Verdict: **renderer-bound — the DOM is the
cost.**

The cause is structural. `web/src/OverviewLogPane.tsx` bypasses React and
appends raw `span`/`code` elements per log line
(`OverviewLogPane.tsx:99–126`), incrementally in 250-line chunks
(`renderWindow`, `OverviewLogPane.tsx:170`, `487–539`) — and **never evicts**.
`LogStore` caps history at 2 MB of text (`LogStore.ts:17`, truncating to half
by cutting the heaviest manifests, `LogStore.ts:653–655`), so the pane
materializes up to ~2 MB of log text as live DOM. Every paint, layout, and
scroll event then pays for the whole history, not the visible screen.

Cold-start is the worst cell: raw long-task duration ~2340 ms vs ~1170 ms on the sibling
cells (busy-resource, all-logs firehose, burst), INP 176 ms vs 96–128 ms.

## Solution

Virtualize (window) the log pane: render only a bounded window of lines around
the viewport plus the tail, evicting off-window DOM, while the full store-held
history stays reachable by scrolling. This collapses Paint + Layout +
EventDispatch together — the single highest-leverage lever the profile
supports. Store/data-layer diffing is explicitly out of scope (second-order:
JS cost is diffuse with no hot spot; see Non-goals).

## Domain model (current)

```
websocket view-stream
  └─ LogStore (web/src/LogStore.ts)
       segments + spans, byte-capped at maxLogLength = 2 MB → truncate to 1 MB
       checkpoints for incremental readers; update listeners
         └─ OverviewLogComponent (web/src/OverviewLogPane.tsx)
              React class shell around an imperative raw-DOM renderer
              dual buffers: forwardBuffer (newer, off-DOM) / backwardBuffer (older)
              rAF-paced mount of up to renderedLineLimit (750) lines; eviction of
              opposite edge when growing a direction
              follow mode (autoscroll): compact geometry-aware tail only
              history mode: hydrate full logical index; freeze reader window until
              deliberate return-to-tail (REQ-LOGPANE-007)
              Live control + End key force rejoin; leave hysteresis on scroll-up
              alert-nav buttons, prefixes, ANSI/level styling per line
  └─ filters (web/src/logfilters.ts): level / source / term (regex) —
       evaluated against store lines, upstream of rendering
  └─ Copy Logs (web/src/CopyLogs.tsx): reads LogStore, not the DOM
```

## Requirements

### Pane behavior

- **REQ-LOGPANE-001 — Bounded rendered DOM.** At any instant the pane holds
  O(window) rendered line elements, independent of store-held history size.
  Off-window lines are evicted from the DOM. Peak `.LogLine` count ≤ **750**.
  → floors: median DOM nodes ≤ baseline × 1.15; `e2e:log-pane` max-rendered-lines;
  raw-duration floors below.
- **REQ-LOGPANE-002 — Full history reachable.** Scrolling reaches every line
  the store holds (back to the truncation point). Jump-to-line
  (`scrollToStoredLineIndex`) and alert-nav land on their target line even
  when it is off-window at click time.
  → floor: correctness E2E green (INV-5 of tilt-web-perf).
- **REQ-LOGPANE-003 — Follow-mode parity.** Pinned-to-tail by default; scroll-up
  disengages (with hysteresis, REQ-LOGPANE-007); near-bottom scroll or Live/End
  re-engages; new tail lines render while pinned. After a font-scale shrink **in
  follow mode**, the pane remains viewport-filled (Probe A): the follow tail is
  not stuck at the fixed `tailLineLimit` when measured geometry requires more
  lines.
  → floor: quiet Probe A/A2/B and correctness E2E green.
- **REQ-LOGPANE-003a — Geometry-aware follow tail.** One immutable per-render
  tail-limit snapshot is captured at the top of `renderBuffer()` and applied to
  every tail decision in that render. Bound:
  `min(renderedLineLimit, max(tailLineLimit, ceil(ceil(clientHeight / avgLineHeight) * 1.25)))`,
  measuring root `clientHeight` and the first/last mounted `.LogLine` span.
  Unmeasurable geometry falls back to `tailLineLimit`. A geometry-driven grow
  takes a checkpoint-zero bounded tail snapshot (or a complete checkpoint-zero
  snapshot when compact-tail preconditions do not hold), never a multi-site
  adaptive `followTailTarget()` revival.
  → floor: focused `OverviewLogPane` unit tests; Probe A.
- **REQ-LOGPANE-004 — Store-side filtering.** Level / source / term-regex
  filters keep evaluating against the store, so filter results are complete
  regardless of the rendered window. This is the decided substitute for
  browser Ctrl+F over full history (see Decisions #4).
  → floor: correctness E2E green; existing `logfilters` unit tests.
- **REQ-LOGPANE-005 — Rendering parity.** Per-line prefixes, ANSI/level
  styling, alert-nav buttons, the tail cursor, and text selection within the
  rendered window behave as today. Copy Logs is store-backed and unaffected.
  Peak rendered `.LogLine` elements stay ≤ **750** (three 250-line batches).
  → floor: correctness E2E green; existing `OverviewLogPane` unit tests;
  `e2e:log-pane` max-rendered-lines.
- **REQ-LOGPANE-006 — Incremental updates stay incremental.** Per-update
  render cost is O(new lines + window), never O(history) — the store-checkpoint
  incremental read path is preserved; no full re-render per log frame.
  → floors: raw-duration no-regression on the sustained cells.
- **REQ-LOGPANE-007 — Return-to-tail.** After the user leaves follow mode
  (history excursion or accidental upward flick), they can reach the live store
  tail without trapping on a short rendered window:
  1. **Bottom-edge forward paging / rejoin.** Scrolling to (or within a small
     proximity of) the bottom of an **overflowing** pane pages newer lines from
     the off-DOM forward buffer and re-engages follow when the live tail is
     reachable; a large unrendered forward gap may coalesce to the live tail
     under follow (same coalesce path as pinned mode). Non-overflowing
     geometry (underfill: `scrollHeight ≤ clientHeight`) is **not** "near
     bottom" — underfill refill must not force-rejoin follow.
  2. **Explicit Live control.** A visible "Live" affordance (and End when the
     pane owns focus) forces follow and scrolls to the live cursor regardless of
     partial geometry. Live visibility tracks follow mode and survives parent
     React re-renders (HUD view-stream updates).
  3. **Leave hysteresis.** Sub-threshold upward scroll deltas do not disengage
     follow (top-boundary history requests still load older windows).
  4. **Expand-on-disengage.** Expanding the mounted window for scroll runway
     runs only on **top-boundary** history hydrate, not on mid-window leave, so
     a frozen history window keeps its visible identities until the reader
     moves deliberately.
  Peak rendered `.LogLine` elements remain ≤ **750**. Not a continuous
  virtual-list redesign (M6 non-goal).
  → floors: `OverviewLogPane` unit tests for forward page, Live/rejoin,
  hysteresis, underfill-vs-near-bottom, and ≤750; `e2e:log-pane` return-to-tail
  journey green.

### Perf gates (all on release-equivalent builds, via tilt-web-perf `run-map.sh`)

- **REQ-PERF-001 — Map-wide renderer collapse (the M5 done-gate).** On the
  same machine and hermetic fixtures used for the pre-M5 baselines, cold-start
  raw long-task duration is ≤ **492 ms**, all-logs-firehose raw long-task duration is ≤
  **778 ms**, and busy-resource heap slope is ≤ **5 MB/min**. Breaches gate
  only if reproducible (majority of up-to-3 runs, per harness decision
  2026-07-12). These targets are the Human-ratified 0.5× reductions from the
  hermetic 984/1556 ms raw long-task-duration baselines plus the existing absolute memory
  floor; they replace the fixture-specific cold-start-only parity target.
  → floors: per-journey raw-duration targets and the sustained heap-slope absolute
  in tilt-web-perf `BRIEF.md` / `src/bench.ts`.
- **REQ-PERF-002 — Whole priority map holds.** Non-target cells keep their
  no-regression floors (raw duration ≤ ×1.25, peak heap ≤ ×1.15, median DOM ≤
  ×1.15) and every cell keeps the absolutes: INP ≤ 200 ms (2nd-worst of 20),
  FCP ≤ 1800 ms, heap slope ≤ 5 MB/min on sustained cells, correctness E2E
  green, no tab crash. No shipping a responsiveness win that regresses
  startup or memory.
  → floors: all existing `FLOORS` in `src/bench.ts`.
- **REQ-PERF-003 — Bundle stays within floor.** Uncompressed JS+CSS ≤ 950 KB
  including any virtualization dependency added.
  → floor: existing bundle budget.

### Fixtures (hermetic re-record — precondition for gating)

- **REQ-FIX-001 — Hermetic load source.** Fixtures are recorded only from a
  disposable k3d cluster driven by `hack/log-only-podmonitor` (the soak
  harness). Shared canton localnets are never used as recording sources
  (2026-07-13 directive). Nothing in this contract reads a shared localnet.
- **REQ-FIX-002 — Fixture set.** Two recordings: (a) steady firehose ≥ 60 s
  (feeds the sustained memory-slope cells and the cold-start/busy slices);
  (b) true burst/reconnect — pod kills/restarts mid-recording (replaces the
  synthetic "first 12 s of steady" slice).
- **REQ-FIX-003 — Scrubbed, identified, bound.** Recordings pass the
  single-source secret scrubber and remain machine-local/gitignored; fixture
  identity is sha256(frames.jsonl). Committed baselines bind (fixtureId,
  target), and pre-upgrade baselines are refused (INV-2 of tilt-web-perf).
- **REQ-FIX-004 — Observed red before gating.** The pre-M5 tree is measured on
  the hermetic fixtures before implementation. The accepted red is the
  map-wide renderer disease the fixtures actually expose: cold-start and
  all-logs raw long-task duration at 984/1556 ms plus busy-resource heap slope at
  15.27 MB/min, reproduced 2/2 and refused at baseline capture. A future
  fixture re-record must reproduce equivalent raw-duration/memory pressure before
  it can gate M5; otherwise REQ-PERF-001 is re-derived and Human-ratified
  before use.

## Invariants

- **INV-M5-1** No code path renders unbounded history. There is no
  "render all lines" escape hatch (rejected in interview; see Decisions #4).
- **INV-M5-2** Perf verdicts come only from release-equivalent builds
  (build-role split; dev builds are for correctness loops).
- **INV-M5-3** Find/filter semantics evaluate store-side, never against the
  rendered window.
- **INV-M5-4** A fixture used for gating names its hermetic provenance
  (k3d + podmonitor recording); a fixture without it informs, never gates.

## Non-goals

- **Store/data-layer diffing** (memoized selectors, reducer diffing) —
  second-order per the profile; reconsider only if the post-M5 profile shows
  JS as the new ceiling.
- **Overview/resource-table first-paint work** beyond the log pane.
- **HUD redesign and the M6 wishlist** (recorded 2026-07-13, user's):
  in-pane log find (also closes the Ctrl+F gap), richer filtering
  (saved sets, per-resource memory), resource-nav overhaul
  (grouping/labels/pinned), density/appearance (compact mode, font controls).
- **Render-all escape hatch** for browser Ctrl+F.
- **FPS / ws-bytes instrumentation** (deferred per tilt-web-perf BRIEF unless
  a priority signal points there).
- **Content-only height shrink without resize or font-scale change** (a tall
  wrapped progress line rewriting shorter). Self-heals on the next resize,
  font change, or append; per-render layout reads for this case are out of scope.
- **Multi-site adaptive `followTailTarget()`** (deleted 2026-07-18). Geometry-
  aware fill uses one per-render snapshot (REQ-LOGPANE-003a), not that shape.

## Acceptance criteria

- [x] Hermetic fixtures recorded (steady ≥ 60 s + true burst), scrubbed,
      identified by sha256, retained machine-locally, and provenance documented
      (REQ-FIX-001..003)
- [x] Pre-M5 baselines captured on the new fixtures; map-wide raw-duration and
      busy-resource memory red reproduced (REQ-FIX-004)
- [x] Virtualized pane lands; `OverviewLogPane` and `LogStore` coverage plus
      the correctness E2E are green (REQ-LOGPANE-001..007, 003a).
- [x] Return-to-tail works under load: near-bottom rejoin / Live, ≤750 lines
      (`e2e:log-pane` return-to-tail journey; REQ-LOGPANE-007).
- [x] The release build meets the reproducible M5 absolutes: cold-start raw
      long-task duration ≤ 492 ms, all-logs-firehose raw long-task duration ≤
      778 ms, and busy-resource retained heap slope ≤ 5 MB/min (REQ-PERF-001).
- [x] All active absolute floors, bundle, no-crash, and correctness checks pass
      under the ratified reproducibility rule (REQ-PERF-002, REQ-PERF-003).
      Committed all-logs and burst baselines use `semantic-route-cycle-v2`
      (human-promoted 2026-07-20 from exact candidate hashes recorded in
      tilt-web-perf `BRIEF.md`). Cold-start remains a legacy-driver baseline
      and deliberately refuses semantic cross-compare until a lawful semantic
      cold-start reference exists; that cell is not claimed as map-green.

## Risk

No high-risk tags (no schema, auth, public API, or infra change). One recorded
user-visible tradeoff: browser Ctrl+F no longer sees off-window history —
accepted, store-side regex filter covers the find workflow (Decisions #4).

## Decisions (spec interview, 2026-07-13, user + agent)

1. **M5 identity**: perf pass on the existing HUD; redesign deferred to M6.
2. **Scope**: virtualized log pane only; store diffing is a non-goal pending
   post-M5 profile evidence.
3. **Done-gate**: map-wide renderer collapse — cold-start raw long-task duration ≤ 492 ms,
   all-logs-firehose raw long-task duration ≤ 778 ms, and busy-resource heap slope
   ≤ 5 MB/min on the same fixtures/machine/release build; existing floors
   unchanged and in force. Human-ratified 2026-07-14 after the hermetic
   re-baseline changed the disease shape.
4. **Ctrl+F**: regression accepted, no escape hatch — the store-level regex
   filter covers the find workflow (user's call); in-app find → M6 wishlist.
5. **Fixture source**: hermetic k3d + `hack/log-only-podmonitor`; steady +
   true-burst recordings; shared localnets retired as recording sources.
6. **M6 wishlist** captured under Non-goals.
7. **Return-to-tail under dual-buffer virtualization** (REQ-LOGPANE-007):
   near-bottom rejoin and Live/End on the existing model; no continuous
   virtual-list rewrite; never raise the 750-line cap. Expand runway only at
   top-boundary hydrate; underfill is not near-bottom; Live survives parent
   re-renders.

The same batch is appended to tilt-web-perf `BRIEF.md` Decisions.

## Hermetic re-baseline evidence (2026-07-14)

The REQ-FIX-004 check produced the accepted red. Facts (release build
`v0.37.5-fork.20260713.gdec442fe4`, fixtures `k3d-steady` e983b6f2 /
`k3d-burst` 1e3121da, real canton log content replayed hermetically):

- The renderer disease reproduces at canton magnitude **map-wide**: raw long-task duration
  all-logs 1556ms / cold-start 984ms / burst 886ms (canton band 1165–1408ms).
- The **shape** shifted: cold-start is no longer the worst cell (all-logs is);
  the "cold-start ≫ siblings" excess was fixture-specific, not intrinsic.
- busy-resource is red on an **absolute** floor: heap slope 15.27 MB/min > 5,
  reproduced 2/2 on deterministic replay — capture refused, so that cell has
  no committed baseline until M5 brings it under floor. This is a stronger
  observed red than any ratio: fail-closed on the pre-fix tree by design.
- Consequently REQ-PERF-001's coefficient was re-derived per its flagged
  clause. The **Human-ratified replacement gate** (mirrored in tilt-web-perf
  BRIEF batch item 3) is cold-start raw long-task duration ≤ 492ms (0.5×) AND
  all-logs raw long-task duration ≤ 778ms (0.5×) AND busy-resource heap slope ≤ 5 MB/min
  (absolute floor green, baseline becomes capturable); all other floors
  unchanged.
- The acceptance line "absolute floors green at capture" holds for 3 of 4
  cells; for busy-resource it is *intentionally* red pre-M5 — the checklist
  below reads accordingly.

## Test traceability

| Requirement | Primary proof |
| --- | --- |
| REQ-LOGPANE-001..007, 003a | `LogStore.test.ts`, `OverviewLogPane.test.tsx`, quiet Probe A/A2/B, `e2e:log-pane` |
| REQ-HUDPERF-001..002 | range/window tests; `e2e:hud-scale` global mounted bounds |
| REQ-HUDPERF-003 | `e2e:hud-scale` far-tail exact-filter/direct-route reachability; model, scroll, keyboard, a11y tests |
| REQ-HUDPERF-004..006 | model, scroll, keyboard, a11y component tests (including missing-`ResizeObserver` fallback) |
| REQ-HUDPERF-007 | `semantic-route-cycle-v2`, 20/20 release report |
| REQ-HUDPERF-008 | `HUD.test.tsx` and projection/window tests |
| REQ-HUDPERF-009 | build, project tests/check, both E2Es, map absolute/milestone floors |
| REQ-PERF-001..003 | release map cells, bundle budget, reproducibility rule |

## Final release evidence (immutable)

The independently approved runtime is
`8d7e4b5531de6b0cacf6bff33f5c75f96c39eabf`; its production asset identity is
`override:a3a59f6f4bd176df`. The sealed performance harness is
`7cb02288534e569522c1ca75c9a3e4fa17b1cf4d`. The same build produced
`main.56f571cd.js` (906,639 bytes, SHA256
`5292fd6f088d7d7c9fd0a9613276d722640f401a67872eb0b421c449f294de3d`) and
`main.05fc5d42.css` (8,180 bytes, SHA256
`4172f3e984879837a9f39d93a2d664bf672b02a0ebe9c556739dfbc7856a7bf1`), for
914,819 raw bytes below the unchanged 950 KB floor. The 465-test suite,
`yarn check`, production build, diff check, scale E2E, and 750-line log-pane
E2E passed.

Release reports used `semantic-route-cycle-v2` with 20/20 transitions,
sequential expected-resource correctness, and no crash. Active M5 results were
cold 428/426 ms against 492 ms, all-logs 439/423 ms against 778 ms, and
busy-resource retained slope 3.01 MB/min against 5 MB/min. The all-logs
retained slopes were 2.87/2.83 MB/min. The first burst draw (4,290 ms, 272 ms
INP) coincided with host load 35.09; the next two identical runs had 64 ms INP
and 1,193/522 ms raw duration, satisfying the ratified two-of-three
reproducibility rule. Burst retained slopes (7.20/6.96/6.95 MB/min) are
reported but not gated because burst is a short cell. All-logs and burst
baselines later received human-promoted `semantic-route-cycle-v2` references
(pre-M5 bundle); cold-start remains legacy-driver only. See tilt-web-perf
`BRIEF.md` Decisions.

---

# Whole-HUD resource rendering contract (append-only, 2026-07-15)

The approved next pass addresses a separate whole-HUD defect. At canonical
176-resource replay, overview mounts 176 rows with visible capacity 12 and
bound 36; the Resource logs sidebar mounts 176 `[data-name]` items with visible
capacity 13 and bound 39. Per-group 20-item pagination and Show More multiply
mounted work across open groups. Memoization cannot bound first mount.

The historic 492/778 numbers above are preserved exactly, while their metric
name is corrected to raw long-task duration. They are not standard
`blockingTimeMs`; the approved harness attributes both raw duration and standard
`blockingTimeMs = max(0, duration - 50 ms)` phase evidence across startup,
passive, and interaction phases.
`legacy-anchor-noop-v1` remains a readable numeric anchor for cells not yet
re-baselined under the semantic driver; `semantic-route-cycle-v2` is the
canonical 20-transition semantic driver and the harness refuses comparisons
across those IDs. The M5 product commits, independent harness approval, and
final release-map evidence are landed.

## Whole-HUD domain model

Each surface derives one immutable logical sequence of discriminated
`group-header`, `disabled-header`, and `resource` entries. A resource occurrence
key includes `groupId` and resource name: multi-label resources legitimately
occur more than once. The logical sequence owns filtering, grouping, sorting,
bulk/group actions, selection validity, and keyboard order; mounted DOM is only
a measured window.

### Module ownership

- Pure: `ResourceVirtualModel.ts` (immutable discriminated entries),
  `ResourceVirtualRange.ts` (positive geometry, row/anchor tracking, spacers,
  at most one leading/trailing viewport of overscan).
- `ResourceVirtualWindow.tsx` owns geometry observation, scroll/resize
  measurement, spacers, mounted callbacks, and the pending-focus handshake.
  When `ResizeObserver` is unavailable, it uses the existing frame-coalesced
  scheduler from a `window` `resize` listener and removes the listener on
  cleanup; positive-height geometry remains fail-closed.
- Sidebar: `SidebarResources` and `SidebarKeyboardShortcuts` consume the
  sidebar model/range.
- Overview: `OverviewTable`, `OverviewTableKeyboardShortcuts`, and
  `OverviewTablePane` consume the overview model/range. Sticky chrome stays
  outside the window; `[aria-label="Resources overview"]` is the positive-height
  scrollport whose actual `clientHeight` drives the range. Flex ancestry uses
  `min-height: 0` and overflow ownership on that scrollport.
- Existing resource group, selection, navigation, sidebar, and overview-column
  modules remain semantic owners.

## Whole-HUD requirements

- **REQ-HUDPERF-001 — Globally bounded overview.** Across scroll, resize,
  expansion, sorting, filtering, focus, and selection, overview mounts at most
  three measured viewport capacities of resource rows across all groups.
- **REQ-HUDPERF-002 — Globally bounded sidebar.** The same global bound holds
  for detail-sidebar resource `[data-name]` items; controls and structural
  headers are not resource-item loopholes.
- **REQ-HUDPERF-003 — Complete reachability.** Every occurrence remains
  reachable by expansion, continuous scroll, exact filtering, full-order
  keyboard traversal, and direct `/r/<encoded-name>/overview` navigation. The
  scale E2E owns full far-tail exact-filter and direct-route reachability plus
  the global mounted bounds; it does not require all virtualized resources to
  materialize in the DOM simultaneously.
- **REQ-HUDPERF-004 — Typed flattened models.** Filtering precedes grouping;
  sorting is global state applied within groups; actions receive complete
  logical groups, never mounted entries.
- **REQ-HUDPERF-005 — Geometry-owned window.** Actual positive row and
  viewport geometry yields visible range plus at most one leading and trailing
  viewport of overscan (short/end ranges are allowed). No fixed row count,
  per-group budget, Show More path, selected-item exception, or render-all
  escape hatch exists. Resize/model changes retain logical anchors or fail
  loudly on unusable geometry. Missing `ResizeObserver` is not unusable
  geometry when a positive-height owner exists: fall back to frame-coalesced
  `window` resize measurement with cleanup (declared browser matrix includes
  iOS Safari 11).
- **REQ-HUDPERF-006 — Keyboard and accessibility parity.** Unmounted keyboard
  targets request scroll, wait for a mounted callback, then focus; editable
  guards, shortcuts, occurrence IDs, status/actions, `aria-rowcount`,
  `aria-rowindex`, and selected styling remain correct.
- **REQ-HUDPERF-007 — Semantic route parity.** Shipped controls support the
  overview → `log-storm` → all logs → overview cycles under the approved driver.
- **REQ-HUDPERF-008 — Update isolation.** `mergeAppUpdate` preserves log-only
  no-render behavior and unchanged resource identity; window work is bounded
  to changed projections plus mounted entries.
- **REQ-HUDPERF-009 — Release verification.** A production build passes the
  independent scale and M5 E2Es, 20/20 semantic transitions, project tests and
  checks, 950 KB JS+CSS budget, and the phase-aware performance floors.
  Each performance cell proves `semantic-route-cycle-v2` 20/20 route
  transitions and, after each shipped exact-name Resource filter, exactly one
  matching `[data-name]`. That timed per-cell match must be CSS-visible,
  positive-area, and intersect the browser viewport, the Resource logs client
  window, and every applicable overflow clip in its ancestor chain; hidden,
  duplicate, residual nonmatching, off-window, viewport-clipped, and
  ancestor-clipped states fail closed. The scale proof requires its sole
  filtered overview resource row to have exact occurrence identity
  `ungrouped:<far-tail>` and the direct route to have exactly one exact selected
  sidebar identity, under those same effective-visibility rules.

## Whole-HUD invariants

- A materialization bound is global per semantic surface, never multiplied by
  group, disabled section, focus, selection, or repeated interaction.
- Invalid geometry, duplicate occurrence keys, unreachable targets, selector
  drift, and unavailable harnesses fail closed. The timed benchmark receives
  no product hook or scale MutationObserver.
- The scale E2E alone proves full far-tail filter/direct-route reachability and
  the global mounted bounds. After each shipped exact-name Resource filter, a
  timed performance cell finds exactly one matching `[data-name]`; it must be
  CSS-visible, positive-area, and intersect the browser viewport, Resource logs
  client window, and every applicable ancestor overflow clip. Hidden,
  duplicate, residual nonmatching, off-window, viewport-clipped, and
  ancestor-clipped states fail closed. The sole filtered overview resource row
  has exact occurrence identity `ungrouped:<far-tail>` and the direct route has
  exactly one exact selected sidebar identity under the same effective-
  visibility rules; bounded virtualization never makes simultaneous DOM
  materialization a correctness condition.
- Missing or duplicate filter controls, a failed clear, selector drift, or an
  unavailable release harness fails the applicable proof closed.
- The unchanged **5 MB/min** sustained-memory floor uses only
  `isolated-forced-gc-v1` retained-heap samples from a fresh byte-identical
  replay page. Missing CDP GC or metrics, fewer than two retained samples, or
  an invalid or non-positive retained span fails closed. The GC-free timed page
  retains ambient peak/final heap and DOM-node evidence; historical ambient
  slopes remain historical and are never reinterpreted as retained-heap slopes.
  Retained-memory coverage invokes the production capture control path and
  proves its fresh-page/CDP ordering, pre-sample GC, crash/CDP error
  propagation, and `finally` cleanup boundary.

## Whole-HUD non-goals

- Non-goals: changing log-store semantics or weakening M5 log semantics,
  reachability, cursor/follow behavior, or the 750-line E2E bound;
  fixtures/baselines, protocol, React, visual density, resource taxonomy,
  fixed pagination, collapsed-by-default scale hiding, or unrelated M6 work.

## Whole-HUD decisions

- The Human authorized the broader redesign on 2026-07-15: use one flattened
  local typed range per surface; retain multi-open groups; add no dependency
  unless evidence proves it safer; keep sticky overview chrome and static
  sidebar controls outside resource entries. Route shell/projection/dependency/
  React work is conditional on a post-windowing profile and new observed red.
- Bounded, verified M5 log-tail ownership/allocation fixes are in scope when
  measured evidence requires them; they preserve log semantics, reachability,
  cursor/follow behavior, and the 750-line E2E bound.
- The sealed, authorized seven-commit harness-faithfulness amendment set at
  final harness HEAD `7cb02288534e569522c1ca75c9a3e4fa17b1cf4d` is:
  `6a5ae43c2d2786435b88e30b6952929216df886f` (sequential shipped exact-name
  Resource filtering for expected-resource reachability);
  `9d4b7c4ad5437d1e135bd63f5cd0d76c9c0db717`
  (`isolated-forced-gc-v1` retained-heap slope ownership on a fresh
  byte-identical page); `aa2e154a22e61f31a7d58c21848374cd25b95070` (exact
  identity/duplicate, CSS visibility, positive area, Resource logs
  client-window evidence, and corrected historical raw-duration wording);
  `51cb229f995bc06af1b3b91ccb405b3d4b6273db` (fail closed on residual
  nonmatching filter results, browser-viewport clipping, and clipping owners
  within the rendered surface path);
  `bb663ab365dc216eda20ba3a597ee62e2d973c7a` (effective visibility through
  overflow-clipping ancestors above the semantic surface);
  `6bc0eeb203c8568a5284020819ce2b8aa662283b` (scale-gate proof of exact
  `ungrouped:<name>` overview identity after filtering and the uniquely selected
  direct-route sidebar identity using the shared full effective-visibility
  oracle); and `7cb02288534e569522c1ca75c9a3e4fa17b1cf4d` (direct regression
  coverage of the production retained-capture control path, including
  fresh-page/CDP ordering, pre-sample GC, crash/CDP failure propagation, and
  `finally` cleanup). Fixtures, baseline identities and values, expected lists,
  numeric floors, and product hooks remain sealed; this does not authorize
  arbitrary future harness edits.

## Whole-HUD acceptance criteria

- [x] The scale E2E proves global mounted bounds and full far-tail
      filter/direct-route reachability: overview mounts 20 with capacity 12 and
      bound 36; sidebar mounts 21 with capacity 13 and bound 39. The filtered
      occurrence is `ungrouped:uncategorized`, and the direct route has one
      effectively visible selected sidebar identity (REQ-HUDPERF-001..003).
- [x] Every performance cell proves `semantic-route-cycle-v2` 20/20 and, after
      each shipped exact-name Resource filter, exactly one matching
      `[data-name]` that is CSS-visible, positive-area, and intersects the
      browser viewport, Resource logs client window, and every applicable
      ancestor overflow clip; hidden, duplicate, residual nonmatching,
      off-window, viewport-clipped, and ancestor-clipped states fail closed.
      The sole filtered overview resource row is exactly
      `ungrouped:<far-tail>` and the direct route has exactly one exact selected
      sidebar identity under the same rules (REQ-HUDPERF-009).
- [x] The 5 MB/min sustained-memory floor uses only
      `isolated-forced-gc-v1` retained-heap samples, while the timed page keeps
      ambient peak/final heap and DOM-node evidence; production capture-path
      coverage proves fresh-page/CDP ordering, pre-sample GC, error propagation,
      and `finally` cleanup (REQ-HUDPERF-009).
- [x] Keyboard/a11y parity, log-only update isolation, M5 preservation, and
      independent release proof hold (REQ-HUDPERF-004..009).

## Whole-HUD risk

Product implementation is medium UI/accessibility/performance risk; release
verification is high-rigor, not schema/auth/API/infra risk.

## Whole-HUD traceability

Traceability for REQ-HUDPERF-001..009 and REQ-LOGPANE-* is the matrix under
**Test traceability** above. The sealed harness-faithfulness amendment set is
listed under **Whole-HUD decisions**; fixture, baseline, expected-list, numeric
floor, and product-hook mutation remain human-boundary only.
