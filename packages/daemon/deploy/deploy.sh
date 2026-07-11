#!/usr/bin/env bash
# Deploy the full Endo Pet Daemon (OCapN-Noise over WebSocket) onto minion.town
# as a Docker container. Run ON the host as root (via SSM). Idempotent and
# phased so each phase fits an SSM command window; `all` chains them.
#
#   deploy.sh install   # install a container runtime (docker.io) if absent
#   deploy.sh fetch     # fresh shallow clone of the WS branch into $SRC
#   deploy.sh build     # docker build the image
#   deploy.sh run       # (re)start the container, publishing 127.0.0.1:8931->8930
#   deploy.sh location  # wait for + print the daemon's advertised OCapN location
#   deploy.sh caddy     # add the wss://minion.town/ocapn-daemon route + reload
#   deploy.sh all       # install fetch build run location caddy
#
# The standalone demo (endo-ocapn-daemon.service on :8930, wss://…/ocapn) is
# left untouched; this adds a second, independent endpoint for the real daemon.
set -euo pipefail

REPO_URL="${ENDO_REPO_URL:-https://github.com/endojs/endo-but-for-bots.git}"
BRANCH="${ENDO_BRANCH:-claude/endo-daemon-ocapn-ws-FkmHO}"
SRC="${ENDO_SRC:-/opt/endo-daemon-src}"
IMAGE="${ENDO_IMAGE:-endo-pet-daemon:ocapn-ws}"
CONTAINER="${ENDO_CONTAINER:-endo-pet-daemon}"
HOST_BIND="${ENDO_HOST_BIND:-127.0.0.1}"
HOST_PORT="${ENDO_HOST_PORT:-8931}"
CONTAINER_PORT=8930
DATA_VOLUME="${ENDO_DATA_VOLUME:-endo-daemon-data}"
CADDY_FILE=/etc/caddy/conf.d/minion-town.caddy

log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

phase_install() {
  if command -v docker >/dev/null 2>&1; then
    log "docker present: $(docker --version)"
  else
    log "installing docker.io"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y --no-install-recommends docker.io
  fi
  systemctl enable --now docker
  docker info >/dev/null && log "docker daemon up"
}

phase_fetch() {
  log "cloning $REPO_URL @ $BRANCH -> $SRC"
  rm -rf "$SRC"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC"
  # Docker only honors a .dockerignore at the build-context root; seed it from
  # the one that ships next to the Dockerfile.
  cp -f "$SRC/packages/daemon/deploy/.dockerignore" "$SRC/.dockerignore"
  log "clone at $(git -C "$SRC" rev-parse --short HEAD)"
}

phase_build() {
  log "building $IMAGE (compiles better-sqlite3/node-datachannel if no prebuild)"
  cd "$SRC"
  # BuildKit (built into dockerd) is required: the legacy builder + containerd
  # image store does a full-tree diff walk on EVERY step commit, which is
  # pathologically slow atop the ~900 MB install layer. BuildKit exports layers
  # once, in parallel, and skips that per-step walk.
  DOCKER_BUILDKIT=1 docker build -f packages/daemon/deploy/Dockerfile -t "$IMAGE" .
  log "built $IMAGE"
}

phase_run() {
  log "(re)starting container $CONTAINER on $HOST_BIND:$HOST_PORT->$CONTAINER_PORT"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" --restart unless-stopped \
    -p "$HOST_BIND:$HOST_PORT:$CONTAINER_PORT" \
    -v "$DATA_VOLUME:/data" \
    "$IMAGE"
  sleep 2
  docker ps --filter "name=$CONTAINER" --format '  {{.Names}} {{.Status}} {{.Ports}}'
}

phase_location() {
  log "waiting for the daemon to advertise its OCapN location"
  for _ in $(seq 1 60); do
    if docker exec "$CONTAINER" test -f /data/ocapn-daemon-location.json 2>/dev/null; then
      log "location file present:"
      docker exec "$CONTAINER" cat /data/ocapn-daemon-location.json
      return 0
    fi
    sleep 2
  done
  log "location file did not appear; container logs:"
  docker logs --tail 40 "$CONTAINER" || true
  return 1
}

phase_caddy() {
  if grep -q 'handle /ocapn-daemon' "$CADDY_FILE"; then
    log "caddy route /ocapn-daemon already present"
    return 0
  fi
  log "backing up $CADDY_FILE and inserting /ocapn-daemon route"
  cp -f "$CADDY_FILE" "$CADDY_FILE.bak-ocapn-daemon"
  # Insert the handle block immediately before the standalone demo's
  # `handle /ocapn* {` so a reader sees the more-specific route first (Caddy
  # itself orders by matcher specificity regardless of file order).
  local block
  block=$(cat <<'EOF'
	# Full Pet Daemon OCapN-Noise-WS endpoint (garden job
	# ocapn-pet-daemon-dockerfile-minion). wss://minion.town/ocapn-daemon ->
	# the Docker container's published loopback port (127.0.0.1:8931 -> the
	# daemon's OCapN-Noise WS listener). UNGATED: OCapN-over-Noise
	# self-authenticates, so the browser login gate does not apply.
	handle /ocapn-daemon* {
		reverse_proxy 127.0.0.1:8931
	}

EOF
)
  # Write the block to a temp file and splice it in before the marker line.
  local tmp; tmp=$(mktemp)
  awk -v ins="$block" '
    /handle \/ocapn\* \{/ && !done { print ins; done=1 }
    { print }
  ' "$CADDY_FILE" >"$tmp"
  mv "$tmp" "$CADDY_FILE"
  log "validating caddy config"
  caddy validate --config /etc/caddy/Caddyfile
  systemctl reload caddy
  log "caddy reloaded with /ocapn-daemon route"
}

case "${1:-all}" in
  install) phase_install ;;
  fetch) phase_fetch ;;
  build) phase_build ;;
  run) phase_run ;;
  location) phase_location ;;
  caddy) phase_caddy ;;
  all)
    phase_install; phase_fetch; phase_build; phase_run; phase_location; phase_caddy
    log "deploy complete"
    ;;
  *) echo "unknown phase: $1" >&2; exit 2 ;;
esac
