#!/bin/bash
# Build the guest Alpine rootfs.
#
# Usage:
#   ./scripts/build-rootfs.sh <arch> <staging-dir> <output-raw>
#
# Where:
#   <arch>          x86_64 or aarch64
#   <staging-dir>   Directory of files to rsync into the rootfs on top of
#                   the tracked images/files/ overlay. build-image.sh stages
#                   the Rust binaries (init, claude-agent) here.
#   <output-raw>    Destination ext4 image, e.g. .../rootfs-arm64.raw.
#
# Background:
#   The upstream PR shipped images/mkosi.conf with Distribution=alpine, but
#   `mkosi` has never officially supported Alpine (the Alpine release format
#   isn't on its allow-list of recognised distros). That made the documented
#   build pipeline broken on day one. This script replaces the `mkosi build`
#   step with `alpine-make-rootfs`, the Alpine-team-maintained equivalent.
#   The package list now lives in images/packages.list, the post-install
#   hook in images/postinst.sh, and the rootfs overlay in images/files/.
#
# Runs as root (needs mount-bind for chroot setup). Suitable for use inside
# a privileged container or a Linux host with sudo. See README.md §"Build
# the guest image" for the supported run modes.
set -euo pipefail

ARCH="${1:?usage: build-rootfs.sh <arch> <staging-dir> <output-raw>}"
STAGING="${2:?usage: build-rootfs.sh <arch> <staging-dir> <output-raw>}"
OUTPUT_RAW="${3:?usage: build-rootfs.sh <arch> <staging-dir> <output-raw>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE_DIR="$PACKAGE_DIR/images"

# Knobs. Defaults are pinned for reproducibility; overrides allow bumping
# Alpine or alpine-make-rootfs without editing this file.
ALPINE_BRANCH="${ALPINE_BRANCH:-3.20}"
ALPINE_MIRROR="${ALPINE_MIRROR:-https://dl-cdn.alpinelinux.org/alpine}"
ALPINE_MAKE_ROOTFS_VERSION="${ALPINE_MAKE_ROOTFS_VERSION:-v0.8.1}"
ALPINE_MAKE_ROOTFS_SHA256="${ALPINE_MAKE_ROOTFS_SHA256:-b4cd8202fa04eae8b4abae22708638cf00ab5826d8b919bc86932fc0cb269f00}"
APK_TOOLS_STATIC_VERSION="${APK_TOOLS_STATIC_VERSION:-2.14.4-r1}"
ROOTFS_SIZE_MB="${ROOTFS_SIZE_MB:-2048}"

case "$ARCH" in
  x86_64)
    APK_ARCH=x86_64
    # SHA256 of apk-tools-static-${APK_TOOLS_STATIC_VERSION}.apk on
    # dl-cdn.alpinelinux.org for the matching Alpine branch.
    APK_TOOLS_STATIC_SHA256="${APK_TOOLS_STATIC_SHA256:-42fe483a9fc4f8b194eb8ba24849ea7dc4f1b60570674c6c319b82a32c65b6e0}"
    ;;
  aarch64|arm64)
    APK_ARCH=aarch64
    APK_TOOLS_STATIC_SHA256="${APK_TOOLS_STATIC_SHA256:-7a2457042a43741d66e2a1b968429544faadab23d7b935de71916ecd0e65f2fe}"
    ;;
  *)
    echo "unknown arch: $ARCH (expected x86_64, aarch64, or arm64)" >&2
    exit 1
    ;;
esac

require_cmd() {
  command -v "$1" >/dev/null 2>&1 \
    || { echo "missing required command: $1" >&2; exit 1; }
}
require_cmd curl
require_cmd tar
require_cmd sha256sum
require_cmd rsync
require_cmd mke2fs

if [ "$(id -u)" -ne 0 ]; then
  echo "build-rootfs.sh must run as root (needs mount-bind for chroot setup)." >&2
  echo "Re-run under sudo, or inside a privileged container." >&2
  exit 1
fi

if [ "$(uname -s)" != "Linux" ]; then
  echo "build-rootfs.sh requires a Linux host (uname -s = $(uname -s))." >&2
  echo "On macOS, run inside Docker; see README.md §Build the guest image." >&2
  exit 1
fi

