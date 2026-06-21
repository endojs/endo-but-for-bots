#!/bin/bash
# Diagnostic for the Node-24 chat worker hang (plain `ava` wedges on CI; Node 22
# and the `c8 ses-ava` path both pass; the full suite exits cleanly on a local
# Node 24). Every ava worker loads `handle-dump.mjs` (via --import): an unref'd
# watchdog with a GENEROUS 170s threshold — far above any legitimate runtime
# (slowest chat file ~12s locally; AVA per-test timeout is 120s) — that fires
# ONLY if a worker's libuv loop is genuinely held open, dumps the surviving
# resources/handles to /tmp/handle-dump.log, and force-exits.
#
# Phase 1 reproduces the REAL hang: the full suite under worker threads, exactly
# as CI runs it. A stuck worker self-dumps its handle types (Timeout? TCP?
# MessagePort? — the last would point at worker-thread teardown, not app code).
# Phase 2 runs each file alone to attribute any genuine single-file hang.
set -u
shopt -s globstar nullglob

PRELOAD="$PWD/test/helpers/handle-dump.mjs"
DUMP=/tmp/handle-dump.log
: >"$DUMP"

echo "[probe] ===== PHASE 1: full suite under worker threads (real-hang repro) ====="
: >/tmp/probe-suite
timeout -s KILL 600 \
  ava --node-arguments="--import=$PRELOAD" >/tmp/probe-suite 2>&1
echo "[probe] PHASE 1 ava exit=$?"
tail -8 /tmp/probe-suite
echo "[probe] ----- phase 1 handle dumps (stuck workers) -----"
cat "$DUMP"

echo "[probe] ===== PHASE 2: per-file attribution ====="
: >"$DUMP"
leak=()
for f in test/**/*.test.*; do
  echo "[probe] RUN $f"
  : >/tmp/probe-out
  PROBE_FILE="$f" timeout -s KILL 200 \
    ava "$f" --node-arguments="--import=$PRELOAD" >/tmp/probe-out 2>&1
  code=$?
  pass=$(grep -oE '[0-9]+ tests passed' /tmp/probe-out | tail -1)
  if grep -q "FILE=$f" "$DUMP"; then
    echo "[probe] LEAK $f   ($pass)   <-- watchdog fired"
    leak+=("$f")
  elif [ "$code" -eq 137 ]; then
    echo "[probe] LEAK(137) $f   ($pass)   <-- killed, no dump"
    leak+=("$f")
  elif [ "$code" -ne 0 ]; then
    echo "[probe] EXIT($code) $f   ($pass)"
  else
    echo "[probe] OK $f   ($pass)"
  fi
done

echo "[probe] ===== LEAKING FILES (worker would not exit): ====="
printf '[probe]   %s\n' "${leak[@]:-<none>}"
echo "[probe] ===== PHASE 2 HANDLE DUMP ====="
cat "$DUMP"
exit 0
