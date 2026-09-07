#!/usr/bin/env bash
# Instrument every XS/shim C object and link both sanitizer runtimes into the
# Rust test executable. No nightly Rust or instrumentation of Rust is implied.
set -euo pipefail

engine_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$engine_directory"

# Cargo's encoded flags override RUSTFLAGS; refuse an environment that could
# silently drop the sanitizer runtime linker flags below.
if [[ -n ${CARGO_ENCODED_RUSTFLAGS:-} ]]; then
  echo 'Unset CARGO_ENCODED_RUSTFLAGS before running oracle sanitizers.' >&2
  exit 1
fi
export CC=clang
export CFLAGS="${CFLAGS:-} -fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer"
# Rust's default -nodefaultlibs also suppresses Clang's sanitizer runtimes.
export RUSTFLAGS="${RUSTFLAGS:-} -C linker=clang -C default-linker-libraries=yes -C link-arg=-fsanitize=address,undefined"
# Do not inherit runtime suppressions or exitcode=0 from another sanitizer run.
export ASAN_OPTIONS="halt_on_error=1:exitcode=1"
export UBSAN_OPTIONS="halt_on_error=1:exitcode=1:print_stacktrace=1"
export RUST_MIN_STACK=33554432
# Separate normal and instrumented artifacts, including the C static library.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$engine_directory/target/sanitizers}"

clang --version
# An explicit native target keeps these linker flags off host build scripts and
# proc-macro dylibs; loading ASAN via a proc macro into rustc is too late for its
# interceptors and can abort the compiler before any oracle test runs.
native_target=$(rustc -vV | sed -n 's/^host: //p')
cargo test --locked --target "$native_target" --no-fail-fast \
  -p xs-oracle -p ironhorse-compile -p ironhorse-regexp -p ironhorse-262 -p ironhorse-fuzz \
  --features ironhorse-compile/parity,ironhorse-regexp/parity \
  "$@" \
  -- --test-threads=1
