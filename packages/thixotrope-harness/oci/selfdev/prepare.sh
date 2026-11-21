#!/bin/sh
# Restore an ordinary editable Linux checkout from the image's offline cache.
set -eu
cd "${1:-/workspace}"
test -f packages/thixotrope-harness/package.json || { echo 'Expected a full Endo checkout' >&2; exit 1; }
sha256sum --check --status /opt/thix-selfdev/lock.sha256 || {
  echo 'The checkout yarn.lock differs from the development image. Rebuild the image for this lockfile.' >&2
  exit 1
}
# The pnpm linker hardlinks its unpacked index into node_modules. Keep the
# index on the same mount as the checkout, including on Docker Desktop.
YARN_GLOBAL_FOLDER="$PWD/.yarn/selfdev" npm_config_nodedir=/usr/local \
  YARN_ENABLE_NETWORK=0 yarn install --immutable
mkdir -p target/release
if [ ! -e target/release/thixotrope-ironhorse-worker ]; then
  ln -s /opt/thix-selfdev/thixotrope-ironhorse-worker target/release/thixotrope-ironhorse-worker
fi
node packages/thixotrope/scripts/bundle-ironhorse-worker.mjs
