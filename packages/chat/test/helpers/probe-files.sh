#!/bin/bash
# Diagnostic: run each chat test file in its own `ava` so we can see which
# file's worker won't exit on Node 24. Each worker also loads
# `handle-dump.mjs` (via --import), an unref'd watchdog that — if the worker
# is still alive ~8s after its tests finish (i.e. a leaked handle is holding
# the libuv loop open) — dumps the surviving resources/handles to
# /tmp/handle-dump.log and force-exits. Clean files exit before the watchdog
# fires and produce no dump line.
set -u
shopt -s globstar nullglob

PRELOAD="$PWD/test/helpers/handle-dump.mjs"
DUMP=/tmp/handle-dump.log
: >"$DUMP"

leak=()
for f in test/**/*.test.*; do
  echo "[probe] RUN $f"
  : >/tmp/probe-out
  PROBE_FILE="$f" timeout -s KILL 40 \
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
echo "[probe] ===== HANDLE DUMP ====="
cat "$DUMP"
exit 0
