#!/bin/bash
# Make the script invokable from any cwd (e.g. `bash
# rust/ocapn_noise/build.sh` from the repo root, or `yarn build:wasm`).
set -e
cd "$(dirname "$0")"
cargo build --target wasm32-unknown-unknown --lib --release
cp ../../target/wasm32-unknown-unknown/release/ocapn_noise_protocol_facilities.wasm \
  ../../packages/ocapn-noise/gen/ocapn-noise.wasm
