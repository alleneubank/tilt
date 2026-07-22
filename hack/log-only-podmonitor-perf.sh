#!/usr/bin/env bash

# Exercises the full Kubernetes log-ingestion -> store fanout -> PodMonitor path.
# The fixed-tree floor is intentionally invariant: this script must fail on the
# pre-fix tree and pass after exact log-only summaries bypass PodMonitor.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT

RESOURCE_COUNT="${RESOURCE_COUNT:-48}"
LOG_REPLICAS="${LOG_REPLICAS:-2}"
LOG_LINES_PER_BATCH="${LOG_LINES_PER_BATCH:-100}"
LOG_BATCH_INTERVAL="${LOG_BATCH_INTERVAL:-0.02}"
PROFILE_SECONDS="${PROFILE_SECONDS:-15}"
READY_TIMEOUT="${READY_TIMEOUT:-240s}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-180s}"
CLEANUP_TIMEOUT="${CLEANUP_TIMEOUT:-180s}"
SERVER_WAIT_SECONDS="${SERVER_WAIT_SECONDS:-180}"
LOG_IMAGE="${LOG_IMAGE:-busybox:1.36.1}"
MIN_BASELINE_RATE_RATIO="${MIN_BASELINE_RATE_RATIO:-0.80}"
# An uncapped logstore leak under this firehose once reached ~90GB and took
# the host down. The scope cap protects the host; the acceptance floor judges
# the change. Healthy runs sit near 150MB, so 2GiB is >10x headroom.
TILT_MEMORY_MAX="${TILT_MEMORY_MAX:-16G}"
MAX_TILT_MEMORY_BYTES="${MAX_TILT_MEMORY_BYTES:-2147483648}"
MEMORY_SAMPLE_INTERVAL="${MEMORY_SAMPLE_INTERVAL:-2}"
# Leak-repro variant knobs. The 2026-07-10 host takedown ran --stream=true
# against Canton-scale logs (multi-KB lines, ~11MB/s) for hours; the default
# engine-path run cannot see a retention bug on that path. Stream mode runs
# the TerminalStream subscriber in-process, LOG_LINE_BYTES scales bytes/s,
# and the soak gives retention time to cross the memory floor.
TILT_STREAM_MODE="${TILT_STREAM_MODE:-false}"
MEMORY_SOAK_SECONDS="${MEMORY_SOAK_SECONDS:-0}"
LOG_LINE_BYTES="${LOG_LINE_BYTES:-32}"
# tilt logs consumes the same /ws/view websocket a browser does
# (hud/client/log_streamer.go), so soak view clients stand in for open web
# UI tabs — an ingredient of the host takedown the storm alone lacks.
SOAK_VIEW_CLIENTS="${SOAK_VIEW_CLIENTS:-0}"

OUTPUT_DIR=""
BASELINE_SUMMARY=""
KUBE_CONTEXT=""

WORK_DIR=""
PROJECT_DIR=""
TILT_BIN=""
TILT_PID=""
TILT_SCOPE_UNIT=""
TILT_CGROUP_DIR=""
MEM_SAMPLER_PID=""
SOAK_CLIENT_PIDS=""
LOG_PID=""
NAMESPACE=""
PORT=""
CLEANED=0
CLEANUP_OK=0
FAILURE_RECORDED=0
ASSET_INDEX_CREATED=0
ASSET_INDEX_PATH=""

usage() {
  cat <<'EOF'
Usage: hack/log-only-podmonitor-perf.sh [options]

Builds the current Tilt working tree, runs an isolated Kubernetes log storm,
captures full-path CPU/allocation/debug-vars evidence, and verifies that real
rollout monitoring remains visible.

Options:
  --output DIR             Report directory (default: timestamped ignored path)
  --baseline SUMMARY.json  Compare runtime log rate with a previous report
  --context NAME           Kubernetes context (default: current context)
  --resource-count N       Stable pod-bearing Tilt resources (default: 48)
  --profile-seconds N      Steady-state CPU sample duration (default: 15)
  --help                    Show this help

Environment overrides:
  LOG_REPLICAS, LOG_LINES_PER_BATCH, LOG_BATCH_INTERVAL, LOG_IMAGE,
  READY_TIMEOUT, ROLLOUT_TIMEOUT, CLEANUP_TIMEOUT, SERVER_WAIT_SECONDS,
  MIN_BASELINE_RATE_RATIO, TILT_MEMORY_MAX, MAX_TILT_MEMORY_BYTES,
  MEMORY_SAMPLE_INTERVAL, TILT_STREAM_MODE, MEMORY_SOAK_SECONDS,
  LOG_LINE_BYTES, SOAK_VIEW_CLIENTS

Leak-repro variant: TILT_STREAM_MODE=true runs the server with --stream=true
(the in-process TerminalStream path that took the host down on 2026-07-10),
LOG_LINE_BYTES pads storm lines toward Canton-scale ingest, and
MEMORY_SOAK_SECONDS holds the storm after profiling so retention can cross
the memory floor. The same fixed floors judge variant runs; a heap profile
(inuse_space) is captured at the end of every run.

Every launch of the built Tilt binary runs inside a systemd user scope with a
hard memory cap (MemoryMax=TILT_MEMORY_MAX, swap disabled) so a leak cannot
take the host down. The server scope's peak memory is sampled for the whole
run and must stay at or below MAX_TILT_MEMORY_BYTES for the verdict to pass.

The generated Tiltfile deliberately does not call allow_k8s_contexts. Tilt's
normal cluster-safety gate remains authoritative. No existing Tilt port or
process is inspected or changed.
EOF
}

while (($# > 0)); do
  case "$1" in
    --output)
      OUTPUT_DIR="${2:?--output requires a directory}"
      shift 2
      ;;
    --baseline)
      BASELINE_SUMMARY="${2:?--baseline requires a summary.json path}"
      shift 2
      ;;
    --context)
      KUBE_CONTEXT="${2:?--context requires a context name}"
      shift 2
      ;;
    --resource-count)
      RESOURCE_COUNT="${2:?--resource-count requires an integer}"
      shift 2
      ;;
    --profile-seconds)
      PROFILE_SECONDS="${2:?--profile-seconds requires an integer}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'required command not found: %s\n' "$1" >&2
    exit 1
  fi
}

sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
    return
  fi
  printf 'required command not found: sha256sum or shasum\n' >&2
  return 1
}

for command_name in awk bash curl git go jq kubectl python3 systemd-run systemctl; do
  require_command "$command_name"
done

if ! [[ "$RESOURCE_COUNT" =~ ^[1-9][0-9]*$ ]]; then
  printf 'resource count must be a positive integer: %s\n' "$RESOURCE_COUNT" >&2
  exit 2
