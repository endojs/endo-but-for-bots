#!/usr/bin/env bash
# capture-watch-clippings — reactive watcher for the Obsidian Clippings folder.
#
# Fires the capture-agent (gemma, read-only bootstrap caps, write-only derived
# output note) whenever a new clipping appears. Idempotent: only processes a clip
# when its derived "<base> — capture.md" is missing or older than the source, so
# routine re-saves/edits don't re-trigger.
set -uo pipefail

CLIPPINGS="/home/dan/obsidian/vault/Clippings"
OUTDIR="/home/dan/obsidian/vault/the field/TADA/captures"
AGENT="/home/dan/endo-bfb/packages/chat/capture/capture-agent.mjs"
LOG="/home/dan/.local/state/field-capture/clippings-watch.log"
mkdir -p "$(dirname "$LOG")" "$OUTDIR"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
note()  { echo "[$(stamp)] $*" >>"$LOG"; }

process() {
  local src="$1"
  [[ "$src" == *.md ]] || return 0
  [[ -f "$src" ]] || return 0
  local base; base="$(basename "$src" .md)"
  local out="$OUTDIR/$base — capture.md"
  # skip if derived note exists and is newer-or-equal to the source
  if [[ -f "$out" && ! "$src" -nt "$out" ]]; then
    note "skip (up to date): $base"
    return 0
  fi
  note "processing: $base"
  if node "$AGENT" --modality clipping --file "$src" >>"$LOG" 2>&1; then
    note "done: $base"
  else
    note "ERROR processing: $base (see above)"
  fi
}

note "watcher starting on $CLIPPINGS"
# Backfill any clippings missing a derived note (e.g. arrived while we were down).
shopt -s nullglob
for f in "$CLIPPINGS"/*.md; do process "$f"; done
shopt -u nullglob

# React to new/moved-in files.
inotifywait -m -q -e close_write -e moved_to --format '%f' "$CLIPPINGS" | while read -r fname; do
  process "$CLIPPINGS/$fname"
done
