#!/bin/bash
# Generate the Familiar application's platform-specific icon files from a
# single SVG source. Outputs (under assets/) are checked in so the packaging
# step has them without a regen toolchain; this script is the regen path.
#
# Pipeline (canonical, deterministic on Linux and macOS via the same tools):
#
#   art/familiar.svg                                  (source)
#     -> assets/icon-{16,32,64,128,256,512,1024}.png  (rsvg-convert)
#     -> assets/icon.icns                             (png2icns, libicns)
#     -> assets/icon.ico                              (icotool, icoutils)
#
# Required tools:
#
#   rsvg-convert   librsvg2-bin       (Linux) | librsvg              (macOS via brew)
#   png2icns       icnsutils          (Linux) | libicns              (macOS via brew)
#   icotool        icoutils           (Linux) | icoutils             (macOS via brew)
#
# Usage:
#
#   ./scripts/generate-icons.sh             # regenerate all artifacts in place
#   ./scripts/generate-icons.sh --check     # generate to a tempdir and diff
#                                           #   against checked-in assets;
#                                           #   non-zero exit on drift (CI use)
#   ./scripts/generate-icons.sh --png-only  # PNG sizes only
#   ./scripts/generate-icons.sh --ico-only  # .ico only (PNGs in a tempdir)
#   ./scripts/generate-icons.sh --icns-only # .icns only (PNGs in a tempdir)
#
# Exit codes:
#   0  success (or --check with no drift)
#   1  a required tool is missing
#   2  --check found drift between source-derived and checked-in artifacts

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FAMILIAR_DIR="$SCRIPT_DIR/.."
ASSETS_DIR="$FAMILIAR_DIR/assets"
SVG_SOURCE="$FAMILIAR_DIR/art/familiar.svg"

# Sizes packed into the macOS .icns. libicns / png2icns supports the
# following icon-type sizes; 64 is intentionally omitted because libicns has
# no native icns type for it (Apple's spec covers 16, 32, 128, 256, 512,
# 1024; 64 is iconset-only via 32@2x).
ICNS_SIZES=(16 32 128 256 512 1024)
# Sizes used in the Windows .ico bundle (16/32/48/64/256 are conventional).
ICO_SIZES=(16 32 48 64 256)
# All sizes that need a checked-in PNG. The .icns sizes are what
# `scripts/package-app.mjs` passes to `@electron/packager` via assets/icon
# (the packager picks icon-${size}.png by suffix per platform).
PNG_SIZES=(16 32 64 128 256 512 1024)

MODE=all
CHECK=false
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=true ;;
    --png-only) MODE=png ;;
    --ico-only) MODE=ico ;;
    --icns-only) MODE=icns ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

require_tool() {
  local tool=$1
  local pkg_linux=$2
  local pkg_macos=$3
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: required tool '$tool' not found." >&2
    echo "  install on Linux:  apt-get install $pkg_linux" >&2
    echo "  install on macOS:  brew install $pkg_macos" >&2
    exit 1
  fi
}

if [ ! -f "$SVG_SOURCE" ]; then
  echo "error: source SVG not found at $SVG_SOURCE" >&2
  exit 1
fi

# Working directory: in-place when regenerating, tempdir when verifying.
if [ "$CHECK" = true ]; then
  WORK_DIR="$(mktemp -d)"
  trap 'rm -rf "$WORK_DIR"' EXIT
  echo "generate-icons: --check mode; writing to $WORK_DIR"
else
  WORK_DIR="$ASSETS_DIR"
  mkdir -p "$WORK_DIR"
fi

render_pngs() {
  require_tool rsvg-convert librsvg2-bin librsvg
  local sizes=("$@")
  for size in "${sizes[@]}"; do
    echo "  rsvg-convert -> icon-${size}.png"
    rsvg-convert "$SVG_SOURCE" -w "$size" -h "$size" \
      -o "$WORK_DIR/icon-${size}.png"
  done
}

