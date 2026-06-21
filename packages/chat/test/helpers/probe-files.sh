#!/bin/bash
# Diagnostic: run each chat test file in its own `ava` so we can see which
# file's worker won't exit on Node 24 (killed at the timeout = leaked handle).
set -u
shopt -s globstar nullglob
leak=()
for f in test/**/*.test.*; do
  echo "[probe] RUN $f"
  timeout -s KILL 30 ava "$f" >/tmp/probe-out 2>&1
  code=$?
  pass=$(grep -oE '[0-9]+ tests passed' /tmp/probe-out | tail -1)
  if [ "$code" -eq 137 ]; then
    echo "[probe] LEAK(137) $f   ($pass)"; leak+=("$f")
  elif [ "$code" -ne 0 ]; then
    echo "[probe] EXIT($code) $f   ($pass)"
  else
    echo "[probe] OK $f   ($pass)"
  fi
done
echo "[probe] ===== LEAKING FILES (worker would not exit): ====="
printf '[probe]   %s\n' "${leak[@]:-<none>}"
exit 0
