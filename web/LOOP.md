# Loop: log-pane flash under firehose — `master`

Mission: drive this campaign to **interior-green** so the only remaining steps
are the human's boundary calls (ratify floors, push, fork release, monorepo
bump). Work through the ADF loop (SPEC → PLAN → TDD → DEV → E2E). Unblock via
the ladder; the verifier — not confidence — decides when work is done.

**Harness-first law for this campaign:** no product fix lands until the flash
floors have been observed red on the pre-fix tree and the measurement is
committed. Optimizing an unmeasured blink is how M5 almost missed sticky
reflow thrash while long-task duration looked green.

## State (updated 2026-07-23 — interior-green handoff)

- **Terminal: interior-green.** Product fix landed; floors red→green cited;
  adversarial review **APPROVE**; publish/release remain human-only.
- Branch `master`: `fix(web): stop log pane thrash under foreign firehose`
  atop `880747999` docs. Ahead of origin by 2; nothing pushed (publish is
  human).
- **Pre-fix red (Layer A):** FLASH-1 scrollSpy 3 calls; FLASH-2 schedule
  3× `"forward"` on other-manifest firehose. Captured
  `flash-layer-a-red.log`. FLASH-3 already green pre-fix (identity retained).
- **Product fix:** `replaceCompactTail` short-circuits empty+!historyHydrated;
  history path skips schedule when `lines.length === 0`; `renderBuffer`
  calls `scrollCursorIntoView` only when `renderedWork`; schedule only when
  `forwardBuffer.length > 0`.
- **Post-fix green:** OverviewLogPane 63/63 pass
  (`overview-log-pane-tests-final.log`); quiet-firehose 5/5 including
  history-hydrated foreign case; `yarn check` exit 0 (`web-check.log`).
- **E2E:** `log-pane-e2e` with `--assets-dir web/build` + k3d-burst:
  `PASS ... max 750 rendered lines` (`log-pane-e2e.log`).
- **Layer B:** `e2e:log-pane-flash` on steady + `stable-000` + fixed
  production assets: FLASH-1/3/4 all 0, measured true, firehose tail
  32955→34496 (`flash-layer-b.json` / `flash-layer-b-e2e.log`). Logic
  unit tests 5/5. Review REJECT (missing firehose advance) → fixed →
  APPROVE (`flash-layer-b-review-final.md`).
- **Review (product):** adversarial APPROVE (`flash-review.md`);
  post-review suggestion fixups applied; final note
  `flash-review-final.md`. No open bug/major.
- User report context retained: screenshot uncategorized / sticky Initial
  Build / versions 20260713 and 20260722 both in the disease class.

## Decisions (append-only; do not re-litigate)

1. 2026-07-23 — **Flash is defined operationally, not aesthetically.**
   Flash = unintended visual/DOM/scroll churn of the log *content* region
   while the selected resource's store-side log content is stable (no new
   or revised lines for that manifest's spans). The CSS cursor blink on
   `.logEnd` is excluded. Why: a human "it blinks" report is not a gate;
   counters that fail closed are. provisional (driver; human ratifies with
   SPEC floors).
2. 2026-07-23 — **Causal counters before paint metrics.** Floors gate on
   `scrollIntoView` calls, scheduled no-op renders, and `.LogLine`
   childList identity churn — not FPS and not page-level CLS. Why:
   tilt-web-perf BRIEF defers FPS until a priority signal; the signal is
   here, but causal counters attribute the bug classes above and resist
   gaming. Paint-level metrics may inform later; they do not gate v1.
   provisional (driver).
3. 2026-07-23 — **Unit floors first, hermetic e2e second.** Cheap
   `OverviewLogPane` tests observe red and stay the inner loop; a
   quiet-resource-under-firehose probe in tilt-web-perf is the independent
   oracle once unit floors pass. Live localnet numbers inform only (INV-4).
   provisional (driver).
4. 2026-07-23 — **Fix order after red is observed:** (a) no-op
   compact-tail / empty-patch short-circuit, (b) `scrollCursorIntoView`
   only when DOM or scroll intent actually changed, (c) remount vs
   in-place content (if any residual path remains), (d) truncate flash
   only if measured rate warrants product change (reporting first).
   provisional (driver).
5. 2026-07-23 — **Layer B hermetic quiet-window is a gate.** Unit FLASH-1/2/3
   remain the pre-fix red oracle for the compact thrash path; hermetic
   `e2e:log-pane-flash` (steady fixture, `stable-000`, ≥10 s observe,
   FLASH-1/3/4 == 0 + measured:true) is the independent browser oracle.
   Pre-M5 fixture assets can also read zero because they early-return before
   scroll on empty patches — they do not disprove the compact-path bug.
   provisional (driver).

