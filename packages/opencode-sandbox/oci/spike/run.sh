#!/bin/sh
# Run the opencode-sandbox spike as the Endo daemon user on a host with the
# Endo daemon running. See run-slice.mjs for SPIKE_MODE/SPIKE_IMAGE/SPIKE_CHECK.
#
#   sudo -u endo env SPIKE_IMAGE=localhost/opencode-sandbox:<commit> \
#     SPIKE_MODE=normal /bin/sh oci/spike/run.sh
#
# The daemon's CONTAINERS_CONF is required for rootless podman operations
# (cgroup manager); it is read from the unit rather than hardcoded so a NixOS
# deploy does not invalidate it.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RELEASE=${ENDO_RELEASE:-/var/lib/endo/current}
CONTAINERS_CONF=${CONTAINERS_CONF:-$(systemctl show endo-daemon.service -p Environment 2>/dev/null | tr ' ' '\n' | sed -n 's/^CONTAINERS_CONF=//p' | head -1)}

PODMAN_PATH=$(ls /nix/store/*-podman-*/bin/podman 2>/dev/null | head -1)
if [ -n "$PODMAN_PATH" ] && [ -x "$PODMAN_PATH" ]; then
  PODMAN_BIN=$(dirname "$PODMAN_PATH")
elif command -v podman >/dev/null 2>&1; then
  PODMAN_BIN=$(dirname "$(command -v podman)")
else
  echo "podman not found" >&2
  exit 1
fi

NODE_BIN=$(ls /nix/store/*-nodejs-slim-22*/bin/node /nix/store/*-nodejs-22*/bin/node 2>/dev/null | head -1)
[ -n "$NODE_BIN" ] || { echo "node not found" >&2; exit 1; }
[ -n "${SPIKE_IMAGE:-}" ] || { echo "SPIKE_IMAGE is required" >&2; exit 1; }

export HOME=${HOME:-/var/lib/endo}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/var/lib/endo/run}
export XDG_CACHE_HOME=${XDG_CACHE_HOME:-/var/lib/endo/cache}
export XDG_STATE_HOME=${XDG_STATE_HOME:-/var/lib/endo/state}
export ENDO_ADDR=${ENDO_ADDR:-127.0.0.1:8920}
if [ -n "$CONTAINERS_CONF" ]; then
  export CONTAINERS_CONF
else
  echo "warning: CONTAINERS_CONF not found; podman may fail on cgroups" >&2
fi
export PATH="$PODMAN_BIN:$(dirname "$NODE_BIN"):/run/current-system/sw/bin:/usr/bin:/bin"

exec "$NODE_BIN" "$RELEASE/packages/cli/bin/endo.cjs" \
  run --UNCONFINED "$HERE/run-slice.mjs" --powers @agent