render_icns() {
  require_tool png2icns icnsutils libicns
  # png2icns selects per-size icns types from the input PNG dimensions.
  local pngs=()
  for size in "${ICNS_SIZES[@]}"; do
    pngs+=("$WORK_DIR/icon-${size}.png")
  done
  echo "  png2icns -> icon.icns"
  png2icns "$WORK_DIR/icon.icns" "${pngs[@]}" >/dev/null
}

render_ico() {
  require_tool icotool icoutils icoutils
  # The .ico bundles its own size set, including 48 (which is not a
  # checked-in PNG). Render the .ico's PNGs into a private scratch dir so
  # the checked-in assets/ stays exactly PNG_SIZES.
  local scratch
  scratch="$(mktemp -d)"
  trap 'rm -rf "$scratch"' RETURN
  local pngs=()
  for size in "${ICO_SIZES[@]}"; do
    rsvg-convert "$SVG_SOURCE" -w "$size" -h "$size" \
      -o "$scratch/icon-${size}.png"
    pngs+=("$scratch/icon-${size}.png")
  done
  echo "  icotool -> icon.ico"
  icotool --create --output "$WORK_DIR/icon.ico" "${pngs[@]}"
}

# Distinct PNG sets per output:
#   `all` and `png` need the union (PNG_SIZES is the union).
#   `icns` needs ICNS_SIZES.
#   `ico` needs ICO_SIZES (note: 48 is ico-only).
case "$MODE" in
  all)
    echo "generate-icons: rendering PNGs at sizes: ${PNG_SIZES[*]}"
    render_pngs "${PNG_SIZES[@]}"
    render_icns
    render_ico
    ;;
  png)
    echo "generate-icons: rendering PNGs at sizes: ${PNG_SIZES[*]}"
    render_pngs "${PNG_SIZES[@]}"
    ;;
  ico)
    # render_ico draws its own PNGs into a scratch dir.
    render_ico
    ;;
  icns)
    render_pngs "${ICNS_SIZES[@]}"
    render_icns
    ;;
esac

if [ "$CHECK" = true ]; then
  echo "generate-icons: comparing generated artifacts against $ASSETS_DIR"
  drift=0
  drift_files=()
  case "$MODE" in
    all|png)
      for size in "${PNG_SIZES[@]}"; do
        if ! cmp -s "$WORK_DIR/icon-${size}.png" "$ASSETS_DIR/icon-${size}.png"; then
          drift=$((drift + 1))
          drift_files+=("assets/icon-${size}.png")
        fi
      done
      ;;
  esac
  case "$MODE" in
    all|icns)
      if ! cmp -s "$WORK_DIR/icon.icns" "$ASSETS_DIR/icon.icns"; then
        drift=$((drift + 1))
        drift_files+=("assets/icon.icns")
      fi
      ;;
  esac
  case "$MODE" in
    all|ico)
      if ! cmp -s "$WORK_DIR/icon.ico" "$ASSETS_DIR/icon.ico"; then
        drift=$((drift + 1))
        drift_files+=("assets/icon.ico")
      fi
      ;;
  esac
  if [ "$drift" -gt 0 ]; then
    echo "generate-icons: drift detected in $drift artifact(s):" >&2
    for f in "${drift_files[@]}"; do
      echo "  $f" >&2
    done
    echo "" >&2
    echo "The checked-in icon artifacts under assets/ are out of sync with" >&2
    echo "art/familiar.svg. Regenerate locally with:" >&2
    echo "  cd packages/familiar && ./scripts/generate-icons.sh" >&2
    echo "and commit the updated assets/." >&2
    exit 2
  fi
  echo "generate-icons: no drift; checked-in artifacts match source."
  exit 0
fi

echo ""
echo "generate-icons: wrote artifacts to $ASSETS_DIR:"
case "$MODE" in
  all)  ls -lh "$ASSETS_DIR"/icon-*.png "$ASSETS_DIR/icon.icns" "$ASSETS_DIR/icon.ico" ;;
  png)  ls -lh "$ASSETS_DIR"/icon-*.png ;;
  ico)  ls -lh "$ASSETS_DIR/icon.ico" ;;
  icns) ls -lh "$ASSETS_DIR/icon.icns" ;;
esac
