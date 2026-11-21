#!/bin/sh
# Exercise the tagged checkout inside a disposable offline container.
set -eu
if [ "${1:-}" != --inside ]; then
  image=${1:?usage: smoke.sh repository@sha256:digest [git-ref]}
  here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
  repo=$(git -C "$here" rev-parse --show-toplevel)
  git -C "$repo" archive "${2:-HEAD}" -- package.json yarn.lock .yarnrc.yml \
    'ava-*.mjs' packages rust/endo/xsnap/src/polyfills.js |
    docker run --rm --interactive --pull never --network none --cap-drop ALL \
      --security-opt no-new-privileges --read-only --user 1000:1000 \
      --pids-limit 1024 --cpus 2 --memory 4g --tmpfs /tmp \
      --tmpfs /workspace:uid=1000,gid=1000,size=2600m,exec \
      --tmpfs /home/node:uid=1000,gid=1000,exec --env HOME=/home/node \
      --mount "type=bind,src=$here/smoke.sh,dst=/smoke.sh,readonly" \
      "$image" sh /smoke.sh --inside
  exit
fi

cd /workspace
tar -xf -
thix-selfdev-prepare
cd packages/thixotrope-harness
yarn test test/unit/session-inventory.test.js
cd ../..
thix=packages/thixotrope/bin/thix.js
state=/tmp/selfdev
node "$thix" serve "$state" > /tmp/selfdev-serve.log 2>&1 &
pid=$!
for i in $(seq 1 60); do
  if [ -S "$state/control.sock" ]; then break; fi
  if ! kill -0 "$pid" 2>/dev/null; then cat /tmp/selfdev-serve.log; exit 1; fi
  sleep 1
done
node "$thix" status "$state"
node "$thix" stop "$state"
wait "$pid"
thix-selfdev-prepare
