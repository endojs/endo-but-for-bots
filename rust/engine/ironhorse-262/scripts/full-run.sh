#!/usr/bin/env bash
# full-run.sh — the one-command, bounded, resumable, parallel full-test262
# sweep of the Ironhorse engine, oracle-locked to XS (maintainer request,
# kriscendobot/garden#51). It runs the complete authoritative TC39 test262 corpus
# against Ironhorse and emits both a stable machine-readable `report.json` and a
# self-contained static `report.html` (drop-in for kriscendobot gh-pages).
#
# Design of the run (why it is shaped this way):
#   * BOUNDED / OOM-SAFE. The XS oracle retains process RSS across the tens of
#     thousands of machine create/destroy cycles a whole-tree run makes, so the
#     tree is partitioned into per-directory batches and EACH batch is its own
#     `ironhorse-xst` process — every batch frees the oracle's RSS on exit. Peak
#     memory is bounded by --jobs (that many concurrent oracle processes), not
#     by the tree size.
#   * RESUMABLE. Each batch writes one JSON file; an interrupted run leaves the
#     completed files on disk and a re-run (same command) skips them.
#   * DETERMINISTIC. Discovery, batching, and aggregation are sorted; the same
#     corpus + engine produces byte-identical `report.json`.
#
# Usage:
#   full-run.sh [--test262-dir DIR] [--subtree PREFIX] [--out DIR]
#               [--jobs N] [--oracle on|off] [--case-timeout N] [--no-fetch]
#
#   --test262-dir DIR  an existing test262 checkout (a root with test/ and
#                      harness/). Default: clone tc39/test262 at the pinned
#                      revision (TEST262_REVISION) into <out>/test262-src.
#   --subtree PREFIX   restrict the sweep to a subtree, e.g. built-ins/Proxy.
#                      Default: the whole test/ tree.
#   --out DIR          output directory. Default:
#                      rust/engine/target/test262-report
#   --jobs N           batch parallelism. Default: min(nproc/2, 8). This bounds
#                      peak memory (concurrent oracle processes).
#   --oracle on|off    gate on the XS oracle (default on).
#   --case-timeout N   hard per-case wall-clock bound (seconds). An
#                      Ironhorse-only non-terminator becomes an ironhorse-hang
#                      failure; an oracle-only one is an infrastructure skip.
#                      Default 10; 0 = off.
#   --no-fetch         do not clone; require --test262-dir.
#
# NOTE: the recorded whole-tree run took 16m30s at --jobs 16 on
# endolin-garden2-5bcdff64. Runner capacity, cold builds, cloning, and the hang
# tail vary, so publishing remains a separate deliberate act and ordinary CI
# must not run it.
# END HELP
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

test262_directory=""
subtree=""
out="$engine_directory/target/test262-report"
jobs=""
oracle="on"
allow_fetch="yes"
# Hard per-case wall-clock bound (seconds). An Ironhorse-only non-terminator is
# an `ironhorse-hang` failure; an oracle-only non-termination is an
# infrastructure skip. Either outcome avoids wedging the batch. 0 disables it.
case_timeout="10"

while [ $# -gt 0 ]; do
  case "$1" in
    --test262-dir) test262_directory="$2"; shift 2 ;;
    --subtree) subtree="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --jobs) jobs="$2"; shift 2 ;;
    --oracle) oracle="$2"; shift 2 ;;
    --case-timeout) case_timeout="$2"; shift 2 ;;
    --no-fetch) allow_fetch="no"; shift ;;
    -h|--help) sed -n '2,/^# END HELP/p' "${BASH_SOURCE[0]}" | sed '$d'; exit 0 ;;
    *) echo "full-run.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$jobs" ]; then
  cpu_count=$( (nproc 2>/dev/null || echo 4) )
  jobs=$(( cpu_count / 2 )); [ "$jobs" -lt 1 ] && jobs=1; [ "$jobs" -gt 8 ] && jobs=8
fi

mkdir -p "$out"
results="$out/results"
mkdir -p "$results"

echo "full-run: building the runner + report binaries (release)..." >&2
cargo build --release --manifest-path "$engine_directory/Cargo.toml" \
  -p ironhorse-262 --bin ironhorse-xst --bin ironhorse-262-report >&2
xst="$engine_directory/target/release/ironhorse-xst"
report_binary="$engine_directory/target/release/ironhorse-262-report"

# --- Resolve / vendor the authoritative test262 corpus at the pinned SHA. -----
if [ -z "$test262_directory" ]; then
  if [ "$allow_fetch" = "no" ]; then
    echo "full-run: --no-fetch given but no --test262-dir" >&2; exit 2
  fi
  test262_directory="$out/test262-src"
  if [ ! -f "$test262_directory/harness/sta.js" ]; then
    echo "full-run: vendoring $TEST262_REPO @ $TEST262_SHA into $test262_directory" >&2
    mkdir -p "$test262_directory"
    git -C "$test262_directory" init -q 2>/dev/null || true
    git -C "$test262_directory" remote add origin "$TEST262_REPO" 2>/dev/null || \
      git -C "$test262_directory" remote set-url origin "$TEST262_REPO"
    git -C "$test262_directory" fetch --depth 1 -q origin "$TEST262_SHA"
    git -C "$test262_directory" checkout -q "$TEST262_SHA"
  fi