## Flash measurement (the campaign's first product)

### Taxonomy (what we count)

| ID | Class | Sensor | Fail when (quiet selected resource) |
| --- | --- | --- | --- |
| **FLASH-1** | No-op autoscroll | call count of `scrollCursorIntoView` after settle | count > 0 on empty / other-manifest-only updates |
| **FLASH-2** | No-op render schedule | `renderBuffer` / rAF scheduled with zero lines mounted and zero buffer drain | any such schedule after settle |
| **FLASH-3** | Line identity churn | `.LogLine` childList add+remove (or outer-el replace) for unchanged `data-sl-index` set | any remount while store text for those indices is unchanged |
| **FLASH-4** | Unprompted pane scroll | `scroll` events on `[aria-label="Log pane"]` without user wheel/key/Live | count > 0 after settle |
| **FLASH-5** | Truncate wipe | `resetRender` / `LogUpdateAction.truncate` during observe window | reported always; gate only after baseline rate exists (v1 inform) |
| **FLASH-X** | Cursor opacity | CSS animation on `.logEnd` | **never gated** |

"Settle" = initial mount + first successful follow tail render completed;
observe window starts after settle.

### Layer A — unit (inner loop, this repo)

Location: `web/src/OverviewLogPane.test.tsx` (existing component harness
with fake rAF + fake timers already).

**Probe shape (must fail on current master before any fix):**

1. Mount pane on resource `A` with a fixed multi-line log (include at least
   one sticky build-event line). Drain rAF until idle; record
   `scrollCursorIntoView` baseline.
2. Append only resource-`B` segments (or empty patch after checkpoint
   advance) repeatedly past `liveLogReadIntervalMs` and rAF.
3. Assert:
   - **FLASH-1:** `scrollCursorIntoView` call delta == 0
   - **FLASH-2:** no net new `renderBuffer` work that mounts or unmounts
     lines; ideally no `renderBufferRafId` scheduled at all for empty
     compact-tail
   - **FLASH-3:** every mounted `.LogLine` keeps the same outer element
     reference for its `data-sl-index`
4. Separate case: progress-id rewrite on resource `A` → content text
   changes, outer el identity preserved (in-place path), no full
   `replaceChild` detach.
5. Separate case: truncate → `resetRender` allowed; FLASH-5 counter
   increments (document, do not fail the quiet-firehose suite).

**Green means:** the three quiet-firehose asserts above hold; progress
in-place holds; existing REQ-LOGPANE unit suite stays green.

### Layer B — hermetic e2e (independent oracle)

Location: tilt-web-perf `bun run e2e:log-pane-flash` →
`src/log-pane-flash-e2e.ts` (+ pure floors in
`log-pane-flash-e2e-logic.ts`). Release-equivalent / production assets
via `--assets-dir` for gate claims.

**Probe shape (implemented):**

1. Authorized **steady** fixture; open `/r/stable-000/overview` (zero
   post-settle log bytes for that manifest in k3d-steady; firehose is
   `log-storm` + chatty-*).
2. Wait for pane lines; install sensors; settle 2.5 s; arm; observe ≥ 10 s.
3. Floors (fail-closed if sensors missing):
   - FLASH-1 `scrollIntoViewCalls == 0`
   - FLASH-3 `logLineChildListMutations == 0`
   - FLASH-4 `unpromptedScrollEvents == 0`
   - `measured: true`, `installed: true`

**Inform-only in v1:** long-task ms / layout-shift during the quiet window.

### Layer C — how a human confirms the measurement (attended, once)

After unit red is cited: open the monorepo HUD on a quiet resource under
live firehose, Performance panel → look for periodic layout/scroll on
the log pane at ~1 s cadence (matches `liveLogReadIntervalMs`). This
correlates FLASH-1; it does not gate.

### Explicit non-measurements (v1)

- FPS / rAF frame-time histograms (deferred; BRIEF already said so).
- Full-page CLS (sticky headers + legitimate scroll poison the score).
- Pixel/screenshot differencing (flake magnet).
- "Feels better" oracle without counters.

## Work plan (ADF per change)

1. **SPEC** — append flash REQ/floors to `web/SPEC.md` (present-tense
   law) and a provisional Decisions row; mirror e2e floors into
   tilt-web-perf BRIEF when Layer B lands. No product code.
