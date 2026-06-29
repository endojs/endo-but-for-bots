#!/bin/sh
set -eu

: "${ENDO_STATE:=/data/endo}"
: "${ENDO_STATE_PATH:=$ENDO_STATE/state}"
: "${ENDO_EPHEMERAL_STATE_PATH:=$ENDO_STATE/run}"
: "${ENDO_CACHE_PATH:=$ENDO_STATE/cache}"
: "${ENDO_SOCK_PATH:=$ENDO_EPHEMERAL_STATE_PATH/endo.sock}"
: "${ENDO_ADDR:=0.0.0.0:8920}"
: "${ENDO_GATEWAY:=remote}"
: "${ENDO_CHAT_DIST:=/opt/endo/chat}"
: "${ENDO_WORKER_SUBPROCESS_PATH:=/opt/endo/bundles/worker-node.cjs}"

export ENDO_STATE
export ENDO_STATE_PATH
export ENDO_EPHEMERAL_STATE_PATH
export ENDO_CACHE_PATH
export ENDO_SOCK_PATH
export ENDO_ADDR
export ENDO_GATEWAY
export ENDO_CHAT_DIST
export ENDO_WORKER_SUBPROCESS_PATH

mkdir -p "$ENDO_STATE_PATH" "$ENDO_EPHEMERAL_STATE_PATH" "$ENDO_CACHE_PATH"
rm -f "$ENDO_SOCK_PATH"

exec node /opt/endo/bundles/endo-daemon.cjs \
  "$ENDO_SOCK_PATH" \
  "$ENDO_STATE_PATH" \
  "$ENDO_EPHEMERAL_STATE_PATH" \
  "$ENDO_CACHE_PATH"
