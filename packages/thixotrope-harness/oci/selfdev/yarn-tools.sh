#!/bin/sh
# Tool-local defaults for the immutable image and the session's writable home.
set -eu
export COREPACK_HOME=/opt/thix-selfdev/corepack COREPACK_ENABLE_NETWORK=0
export YARN_CACHE_FOLDER=/opt/thix-selfdev/cache YARN_ENABLE_GLOBAL_CACHE=false
# Yarn runs its executable command wrappers under TMPDIR. Docker's /tmp is noexec.
export TMPDIR="$HOME"
case "${0##*/}" in
  yarn|yarnpkg) set -- yarn "$@" ;;
esac
exec node /usr/local/lib/node_modules/corepack/dist/corepack.js "$@"
