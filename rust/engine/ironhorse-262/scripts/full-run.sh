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
#     tree is partitioned into case-count-capped batches and EACH batch is its own
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
#                      rust/engine/target/test262-report
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
if [ "$oracle" != "on" ] && [ "$oracle" != "off" ]; then
  echo "full-run: --oracle must be on or off" >&2; exit 2
fi

mkdir -p "$out"
results="$out/results"
mkdir -p "$results"

echo "full-run: building the runner + report binaries (release)…" >&2
cargo build --release --manifest-path "$engine_dir/Cargo.toml" \
  -p ironhorse-262 --bin ironhorse-xst --bin ironhorse-262-report >&2
xst="$engine_dir/target/release/ironhorse-xst"
report_binary="$engine_dir/target/release/ironhorse-262-report"

# The partition cap is single-sourced from the report binary (the same Rust
# `BATCH_CASE_LIMIT` discovery chunks on), so `--batch-size` and discovery can
# never drift out of agreement — raising/lowering the cap moves both at once.
batch_size=$("$report_binary" batch-size)
case "$batch_size" in
  ''|*[!0-9]*) echo "full-run: report binary returned a non-numeric batch-size: '$batch_size'" >&2; exit 2 ;;
esac

# --- Resolve / vendor the authoritative test262 corpus at the pinned SHA. -----
vendored="no"
if [ -z "$test262_dir" ]; then
  if [ "$allow_fetch" = "no" ]; then
    echo "full-run: --no-fetch given but no --test262-dir" >&2; exit 2
  fi
  vendored="yes"
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

