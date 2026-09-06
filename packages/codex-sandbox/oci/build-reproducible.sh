#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
image_name=${1:-localhost/endo-codex:0.152.0}
build_epoch=1757376000

exec podman build \
  --file "$script_dir/Containerfile" \
  --layers=false \
  --no-cache \
  --platform linux/amd64 \
  --timestamp "$build_epoch" \
  --tag "$image_name" \
  "$script_dir"
