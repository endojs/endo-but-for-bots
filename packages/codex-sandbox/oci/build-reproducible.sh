#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
image_name=${1:-localhost/endo-codex:0.152.0}
image_platform=${2:-linux/amd64}
case "$image_platform" in
  linux/amd64|linux/arm64) ;;
  *) echo 'Expected linux/amd64 or linux/arm64' >&2; exit 1 ;;
esac
build_epoch=1789862400
engine=${ENGINE:-podman}
dev_image=$(sh "$script_dir/../../hosted-agent/oci/dev/build.sh" "$image_platform")
case "${engine##*/}" in
  docker) set -- --build-arg "SOURCE_DATE_EPOCH=$build_epoch" ;;
  *) set -- --layers=false --timestamp "$build_epoch" ;;
esac

exec "$engine" build \
  --build-arg "ENDO_DEV_IMAGE=$dev_image" \
  --file "$script_dir/Containerfile" \
  "$@" \
  --no-cache \
  --platform "$image_platform" \
  --tag "$image_name" \
  "$script_dir"
