#!/usr/bin/env bash
# photo-ingest — pull NEW photos from NextCloud (on friky) and run them through
# the capture-agent's image modality (EXIF/GPS + gemma vision → derived note).
# inotify can't watch a remote FS, so this is timer-driven (the (b) approach).
# Tracks a seen-set by relative path; FIRST run baselines existing photos (marks
# them seen, processes none) so the library isn't re-dumped.
set -uo pipefail
FRIKY="root@192.168.50.74"
NC="/mnt/user/appdata/nextcloud/data/dan/files/Photos"
LOCAL="$HOME/.local/state/field-capture/media/nextcloud-photos"
SEEN="$HOME/.local/state/field-capture/photos-seen.txt"
AGENT="$HOME/endo-bfb/packages/chat/capture/capture-agent.mjs"
LOG="$HOME/.local/state/field-capture/photo-ingest.log"
MAX_PER_RUN=15
mkdir -p "$LOCAL"; touch "$SEEN"
note(){ echo "[$(date -u +%FT%TZ)] $*" >>"$LOG"; }

mapfile -t REMOTE < <(ssh -o BatchMode=yes -o ConnectTimeout=10 "$FRIKY" \
  "cd '$NC' 2>/dev/null && find . -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.heic' -o -iname '*.png' \) 2>/dev/null | sed 's|^\./||'")
if [ ${#REMOTE[@]} -eq 0 ]; then note "no remote photos / friky unreachable — skip"; exit 0; fi

# Baseline on first run: record all current photos as seen, process none.
if [ ! -s "$SEEN" ]; then
  printf '%s\n' "${REMOTE[@]}" > "$SEEN"
  note "baselined ${#REMOTE[@]} existing photos (not processed). New uploads from now on will be ingested."
  exit 0
fi

count=0
for rel in "${REMOTE[@]}"; do
  grep -qxF "$rel" "$SEEN" && continue
  if [ "$count" -ge "$MAX_PER_RUN" ]; then note "hit MAX_PER_RUN=$MAX_PER_RUN; rest next run"; break; fi
  flat="$(echo "$rel" | tr '/ ' '__')"
  if ssh -o BatchMode=yes -o ConnectTimeout=10 "$FRIKY" "cat \"$NC/$rel\"" > "$LOCAL/$flat" 2>/dev/null && [ -s "$LOCAL/$flat" ]; then
    if node "$AGENT" --modality image --file "$LOCAL/$flat" --srcname "$rel" >>"$LOG" 2>&1; then
      note "ingested: $rel"; echo "$rel" >> "$SEEN"; count=$((count+1))
    else
      note "ERROR ingesting: $rel"
    fi
    rm -f "$LOCAL/$flat"   # derived note keeps EXIF/vision; original stays on NextCloud
  else
    note "pull failed: $rel"; rm -f "$LOCAL/$flat"
  fi
done
[ "$count" -gt 0 ] && note "run complete: $count new photo(s) ingested"
exit 0
