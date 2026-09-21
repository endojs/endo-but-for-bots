#!/bin/sh
# Print only the immutable local image ID on stdout; build logs go to stderr.
set -eu
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
image_platform=${1:-linux/amd64}
engine=${ENGINE:-podman}
case "$image_platform" in
  linux/amd64|linux/arm64) ;;
  *) echo 'Expected linux/amd64 or linux/arm64' >&2; exit 1 ;;
esac
if [ -n "${ENDO_DEV_IMAGE:-}" ]; then
  printf '%s\n' "$ENDO_DEV_IMAGE" | grep -Eq '^(sha256:|[^[:space:]@]+@sha256:)[a-f0-9]{64}$' ||
    { echo 'ENDO_DEV_IMAGE must be an immutable image ID or digest reference' >&2; exit 1; }
  image_name=$ENDO_DEV_IMAGE
else
  image_name="localhost/endo-agent-dev:node22.23.2-${image_platform#linux/}"
  case "${engine##*/}" in
    docker) set -- --build-arg SOURCE_DATE_EPOCH=1789862400 ;;
    *) set -- --layers=false --timestamp 1789862400 ;;
  esac
  "$engine" build --file "$script_dir/Containerfile" \
    "$@" --no-cache --platform "$image_platform" \
    --tag "$image_name" "$script_dir" >&2
fi
actual_platform=$("$engine" image inspect --format '{{.Os}}/{{.Architecture}}' "$image_name")
[ "$actual_platform" = "$image_platform" ] ||
  { echo "Development image platform mismatch: $actual_platform != $image_platform" >&2; exit 1; }
"$engine" image inspect --format '{{.Id}}' "$image_name"
