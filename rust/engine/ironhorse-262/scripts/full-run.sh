#!/usr/bin/env bash
# full-run.sh — the one-command, bounded, resumable, parallel full-test262
# sweep of the Ironhorse engine, oracle-locked to XS (maintainer request,
# designs/ironhorse-test262-convergence.md). It runs the authoritative test262 scope
# against Ironhorse and emits both a stable machine-readable `report.json` and a
# self-contained static `report.html` (drop-in for kriscendobot gh-pages).
#
# Design of the run (why it is shaped this way):
#   * BOUNDED PROCESS LIFETIME. The XS oracle retains process RSS across the tens of
#     thousands of machine create/destroy cycles a whole-tree run makes, so the
#     tree is partitioned into case-count-capped batches and EACH batch is its own
#     `endot-ih` process — every batch frees the oracle's RSS on exit, and
#     a watchdog prevents an unmetered oracle call from holding a worker forever.
#   * RESUMABLE. Each batch writes one JSON file; an interrupted run leaves the
#     completed files on disk and a re-run (same command) skips them.
#   * DETERMINISTIC. Discovery, batching, and aggregation are sorted; case
#     ordering and totals are stable for the same corpus + engine.
#
# Usage:
#   full-run.sh [--test262-dir DIR] [--subtree PREFIX] [--output DIR]
#               [--jobs N] [--oracle on|off] [--no-fetch]
#
#   --test262-dir DIR  an existing test262 checkout (a root with test/ and
#                      harness/). Default: clone tc39/test262 at the pinned
#                      revision (TEST262_REVISION) into <output>/test262-src.
#   --subtree PREFIX   restrict the sweep to a subtree, e.g. built-ins/Proxy.
#                      Default: the whole test/ tree.
#   --output DIR       output directory. Default:
#                      rust/engine/target/test262-report
#   --jobs N           batch parallelism. Default: min(nproc/2, 8). This bounds
#                      peak memory (concurrent oracle processes).
#   --oracle on|off    gate on the XS oracle (default on).
#   --no-fetch         do not clone; require --test262-dir.
#
# NOTE: an indicative run at 14f26d0a6 on a 32-vCPU host with jobs=16 and the
# XS oracle enabled took 16m30s; later watchdog/quarantine changes and slower runners
# lower parallelism take longer. Publishing its output is a
# separate, deliberate act (a gh-pages commit); ordinary CI must not run it.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
crate_directory=$(cd "$here/.." && pwd)
repo_root=$(cd "$crate_directory" && git rev-parse --show-toplevel)
engine_directory="$repo_root/rust/engine"

# shellcheck source=/dev/null
source "$crate_directory/TEST262_REVISION"
# Re-affirm the sourced pins (validates the revision file and makes the
# assignment visible to static analysis).
TEST262_REPO="${TEST262_REPO:?TEST262_REVISION must define TEST262_REPO}"
TEST262_SHA="${TEST262_SHA:?TEST262_REVISION must define TEST262_SHA}"

test262_dir=""
subtree=""
output="$engine_directory/target/test262-report"
jobs=""
oracle="on"
allow_fetch="yes"

while [ $# -gt 0 ]; do
  case "$1" in
    --test262-dir) test262_dir="$2"; shift 2 ;;
    --subtree) subtree="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    --jobs) jobs="$2"; shift 2 ;;
    --oracle) oracle="$2"; shift 2 ;;
    --no-fetch) allow_fetch="no"; shift ;;
    -h|--help) sed -n '2,/^set -euo pipefail$/{ /^set -euo pipefail$/d; p; }' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "full-run.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$jobs" ]; then
  processor_count=$(nproc 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo 4)
  jobs=$(( processor_count / 2 )); [ "$jobs" -lt 1 ] && jobs=1; [ "$jobs" -gt 8 ] && jobs=8
fi
case "$jobs" in
  ''|*[!0-9]*) echo "full-run: --jobs needs a positive integer" >&2; exit 2 ;;
esac
if [ "$jobs" -eq 0 ]; then
  echo "full-run: --jobs needs a positive integer" >&2; exit 2
fi
if [ "$jobs" -gt 64 ]; then
  echo "full-run: --jobs must not exceed 64" >&2; exit 2