fi
if [ ! -f "$test262_directory/harness/sta.js" ]; then
  echo "full-run: no test262 harness under $test262_directory" >&2; exit 2
fi
test_root="$test262_directory/test"

# --- Provenance (recorded once; the report re-emits it verbatim). ------------
test262_sha=$(git -C "$test262_directory" rev-parse HEAD 2>/dev/null || echo "$TEST262_SHA")
endo_sha=$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || echo unknown)
moddable_sha=$(git -C "$repo_root" rev-parse HEAD:c/moddable 2>/dev/null || echo unknown)
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
host=$(hostname 2>/dev/null || echo unknown)
oracle_flag=""; [ "$oracle" = "off" ] && oracle_flag="--no-oracle"
config="oracle=$oracle flat-per-directory-batches jobs=$jobs case-timeout=${case_timeout}s subtree=${subtree:-<all>}"
command_line="full-run.sh --subtree ${subtree:-<all>} --jobs $jobs --oracle $oracle --case-timeout $case_timeout"

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
provenance="$out/provenance.json"

# --- Discover + plan (resume). -----------------------------------------------
discover_args=(--test262-dir "$test262_directory")
[ -n "$subtree" ] && discover_args+=(--subtree "$subtree")

mapfile -t all_batches < <("$report_binary" discover "${discover_args[@]}")
mapfile -t pending < <("$report_binary" plan --results "$results" "${discover_args[@]}")
echo "full-run: ${#all_batches[@]} batches total, ${#pending[@]} pending (resume-aware), jobs=$jobs" >&2

# Completeness precondition: a scope that discovers nothing (a typo'd --subtree,
# an empty tree) must fail loudly, never publish a fully-provenanced report of
# zero cases.
if [ "${#all_batches[@]}" -eq 0 ]; then
  echo "full-run: ERROR no batches discovered under $test_root${subtree:+/$subtree} - nothing to run" >&2
  exit 2
fi

# --- Run the pending batches, one oracle process each, --jobs in parallel. ----
# Each batch writes to a .part file first and is atomically renamed on success,
# so a killed process never leaves a partial file that resume mistakes for done.
run_one_batch() {
  batch="$1"
  batch_file_stem=$(printf '%s' "$batch" | sed 's|/|__|g')
  final="$results/$batch_file_stem.json"
  part="$results/$batch_file_stem.part"
  "$xst" --flat $oracle_flag --case-timeout "$case_timeout" --json "$part" \
    --test262-dir "$test262_directory" "$test_root/$batch" >/dev/null 2>&1 || true
  if [ -s "$part" ]; then mv -f "$part" "$final"; else rm -f "$part"; fi
}
export -f run_one_batch
export xst results test262_directory test_root oracle_flag case_timeout

if [ "${#pending[@]}" -gt 0 ]; then
  printf '%s\n' "${pending[@]}" | xargs -P "$jobs" -I{} bash -c 'run_one_batch "$@"' _ {}
fi

# --- Completeness gate: reconcile discovered vs produced. ---------------------
# A batch process can die (OOM-kill, abort) leaving no file, or leave a
# truncated one; `plan` (re-run here) counts both as still-pending — a file that
# parses to zero cases is treated as incomplete. If ANY batch is still pending
# after the sweep, fail rather than aggregate an authoritative-looking report
# that silently omits whole directories. This is why `run_one_batch` can swallow a
# single batch's failure (the parallel run finishes) without hiding it: the
# reconciliation below is the real completeness check.
mapfile -t still_pending < <("$report_binary" plan --results "$results" "${discover_args[@]}")
if [ "${#still_pending[@]}" -gt 0 ]; then
  echo "full-run: ERROR ${#still_pending[@]} of ${#all_batches[@]} batch(es) produced no parseable result:" >&2
  printf '  %s\n' "${still_pending[@]}" >&2
  echo "full-run: refusing to publish an incomplete report; re-run to resume the missing batches." >&2
  exit 1
fi

finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat > "$provenance" <<EOF
{
  "runner": "ironhorse-xst",
  "test262_sha": "$(json_escape "$test262_sha")",
  "test262_ref": "tc39/test262@$(json_escape "${test262_sha:0:12}")",
  "endo_sha": "$(json_escape "$endo_sha")",
  "oracle": "moddable submodule @ $(json_escape "${moddable_sha:0:12}")",
  "command": "$(json_escape "$command_line")",
  "config": "$(json_escape "$config")",
  "started_at": "$(json_escape "$started_at")",
  "finished_at": "$(json_escape "$finished_at")",
  "host": "$(json_escape "$host")"
}
EOF

# --- Aggregate -> stable JSON + static HTML. ----------------------------------
"$report_binary" aggregate --results "$results" --provenance "$provenance" \
  --json "$out/report.json" --html "$out/report.html"

echo "full-run: done." >&2
echo "  report.json: $out/report.json" >&2
echo "  report.html: $out/report.html" >&2
