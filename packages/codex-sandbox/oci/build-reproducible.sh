#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
image_name=${1:-localhost/endo-codex:0.152.0}
image_platform=${2:-linux/amd64}
case "$image_platform" in
  linux/amd64|linux/arm64) ;;
  *) echo 'Expected linux/amd64 or linux/arm64' >&2; exit 1 ;;
esac
build_epoch=1757376000

exec podman build \
  --file "$script_dir/Containerfile" \
  --layers=false \
  --no-cache \
  --platform "$image_platform" \
  --timestamp "$build_epoch" \
  --tag "$image_name" \
  "$script_dir"
