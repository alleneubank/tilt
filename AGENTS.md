# Agent notes — alleneubank/tilt fork

Fork-only working agreement for humans and agents. Not part of upstream
tilt-dev/tilt. Commits that exist only for this fork use the subject prefix
`[fork]` (see below).

## Canonical branch

**`master` is the sole product line of this fork.**

- Develop, dogfood, and cut `-fork` releases from `master`.
- Do not keep a parallel long-lived product branch (the old `fork` branch was
  packaging-only and is no longer the source of truth).
- Remote: `github.com/alleneubank/tilt` (`origin`). Upstream is
  `github.com/tilt-dev/tilt` (`upstream`).

```text
upstream/master     # tilt-dev product
       │
       └── origin/master   # this fork: upstreamable work + [fork]-only commits
                │
                └── pr/*   # short-lived branches for specific upstream PRs
```

## Commit subjects: what is for upstream?

| Subject style | Meaning |
|---------------|---------|
| Normal conventional commits (`feat:`, `fix:`, `perf:`, …) | **Candidates for upstream** when proven. Cherry-pick or re-cut onto `upstream/master` as a focused PR branch. |
| **`[fork] …`** | **Not for upstream.** Packaging, overlay release plumbing, this file, or other fork-only policy. |

Examples:

- `fix(store): bound pre-reducer log ingress` — may go upstream when ready.
- `[fork] hack: linux/amd64 -fork release script for overlay consumption` — stays on the fork forever.
- `[fork] docs: add AGENTS.md for fork workflow` — stays on the fork forever.

Agents must not open or prepare an upstream PR that includes `[fork]` commits
unless the human explicitly rewrites scope.

## Upstreaming workflow

1. Prove the change on **this** `master` (tests, soak, dogfood as appropriate).
2. Cut a **short-lived** branch from current `upstream/master` (not from a
   stale base).
3. Cherry-pick **only** the non-`[fork]` commits for that feature (or re-apply
   the same patch-id blobs). One concern per PR when possible.
4. Open the PR against **tilt-dev/tilt**. Do not open a megapr of all fork
   commits.
5. Leave unready work (e.g. large web virtualization) on `master` until
   deliberately sliced.

Publish (push to deploy-tracked refs, `hack/release-fork.sh --publish`, overlay
bumps, upstream merge) remains a **human boundary**.

## Releases (fork distribution)

- Script: `hack/release-fork.sh` (dry run by default; `--publish` is human-only).
- Tags: `v<base>-fork.<date>.g<sha>` (SemVer prerelease; not GitHub “latest”).
- Consumers: `tilt-overlay` pins fork versions explicitly.

## Working rules for agents

- Default checkout and PR base for fork work: **`master`**.
- Keep `upstream/master..master` readable: prefer small, reviewable commits;
  do not mix unrelated features in one commit.
- When rewriting history on this fork, preserve `[fork]` vs upstreamable
  distinction in subjects.
- Do not delete or rewrite published `-fork` release tags without explicit
  human order.
- `web/SPEC.md` and other product contracts for in-flight work may live on
  `master` without a `[fork]` prefix when they describe code that might later
  be upstreamed; pure process docs for the fork use `[fork]`.