# --- Verify the corpus identity (round-2 must-fix #3). ------------------------
# A published conformance report must state exactly which corpus produced it and
# must never assert an identity it did not verify. `git rev-parse HEAD` alone can
# ascend into an ENCLOSING repository (e.g. when --test262-dir points into a
# checkout that is not itself a git top-level), so we only trust a SHA when the
# repository top-level IS the corpus dir. A vendored checkout is additionally
# required to match the configured pin exactly and to be clean; a mismatch/dirty
# vendored tree is fatal (it would publish old work under a new pin). A
# user-supplied dir that cannot be verified records `unknown` rather than lying.
canon() { (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"; }
corpus_top=$(git -C "$test262_dir" rev-parse --show-toplevel 2>/dev/null || echo "")
if [ -n "$corpus_top" ] && [ "$(canon "$corpus_top")" = "$(canon "$test262_dir")" ]; then
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
elif [ "$corpus_dirty" = "yes" ]; then
  # A user-supplied dir with local edits: keep the SHA but mark it unclean so
  # the report never claims a pristine pin.
  test262_sha="$test262_sha-dirty"
fi
if [ "$test262_sha" = "unknown" ]; then
  test262_ref="unverified"
else
  test262_ref="tc39/test262@${test262_sha:0:12}"
fi

# --- Provenance (recorded once; the report re-emits it verbatim). ------------
endo_sha=$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || echo unknown)
moddable_sha=$(git -C "$repo_root" rev-parse HEAD:c/moddable 2>/dev/null || echo unknown)
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
# (round-2 must-fix #1).
run_id="test262=$test262_sha;endo=$endo_sha;oracle=$oracle;ses=$ses_mode;cap=$batch_size;scope=${subtree:-<all>}"

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
provenance="$out/provenance.json"

# --- Discover + plan (resume). -----------------------------------------------
discover_args=(--test262-dir "$test262_dir")
[ -n "$subtree" ] && discover_args+=(--subtree "$subtree")

discovery_file="$out/discovery.txt"
pending_file="$out/pending.txt"
if ! "$report_binary" discover "${discover_args[@]}" > "$discovery_file"; then
  echo "full-run: batch discovery failed" >&2; exit 2
fi
if ! "$report_binary" plan --results "$results" --run-id "$run_id" "${discover_args[@]}" > "$pending_file"; then
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
# (round-2 must-fix #6). A real corpus/subtree always discovers batches.
if [ "${#all_batches[@]}" -eq 0 ]; then
  echo "full-run: discovery found ZERO batches under ${subtree:-the whole tree} — nothing to run; check --test262-dir/--subtree" >&2
  exit 2
fi
echo "full-run: ${#all_batches[@]} batches total, ${#pending[@]} pending (resume-aware), jobs=$jobs" >&2

# --- Run the pending batches, one oracle process each, --jobs in parallel. ----
# Each batch writes to a .part file first and is atomically renamed on success,
# so a killed process never leaves a partial file that resume mistakes for done.
# Per-batch stdout/stderr + exit status are captured to a log (round-2 must-fix
# #6: diagnostics preserved, not discarded), so a failed/hung batch is
# diagnosable after the fact instead of vanishing.
logs="$out/logs"
mkdir -p "$logs"
run_one() {
  batch="$1"
  directory=${batch%@@*}
  batch_index=${batch##*@@}
  sanitized=$(printf '%s' "$batch" | sed 's|/|__|g')
  final="$results/$sanitized.json"
  part="$results/$sanitized.part"
  log="$logs/$sanitized.log"
  rm -f "$part"
  status=0
  "$xst" --flat --batch-size "$batch_size" --batch-index "$((10#$batch_index))" \
    $oracle_flag --run-id "$run_id" --json "$part" --test262-dir "$test262_dir" \
    "$test_root/$directory" >"$log" 2>&1 || status=$?
  echo "exit-status: $status" >> "$log"
  # The resume marker is validated by the SAME parser that consumes it and bound
  # to the run identity: only a complete, correctly-stamped batch is promoted.
  if "$report_binary" validate --batch "$part" --run-id "$run_id" >>"$log" 2>&1; then
    mv -f "$part" "$final"
  else
    rm -f "$part"
  fi
}
export -f run_one
export xst report_binary results test262_dir test_root oracle_flag batch_size run_id logs

if [ "${#pending[@]}" -gt 0 ]; then
  printf '%s\n' "${pending[@]}" | xargs -P "$jobs" -I{} bash -c 'run_one "$@"' _ {}
fi

# Completeness gate: a run is publishable only when every discovered batch has
# a valid result. This also catches killed/truncated workers and stale files.
if ! "$report_binary" plan --results "$results" --run-id "$run_id" "${discover_args[@]}" > "$pending_file"; then
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

cat > "$provenance" <<EOF
{
  "runner": "ironhorse-xst",
  "test262_sha": "$(json_escape "$test262_sha")",
  "test262_ref": "$(json_escape "$test262_ref")",
  "endo_sha": "$(json_escape "$endo_sha")",
  "oracle": "moddable submodule @ $(json_escape "${moddable_sha:0:12}")",
  "command": "$(json_escape "$command_line")",
  "config": "$(json_escape "$config")",
  "scope": "$(json_escape "$scope")",
  "oracle_mode": "$(json_escape "$oracle")",
  "ses_mode": "$(json_escape "$ses_mode")",
  "completion": "complete",
  "run_id": "$(json_escape "$run_id")",
  "started_at": "$(json_escape "$started_at")",
  "finished_at": "$(json_escape "$finished_at")",
  "host": "$(json_escape "$host")"
}
EOF

# --- Aggregate → stable JSON + static HTML. ----------------------------------
# Aggregate EXACTLY the discovered plan, bound to the run identity in the
# provenance — never a directory glob — so a stale/foreign batch cannot leak in
# (round-2 must-fix #1). `discovery.txt` is the verified plan (every one of its
# batches passed the completeness gate above).
"$report_binary" aggregate --results "$results" --provenance "$provenance" \
  --plan "$discovery_file" --json "$out/report.json" --html "$out/report.html"

echo "full-run: done." >&2
echo "  report.json: $out/report.json" >&2
echo "  report.html: $out/report.html" >&2