2. **TDD Layer A** — author FLASH-1/2/3 unit tests; run and **cite
   observed red** on current HEAD. Commit tests only if they compile and
   fail for the right reason.
3. **PLAN + DEV fix (a)(b)** — empty-patch / no-op compact-tail
   short-circuit; `scrollCursorIntoView` only on real DOM or scroll
   intent change. Smallest patch that greens Layer A.
4. **TDD progress remount** — if any path still detaches outer els on
   rewrite, fix in-place; else mark Decision "already held on master"
   with cited test.
5. **Layer B probe** — quiet-resource-under-firehose in tilt-web-perf;
   run release-equivalent once; cite green/red.
6. **Layer B** — land and green `e2e:log-pane-flash` on production assets
   + steady fixture; record JSON snapshot.
7. **Regression guard** — existing `yarn test` OverviewLogPane suite +
   `e2e:log-pane` return-to-tail + map floors remain green (no M5
   backslide).
8. **Dissolve** — on ship, migrate floors into SPEC/BRIEF permanently;
   delete this LOOP.md per doctrine.

## Verification floors

- **Flash unit (Layer A):** FLASH-1/2/3 asserts green; output cited in
  State. Pre-fix red must be on record before the fix commit.
- **Log pane correctness:** `cd web && yarn test --watchAll=false --testPathPattern=OverviewLogPane` green;
  existing return-to-tail / ≤750 coverage untouched.
- **Static:** `cd web && yarn check` green on touched files.
- **Flash e2e (Layer B):** `bun run e2e:log-pane-flash -- --assets-dir
  <prod> --fixture fixtures/k3d-steady` → FLASH-1/3/4 == 0,
  `measured: true`.
- **No M5 backslide:** if a release-map cell is re-run, existing
  REQ-PERF-001 absolutes still hold (inform if time-boxed; required
  before a fork release that claims flash-fixed).
- **Review gate:** structured review on every substantive diff;
  severity-floor `major` (reviewer's scale): major+ blocks; max 3
  review→fixup rounds per change. Driver never self-approves.

## Unblocking ladder

Investigate (two focused passes) → doctrine (Decisions here, `web/SPEC.md`
Decisions, tilt-web-perf BRIEF Decisions, `doctrine.md` in the loop-brief
skill, memory) → `rl consult` with evidence + candidates + spec excerpts
→ provisional decision (dated entry above) → accumulate for the human
(irreversible / scope-changing / Boundary items only).

## In-session edit policy

The driver edits directly when the fix is finding-sized (≤ ~2 files,
mechanical, fully understood). After any in-session edit: run the owning
gates, commit conventionally, route through the same review gate — the
driver never self-approves. Larger or design-shaped work goes to a cook
packet. Never mix in-session edits with an in-flight worker on the same
files.

**This campaign's first commits are measurement-only** (SPEC + failing
tests). Product fixes start only after State records the red citation.

## Boundaries — NEVER

- Never push, open PRs, or merge — publish is the human's, per-artifact.
- Never touch live secrets or biometrics; never reroute around auth
  failures — surface and stop.
- Never claim flash fixed without Layer A green + cited pre-fix red.
- Never gate on live localnet alone (INV-4); live informs only.
- Never weaken M5 floors or the 750-line cap to pass flash work.
- Never treat the intentional `.logEnd` opacity animation as a failure.
- Never mutate the shared canton localnet as a fixture source (use
  hermetic replay / unit fakes).
- Never cut a `-fork` release or bump tilt-overlay without human order.

## Known pre-existing failures — do not chase (cited evidence only)

- Cold-start semantic-route-cycle baseline still legacy-driver only
  (`web/SPEC.md` Final release evidence) — out of scope unless flash
  work touches that cell.
- Burst retained heap slopes reported but not gated (short cell) —
  ignore for flash.
- Content-only height shrink without resize/font-scale remains a known
  SPEC non-goal.

## Terminal states & budget

- **done:** Layer A green with pre-fix red on record; product fix for
  FLASH-1/2 landed; progress remount path verified or waived with
  evidence; Layer B either green or explicitly deferred by human with a
  SPEC Decision; M5 non-regression not knowingly broken; LOOP dissolved
  into SPEC/BRIEF. Then stop and write the handoff (release + monorepo
  pin are human).
- **blocked:** numbered decision batch, each with evidence + a proposed
  answer; keep working independent items until only the batch remains.
- **budget:** hard cap **8** iterations for the campaign — or, earlier,
  three consecutive iterations without measurable movement on any
  checklist item → stop honestly with what was tried and why it cannot
  converge.
