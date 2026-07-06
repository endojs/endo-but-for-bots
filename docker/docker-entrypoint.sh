#!/bin/sh
# Entrypoint for the Endo daemon container.
#
# Runs the daemon in the foreground as PID 1 so Docker's stop signal (SIGTERM)
# reaches it directly — daemon-node.js installs a SIGTERM handler that cancels
# cleanly. The four positional paths are derived from the XDG environment so a
# `docker exec <container> endo <cmd>` (which resolves paths via @endo/where from
# the same env) talks to this running daemon over the same socket.
set -eu

# Resolve the daemon's paths from the XDG environment the image sets, matching
# @endo/where. ENDO_SOCK, if set, overrides the socket location for both the
# daemon and the CLI.
state_path="${XDG_STATE_HOME:-/data/state}/endo"
cache_path="${XDG_CACHE_HOME:-/data/cache}/endo"
ephemeral_path="${XDG_RUNTIME_DIR:-/run/endo}/endo"
sock_path="${ENDO_SOCK:-${ephemeral_path}/captp0.sock}"

# The persisted directories live on the mounted volume; the ephemeral directory
# (pid files, unix socket) is recreated on every start.
mkdir -p "$state_path" "$cache_path" "$ephemeral_path"

echo "[entrypoint] Endo daemon"
echo "[entrypoint]   state:   $state_path"
echo "[entrypoint]   cache:   $cache_path"
echo "[entrypoint]   runtime: $ephemeral_path"
echo "[entrypoint]   socket:  $sock_path"
echo "[entrypoint]   listen:  ${ENDO_ADDR:-0.0.0.0:8920}  (gateway=${ENDO_GATEWAY:-local})"

# The daemon self-initializes an empty state directory on first launch: it
# creates the formula store, mints the root agent, and writes the agent's
# identifier to <state>/root — that identifier is the bearer token remote
# clients present at https://<host>/#agent=<id>.
exec node /opt/endo/bundles/endo-daemon.mjs \
  "$sock_path" \
  "$state_path" \
  "$ephemeral_path" \
  "$cache_path"