fi
if ! [[ "$PROFILE_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  printf 'profile seconds must be a positive integer: %s\n' "$PROFILE_SECONDS" >&2
  exit 2
fi
if ! jq -en --arg ratio "$MIN_BASELINE_RATE_RATIO" '($ratio | tonumber) > 0 and ($ratio | tonumber) <= 1' >/dev/null; then
  printf 'MIN_BASELINE_RATE_RATIO must be in (0, 1]: %s\n' "$MIN_BASELINE_RATE_RATIO" >&2
  exit 2
fi
if ! [[ "$TILT_MEMORY_MAX" =~ ^[1-9][0-9]*[KMGT]?$ ]]; then
  printf 'TILT_MEMORY_MAX must be a positive size with an optional K/M/G/T suffix: %s\n' "$TILT_MEMORY_MAX" >&2
  exit 2
fi
if ! [[ "$MAX_TILT_MEMORY_BYTES" =~ ^[1-9][0-9]*$ ]]; then
  printf 'MAX_TILT_MEMORY_BYTES must be a positive integer byte count: %s\n' "$MAX_TILT_MEMORY_BYTES" >&2
  exit 2
fi
if ! jq -en --arg interval "$MEMORY_SAMPLE_INTERVAL" '($interval | tonumber) > 0' >/dev/null; then
  printf 'MEMORY_SAMPLE_INTERVAL must be a positive number of seconds: %s\n' "$MEMORY_SAMPLE_INTERVAL" >&2
  exit 2
fi
if ! [[ "$TILT_STREAM_MODE" =~ ^(true|false)$ ]]; then
  printf 'TILT_STREAM_MODE must be true or false: %s\n' "$TILT_STREAM_MODE" >&2
  exit 2
fi
if ! [[ "$MEMORY_SOAK_SECONDS" =~ ^(0|[1-9][0-9]*)$ ]]; then
  printf 'MEMORY_SOAK_SECONDS must be a non-negative integer: %s\n' "$MEMORY_SOAK_SECONDS" >&2
  exit 2
fi
if ! [[ "$LOG_LINE_BYTES" =~ ^[1-9][0-9]*$ ]] || ((LOG_LINE_BYTES > 16384)); then
  printf 'LOG_LINE_BYTES must be a positive integer no greater than 16384: %s\n' "$LOG_LINE_BYTES" >&2
  exit 2
fi
if ! [[ "$SOAK_VIEW_CLIENTS" =~ ^[0-9]+$ ]] || ((SOAK_VIEW_CLIENTS > 8)); then
  printf 'SOAK_VIEW_CLIENTS must be an integer in [0, 8]: %s\n' "$SOAK_VIEW_CLIENTS" >&2
  exit 2
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
readonly RUN_ID
if [[ -z "$OUTPUT_DIR" ]]; then
  OUTPUT_DIR="${REPO_ROOT}/hack/log-only-podmonitor/reports/${RUN_ID}"
fi
if [[ -e "$OUTPUT_DIR" ]]; then
  if [[ ! -d "$OUTPUT_DIR" ]] || [[ -n "$(find "$OUTPUT_DIR" -mindepth 1 -print -quit)" ]]; then
    printf 'refusing to overwrite non-empty report path: %s\n' "$OUTPUT_DIR" >&2
    exit 2
  fi
fi
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
readonly RAW_DIR="${OUTPUT_DIR}/raw"
mkdir -p "$RAW_DIR"

record_failure() {
  local message="$1"
  FAILURE_RECORDED=1
  printf '%s\n' "$message" | tee -a "${OUTPUT_DIR}/failure.txt" >&2
}

on_error() {
  local line="$1"
  local status="$2"
  # The ERR trap fires even where errexit is disabled, and set +e regions
  # (stop_process, cleanup) run commands that fail on purpose — e.g. wait on
  # a TERMed scope wrapper returns 143. Recording those would both stamp a
  # spurious failure into a passing report and consume the one-shot failure
  # record before a real failure could claim it.
  case "$-" in
    *e*) ;;
    *) return 0 ;;
  esac
  if ((FAILURE_RECORDED == 0)); then
    record_failure "harness command failed at line ${line} with exit status ${status}"
  fi
}

