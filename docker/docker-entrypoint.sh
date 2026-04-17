#!/bin/bash
set -eu

# Map ENDO_STATE (simple) to ENDO_STATE_PATH (what the daemon reads).
export ENDO_STATE_PATH="${ENDO_STATE_PATH:-${ENDO_STATE:-/data/endo}}"

# Ensure the state directory exists.
mkdir -p "${ENDO_STATE_PATH}"

echo "[endo-docker] Starting daemon at ${ENDO_ADDR:-0.0.0.0:8920}"
echo "[endo-docker] State: ${ENDO_STATE_PATH}"
echo "[endo-docker] GC: ${ENDO_GC:-0}"

# Run daemon in foreground (no fork).
# run-daemon calls the daemon's main() which reads ENDO_STATE_PATH,
# ENDO_ADDR, ENDO_GC, etc. from the environment.
exec yarn endo run-daemon
