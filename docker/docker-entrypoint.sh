#!/bin/sh
# Start the Endo daemon in the foreground for headless container operation.
#
# The daemon is normally spawned detached by `endo start`; a container wants it
# as the foreground process (PID 1's child), so we invoke the daemon node entry
# directly with explicit paths rather than through the CLI's fork-and-detach.
#
# Paths are env-overridable so an operator can relocate state without rebuilding:
#   ENDO_STATE    persisted state root (mount a volume here) [default /data/endo]
#   ENDO_RUNTIME  ephemeral runtime dir: pid file            [default /run/endo]
#   ENDO_SOCK     control socket path              [default /run/endo/captp0.sock]
# The Dockerfile pins ENDO_SOCK in the image ENV, so relocating ENDO_RUNTIME
# alone does not move the socket; set ENDO_SOCK explicitly to move it. ENDO_SOCK
# is also read by the CLI (via @endo/where), so `docker exec <ctr> endo ...`
# reaches this same daemon.
set -eu

: "${ENDO_STATE:=/data/endo}"
: "${ENDO_RUNTIME:=/run/endo}"
: "${ENDO_SOCK:=${ENDO_RUNTIME}/captp0.sock}"

state_path="${ENDO_STATE}/state"
cache_path="${ENDO_STATE}/cache"
ephemeral_path="${ENDO_RUNTIME}"

# The daemon binds the control socket directly without creating its parent, so
# make the socket's directory here too. It is $ephemeral_path for the default
# ENDO_SOCK, but an operator can point ENDO_SOCK elsewhere.
mkdir -p \
  "${state_path}" \
  "${cache_path}" \
  "${ephemeral_path}" \
  "$(dirname "${ENDO_SOCK}")"

# Argument order matches packages/daemon/src/daemon-node.js:
#   [sockPath] [statePath] [ephemeralStatePath] [cachePath]
exec node /opt/endo/packages/daemon/src/daemon-node.js \
  "${ENDO_SOCK}" \
  "${state_path}" \
  "${ephemeral_path}" \
  "${cache_path}"