write_incomplete_report() {
  local status="$1"
  if [[ -f "${OUTPUT_DIR}/summary.json" ]]; then
    return
  fi

  local failure_message="harness did not complete"
  if [[ -s "${OUTPUT_DIR}/failure.txt" ]]; then
    failure_message="$(<"${OUTPUT_DIR}/failure.txt")"
  fi

  local git_head="unknown"
  if [[ -s "${RAW_DIR}/git-head.txt" ]]; then
    git_head="$(<"${RAW_DIR}/git-head.txt")"
  else
    git_head="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')"
  fi

  jq -n \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg gitHead "$git_head" \
    --arg context "$KUBE_CONTEXT" \
    --arg namespace "$NAMESPACE" \
    --arg failure "$failure_message" \
    --argjson exitStatus "$status" \
    --argjson cleanupOK "$CLEANUP_OK" '
    {
      schema_version: 1,
      verdict: "fail",
      timestamp: $timestamp,
      source: {git_head: $gitHead},
      target: {kubernetes_context: $context, namespace: $namespace},
      failure: {exit_status: $exitStatus, message: $failure},
      floors: {
        harness_completed: false,
        hot_path_absent: false,
        log_rate_nonzero: false,
        baseline_rate_comparable: false,
        rollout_observed: false,
        memory_bounded: false,
        artifacts_complete: false,
        cleanup_complete: ($cleanupOK == 1)
      }
    }
  ' >"${OUTPUT_DIR}/summary.json"

  cat >"${OUTPUT_DIR}/report.md" <<EOF
# Log-only PodMonitor performance report

- Verdict: **fail**
- Git HEAD: \`${git_head}\`
- Kubernetes context: \`${KUBE_CONTEXT}\`
- Generated namespace: \`${NAMESPACE}\`
- Exit status: ${status}
- Failure: ${failure_message}
- Generated state cleaned up: ${CLEANUP_OK}

The harness failed closed before all measurement floors could run. Available
diagnostics are retained under \`raw/\` and in \`failure.txt\`.
EOF
}

# Every launch of the measured binary rides inside a memory-capped systemd
# user scope. The cap is host protection, not the acceptance floor: the floor
# is the sampled peak below. Swap is disabled so the cap cannot be routed
# around through swap-thrash.
tilt_scoped() {
  systemd-run --user --scope --quiet \
    --property=MemoryMax="$TILT_MEMORY_MAX" \
    --property=MemorySwapMax=0 \
    env TILT_DISABLE_ANALYTICS=1 "$TILT_BIN" "$@"
}

# Appends one JSONL record per interval with the scope's current and peak
# memory plus the kernel oom_kill count. The cgroup files disappear as soon
# as the scope dies, so the running peak must be persisted here rather than
# read once at the end.
sample_scope_memory() {
  local cgroup_dir="$1"
  local out_file="$2"
  local interval="$3"
  local epoch current peak oom
  while [[ -f "${cgroup_dir}/memory.current" ]]; do
    epoch="$(date +%s)"
    current="$(cat "${cgroup_dir}/memory.current" 2>/dev/null || true)"
    [[ -n "$current" ]] || break
    peak="$(cat "${cgroup_dir}/memory.peak" 2>/dev/null || true)"
    [[ -n "$peak" ]] || peak="$current"
    oom="$(awk '$1 == "oom_kill" {print $2}' "${cgroup_dir}/memory.events" 2>/dev/null || true)"
    [[ -n "$oom" ]] || oom=0
    printf '{"epoch":%s,"memory_current_bytes":%s,"memory_peak_bytes":%s,"oom_kills":%s}\n' \
      "$epoch" "$current" "$peak" "$oom" >>"$out_file"
    sleep "$interval"
  done
}

stop_process() {
  local pid="$1"
  if [[ -z "$pid" ]] || ! kill -0 "$pid" >/dev/null 2>&1; then
    return 0
  fi

  kill -TERM "$pid" >/dev/null 2>&1 || true

  # A watchdog keeps cleanup bounded without relying on platform-specific
  # timeout(1). It is canceled as soon as the child exits normally.
  (
    sleep 10
    kill -KILL "$pid" >/dev/null 2>&1 || true
  ) &
  local watchdog_pid=$!

  set +e
  wait "$pid" >/dev/null 2>&1
  set -e
  kill "$watchdog_pid" >/dev/null 2>&1 || true
  wait "$watchdog_pid" >/dev/null 2>&1 || true
}

cleanup() {
  if ((CLEANED == 1)); then
    return 0
  fi

  set +e
  local cleanup_status=0

  if [[ -n "$MEM_SAMPLER_PID" ]]; then
    stop_process "$MEM_SAMPLER_PID"
    MEM_SAMPLER_PID=""
  fi
  if [[ -n "$SOAK_CLIENT_PIDS" ]]; then
    for soak_client_pid in $SOAK_CLIENT_PIDS; do
      stop_process "$soak_client_pid"
    done
    SOAK_CLIENT_PIDS=""
  fi
  if [[ -n "$LOG_PID" ]]; then
    stop_process "$LOG_PID"
    LOG_PID=""
  fi
  if [[ -n "$TILT_PID" ]]; then
    stop_process "$TILT_PID"
    TILT_PID=""
  fi

  if [[ -n "$TILT_BIN" && -x "$TILT_BIN" && -n "$PROJECT_DIR" && -f "${PROJECT_DIR}/Tiltfile" && -n "$KUBE_CONTEXT" ]]; then
    if ! (
      cd "$PROJECT_DIR"
      tilt_scoped down \
        --context="$KUBE_CONTEXT" \
        --delete-namespaces \
        --file="${PROJECT_DIR}/Tiltfile"
    ) >>"${RAW_DIR}/cleanup.log" 2>&1; then
      cleanup_status=1
    fi
  fi

  if [[ -n "$NAMESPACE" && -n "$KUBE_CONTEXT" ]]; then
    if ! kubectl --context="$KUBE_CONTEXT" wait \
      --for=delete "namespace/${NAMESPACE}" \
      --timeout="$CLEANUP_TIMEOUT" >>"${RAW_DIR}/cleanup.log" 2>&1; then
      cleanup_status=1
    fi
  fi

  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    rm -rf "$WORK_DIR"
  fi
  if ((ASSET_INDEX_CREATED == 1)) && [[ -n "$ASSET_INDEX_PATH" && -f "$ASSET_INDEX_PATH" ]]; then
    rm -f "$ASSET_INDEX_PATH"
  fi

  CLEANED=1
  if ((cleanup_status == 0)); then
    CLEANUP_OK=1
  fi
  set -e
  return "$cleanup_status"
}

on_exit() {
  local status=$?
  trap - EXIT
  if ((status != 0 && FAILURE_RECORDED == 0)); then
    record_failure "harness exited with status ${status}"
  fi
  cleanup || true
  if ((status != 0)); then
    write_incomplete_report "$status"
  fi
  exit "$status"
}

trap 'on_error "$LINENO" "$?"' ERR
trap on_exit EXIT
trap 'exit 130' INT TERM

if [[ -n "$BASELINE_SUMMARY" ]]; then
  if [[ ! -f "$BASELINE_SUMMARY" ]]; then
    record_failure "baseline summary not found: ${BASELINE_SUMMARY}"
    exit 1
  fi
  jq -e '.measurements.log_records_per_second | numbers' "$BASELINE_SUMMARY" >/dev/null || {
    record_failure "baseline summary has no numeric log rate: ${BASELINE_SUMMARY}"
    exit 1
  }
fi

if [[ -z "$KUBE_CONTEXT" ]]; then
  KUBE_CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
fi
if [[ -z "$KUBE_CONTEXT" ]]; then
  record_failure "no Kubernetes context selected; pass --context or configure a current context"
  exit 1
fi

# Fail closed before building anything: if a memory-capped user scope cannot
# be created, the harness must refuse to launch Tilt uncapped rather than run
# the firehose against the bare host.
if ! systemd-run --user --scope --quiet \
  --property=MemoryMax="$TILT_MEMORY_MAX" \
  --property=MemorySwapMax=0 \
  true >/dev/null 2>&1; then
  record_failure "systemd-run cannot create a memory-capped user scope; refusing to launch Tilt uncapped"
  exit 1
fi

# This is a read-only live-state preflight. The generated Namespace is not
# submitted until Tilt has evaluated its normal cluster-safety gate.
kubectl --context="$KUBE_CONTEXT" version \
  --request-timeout=10s \
  -o json >"${RAW_DIR}/kubectl-version.json" || {
  record_failure "Kubernetes context is not reachable: ${KUBE_CONTEXT}"
  exit 1
}

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tilt-log-only-podmonitor.XXXXXX")"
PROJECT_DIR="${WORK_DIR}/project"
TILT_BIN="${WORK_DIR}/bin/tilt"
mkdir -p "$PROJECT_DIR" "$(dirname "$TILT_BIN")"

RUN_ID_LOWER="$(printf '%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]')"
NAMESPACE="tilt-logonly-perf-${RUN_ID_LOWER}"
# Kubernetes names are limited to 63 characters. The prefix carries the
# surface identity; the suffix keeps concurrent runs isolated.
NAMESPACE="${NAMESPACE:0:63}"
PORT="$(python3 - <<'PY'
import socket

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"

cat >"${PROJECT_DIR}/Tiltfile" <<'EOF'
# Generated by hack/log-only-podmonitor-perf.sh.
# Cluster safety remains enabled: do not add allow_k8s_contexts here.
k8s_yaml('workload.yaml')
EOF

# The payload is expanded once into the pod args, so line size costs the
# storm loop nothing extra at runtime.
LOG_PAYLOAD="$(printf 'x%.0s' $(seq 1 "$LOG_LINE_BYTES"))"

cat >"${PROJECT_DIR}/workload.yaml" <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: ${NAMESPACE}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: log-storm
  namespace: ${NAMESPACE}
spec:
  replicas: ${LOG_REPLICAS}
  selector:
    matchLabels:
      app: log-storm
  template:
    metadata:
      labels:
        app: log-storm
    spec:
      terminationGracePeriodSeconds: 0
      containers:
      - name: log-storm
        image: ${LOG_IMAGE}
        imagePullPolicy: IfNotPresent
        command: ["sh", "-c"]
        args:
        - |
          batch=0
          while true; do
            batch=\$((batch + 1))
            line=0
            while [ "\$line" -lt ${LOG_LINES_PER_BATCH} ]; do
              printf 'log-storm pod=%s batch=%d line=%d payload=${LOG_PAYLOAD}\\n' "\$HOSTNAME" "\$batch" "\$line"
              line=\$((line + 1))
            done
            sleep ${LOG_BATCH_INTERVAL}
          done
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: rollout-target
  namespace: ${NAMESPACE}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: rollout-target
  template:
    metadata:
      labels:
        app: rollout-target
    spec:
      terminationGracePeriodSeconds: 0
      containers:
      - name: rollout-target
        image: ${LOG_IMAGE}
        imagePullPolicy: IfNotPresent
        command: ["sh", "-c"]
        args: ["while true; do sleep 3600; done"]
EOF

for ((index = 0; index < RESOURCE_COUNT; index++)); do
  printf -v resource_name 'stable-%03d' "$index"
  cat >>"${PROJECT_DIR}/workload.yaml" <<EOF
---
apiVersion: v1
kind: Pod
metadata:
  name: ${resource_name}
  namespace: ${NAMESPACE}
  labels:
    app: ${resource_name}
spec:
  terminationGracePeriodSeconds: 0
  containers:
  - name: stable
    image: ${LOG_IMAGE}
    imagePullPolicy: IfNotPresent
    command: ["sh", "-c"]
    args: ["while true; do sleep 3600; done"]
EOF
done

cp "${PROJECT_DIR}/Tiltfile" "${RAW_DIR}/Tiltfile"
cp "${PROJECT_DIR}/workload.yaml" "${RAW_DIR}/workload.yaml"

git -C "$REPO_ROOT" rev-parse HEAD >"${RAW_DIR}/git-head.txt"
{
  git -C "$REPO_ROOT" diff --no-ext-diff --binary HEAD
  while IFS= read -r -d '' untracked_path; do
    printf '\0%s\0' "$untracked_path"
    cat "${REPO_ROOT}/${untracked_path}"
  done < <(git -C "$REPO_ROOT" ls-files --others --exclude-standard -z)
} | sha256_stream >"${RAW_DIR}/git-diff.sha256"
git -C "$REPO_ROOT" status --short >"${RAW_DIR}/git-status.txt"

# A clean source archive may omit ignored frontend build output. The server
# only needs an index to expose the debug/API endpoints used by this harness;
# create a temporary minimal embedded asset and remove it during cleanup.
ASSET_INDEX_PATH="${REPO_ROOT}/pkg/assets/build/index.html"
if [[ ! -s "$ASSET_INDEX_PATH" ]]; then
  mkdir -p "$(dirname "$ASSET_INDEX_PATH")"
  printf '%s\n' '<!doctype html><html><head><title>Tilt harness</title></head><body>log-only PodMonitor perf harness</body></html>' >"$ASSET_INDEX_PATH"
  ASSET_INDEX_CREATED=1
fi

jq -n \
  --arg context "$KUBE_CONTEXT" \
  --arg namespace "$NAMESPACE" \
  --arg image "$LOG_IMAGE" \
  --argjson port "$PORT" \
  --argjson resources "$RESOURCE_COUNT" \
  --argjson replicas "$LOG_REPLICAS" \
  --argjson linesPerBatch "$LOG_LINES_PER_BATCH" \
  --arg batchInterval "$LOG_BATCH_INTERVAL" \
  --argjson profileSeconds "$PROFILE_SECONDS" \
  --arg minBaselineRateRatio "$MIN_BASELINE_RATE_RATIO" \
  --arg tiltMemoryMax "$TILT_MEMORY_MAX" \
  --argjson maxTiltMemoryBytes "$MAX_TILT_MEMORY_BYTES" \
  --arg memorySampleInterval "$MEMORY_SAMPLE_INTERVAL" \
  --argjson streamMode "$TILT_STREAM_MODE" \
  --argjson memorySoakSeconds "$MEMORY_SOAK_SECONDS" \
  --argjson logLineBytes "$LOG_LINE_BYTES" \
  --argjson soakViewClients "$SOAK_VIEW_CLIENTS" \
  '{
    context: $context,
    namespace: $namespace,
    image: $image,
    port: $port,
    stable_resource_count: $resources,
    log_replicas: $replicas,
    log_lines_per_batch: $linesPerBatch,
    log_batch_interval_seconds: ($batchInterval | tonumber),
    profile_seconds: $profileSeconds,
    min_baseline_rate_ratio: ($minBaselineRateRatio | tonumber),
    tilt_memory_max: $tiltMemoryMax,
    max_tilt_memory_bytes: $maxTiltMemoryBytes,
    memory_sample_interval_seconds: ($memorySampleInterval | tonumber),
    stream_mode: $streamMode,
    memory_soak_seconds: $memorySoakSeconds,
    log_line_bytes: $logLineBytes,
    soak_view_clients: $soakViewClients
  }' >"${RAW_DIR}/config.json"

printf 'Building Tilt from %s\n' "$(<"${RAW_DIR}/git-head.txt")"
(
  cd "$REPO_ROOT"
  # The harness records Git state separately; disabling VCS stamping keeps
  # detached/archive worktrees reproducible across Go toolchain versions.
  go build -buildvcs=false -mod=vendor -o "$TILT_BIN" ./cmd/tilt
) >"${RAW_DIR}/build.log" 2>&1

printf 'Starting isolated Tilt on port %s in namespace %s (MemoryMax=%s)\n' "$PORT" "$NAMESPACE" "$TILT_MEMORY_MAX"
TILT_SCOPE_UNIT="tilt-logonly-${RUN_ID_LOWER}.scope"
(
  cd "$PROJECT_DIR"
  # In stream mode the entire storm is printed to stdout — that in-process
  # print path is what is under test, but persisting it would write GBs of
  # generated bytes with no evidentiary value. Errors stay in tilt-up.log.
  if [[ "$TILT_STREAM_MODE" == "true" ]]; then
    exec >/dev/null
  fi
  # The server gets a named scope (unlike tilt_scoped) so its cgroup can be
  # resolved for memory sampling. TERM to the systemd-run wrapper tears down
  # the whole scope, so stop_process keeps working unchanged.
  exec env TILT_DISABLE_ANALYTICS=1 systemd-run --user --scope --quiet \
    --unit="$TILT_SCOPE_UNIT" \
    --property=MemoryMax="$TILT_MEMORY_MAX" \
    --property=MemorySwapMax=0 \
    "$TILT_BIN" up \
    --context="$KUBE_CONTEXT" \
    --file="${PROJECT_DIR}/Tiltfile" \
    --host=127.0.0.1 \
    --legacy=false \
    --port="$PORT" \
    --stream="$TILT_STREAM_MODE" \
    --web-mode=prod
) >"${RAW_DIR}/tilt-up.log" 2>&1 &
TILT_PID=$!

# The memory floor is fail-closed: no resolvable scope cgroup means no
# verdict, not an unmeasured pass.
for _ in $(seq 1 50); do
  scope_cgroup="$(systemctl --user show "$TILT_SCOPE_UNIT" -p ControlGroup --value 2>/dev/null || true)"
  if [[ -n "$scope_cgroup" && -f "/sys/fs/cgroup${scope_cgroup}/memory.current" ]]; then
    TILT_CGROUP_DIR="/sys/fs/cgroup${scope_cgroup}"
    break
  fi
  sleep 0.2
done
if [[ -z "$TILT_CGROUP_DIR" ]]; then
  record_failure "could not resolve the Tilt server scope cgroup for memory accounting; see raw/tilt-up.log"
  exit 1
fi

sample_scope_memory "$TILT_CGROUP_DIR" "${RAW_DIR}/memory-samples.jsonl" "$MEMORY_SAMPLE_INTERVAL" &
MEM_SAMPLER_PID=$!

readonly TILT_URL="http://127.0.0.1:${PORT}"
curl --fail --silent --show-error \
  --connect-timeout 1 \
  --max-time 2 \
  --retry "$SERVER_WAIT_SECONDS" \
  --retry-all-errors \
  --retry-delay 1 \
  --retry-max-time "$SERVER_WAIT_SECONDS" \
  "${TILT_URL}/healthz" >"${RAW_DIR}/healthz.txt" || {
  record_failure "Tilt server did not become healthy; see raw/tilt-up.log"
  exit 1
}

# The (Tiltfile) uiresource is created shortly after the server starts
# answering healthz; wait reports NotFound as an immediate error rather than
# blocking, so NotFound is retried as "not yet" up to READY_TIMEOUT while any
# other failure stays fatal.
TILTFILE_WAIT_DEADLINE="$((SECONDS + ${READY_TIMEOUT%s}))"
until tilt_scoped wait \
  --port="$PORT" \
  --timeout="$READY_TIMEOUT" \
  --for=condition=Ready \
  'uiresource/(Tiltfile)' >"${RAW_DIR}/wait-tiltfile.log" 2>&1; do
  if ! grep -q 'NotFound' "${RAW_DIR}/wait-tiltfile.log" || ((SECONDS >= TILTFILE_WAIT_DEADLINE)); then
    record_failure "Tiltfile uiresource never became Ready; see raw/wait-tiltfile.log"
    exit 1
  fi
  sleep 1
done

# Once the Tiltfile is Ready, the cluster safety check has passed and every
# generated resource is known. One bounded all-resource wait avoids declaring
# steady state while a stable pod can still emit a rollout notification.
tilt_scoped wait \
  --port="$PORT" \
  --timeout="$READY_TIMEOUT" \
  --for=condition=Ready \
  uiresource \
  --all >"${RAW_DIR}/wait-uiresources.log" 2>&1

tilt_scoped get uiresources \
  --port="$PORT" \
  -o json >"${RAW_DIR}/uiresources.json"

jq -e --argjson minimum "$((RESOURCE_COUNT + 2))" '
  ([.items[].metadata.name] | index("log-storm")) != null and
  ([.items[].metadata.name] | index("rollout-target")) != null and
  ([.items[] | select(.metadata.name != "(Tiltfile)")] | length) >= $minimum and
  ([.items[] | select(
    .status.runtimeStatus == "error" or
    .status.updateStatus == "error" or
    .status.composeResourceInfo.healthStatus == "unhealthy"
  )] | length) == 0
' "${RAW_DIR}/uiresources.json" >/dev/null || {
  record_failure "Tilt resources are missing or unhealthy; see raw/uiresources.json"
  exit 1
}

kubectl --context="$KUBE_CONTEXT" --namespace="$NAMESPACE" wait \
  --for=condition=Ready pod \
  --all \
  --timeout="$READY_TIMEOUT" >"${RAW_DIR}/wait-pods.log" 2>&1

curl --fail --silent --show-error "${TILT_URL}/debug/vars" >"${RAW_DIR}/vars-before.json"
jq -e '.memstats | .TotalAlloc, .Mallocs, .NumGC | numbers' "${RAW_DIR}/vars-before.json" >/dev/null || {
  record_failure "debug vars before sample are missing required memstats"
  exit 1
}

curl --fail --silent --show-error "${TILT_URL}/debug/pprof/allocs" >"${RAW_DIR}/allocs-before.pprof"
[[ -s "${RAW_DIR}/allocs-before.pprof" ]] || {
  record_failure "allocation profile before sample is empty"
  exit 1
}

# Tail zero makes the sample count only records delivered during the bounded
# CPU profile instead of replaying startup history. The follow client ingests
# the same firehose as the server, so it gets its own capped scope; this is
# written out (not tilt_scoped) because backgrounding the function would put
# a bash subshell between stop_process and the systemd-run wrapper.
env TILT_DISABLE_ANALYTICS=1 systemd-run --user --scope --quiet \
  --property=MemoryMax="$TILT_MEMORY_MAX" \
  --property=MemorySwapMax=0 \
  "$TILT_BIN" logs log-storm \
  --port="$PORT" \
  --follow \
  --tail=0 \
  --json >"${RAW_DIR}/log-sample.jsonl" 2>"${RAW_DIR}/log-sample.stderr" &
LOG_PID=$!

SAMPLE_START_EPOCH="$(date +%s)"
curl --fail --silent --show-error \
  --max-time "$((PROFILE_SECONDS + 15))" \
  "${TILT_URL}/debug/pprof/profile?seconds=${PROFILE_SECONDS}" >"${RAW_DIR}/cpu.pprof" || {
  record_failure "CPU profile capture failed"
  exit 1
}
SAMPLE_END_EPOCH="$(date +%s)"
stop_process "$LOG_PID"
LOG_PID=""

[[ -s "${RAW_DIR}/cpu.pprof" ]] || {
  record_failure "CPU profile is empty"
  exit 1
}

curl --fail --silent --show-error "${TILT_URL}/debug/vars" >"${RAW_DIR}/vars-after.json"
jq -e '.memstats | .TotalAlloc, .Mallocs, .NumGC | numbers' "${RAW_DIR}/vars-after.json" >/dev/null || {
  record_failure "debug vars after sample are missing required memstats"
  exit 1
}

curl --fail --silent --show-error "${TILT_URL}/debug/pprof/allocs" >"${RAW_DIR}/allocs-after.pprof"
[[ -s "${RAW_DIR}/allocs-after.pprof" ]] || {
  record_failure "allocation profile after sample is empty"
  exit 1
}

# The soak holds the storm after profiling so a retention bug has time to
# cross the memory floor; the sampler keeps recording throughout. The host
# stays protected by the scope cap, so a runaway leak ends as an OOM kill of
# the scope — reported as a failure with the samples retained.
if ((MEMORY_SOAK_SECONDS > 0)); then
  printf 'Soaking under the storm for %ss (memory floor: %s bytes)\n' \
    "$MEMORY_SOAK_SECONDS" "$MAX_TILT_MEMORY_BYTES"
  # Each soak view client is a /ws/view websocket consumer — the same
  # endpoint and cadence a browser tab drives. Output goes to /dev/null: the
  # server-side cost of serving the view is what is under test, and the
  # streamed bytes have no evidentiary value. Written out (not tilt_scoped)
  # for the same subshell-orphan reason as the measurement client.
  for ((client = 0; client < SOAK_VIEW_CLIENTS; client++)); do
    env TILT_DISABLE_ANALYTICS=1 systemd-run --user --scope --quiet \
      --property=MemoryMax="$TILT_MEMORY_MAX" \
      --property=MemorySwapMax=0 \
      "$TILT_BIN" logs log-storm \
      --port="$PORT" \
      --follow \
      --tail=0 \
      --json >/dev/null 2>/dev/null &
    SOAK_CLIENT_PIDS="${SOAK_CLIENT_PIDS} $!"
  done
  SOAK_START="$SECONDS"
  SOAK_LAST_REPORT=0
  while ((SECONDS - SOAK_START < MEMORY_SOAK_SECONDS)); do
    if ! kill -0 "$TILT_PID" 2>/dev/null; then
      record_failure "Tilt server died during the memory soak; a kill at MemoryMax=${TILT_MEMORY_MAX} means retention reached the host-protection cap (see raw/memory-samples.jsonl)"
      exit 1
    fi
    sleep 5
    SOAK_ELAPSED="$((SECONDS - SOAK_START))"
    if ((SOAK_ELAPSED - SOAK_LAST_REPORT >= 30)); then
      SOAK_LAST_REPORT="$SOAK_ELAPSED"
      printf 'soak: t=%ss memory.current=%s bytes\n' "$SOAK_ELAPSED" \
        "$(cat "${TILT_CGROUP_DIR}/memory.current" 2>/dev/null || printf '?')"
    fi
  done
fi

# inuse_space names what is retaining memory; captured after the soak so a
# leak's live set dominates the profile.
curl --fail --silent --show-error "${TILT_URL}/debug/pprof/heap" >"${RAW_DIR}/heap-after.pprof" || {
  record_failure "heap profile capture failed"
  exit 1
}
[[ -s "${RAW_DIR}/heap-after.pprof" ]] || {
  record_failure "heap profile is empty"
  exit 1
}

# Soak clients stay attached through the heap capture so their server-side
# footprint appears in the profile, then stop before the rollout phase.
if [[ -n "$SOAK_CLIENT_PIDS" ]]; then
  for soak_client_pid in $SOAK_CLIENT_PIDS; do
    stop_process "$soak_client_pid"
  done
  SOAK_CLIENT_PIDS=""
fi

SAMPLE_SECONDS="$((SAMPLE_END_EPOCH - SAMPLE_START_EPOCH))"
if ((SAMPLE_SECONDS <= 0)); then
  record_failure "sample duration was not positive"
  exit 1
fi

# Blank lines are permitted as websocket framing, but every non-blank line
# must be valid JSON from the requested runtime resource.
awk 'NF' "${RAW_DIR}/log-sample.jsonl" >"${RAW_DIR}/log-sample.nonblank.jsonl"
jq -c -e --arg resource log-storm '
  select(.resource == $resource and .source == "runtime" and (.message | type == "string"))
' "${RAW_DIR}/log-sample.nonblank.jsonl" >"${RAW_DIR}/log-sample.validated.jsonl"

LOG_RECORDS="$(wc -l <"${RAW_DIR}/log-sample.validated.jsonl" | tr -d ' ')"
NONBLANK_RECORDS="$(wc -l <"${RAW_DIR}/log-sample.nonblank.jsonl" | tr -d ' ')"
if [[ "$LOG_RECORDS" != "$NONBLANK_RECORDS" ]]; then
  record_failure "log sample contains malformed or unexpected JSON records"
  exit 1
fi

LOG_RATE="$(jq -n --argjson count "$LOG_RECORDS" --argjson seconds "$SAMPLE_SECONDS" '$count / $seconds')"
LOG_NONZERO_OK=0
if jq -en --argjson rate "$LOG_RATE" '$rate > 0' >/dev/null; then
  LOG_NONZERO_OK=1
fi

jq -n \
  --slurpfile before "${RAW_DIR}/vars-before.json" \
  --slurpfile after "${RAW_DIR}/vars-after.json" \
  --argjson seconds "$SAMPLE_SECONDS" '
  {
    sample_seconds: $seconds,
    delta: {
      TotalAlloc: ($after[0].memstats.TotalAlloc - $before[0].memstats.TotalAlloc),
      Mallocs: ($after[0].memstats.Mallocs - $before[0].memstats.Mallocs),
      NumGC: ($after[0].memstats.NumGC - $before[0].memstats.NumGC)
    }
  }
  | .rates_per_second = {
      TotalAlloc: (.delta.TotalAlloc / $seconds),
      Mallocs: (.delta.Mallocs / $seconds),
      NumGC: (.delta.NumGC / $seconds)
    }
' >"${RAW_DIR}/debug-vars-delta.json"

go tool pprof -top -cum -nodefraction=0 -nodecount=0 \
  "$TILT_BIN" "${RAW_DIR}/cpu.pprof" >"${OUTPUT_DIR}/cpu-top-cum.txt"
go tool pprof -top -cum -nodefraction=0 -nodecount=0 \
  -sample_index=alloc_space \
  -diff_base="${RAW_DIR}/allocs-before.pprof" \
  "$TILT_BIN" "${RAW_DIR}/allocs-after.pprof" >"${OUTPUT_DIR}/allocs-delta-top-cum.txt"
go tool pprof -top -cum -nodefraction=0 -nodecount=0 \
  -sample_index=inuse_space \
  "$TILT_BIN" "${RAW_DIR}/heap-after.pprof" >"${OUTPUT_DIR}/heap-inuse-top-cum.txt"

grep -q 'Showing nodes accounting for' "${OUTPUT_DIR}/cpu-top-cum.txt" || {
  record_failure "CPU pprof summary is malformed"
  exit 1
}
grep -q 'Showing nodes accounting for' "${OUTPUT_DIR}/allocs-delta-top-cum.txt" || {
  record_failure "allocation pprof summary is malformed"
  exit 1
}
grep -q 'Showing nodes accounting for' "${OUTPUT_DIR}/heap-inuse-top-cum.txt" || {
  record_failure "heap pprof summary is malformed"
  exit 1
}

readonly HOT_PATH_PATTERN='github.com/tilt-dev/tilt/internal/engine/k8srollout\.\(\*PodMonitor\)\.diff|github.com/tilt-dev/tilt/internal/engine/k8srollout\.podStatusesEqual'
{
  grep -E "$HOT_PATH_PATTERN" "${OUTPUT_DIR}/cpu-top-cum.txt" || true
  grep -E "$HOT_PATH_PATTERN" "${OUTPUT_DIR}/allocs-delta-top-cum.txt" || true
} >"${OUTPUT_DIR}/hot-path-samples.txt"
HOT_PATH_SAMPLES="$(wc -l <"${OUTPUT_DIR}/hot-path-samples.txt" | tr -d ' ')"
HOT_PATH_OK=0
if ((HOT_PATH_SAMPLES == 0)); then
  HOT_PATH_OK=1
fi

{
  grep -E 'github.com/google/go-cmp/cmp\.Equal|ChangeSummary\)\.IsLogOnly' "${OUTPUT_DIR}/cpu-top-cum.txt" || true
  grep -E 'github.com/google/go-cmp/cmp\.Equal|ChangeSummary\)\.IsLogOnly' "${OUTPUT_DIR}/allocs-delta-top-cum.txt" || true
} >"${OUTPUT_DIR}/supporting-symbol-samples.txt"

BASELINE_RATE="null"
BASELINE_RATIO="null"
BASELINE_OK=1
if [[ -n "$BASELINE_SUMMARY" ]]; then
  BASELINE_RATE="$(jq -er '.measurements.log_records_per_second | numbers' "$BASELINE_SUMMARY")"
  BASELINE_RATIO="$(jq -n --argjson candidate "$LOG_RATE" --argjson baseline "$BASELINE_RATE" '
    if $baseline == 0 then null else $candidate / $baseline end
  ')"
  if ! jq -en \
    --argjson candidate "$LOG_RATE" \
    --argjson baseline "$BASELINE_RATE" \
    --arg minimum "$MIN_BASELINE_RATE_RATIO" '
      $baseline > 0 and ($candidate / $baseline) >= ($minimum | tonumber)
    ' >/dev/null; then
    BASELINE_OK=0
  fi
fi

OLD_ROLLOUT_POD="$(kubectl --context="$KUBE_CONTEXT" --namespace="$NAMESPACE" get pods \
  -l app=rollout-target \
  -o json | jq -er '.items | sort_by(.metadata.creationTimestamp) | last | .metadata.name')"

kubectl --context="$KUBE_CONTEXT" --namespace="$NAMESPACE" rollout restart \
  deployment/rollout-target >"${RAW_DIR}/rollout-restart.log"
kubectl --context="$KUBE_CONTEXT" --namespace="$NAMESPACE" rollout status \
  deployment/rollout-target \
  --timeout="$ROLLOUT_TIMEOUT" >"${RAW_DIR}/rollout-status.log"

NEW_ROLLOUT_POD="$(kubectl --context="$KUBE_CONTEXT" --namespace="$NAMESPACE" get pods \
  -l app=rollout-target \
  -o json | jq -er '.items | map(select(.metadata.deletionTimestamp == null)) | sort_by(.metadata.creationTimestamp) | last | .metadata.name')"

tilt_scoped logs rollout-target \
  --port="$PORT" \
  --since=5m \
  --json >"${RAW_DIR}/rollout-logs.jsonl"

ROLLOUT_OK=0
if [[ "$NEW_ROLLOUT_POD" != "$OLD_ROLLOUT_POD" ]] && jq -c -e --arg pod "$NEW_ROLLOUT_POD" '
  select(.resource == "rollout-target" and (.message | contains("Tracking new pod rollout (" + $pod + ")")))
' "${RAW_DIR}/rollout-logs.jsonl" >"${RAW_DIR}/rollout-evidence.jsonl"; then
  ROLLOUT_OK=1
else
  : >"${RAW_DIR}/rollout-evidence.jsonl"
fi

# The memory floor covers the whole run: startup, storm, profile, rollout.
# It must be evaluated before cleanup because the scope cgroup (and its
# monotonic memory.peak) disappears when the server stops.
if [[ -n "$MEM_SAMPLER_PID" ]]; then
  stop_process "$MEM_SAMPLER_PID"
  MEM_SAMPLER_PID=""
fi
FINAL_MEMORY_PEAK="$(cat "${TILT_CGROUP_DIR}/memory.peak" 2>/dev/null || printf '0')"
MEMORY_SAMPLE_COUNT=0
if [[ -s "${RAW_DIR}/memory-samples.jsonl" ]]; then
  MEMORY_SAMPLE_COUNT="$(wc -l <"${RAW_DIR}/memory-samples.jsonl" | tr -d ' ')"
fi
MEMORY_PEAK_BYTES="$(jq -s --argjson final "$FINAL_MEMORY_PEAK" \
  'map(.memory_peak_bytes) + [$final] | max // 0' \
  "${RAW_DIR}/memory-samples.jsonl" 2>/dev/null || printf '0')"
MEMORY_OOM_KILLS="$(jq -s 'map(.oom_kills) | max // 0' \
  "${RAW_DIR}/memory-samples.jsonl" 2>/dev/null || printf '0')"
MEMORY_OK=0
if jq -en \
  --argjson samples "$MEMORY_SAMPLE_COUNT" \
  --argjson peak "$MEMORY_PEAK_BYTES" \
  --argjson oom "$MEMORY_OOM_KILLS" \
  --argjson floor "$MAX_TILT_MEMORY_BYTES" '
    $samples >= 1 and $peak > 0 and $peak <= $floor and $oom == 0
  ' >/dev/null; then
  MEMORY_OK=1
fi

# Preserve the complete evidence before deleting the generated project.
cleanup || true

ARTIFACTS_OK=1
for artifact in \
  "${RAW_DIR}/cpu.pprof" \
  "${RAW_DIR}/allocs-before.pprof" \
  "${RAW_DIR}/allocs-after.pprof" \
  "${RAW_DIR}/vars-before.json" \
  "${RAW_DIR}/vars-after.json" \
  "${RAW_DIR}/debug-vars-delta.json" \
  "${RAW_DIR}/log-sample.validated.jsonl" \
  "${RAW_DIR}/rollout-evidence.jsonl" \
  "${RAW_DIR}/memory-samples.jsonl" \
  "${RAW_DIR}/heap-after.pprof" \
  "${OUTPUT_DIR}/cpu-top-cum.txt" \
  "${OUTPUT_DIR}/allocs-delta-top-cum.txt" \
  "${OUTPUT_DIR}/heap-inuse-top-cum.txt"; do
  if [[ ! -s "$artifact" ]]; then
    ARTIFACTS_OK=0
  fi
done

OVERALL_OK=0
if ((HOT_PATH_OK == 1 && LOG_NONZERO_OK == 1 && BASELINE_OK == 1 && ROLLOUT_OK == 1 && MEMORY_OK == 1 && ARTIFACTS_OK == 1 && CLEANUP_OK == 1)); then
  OVERALL_OK=1
fi

VERDICT="fail"
if ((OVERALL_OK == 1)); then
  VERDICT="pass"
fi

jq -n \
  --arg schemaVersion "1" \
  --arg verdict "$VERDICT" \
  --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg gitHead "$(<"${RAW_DIR}/git-head.txt")" \
  --arg gitDiffHash "$(<"${RAW_DIR}/git-diff.sha256")" \
  --arg context "$KUBE_CONTEXT" \
  --arg namespace "$NAMESPACE" \
  --arg oldRolloutPod "$OLD_ROLLOUT_POD" \
  --arg newRolloutPod "$NEW_ROLLOUT_POD" \
  --argjson sampleSeconds "$SAMPLE_SECONDS" \
  --argjson logRecords "$LOG_RECORDS" \
  --argjson logRate "$LOG_RATE" \
  --argjson baselineRate "$BASELINE_RATE" \
  --argjson baselineRatio "$BASELINE_RATIO" \
  --argjson hotPathSamples "$HOT_PATH_SAMPLES" \
  --argjson hotPathOK "$HOT_PATH_OK" \
  --argjson logNonzeroOK "$LOG_NONZERO_OK" \
  --argjson baselineOK "$BASELINE_OK" \
  --argjson rolloutOK "$ROLLOUT_OK" \
  --arg tiltMemoryMax "$TILT_MEMORY_MAX" \
  --argjson maxMemoryBytes "$MAX_TILT_MEMORY_BYTES" \
  --argjson memoryPeakBytes "$MEMORY_PEAK_BYTES" \
  --argjson memorySamples "$MEMORY_SAMPLE_COUNT" \
  --argjson memoryOOMKills "$MEMORY_OOM_KILLS" \
  --argjson memoryOK "$MEMORY_OK" \
  --argjson streamMode "$TILT_STREAM_MODE" \
  --argjson memorySoakSeconds "$MEMORY_SOAK_SECONDS" \
  --argjson logLineBytes "$LOG_LINE_BYTES" \
  --argjson soakViewClients "$SOAK_VIEW_CLIENTS" \
  --argjson artifactsOK "$ARTIFACTS_OK" \
  --argjson cleanupOK "$CLEANUP_OK" '
  {
    schema_version: ($schemaVersion | tonumber),
    verdict: $verdict,
    timestamp: $timestamp,
    source: {
      git_head: $gitHead,
      git_diff_sha256: $gitDiffHash
    },
    target: {
      kubernetes_context: $context,
      namespace: $namespace
    },
    variant: {
      stream_mode: $streamMode,
      memory_soak_seconds: $memorySoakSeconds,
      log_line_bytes: $logLineBytes,
      soak_view_clients: $soakViewClients
    },
    measurements: {
      sample_seconds: $sampleSeconds,
      log_records: $logRecords,
      log_records_per_second: $logRate,
      baseline_log_records_per_second: $baselineRate,
      baseline_rate_ratio: $baselineRatio,
      hot_path_profile_rows: $hotPathSamples,
      old_rollout_pod: $oldRolloutPod,
      new_rollout_pod: $newRolloutPod,
      memory_peak_bytes: $memoryPeakBytes,
      memory_sample_count: $memorySamples,
      memory_oom_kills: $memoryOOMKills,
      tilt_memory_max: $tiltMemoryMax,
      max_tilt_memory_bytes: $maxMemoryBytes
    },
    floors: {
      hot_path_absent: ($hotPathOK == 1),
      log_rate_nonzero: ($logNonzeroOK == 1),
      baseline_rate_comparable: ($baselineOK == 1),
      rollout_observed: ($rolloutOK == 1),
      memory_bounded: ($memoryOK == 1),
      artifacts_complete: ($artifactsOK == 1),
      cleanup_complete: ($cleanupOK == 1)
    }
  }
' >"${OUTPUT_DIR}/summary.json"

cat >"${OUTPUT_DIR}/report.md" <<EOF
# Log-only PodMonitor performance report

- Verdict: **${VERDICT}**
- Git HEAD: \`$(<"${RAW_DIR}/git-head.txt")\`
- Working-tree diff SHA-256: \`$(<"${RAW_DIR}/git-diff.sha256")\`
- Kubernetes context: \`${KUBE_CONTEXT}\`
- Generated namespace: \`${NAMESPACE}\`
- Sample: ${LOG_RECORDS} validated runtime records over ${SAMPLE_SECONDS}s (${LOG_RATE} records/s)
- Baseline rate: ${BASELINE_RATE}
- Candidate/baseline ratio: ${BASELINE_RATIO}
- Rollout pod: \`${OLD_ROLLOUT_POD}\` -> \`${NEW_ROLLOUT_POD}\`
- Server memory peak: ${MEMORY_PEAK_BYTES} bytes over ${MEMORY_SAMPLE_COUNT} samples (floor: ${MAX_TILT_MEMORY_BYTES} bytes, scope cap: ${TILT_MEMORY_MAX}, OOM kills: ${MEMORY_OOM_KILLS})
- Variant: stream_mode=${TILT_STREAM_MODE}, soak=${MEMORY_SOAK_SECONDS}s, line_bytes=${LOG_LINE_BYTES}, soak_view_clients=${SOAK_VIEW_CLIENTS}

## Floors

- Hot path absent from steady-state CPU/alloc delta: ${HOT_PATH_OK}
- Runtime log rate nonzero: ${LOG_NONZERO_OK}
- Runtime log rate comparable with baseline: ${BASELINE_OK}
- New rollout observed in Tilt logs: ${ROLLOUT_OK}
- Server memory bounded: ${MEMORY_OK}
- Required artifacts complete: ${ARTIFACTS_OK}
- Generated state cleaned up: ${CLEANUP_OK}

## Hot-path samples

\`\`\`text
$(<"${OUTPUT_DIR}/hot-path-samples.txt")
\`\`\`

Raw inputs are under \`raw/\`. Full cumulative summaries are
\`cpu-top-cum.txt\` and \`allocs-delta-top-cum.txt\`.
EOF

printf 'Report: %s\n' "$OUTPUT_DIR"
printf 'Verdict: %s\n' "$VERDICT"

if ((OVERALL_OK == 0)); then
  record_failure "one or more brief floors failed; see ${OUTPUT_DIR}/summary.json"
  exit 1
fi
