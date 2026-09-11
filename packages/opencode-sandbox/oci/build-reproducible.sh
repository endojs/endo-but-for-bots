#!/bin/sh
# Build the @endo/opencode-sandbox image.
#
#   OPENCODE_BINARY=/path/to/linux-x64/opencode ./build-reproducible.sh
#   OPENCODE_BINARY=... OPENCODE_BINARY_SHA256=<hex> ./build-reproducible.sh
#   ./build-reproducible.sh --source
#
# Default (prebuilt): consume a patched CLI cross-built from the pinned fork
# commit with bun@1.3.14 and copy it into Containerfile. This is the Tokyo
# deployment path. The binary digest is verified when OPENCODE_BINARY_SHA256
# is provided and always printed for the release record.
# --source: build the CLI inside the image with Containerfile.source; needs
# ~10-15 GB of scratch space and network access.
#
# Both print the image id, in-image CLI digest, and version. The model catalog
# is embedded in the binary at build time (script/build.ts) and the runtime
# fetch is disabled; no external catalog file is consumed.
# Requires podman (or docker) and git; the source path also needs network
# access for the clone and package install.
set -eu

SOURCE=0
if [ "${1:-}" = "--source" ]; then
  SOURCE=1
  shift
fi

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OPENCODE_REPO=${OPENCODE_REPO:-https://github.com/kumavis/opencode.git}
OPENCODE_REF=${OPENCODE_REF:-build/v1.18.30-opencode-patched}
OPENCODE_COMMIT=${OPENCODE_COMMIT:-}
if [ -z "$OPENCODE_COMMIT" ] && command -v git >/dev/null 2>&1; then
  OPENCODE_COMMIT=$(git ls-remote "$OPENCODE_REPO" "$OPENCODE_REF" 2>/dev/null | cut -f1)
fi
[ -n "$OPENCODE_COMMIT" ] ||
  { echo "OPENCODE_COMMIT required (cannot resolve $OPENCODE_REF; is git/network available?)" >&2; exit 1; }
IMAGE=${IMAGE:-localhost/opencode-sandbox:$(echo "$OPENCODE_COMMIT" | cut -c1-12)}
PLATFORM=${PLATFORM:-linux/amd64}
ENGINE=${ENGINE:-podman}
LAYERS=${LAYERS:-false}

digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    echo "no sha256sum/openssl available" >&2
    exit 1
  fi
}

if [ "$SOURCE" = 1 ]; then
  "$ENGINE" build --platform "$PLATFORM" --layers="$LAYERS" \
    --build-arg "OPENCODE_REPO=$OPENCODE_REPO" \
    --build-arg "OPENCODE_REF=$OPENCODE_REF" \
    --build-arg "OPENCODE_COMMIT=$OPENCODE_COMMIT" \
    -f "$HERE/Containerfile.source" \
    -t "$IMAGE" "$HERE"
else
  BINARY=${OPENCODE_BINARY:-${1:-}}
  [ -n "$BINARY" ] || { echo "usage: OPENCODE_BINARY=<linux binary> $0 [--source]" >&2; exit 1; }
  [ -f "$BINARY" ] || { echo "binary not found: $BINARY" >&2; exit 1; }

  if command -v file >/dev/null 2>&1; then
    case "$PLATFORM" in
      *amd64) file -b "$BINARY" | grep -q "x86-64" || echo "warning: $BINARY may not match $PLATFORM" >&2 ;;
      *arm64) file -b "$BINARY" | grep -qE "aarch64|ARM" || echo "warning: $BINARY may not match $PLATFORM" >&2 ;;
    esac
  fi

  BINARY_DIGEST=$(digest "$BINARY")
  if [ -n "${OPENCODE_BINARY_SHA256:-}" ]; then
    [ "$BINARY_DIGEST" = "$OPENCODE_BINARY_SHA256" ] ||
      { echo "binary digest mismatch: $BINARY_DIGEST != $OPENCODE_BINARY_SHA256" >&2; exit 1; }
    echo "binary sha256 verified: $BINARY_DIGEST"
  else
    echo "binary sha256 (recorded, not verified): $BINARY_DIGEST"
  fi

  CONTEXT=$(mktemp -d)
  trap 'rm -rf "$CONTEXT"' EXIT
  trap 'exit 130' INT TERM
  cp "$HERE/Containerfile" "$CONTEXT/Containerfile"
  cp "$BINARY" "$CONTEXT/opencode"
  chmod 0755 "$CONTEXT/opencode"

  "$ENGINE" build --platform "$PLATFORM" --layers="$LAYERS" -t "$IMAGE" "$CONTEXT"
fi

echo "image: $IMAGE"
"$ENGINE" image inspect --format '{{.Id}}' "$IMAGE"
"$ENGINE" run --rm --platform "$PLATFORM" --entrypoint sha256sum "$IMAGE" /usr/local/bin/opencode
"$ENGINE" run --rm --platform "$PLATFORM" --entrypoint opencode "$IMAGE" --version
