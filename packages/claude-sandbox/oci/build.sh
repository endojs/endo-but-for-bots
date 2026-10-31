#!/bin/sh
set -eu
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
image_name=${1:-localhost/claude-code:2.1.233}
image_platform=${2:-linux/amd64}
engine=${ENGINE:-podman}
dev_image=$(sh "$script_dir/../../hosted-agent/oci/dev/build.sh" "$image_platform")
case "${engine##*/}" in
  docker) set -- --build-arg SOURCE_DATE_EPOCH=1789862400 ;;
  *) set -- --timestamp 1789862400 ;;
esac
exec "$engine" build --file "$script_dir/Containerfile" \
  --build-arg "ENDO_DEV_IMAGE=$dev_image" \
  --platform "$image_platform" "$@" \
  --tag "$image_name" "$script_dir"
