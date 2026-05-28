#!/bin/bash
# Build the claude-orch guest rootfs + kernel for one architecture.
#
# Usage:
#   ./scripts/build-image.sh [x86_64|aarch64]
#   ./scripts/build-image.sh --check [arch]   # validate prereqs, no build
#
# Requires (on the host running this script):
#   - cargo + rustup with the musl target installed
#   - e2fsprogs (mke2fs -d) and rsync, for build-rootfs.sh
#   - linux source tree at $LINUX_SRC (default: /usr/src/linux)
#   - Linux host running as root (for build-rootfs.sh's chroot)
#
# The rootfs step uses alpine-make-rootfs (downloaded + SHA-pinned by
# build-rootfs.sh) — the upstream `mkosi` path that the original commit
# of this script targeted never worked because mkosi has no Alpine
# distribution backend. See scripts/build-rootfs.sh and DESIGN.md §8.1.
#
# Outputs land in build/<arch>/.
set -euo pipefail

CHECK_ONLY=0
if [ "${1:-}" = "--check" ]; then
  CHECK_ONLY=1
  shift
fi

ARCH="${1:-x86_64}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PACKAGE_DIR/../.." && pwd)"
IMAGE_DIR="$PACKAGE_DIR/images"
BUILD_DIR="$IMAGE_DIR/build/$ARCH"
LINUX_SRC="${LINUX_SRC:-/usr/src/linux}"
# Pin to an exact version by default; floating tags are a supply-chain
# surface. Bump after testing the CLI shape end-to-end with smoke-boot.
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.0.0}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    return 1
  fi
}

check_prereqs() {
  local missing=0
  require_cmd cargo || missing=1
  require_cmd make || missing=1
  # build-rootfs.sh dependencies. Listing them here too so `--check`
  # surfaces a missing mke2fs before we burn the rust build.
  require_cmd mke2fs || missing=1
  require_cmd rsync || missing=1
  require_cmd curl || missing=1
  require_cmd sha256sum || missing=1
  if [ ! -d "$LINUX_SRC" ]; then
    echo "Missing kernel source tree at LINUX_SRC=$LINUX_SRC" >&2
    missing=1
  fi
  if [ "$(uname -s)" != "Linux" ]; then
    echo "build-image.sh requires a Linux host (uname -s = $(uname -s))" >&2
    missing=1
  fi
  return $missing
}

# Validate the arch positional against the supported set. Called from
# both the `--check` early-exit path and the main build path so an
# unknown arch can't pass `--check` and then surface a confusing
# failure deeper in the build.
check_arch() {
  case "$ARCH" in
    x86_64|aarch64|arm64) return 0 ;;
    *)
      echo "unknown arch: $ARCH (expected x86_64, aarch64, or arm64)" >&2
      return 1
      ;;
  esac
}

if [ "$CHECK_ONLY" = "1" ]; then
  ok=0
  check_prereqs || ok=1
  check_arch || ok=1
  if [ "$ok" = 0 ]; then
    echo "All prerequisites satisfied for arch=$ARCH."
    exit 0
  fi
  exit 1
fi

if ! check_prereqs; then
  exit 1
fi
if ! check_arch; then
  exit 1
fi

mkdir -p "$BUILD_DIR"

case "$ARCH" in
  x86_64)
    RUST_TARGET="x86_64-unknown-linux-musl"
    KERNEL_ARCH="x86_64"
    KERNEL_TARGET="bzImage"
    KERNEL_IMG="vmlinux-x86_64"
    KERNEL_RELPATH="arch/x86/boot/bzImage"
    ROOTFS_IMG="rootfs-x86_64.raw"
    ;;
  aarch64|arm64)
    ARCH=aarch64
    RUST_TARGET="aarch64-unknown-linux-musl"
    KERNEL_ARCH="arm64"
    KERNEL_TARGET="Image"
    KERNEL_IMG="Image-arm64"
    KERNEL_RELPATH="arch/arm64/boot/Image"
    ROOTFS_IMG="rootfs-arm64.raw"
    ;;
  *)
    echo "unknown arch: $ARCH" >&2
    exit 1
    ;;
esac

echo "== building guest binaries (Rust, target=$RUST_TARGET)"
cargo build --release \
  --target "$RUST_TARGET" \
  --manifest-path "$REPO_ROOT/rust/claude-orch/bootstrap-init/Cargo.toml"
# `--features seccomp` here is the load-bearing flag that puts the
# filter into the shipping `claude-agent`. The crate's default
# feature set is empty (so host `cargo check` works on macOS+Windows);
# guest builds must opt in explicitly.
cargo build --release \
  --target "$RUST_TARGET" \
  --features seccomp \
  --manifest-path "$REPO_ROOT/rust/claude-orch/runtime-agent/Cargo.toml"

# Stage the Rust binaries into a private directory which build-rootfs.sh
# rsyncs onto the rootfs on top of the tracked images/files/ overlay.
# Done out-of-tree so a previous build's binaries can never leak into a
# tracked path or follow-on `git status`.
STAGING="$BUILD_DIR/staging"
rm -rf "$STAGING"
install -m 0755 -D "$REPO_ROOT/target/$RUST_TARGET/release/init" \
  "$STAGING/sbin/init"
install -m 0755 -D "$REPO_ROOT/target/$RUST_TARGET/release/claude-agent" \
  "$STAGING/usr/local/bin/claude-agent"

echo "== building rootfs (alpine-make-rootfs, arch=$ARCH)"
CLAUDE_CODE_VERSION="$CLAUDE_CODE_VERSION" \
  "$SCRIPT_DIR/build-rootfs.sh" "$ARCH" "$STAGING" \
  "$BUILD_DIR/$ROOTFS_IMG"

echo "== building kernel ($KERNEL_ARCH $KERNEL_TARGET)"
if [ ! -d "$LINUX_SRC" ]; then
  echo "LINUX_SRC=$LINUX_SRC not found." >&2
  echo "Point LINUX_SRC at a kernel source tree (>= 6.6)." >&2
  exit 1
fi
( cd "$LINUX_SRC" && \
    make ARCH="$KERNEL_ARCH" tinyconfig && \
    ./scripts/kconfig/merge_config.sh -m .config \
      "$IMAGE_DIR/kernel/microvm.fragment" && \
    make ARCH="$KERNEL_ARCH" olddefconfig && \
    make ARCH="$KERNEL_ARCH" -j"$(nproc)" "$KERNEL_TARGET" )

install -m 0644 "$LINUX_SRC/$KERNEL_RELPATH" "$BUILD_DIR/$KERNEL_IMG"

echo "== artifacts in $BUILD_DIR"
ls -la "$BUILD_DIR"
