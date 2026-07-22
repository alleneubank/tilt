# Loop: M5.1 log-pane return-to-tail — `fix/log-pane-return-to-tail`

Mission: drive **return-to-tail UX** for the virtualized log pane to
**interior-green** so the only remaining steps are human boundary calls
(merge to `master`, monorepo dogfood sign-off, fork release / overlay pin).
Work through ADF (SPEC → PLAN → TDD → DEV → E2E). Unblock via the ladder; the
verifier — not confidence — decides when work is done.

**Done shape (interior):** after a small upward scroll on a chatty resource,
the user can get back to live logs without fighting a short rendered window —
continuous forward paging and/or one explicit **Live** control — while
preserving M5 bounds (≤750 rendered lines, no PodMonitor-era DOM growth).

## State (updated 2026-07-22 — rewrite each iteration; newest facts first)

- **Terminal: interior-green (`done`).** Branch `fix/log-pane-return-to-tail`
  HEAD `f297ce109` (3 commits on `f362552f6..HEAD`). Nothing pushed.
- Commits:
  1. `395bbebe5` fix(web): return-to-tail for virtualized log pane (M5.1)
  2. `4f3e5cb71` fix(web): keep Live control visible across React re-renders
  3. `f297ce109` fix(web): do not treat underfilled panes as near bottom
- REQ-LOGPANE-007 in `web/SPEC.md`; charter `web/LOOP.md`.
- Floors evidenced:
  - `yarn check` exit 0
  - OverviewLogPane **58/58**; full unit **485/485**
  - `make build-js`; immutable e2e:
    `PASS log pane journey: … → …; max 750 rendered lines`
    (`assets-f297ce109`)
  - `rl review` **APPROVE** (grok structured, job
    `review-1784687347529-6wyw11`, 3 rounds: Live hidden + underfill fixes)
- Product: bottom-edge forward paging/rejoin, Live + End, leave hysteresis,
  expand only at top-boundary hydrate; underfill ≠ near-bottom.
- **Human boundary remaining:** merge to `master`, monorepo dogfood, optional
  `-fork` release + overlay pin. Do not push from this loop.

## Decisions (append-only; do not re-litigate)

1. 2026-07-13 — M5 is a perf pass on existing UX; redesign deferred to M6.
   **ratified (human)** — `web/SPEC.md`.
2. 2026-07-22 — Ship **M5.1 return-to-tail under the existing virtualized
   model**; do **not** wait on M6 redesign for this dogfood failure.
   **ratified (human)** — this session.
3. 2026-07-22 — Scope: must (forward paging, Live, hysteresis); should
   (expand-on-disengage at top boundary); never raise 750 / M6 rewrite.
   **ratified (human)**.
4. 2026-07-22 — Branch `fix/log-pane-return-to-tail`; conventional commits.
   **provisional (driver)**.
5. 2026-07-22 — Review floor approve-unless-High, ≤3 rounds.
   **provisional (driver)** — cleared APPROVE on round 3.
6. 2026-07-22 — Real-browser floor is `e2e:log-pane` return-to-tail.
   **provisional (driver)** — PASS on HEAD assets.
7. 2026-07-22 — Expand only at top-boundary hydrate; `isNearScrollBottom`
   false when clientHeight≤0 or maxScroll===0 (underfill).
   **provisional (driver)** — unit + review findings.

## Work plan (ADF per change)

Complete. Terminal `done`.

## Verification floors

All campaign floors green; evidence under goal scratch + State.

## Unblocking ladder

(standard)

## In-session edit policy

(standard)

## Boundaries — NEVER

- Never push / release / overlay / monorepo pin without human order.
- Never raise 750-line cap or start M6 rewrite under this charter.

## Known pre-existing failures — do not chase (cited evidence only)

- Unrelated monorepo data-api projector errors on dogfood host.
- Cold-start semantic cross-compare gaps in tilt-web-perf (SPEC notes).

## Terminal states & budget

- **done:** yes — checklist complete; nothing pushed.
- **budget:** 10 iterations; used ≤3 substantive review rounds + impl.