fi
if [ "$oracle" != "on" ] && [ "$oracle" != "off" ]; then
  echo "full-run: --oracle must be on or off" >&2; exit 2
fi

mkdir -p "$output"
results="$output/results"
mkdir -p "$results"

echo "full-run: building the runner + report binaries (release)..." >&2
cargo build --release --manifest-path "$engine_directory/Cargo.toml" \
  -p ironhorse-262 --bin endot-ih --bin ironhorse-262-report >&2
target_directory=${CARGO_TARGET_DIR:-$engine_directory/target}
target_triple_directory=""
[ -n "${CARGO_BUILD_TARGET:-}" ] && target_triple_directory="${CARGO_BUILD_TARGET}/"
xst_binary="$target_directory/${target_triple_directory}release/endot-ih"
report_binary="$target_directory/${target_triple_directory}release/ironhorse-262-report"

# The partition cap is single-sourced from the report binary (the same Rust
# `BATCH_CASE_LIMIT` discovery chunks on), so `--batch-size` and discovery can
# never drift out of agreement — raising/lowering the cap moves both at once.
batch_size=$("$report_binary" batch-size)
case "$batch_size" in
  ''|*[!0-9]*) echo "full-run: report binary returned a non-numeric batch-size: '$batch_size'" >&2; exit 2 ;;
esac

# Resolve or vendor the authoritative test262 corpus at the pinned SHA.
vendored="no"
if [ -z "$test262_dir" ]; then
  if [ "$allow_fetch" = "no" ]; then
    echo "full-run: --no-fetch given but no --test262-dir" >&2; exit 2
  fi
  vendored="yes"
  test262_dir="$output/test262-src"
  if [ ! -f "$test262_dir/harness/sta.js" ]; then
    echo "full-run: vendoring $TEST262_REPO @ $TEST262_SHA into $test262_dir" >&2
    mkdir -p "$test262_dir"
    git -C "$test262_dir" init -q
    corpus_top=$(git -C "$test262_dir" rev-parse --show-toplevel)
    if [ "$(cd "$corpus_top" && pwd -P)" != "$(cd "$test262_dir" && pwd -P)" ]; then
      echo "full-run: refusing to modify an enclosing repository while vendoring test262" >&2
      exit 2
    fi
    git -C "$test262_dir" remote add origin "$TEST262_REPO" 2>/dev/null || \
      git -C "$test262_dir" remote set-url origin "$TEST262_REPO"
    git -C "$test262_dir" fetch --depth 1 -q origin "$TEST262_SHA"
    git -C "$test262_dir" checkout -q "$TEST262_SHA"
  fi
fi
if [ ! -f "$test262_dir/harness/sta.js" ]; then
  echo "full-run: no test262 harness under $test262_dir" >&2; exit 2
fi
test_root="$test262_dir/test"

