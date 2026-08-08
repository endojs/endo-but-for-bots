#!/usr/bin/env bash
# full-run.sh — the one-command, bounded, resumable, parallel full-test262
# sweep of the Ironhorse engine, oracle-locked to XS (maintainer request,
# kriskowal/garden#51). It runs the complete authoritative TC39 test262 corpus
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
#               [--jobs N] [--oracle on|off] [--no-fetch]
#
#   --test262-dir DIR  an existing test262 checkout (a root with test/ and
#                      harness/). Default: clone tc39/test262 at the pinned
#                      revision (TEST262_REVISION) into <out>/test262-src.
#   --subtree PREFIX   restrict the sweep to a subtree, e.g. built-ins/Proxy.
#                      Default: the whole test/ tree.
#   --out DIR          output directory. Default:
#                      rust/engine/ironhorse-262/target/test262-report
#   --jobs N           batch parallelism. Default: min(nproc/2, 8). This bounds
#                      peak memory (concurrent oracle processes).
#   --oracle on|off    gate on the XS oracle (default on).
#   --no-fetch         do not clone; require --test262-dir.
#
# NOTE: a whole-tree run is a MULTI-HOUR sweep. Publishing its output is a
# separate, deliberate act (a gh-pages commit); ordinary CI must not run it.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
crate_dir=$(cd "$here/.." && pwd)
repo_root=$(cd "$crate_dir" && git rev-parse --show-toplevel)
engine_dir="$repo_root/rust/engine"

# shellcheck source=/dev/null
source "$crate_dir/TEST262_REVISION"
# Re-affirm the sourced pins (validates the revision file and makes the
# assignment visible to static analysis).
TEST262_REPO="${TEST262_REPO:?TEST262_REVISION must define TEST262_REPO}"
TEST262_SHA="${TEST262_SHA:?TEST262_REVISION must define TEST262_SHA}"

test262_dir=""
subtree=""
out="$engine_dir/target/test262-report"
jobs=""
oracle="on"
allow_fetch="yes"

while [ $# -gt 0 ]; do
  case "$1" in
    --test262-dir) test262_dir="$2"; shift 2 ;;
    --subtree) subtree="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --jobs) jobs="$2"; shift 2 ;;
    --oracle) oracle="$2"; shift 2 ;;
    --no-fetch) allow_fetch="no"; shift ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "full-run.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$jobs" ]; then
  n=$( (nproc 2>/dev/null || echo 4) )
  jobs=$(( n / 2 )); [ "$jobs" -lt 1 ] && jobs=1; [ "$jobs" -gt 8 ] && jobs=8
fi

mkdir -p "$out"
results="$out/results"
mkdir -p "$results"

echo "full-run: building the runner + report binaries (release)…" >&2
cargo build --release --manifest-path "$engine_dir/Cargo.toml" \
  -p ironhorse-262 --bin ironhorse-xst --bin ironhorse-262-report >&2
xst="$engine_dir/target/release/ironhorse-xst"
report_bin="$engine_dir/target/release/ironhorse-262-report"

# --- Resolve / vendor the authoritative test262 corpus at the pinned SHA. -----
if [ -z "$test262_dir" ]; then
  if [ "$allow_fetch" = "no" ]; then
    echo "full-run: --no-fetch given but no --test262-dir" >&2; exit 2
  fi
  test262_dir="$out/test262-src"
  if [ ! -f "$test262_dir/harness/sta.js" ]; then
    echo "full-run: vendoring $TEST262_REPO @ $TEST262_SHA into $test262_dir" >&2
    mkdir -p "$test262_dir"
    git -C "$test262_dir" init -q 2>/dev/null || true
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

# --- Provenance (recorded once; the report re-emits it verbatim). ------------
test262_sha=$(git -C "$test262_dir" rev-parse HEAD 2>/dev/null || echo "$TEST262_SHA")
endo_sha=$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || echo unknown)
moddable_sha=$(git -C "$repo_root" rev-parse HEAD:c/moddable 2>/dev/null || echo unknown)
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
host=$(hostname 2>/dev/null || echo unknown)
oracle_flag=""; [ "$oracle" = "off" ] && oracle_flag="--no-oracle"
config="oracle=$oracle flat-per-directory-batches jobs=$jobs subtree=${subtree:-<all>}"
command_line="full-run.sh --subtree ${subtree:-<all>} --jobs $jobs --oracle $oracle"

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
provenance="$out/provenance.json"

# --- Discover + plan (resume). -----------------------------------------------
discover_args=(--test262-dir "$test262_dir")
[ -n "$subtree" ] && discover_args+=(--subtree "$subtree")

mapfile -t all_batches < <("$report_bin" discover "${discover_args[@]}")
mapfile -t pending < <("$report_bin" plan --results "$results" "${discover_args[@]}")
echo "full-run: ${#all_batches[@]} batches total, ${#pending[@]} pending (resume-aware), jobs=$jobs" >&2

# --- Run the pending batches, one oracle process each, --jobs in parallel. ----
# Each batch writes to a .part file first and is atomically renamed on success,
# so a killed process never leaves a partial file that resume mistakes for done.
run_one() {
  b="$1"
  san=$(printf '%s' "$b" | sed 's|/|__|g')
  final="$results/$san.json"
  part="$results/$san.part"
  "$xst" --flat $oracle_flag --json "$part" --test262-dir "$test262_dir" \
    "$test_root/$b" >/dev/null 2>&1 || true
  if [ -s "$part" ]; then mv -f "$part" "$final"; else rm -f "$part"; fi
}
export -f run_one
export xst results test262_dir test_root oracle_flag

if [ "${#pending[@]}" -gt 0 ]; then
  printf '%s\n' "${pending[@]}" | xargs -P "$jobs" -I{} bash -c 'run_one "$@"' _ {}
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

# --- Aggregate → stable JSON + static HTML. ----------------------------------
"$report_bin" aggregate --results "$results" --provenance "$provenance" \
  --json "$out/report.json" --html "$out/report.html"

echo "full-run: done." >&2
echo "  report.json: $out/report.json" >&2
echo "  report.html: $out/report.html" >&2
