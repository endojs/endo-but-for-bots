#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${ANDROID_NDK_HOME:?Set ANDROID_NDK_HOME to an installed Android NDK}"
case "$(uname -s)" in
  Darwin) host_tag=darwin-x86_64 ;;
  Linux) host_tag=linux-x86_64 ;;
  *) echo 'Unsupported Android build host' >&2; exit 1 ;;
esac
compiler_dir="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/$host_tag/bin"
export CC_aarch64_linux_android="$compiler_dir/aarch64-linux-android29-clang"
export CXX_aarch64_linux_android="$compiler_dir/aarch64-linux-android29-clang++"
export AR_aarch64_linux_android="$compiler_dir/llvm-ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CC_aarch64_linux_android"
node packages/daemon/scripts/bundle-bus-worker-xs-ses-boot.mjs
node packages/daemon/scripts/bundle-bus-worker-xs.mjs
node packages/daemon/scripts/bundle-bus-daemon-rust-xs.mjs
node packages/daemon/scripts/bundle-archive-text-endowments-xs.mjs
cargo build --locked --release --package endo --bin endor --no-default-features --target aarch64-linux-android
runtime_dir=packages/floot-android/android/app/src/main/jniLibs/arm64-v8a
mkdir -p "$runtime_dir"
cp target/aarch64-linux-android/release/endor "$runtime_dir/libendor.so"
