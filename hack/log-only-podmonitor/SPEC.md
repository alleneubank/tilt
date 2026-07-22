# Log-only PodMonitor performance specification

## Problem and solution

Tilt sends every store change summary to every subscriber. Kubernetes log ingestion produces summaries that can be exactly log-only, but `PodMonitor` currently treats those notifications like rollout changes: it walks all manifest targets and compares pod status values. Under sustained log volume, work unrelated to rollout monitoring becomes a material CPU and allocation cost.

`PodMonitor` must ignore only summaries that are exactly log-only. Summaries that combine logs with any other change must continue through rollout monitoring. A full-path Kubernetes harness measures the behavior from pod log production through Tilt's store subscriber fanout, while focused Go tests protect the summary and status-comparison semantics.

## Domain model

The measured path is:

```text
Kubernetes log producer
  -> PodLogStream ingestion
  -> Store change with ChangeSummary.Log
  -> subscriber fanout
  -> PodMonitor.OnChange
  -> PodMonitor.diff
  -> podStatusesEqual
```

- `store.ChangeSummary` is an aggregate. `Log == true` says logs were added; it does not imply that no other state changed.
- `ChangeSummary.IsLogOnly()` identifies the single exact state `{Log: true}`.
- `PodMonitor` caches the latest relevant `podStatus` per pod and manifest and emits rollout condition logs when those values change.
- The performance harness creates an isolated temporary namespace, stable pod-bearing Tilt resources, a controlled log producer, and a rollout target. It profiles only after the resources are stable.

## Requirements

- **REQ-LPM-001:** `ChangeSummary.IsLogOnly()` returns true only for the exact value `ChangeSummary{Log: true}`; every other summary field retains its zero value.
- **REQ-LPM-002:** `PodMonitor.OnChange` returns without reading or mutating its pod cache for an exact log-only summary.
- **REQ-LPM-003:** A summary containing `Log` plus any other change is processed by `PodMonitor`.
- **REQ-LPM-004:** Explicit pod status equality preserves the prior field semantics for pod ID, manifest name, start time, and every field of the scheduled, initialized, and ready conditions.
- **REQ-LPM-005:** The harness builds the current working-tree Tilt binary and exercises real Kubernetes log ingestion and subscriber fanout; it does not substitute a direct `PodMonitor` benchmark for the full path.
- **REQ-LPM-006:** The harness uses a unique generated namespace and an explicit random Tilt API port, and all Tilt CLI calls target that port.
- **REQ-LPM-007:** The steady-state CPU and allocation profiles include no samples attributed to `PodMonitor.diff` or `podStatusesEqual` after the fix.
- **REQ-LPM-008:** The harness verifies a nonzero runtime log rate. When given a baseline summary, the measured rate must be at least 80% of the baseline rate.
- **REQ-LPM-009:** While the log storm continues, the harness rolls a real Kubernetes Deployment and verifies that Tilt records rollout-monitor output for the new pod.
- **REQ-LPM-010:** Missing or malformed debug vars, profiles, log samples, rollout evidence, or required tooling makes the harness fail closed while retaining available diagnostics.
- **REQ-LPM-011:** The harness emits raw profiles, raw metric samples, `go tool pprof -top -cum` summaries, JSON results, and a Markdown report.
- **REQ-LPM-012:** The harness cleans up only the generated Tilt process, resources, and namespace. It does not inspect, stop, or reconfigure another Tilt instance.
- **REQ-LPM-013:** Every launch of the built Tilt binary runs inside a systemd user scope with a hard memory cap and swap disabled. The server scope's memory is sampled for the whole run; the verdict fails when the sampled peak exceeds the configured bound, when no samples exist, when the scope cgroup cannot be resolved, or when the kernel OOM-kills the scope.
- **REQ-LPM-014:** The harness supports a leak-repro variant: `--stream=true` server mode, configurable storm line size, and a bounded post-profile soak, all judged by the same fixed floors. Every run captures an end-of-run heap profile (`inuse_space`) with a summarized top; a server death during the soak fails closed with the memory samples retained.

## Invariants

- `Log == true` never means "log-only" when another summary field is populated.
- Skipping an exact log-only summary never changes `PodMonitor.pods` or `PodMonitor.trackingStarted`.
- Pod rollout output remains driven by real pod/status changes while logs are flowing.
- The measured Tilt server never runs uncapped on the host.
- The same harness command and fixed floor judge the pre-fix and post-fix trees; only an optional baseline path changes for throughput comparison.
- Reports identify the Git commit and dirty-tree hash of the binary they measured.

## Non-goals

- A generic store-subscriber filtering framework.
- A separate benchmark repository or a mandatory hardware-sensitive CI job.
- Optimizing log storage, Kubernetes watch behavior, or terminal streaming.
- Mutating or restarting the existing localnet Tilt instance on port `25674`.
- Publishing a branch, pull request, release, or deployment.

## Risk tags

- **RISK-INFRA:** The harness creates and deletes a temporary namespace on the selected Kubernetes context. Tilt's existing cluster-safety gate remains authoritative; the generated Tiltfile does not call `allow_k8s_contexts`.
- **RISK-CORRECTNESS:** An over-broad early return could suppress rollout state changes batched with logs. REQ-LPM-001 through REQ-LPM-004 are protected with focused tests before the implementation changes.

## Acceptance criteria

- [x] The fixed harness is observed failing against the pre-fix product tree because the targeted hot path is present.
- [x] Exact and mixed summary tests cover every `ChangeSummary` field.
- [x] Pod status equality tests cover every compared field and time equality semantics.
- [x] Targeted Go tests and benchmarks pass after the product change.
- [x] The fixed harness passes after the product change with nonzero/comparable logs and real rollout evidence.
- [x] The report contains raw and summarized CPU, allocation, debug-vars, log-rate, and rollout artifacts.
- [x] No existing localnet process or namespace is changed.
- [x] The memory floor is observed failing (red) before it is trusted to judge a run.

## Test traceability

- **REQ-LPM-001:** `internal/store/summary_test.go` — `TestChangeSummaryIsLogOnly`
- **REQ-LPM-002, REQ-LPM-003:** `internal/engine/k8srollout/podmonitor_test.go` — `TestMonitorChangeSummaryFiltering`, `TestMonitorMixedLogSummaryPrintsRealPodChange`
- **REQ-LPM-004:** `internal/engine/k8srollout/podmonitor_test.go` — `TestPodStatusesEqual`
- **REQ-LPM-005 through REQ-LPM-012:** `hack/log-only-podmonitor-perf.sh` — fixed full-path verdict and emitted `summary.json`
- **REQ-LPM-013:** `hack/log-only-podmonitor-perf.sh` — `systemd-run` scoped launches, `raw/memory-samples.jsonl`, and `summary.json` `floors.memory_bounded`
- **REQ-LPM-014:** `hack/log-only-podmonitor-perf.sh` — `TILT_STREAM_MODE`/`MEMORY_SOAK_SECONDS`/`LOG_LINE_BYTES`, `raw/heap-after.pprof`, `heap-inuse-top-cum.txt`, and `summary.json` `variant`
