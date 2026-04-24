#!/bin/bash
set -eu

# Resolve a single ENDO_STATE root to the four path env vars that
# daemon-node.js reads in foreground mode.
ENDO_STATE="${ENDO_STATE:-/data/endo}"

export ENDO_STATE_PATH="${ENDO_STATE_PATH:-${ENDO_STATE}/state}"
export ENDO_EPHEMERAL_STATE_PATH="${ENDO_EPHEMERAL_STATE_PATH:-/tmp/endo}"
export ENDO_SOCK_PATH="${ENDO_SOCK_PATH:-/tmp/endo/endo.sock}"
export ENDO_CACHE_PATH="${ENDO_CACHE_PATH:-${ENDO_STATE}/cache}"
export ENDO_ADDR="${ENDO_ADDR:-0.0.0.0:8920}"

# Ensure directories exist.
mkdir -p "${ENDO_STATE_PATH}" "${ENDO_EPHEMERAL_STATE_PATH}" "${ENDO_CACHE_PATH}"

# Serve Chat UI if the bundle directory exists.
if [ -d "${ENDO_STATIC_DIR:-}" ]; then
  export ENDO_STATIC_DIR
elif [ -d "/opt/endo/bundles/endo-chat" ]; then
  export ENDO_STATIC_DIR="/opt/endo/bundles/endo-chat"
fi

echo "[endo-docker] Starting daemon (foreground, PID 1)"
echo "[endo-docker] State: ${ENDO_STATE_PATH}"
echo "[endo-docker] Address: ${ENDO_ADDR}"
echo "[endo-docker] GC: ${ENDO_GC:-0}"
echo "[endo-docker] Static: ${ENDO_STATIC_DIR:-none}"

# Run daemon-node.js directly as PID 1 (no fork).
# daemon-node.js reads paths from ENDO_*_PATH env vars when no
# positional args are provided.
exec node packages/daemon/src/daemon-node.js
