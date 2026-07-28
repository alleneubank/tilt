# Log-only PodMonitor performance brief

> Law doc for the log-only PodMonitor path, present-tense, no narrated history — git is the changelog. Amend Decisions and Boundary only with human confirmation; log the rationale. Dated working memory lives beside this file, never inside it.

## Bar

Log ingestion remains healthy under a deterministic Kubernetes log storm without churning pod rollout monitoring, while real rollout changes remain visible.

## Dimensions

- **Path isolation:** Exact log-only summaries do not enter rollout diffing.
- **Correctness:** Mixed summaries and real pod changes retain rollout semantics.
- **Ingestion:** Runtime logs continue to arrive at a comparable rate.
- **Bounded memory:** The measured server's memory stays bounded for the whole run; a leak can never take the host down.
- **Reproducibility:** A generated, isolated workload produces comparable raw evidence from any measured tree.
- **Safety and auditability:** Missing evidence fails closed, reports bind to source state, and cleanup is scoped to generated resources.

## Floors

- **Harness validity:** The same fixed-floor harness observes `PodMonitor.diff` or `podStatusesEqual` in a pre-fix steady-state CPU or allocation profile. The pre-fix run therefore exits nonzero and retains its report.
- **Path isolation:** After the fix, steady-state CPU and allocation-delta summaries generated with `-nodefraction=0 -nodecount=0` contain no sample for the fully qualified `PodMonitor.diff` or `podStatusesEqual` symbols.
- **Correctness:** Package tests prove exact `{Log: true}` summaries skip `PodMonitor`; every mixed summary field continues processing; explicit status comparisons preserve every previous field and time-equality behavior.
- **Ingestion:** The sampled runtime log rate is greater than zero. When a baseline report is supplied, the candidate rate is at least 80% of the baseline.
- **Rollout:** During the continuing storm, a real Deployment restart creates a new pod and Tilt's resource logs contain rollout-monitor output naming that pod.
- **Memory:** The Tilt server runs inside a systemd user scope hard-capped at `TILT_MEMORY_MAX` (default 16G, swap disabled), and the scope's sampled peak memory stays at or below `MAX_TILT_MEMORY_BYTES` (default 2 GiB). Zero samples, an unresolvable scope cgroup, or a kernel OOM kill fails the run.
- **Evidence:** Every successful run contains valid debug-vars snapshots and deltas, CPU and allocation profiles, cumulative pprof summaries, validated JSONL log samples, rollout evidence, `summary.json`, and `report.md`.
- **Isolation:** The run uses a unique namespace, a non-default explicit Tilt port, and the built working-tree binary for every Tilt command; teardown removes only generated state.

Passing these floors licenses the change; it is not a claim about unrelated Tilt performance paths.

## Oracle

The oracle is `hack/log-only-podmonitor-perf.sh` running the same fixed floor against a real Kubernetes log stream before and after the product change. It cannot be satisfied by a unit-test shortcut: the raw pprof and debug-vars artifacts come from the built Tilt server, the JSONL sample comes back through `tilt logs`, and the rollout check names a new pod observed after a real Deployment restart. A required observed pre-fix failure demonstrates that the harness can see the regression it judges.

## Never

- Never treat "contains logs" as "log-only."
- Never skip a summary containing logs plus another state change.
- Never weaken, omit, or fabricate a profile/log/rollout artifact to produce a pass.
- Never use a mocked store path as the full-path performance verdict.
- Never contact the default Tilt port or stop, restart, profile with a new binary, or otherwise mutate the existing localnet.
- Never call `allow_k8s_contexts` from the generated Tiltfile or route around Tilt's cluster-safety decision.
- Never retain generated Kubernetes resources after a normal run.
- Never launch the measured Tilt binary outside a memory-capped systemd user scope.

## Decisions

- The harness lives in this repository; a separate benchmark repository is not part of this change.
- The generated project and YAML are temporary. Only the harness, law documents, tests, and product change are versioned.
- Default runs use `--stream=false`: they profile the core engine path and sample logs with a separate bounded `tilt logs` client. A leak-repro variant (`TILT_STREAM_MODE=true` + `MEMORY_SOAK_SECONDS` + `LOG_LINE_BYTES`) runs the in-process stream path at Canton-scale ingest under the same fixed floors; it exists because that exact configuration leaked to ~90 GB on the host, and it is judged by the memory floor plus an end-of-run inuse_space heap profile. (Human-ratified 2026-07-10.)
- Full-path profile presence is the performance gate; Go benchmarks are supporting diagnostic evidence, not the verdict.
- Profile floors are path-specific and exact. Throughput is comparative because absolute rates vary by machine.
- The baseline throughput floor is 80%, allowing bounded host/cluster variance while rejecting a material ingestion regression.
- The existing localnet on port `25674` is optional read-only confirmation only and is outside the autonomous verifier.
- The memory acceptance floor is the sampled scope peak at or below 2 GiB (>10x observed healthy usage of ~150 MB). The 16G scope cap with swap disabled protects the host and does not judge the change; an OOM kill at the cap is a fail, not a crash. Human-ordered after an uncapped run leaked to ~90 GB and took the host down.
- Build roles are split: dev/working-tree builds carry correctness only (TDD, DEV, E2E-correctness). Performance verdicts and the secondary E2E-perf gate must also hold on the release build that ships to users — the goreleaser-equivalent artifact (release ldflags, `-tags=osusergo`, embedded assets), never a dev-mode build. The working-tree binary this harness builds must match those release flags to count as the perf verdict. (Human-ratified 2026-07-11.)

## Boundary

- Push, pull request, merge, release, and deployment require the human.
- Access to live secrets, biometric approval, or a non-local Kubernetes context requires the human and is not attempted by this harness.
- The existing localnet must not be killed or mutated without explicit approval.
- A missing usable local Kubernetes context is reported as a verification block; the harness does not create a cluster or weaken cluster safety.