# Verify the corpus identity before using or publishing it.
# A published conformance report must state exactly which corpus produced it and
# must never assert an identity it did not verify. `git rev-parse HEAD` alone can
# ascend into an ENCLOSING repository (e.g. when --test262-dir points into a
# checkout that is not itself a git top-level), so we only trust a SHA when the
# repository top-level IS the corpus dir. A vendored checkout is additionally
# required to match the configured pin exactly and to be clean; a mismatch/dirty
# vendored tree is fatal (it would publish old work under a new pin). A
# unverifiable user-supplied directory is rejected.
canonical_path() { (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"; }
corpus_top=$(git -C "$test262_dir" rev-parse --show-toplevel 2>/dev/null || echo "")
if [ -n "$corpus_top" ] && [ "$(canonical_path "$corpus_top")" = "$(canonical_path "$test262_dir")" ]; then
  test262_sha=$(git -C "$test262_dir" rev-parse HEAD 2>/dev/null || echo unknown)
  corpus_dirty="no"
  [ -n "$(git -C "$test262_dir" status --porcelain 2>/dev/null)" ] && corpus_dirty="yes"
else
  # Not a git top-level at the corpus dir (a plain export, or an enclosing repo
  # we refuse to ascend into): the identity is unverifiable.
  test262_sha="unknown"
  corpus_dirty="unknown"
fi
if [ "$vendored" = "yes" ]; then
  if [ "$test262_sha" != "$TEST262_SHA" ]; then
    echo "full-run: vendored corpus HEAD ($test262_sha) does not match the configured pin ($TEST262_SHA); refusing to publish" >&2
    exit 2
  fi
  if [ "$corpus_dirty" = "yes" ]; then
    echo "full-run: vendored corpus at $test262_dir is dirty; refusing to publish an unverifiable identity" >&2
    exit 2
  fi
elif [ "$corpus_dirty" != "no" ] || [ "$test262_sha" = "unknown" ]; then
  echo "full-run: --test262-dir must be a clean git top-level so resume has a unique corpus identity" >&2
  exit 2
fi
if [ "$test262_sha" = "$TEST262_SHA" ]; then
  test262_ref="tc39/test262@${test262_sha:0:12}"
  corpus_verified=true
else
  # A clean, caller-supplied checkout is reproducible, but it is not evidence
  # that the corpus came from tc39 or is the configured corpus revision.
  test262_ref="unverified-corpus@${test262_sha:0:12}"
  corpus_verified=false
fi

# Record provenance once; the report re-emits it verbatim.
if ! git -C "$repo_root" diff --quiet HEAD -- rust/engine c/moddable; then
  echo "full-run: the engine or oracle tree is dirty; commit it before running a resumable sweep" >&2
  exit 2
fi
# The endo/Ironhorse *commit* under test — a resolvable HEAD commit, not the
# `HEAD:rust` subtree tree object (which no reader can resolve as a commit). The
# dirty-check above guarantees the rust engine tree matches this commit.
endo_sha=$(git -C "$repo_root" rev-parse HEAD)
moddable_sha=$(git -C "$repo_root/c/moddable" rev-parse HEAD)
moddable_pin=$(git -C "$repo_root" rev-parse HEAD:c/moddable)
if [ "$moddable_sha" != "$moddable_pin" ] || [ -n "$(git -C "$repo_root/c/moddable" status --porcelain)" ]; then
  echo "full-run: c/moddable must be clean and checked out at the recorded gitlink" >&2
  exit 2
fi
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
host="redacted"
oracle_flag=""; [ "$oracle" = "off" ] && oracle_flag="--no-oracle"
ses_mode="none"
scope="whole-corpus"; [ -n "$subtree" ] && scope="subtree=$subtree"
config="oracle=$oracle max-cases-per-batch=$batch_size jobs=$jobs subtree=${subtree:-<all>}"
command_line="full-run.sh --subtree ${subtree:-<all>} --jobs $jobs --oracle $oracle"

# The run identity every batch is stamped with: the fingerprint of the
# result-affecting inputs. Reusing a results dir after ANY of these changes
# re-runs the affected batches rather than retaining stale/foreign results
# across runs.
# The XS oracle's source pin (moddable_sha) is part of the identity: it is the
# gate that decides every case's verdict, so bumping c/moddable must re-run the
# affected batches rather than retain results scored against the old oracle.
run_id="test262=$test262_sha;endo=$endo_sha;oracle=$oracle;moddable=$moddable_sha;ses=$ses_mode;cap=$batch_size;scope=${subtree:-<all>}"

provenance="$output/provenance.json"

# Discover and plan the resumable run.
discover_arguments=(--test262-dir "$test262_dir")
[ -n "$subtree" ] && discover_arguments+=(--subtree "$subtree")

discovery_file="$output/discovery.txt"
pending_file="$output/pending.txt"
if ! "$report_binary" discover "${discover_arguments[@]}" > "$discovery_file"; then
  echo "full-run: batch discovery failed" >&2; exit 2
fi
if ! "$report_binary" plan --results "$results" --run-id "$run_id" "${discover_arguments[@]}" > "$pending_file"; then
  echo "full-run: resume planning failed" >&2; exit 2
fi
all_batches=()
while IFS= read -r batch; do
  [ -n "$batch" ] && all_batches[${#all_batches[@]}]="$batch"
done < "$discovery_file"
pending=()
while IFS= read -r batch; do
  [ -n "$batch" ] && pending[${#pending[@]}]="$batch"
done < "$pending_file"
# Reject a zero-batch discovery: an empty plan would otherwise sail through the
# completeness gate and publish an authoritative-looking "0 cases" report
# A real corpus/subtree always discovers batches.
if [ "${#all_batches[@]}" -eq 0 ]; then
  echo "full-run: discovery found ZERO batches under ${subtree:-the whole tree} — nothing to run; check --test262-dir/--subtree" >&2
  exit 2
fi
echo "full-run: ${#all_batches[@]} batches total, ${#pending[@]} pending (resume-aware), jobs=$jobs" >&2

# Run the pending batches, one oracle process each, with bounded parallelism.
# Each batch writes to a .part file first and is atomically renamed on success,
# so a killed process never leaves a partial file that resume mistakes for done.
# Per-batch stdout/stderr + exit status are captured to a log, so a failed/hung batch is
# diagnosable after the fact instead of vanishing.
logs="$output/logs"
# `run_id` is deliberately descriptive and can exceed NAME_MAX for a deep
# subtree.  Resume-state directory names need only be stable, not readable.
if command -v sha256sum >/dev/null 2>&1; then
  run_key=$(printf '%s' "$run_id" | sha256sum | awk '{print $1}')
else
  run_key=$(printf '%s' "$run_id" | shasum -a 256 | awk '{print $1}')
fi
attempts="$output/attempts/$run_key"
quarantines="$output/quarantines/$run_key"
mkdir -p "$logs" "$attempts" "$quarantines"
# The per-batch attempt cap. Quarantine (below) fires once a batch has failed
# this many times. The cap counts attempts ACROSS invocations (persisted in
# `$attempts/<batch>`) AND is retried in-process within one invocation, so the
# quarantine path is reachable from a single sweep run — the CI dispatch runs
# this script once (see scripts/README.md, "CI").
BATCH_ATTEMPT_LIMIT=3
export BATCH_ATTEMPT_LIMIT

run_one_batch() {
  batch="$1"
  directory=${batch%@@*}
  batch_index=${batch##*@@}
  filename=$("$report_binary" batch-filename "$batch")
  basename=${filename%.json}
  final="$results/$filename"
  part="$results/$basename.part"
  log="$logs/$basename.log"
  attempt_file="$attempts/$basename"
  attempt=0
  [ -f "$attempt_file" ] && read -r attempt < "$attempt_file" || true
  case "$attempt" in ''|*[!0-9]*) attempt=0 ;; esac
  expected_count=$("$report_binary" batch-count --test262-dir "$test262_dir" --batch "$batch")
  status=0
  # Retry the batch in-process up to the cap so ONE invocation can reach the
  # quarantine path rather than leaving a permanently-pending batch that fails
  # the completeness gate. `attempt` accumulates across invocations, so a batch
  # already at the cap on entry skips straight to quarantine.
  while [ "$attempt" -lt "$BATCH_ATTEMPT_LIMIT" ]; do
    attempt=$((attempt + 1))
    printf '%s\n' "$attempt" > "$attempt_file"
    rm -f "$part"
    status=0
    "$xst_binary" --direct-only --batch-size "$batch_size" --batch-index "$((10#$batch_index))" \
      $oracle_flag --run-id "$run_id" --json "$part" --test262-dir "$test262_dir" \
      "$test_root/$directory" >"$log" 2>&1 &
    worker=$!
    (
      # timer starts EMPTY, never 0: a TERM that lands after the trap is installed
      # but before the first `sleep &` must not run `kill "$timer"` with an unset
      # target — `kill 0` (or `kill ""` -> the group) would TERM the whole sweep's
      # process group (full-run.sh, xargs, every sibling worker). The guard makes
      # the handler a no-op until a real timer PID exists.
      timer=""
      trap '[ -n "$timer" ] && kill "$timer" 2>/dev/null; exit 0' TERM INT
      sleep "${IRONHORSE_262_BATCH_TIMEOUT:-180}" & timer=$!
      wait "$timer" || exit 0
      kill -TERM "$worker" 2>/dev/null || exit 0
      sleep "${IRONHORSE_262_KILL_GRACE:-30}" & timer=$!
      wait "$timer" || exit 0
      kill -KILL "$worker" 2>/dev/null || true
    ) &
    watchdog=$!
    wait "$worker" || status=$?
    kill "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
    echo "exit-status: $status (attempt $attempt/$BATCH_ATTEMPT_LIMIT)" >> "$log"
    # The resume marker is validated by the SAME parser that consumes it and
    # bound to the run identity: only a complete, correctly-stamped batch is
    # promoted.
    if "$report_binary" validate --batch "$part" --run-id "$run_id" \
        --expected-count "$expected_count" >>"$log" 2>&1; then
      mv -f "$part" "$final"
      return 0
    fi
    rm -f "$part"
  done
  # Attempts exhausted: quarantine so one bad batch never blocks publication
  # forever. Promote ONLY if the quarantine record itself validates (the guard
  # is load-bearing, not decorative).
  reason="quarantine:worker-failed-after-${attempt}-attempts:status-${status}"
  "$report_binary" quarantine --test262-dir "$test262_dir" --batch "$batch" \
    --run-id "$run_id" --reason "$reason" --json "$part" >>"$log" 2>&1
  if "$report_binary" validate --batch "$part" --run-id "$run_id" \
      --expected-count "$expected_count" >>"$log" 2>&1; then
    mv -f "$part" "$final"
    printf '%s\n' "$reason" > "$quarantines/$basename"
  else
    rm -f "$part"
  fi
}
export -f run_one_batch
export xst_binary report_binary results test262_dir test_root oracle_flag batch_size run_id logs attempts quarantines

if [ "${#pending[@]}" -gt 0 ]; then
  printf '%s\n' "${pending[@]}" | xargs -P "$jobs" -I{} bash -c 'run_one_batch "$@"' _ {} || true
fi

# Completeness gate: a run is publishable only when every discovered batch has
# a valid result. This also catches killed/truncated workers and stale files.
if ! "$report_binary" plan --results "$results" --run-id "$run_id" "${discover_arguments[@]}" > "$pending_file"; then
  echo "full-run: post-sweep completeness check failed" >&2; exit 2
fi
remaining=0
while IFS= read -r batch; do
  [ -n "$batch" ] && remaining=$((remaining + 1))
done < "$pending_file"
if [ "$remaining" -ne 0 ]; then
  echo "full-run: incomplete sweep: $remaining batch(es) remain pending; re-run to resume" >&2
  exit 1
fi

finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
completion="complete"
if find "$quarantines" -type f -print -quit | grep -q .; then
  completion="incomplete"
fi

cat > "$provenance" <<EOF
{
  "runner": $("$report_binary" json-string "endot-ih"),
  "test262_sha": $("$report_binary" json-string "$test262_sha"),
  "test262_ref": $("$report_binary" json-string "$test262_ref"),
  "endo_sha": $("$report_binary" json-string "$endo_sha"),
  "oracle": $("$report_binary" json-string "moddable submodule @ ${moddable_sha:0:12}"),
  "command": $("$report_binary" json-string "$command_line"),
  "config": $("$report_binary" json-string "$config"),
  "scope": $("$report_binary" json-string "$scope"),
  "oracle_mode": $("$report_binary" json-string "$oracle"),
  "corpus_verified": $corpus_verified,
  "ses_mode": $("$report_binary" json-string "$ses_mode"),
  "completion": $("$report_binary" json-string "$completion"),
  "run_id": $("$report_binary" json-string "$run_id"),
  "started_at": $("$report_binary" json-string "$started_at"),
  "finished_at": $("$report_binary" json-string "$finished_at"),
  "host": $("$report_binary" json-string "$host")
}
EOF

# Aggregate to stable JSON and static HTML.
# Aggregate EXACTLY the discovered plan, bound to the run identity in the
# provenance — never a directory glob — so a stale/foreign batch cannot leak in.
# `discovery.txt` is the verified plan (every one of its
# batches passed the completeness gate above).
expected_total=0
for batch in "${all_batches[@]}"; do
  count=$("$report_binary" batch-count --test262-dir "$test262_dir" --batch "$batch")
  expected_total=$((expected_total + count))
done
"$report_binary" aggregate --results "$results" --provenance "$provenance" \
  --plan "$discovery_file" --expected-total "$expected_total" \
  --json "$output/report.json" --html "$output/report.html"

echo "full-run: done." >&2
echo "  report.json: $output/report.json" >&2
echo "  report.html: $output/report.html" >&2
