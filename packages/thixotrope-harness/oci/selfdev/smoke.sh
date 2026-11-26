#!/bin/sh
# Run a seeded checkout with the normal OCI adapter and real host bind mounts.
# Usage: smoke.sh [--runtime docker|podman] repository@sha256:digest [git-ref]
set -eu
runtime=docker
case "${1:-}" in
  --runtime) runtime=${2:?--runtime needs docker or podman}; shift 2 ;;
  --runtime=*) runtime=${1#--runtime=}; shift ;;
esac
image=${1:?usage: smoke.sh [--runtime docker|podman] repository@sha256:digest [git-ref]}
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
mkdir -m 700 "$root/workspace" "$root/home"
git -C "$repo" archive "${2:-HEAD}" -- package.json yarn.lock .yarnrc.yml \
  'ava-*.mjs' packages rust/endo/xsnap/src/polyfills.js |
  tar -xf - -C "$root/workspace"
git -C "$root/workspace" init -q
git -C "$root/workspace" -c user.name=Test -c user.email=test@example.invalid commit -qm seed --allow-empty
cp "$here/../../scripts/verify-project-turn.mjs" "$root/workspace/packages/thixotrope-harness/scripts/"
node "$here/../../scripts/verify-project-image.mjs" "$image" "$root" "$runtime"