TMP="$(mktemp -d)"
ROOTFS_DIR="$TMP/rootfs"
trap 'rm -rf "$TMP"' EXIT

# Fetch and verify alpine-make-rootfs. Pin to a tag + SHA so a tampered
# CDN can't smuggle in a different script under our root privileges.
AMR="$TMP/alpine-make-rootfs"
echo "== fetching alpine-make-rootfs $ALPINE_MAKE_ROOTFS_VERSION"
curl -fsSLo "$AMR" \
  "https://raw.githubusercontent.com/alpinelinux/alpine-make-rootfs/$ALPINE_MAKE_ROOTFS_VERSION/alpine-make-rootfs"
echo "$ALPINE_MAKE_ROOTFS_SHA256  $AMR" | sha256sum -c -
chmod +x "$AMR"

# Fetch apk-tools-static for the target arch. alpine-make-rootfs has its
# own download path baked in but only for x86_64; for cross-arch builds
# we provide $APK explicitly. Pinning the SHA matters here too — apk.static
# runs as root and bootstraps every other binary in the rootfs.
echo "== fetching apk-tools-static $APK_TOOLS_STATIC_VERSION ($APK_ARCH)"
APK_PKG="$TMP/apk-tools-static.apk"
curl -fsSLo "$APK_PKG" \
  "$ALPINE_MIRROR/v$ALPINE_BRANCH/main/$APK_ARCH/apk-tools-static-$APK_TOOLS_STATIC_VERSION.apk"
echo "$APK_TOOLS_STATIC_SHA256  $APK_PKG" | sha256sum -c -

APK_EXTRACT="$TMP/apk-extract"
mkdir -p "$APK_EXTRACT"
tar -xzf "$APK_PKG" -C "$APK_EXTRACT" sbin/apk.static
export APK="$APK_EXTRACT/sbin/apk.static"
chmod +x "$APK"

# Parse packages.list. Format: one package per line, blank lines and
# lines starting with `#` ignored. Token-quote with awk to avoid eval.
PACKAGES="$(awk '/^[[:space:]]*#/ { next } NF { printf "%s ", $1 }' \
  "$IMAGE_DIR/packages.list")"
if [ -z "${PACKAGES// /}" ]; then
  echo "no packages listed in $IMAGE_DIR/packages.list" >&2
  exit 1
fi

echo "== alpine-make-rootfs (arch=$APK_ARCH, branch=v$ALPINE_BRANCH)"
# `-c` runs postinst.sh inside the rootfs chroot so `npm install -g` uses
# the *guest's* node, not the build host's. We deliberately do NOT pass
# `-s FS_SKEL_DIR` here: alpine-make-rootfs's chroot setup overwrites
# /etc/resolv.conf with the host's (to enable network during postinst)
# and *deletes* it again at cleanup, which would wipe our overlay's
# /etc/resolv.conf. Apply the overlay below, after cleanup completes.
"$AMR" \
  -b "$ALPINE_BRANCH" \
  -m "$ALPINE_MIRROR" \
  -p "$PACKAGES" \
  -c \
  "$ROOTFS_DIR" \
  "$IMAGE_DIR/postinst.sh"

# Apply the static overlay + caller-staged binaries on top of the
# freshly-bootstrapped rootfs. Order matters: overlay first (to put down
# /etc/resolv.conf etc.), then staging (so binaries trump any same-path
# overlay if they ever collide).
echo "== applying overlay (images/files/) and staging"
if [ -d "$IMAGE_DIR/files" ]; then
  rsync -a "$IMAGE_DIR/files/" "$ROOTFS_DIR/"
fi
if [ -d "$STAGING" ]; then
  rsync -a "$STAGING/" "$ROOTFS_DIR/"
fi

# Pack the directory tree into a flat ext4 image with `mke2fs -d`. This
# matches what scripts/smoke-boot.sh does for the minimal rootfs.
echo "== packing ext4 image -> $OUTPUT_RAW (${ROOTFS_SIZE_MB}M)"
rm -f "$OUTPUT_RAW"
mkdir -p "$(dirname "$OUTPUT_RAW")"
mke2fs -q -t ext4 -d "$ROOTFS_DIR" -L claude-orch \
  "$OUTPUT_RAW" "${ROOTFS_SIZE_MB}M"

echo "== rootfs ready"
ls -la "$OUTPUT_RAW"
