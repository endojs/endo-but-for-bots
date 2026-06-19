#!/usr/bin/env bash
# voice-ingest — pull NEW voice memos from NextCloud (on friky/tower) and run them
# through the field-capture pipeline (whisper + gemma -> derived vault note).
# Mirrors photo-ingest: timer-driven, tracks a seen-set by filename. Memos land in
# NextCloud voice/ from the iOS shortcut (unique-suffixed names, so no overwrites).
# FIRST run baselines existing memos (marks them seen, processes none) so the
# 30+ memo backlog isn't dumped — only NEW uploads from now on are ingested.
set -uo pipefail
FRIKY="root@192.168.50.74"
NC="/mnt/user/appdata/nextcloud/data/dan/files/voice"
LOCAL="$HOME/.local/state/field-capture/media/nextcloud-voice"
SEEN="$HOME/.local/state/field-capture/voice-seen.txt"
CAPTURE_URL="http://127.0.0.1:8770/capture"
TOKEN_FILE="$HOME/.config/field-capture/token"
LOG="$HOME/.local/state/field-capture/voice-ingest.log"
MAX_PER_RUN=20
mkdir -p "$LOCAL"; touch "$SEEN"
note(){ echo "[$(date -u +%FT%TZ)] $*" >>"$LOG"; }

[ -r "$TOKEN_FILE" ] || { note "FATAL: no capture token at $TOKEN_FILE"; exit 1; }
TOKEN="$(cat "$TOKEN_FILE")"

# list remote audio in voice/ root (memos land flat there; skip organisational subdirs)
mapfile -t REMOTE < <(ssh -o BatchMode=yes -o ConnectTimeout=10 "$FRIKY" \
  "cd '$NC' 2>/dev/null && find . -maxdepth 1 -type f \( -iname '*.m4a' -o -iname '*.mp3' -o -iname '*.mp4' -o -iname '*.wav' -o -iname '*.aac' \) 2>/dev/null | sed 's|^\./||'")
if [ ${#REMOTE[@]} -eq 0 ]; then note "no remote memos / friky unreachable — skip"; exit 0; fi

# Baseline on first run: record all current memos as seen, process none.
if [ ! -s "$SEEN" ]; then
  printf '%s\n' "${REMOTE[@]}" > "$SEEN"
  note "baselined ${#REMOTE[@]} existing memos (not processed). New uploads from now on will be ingested."
  exit 0
fi

count=0
for rel in "${REMOTE[@]}"; do
  grep -qxF "$rel" "$SEEN" && continue
  if [ "$count" -ge "$MAX_PER_RUN" ]; then note "hit MAX_PER_RUN=$MAX_PER_RUN; rest next run"; break; fi
  flat="$(echo "$rel" | tr '/ ' '__')"
  if ssh -o BatchMode=yes -o ConnectTimeout=10 "$FRIKY" "cat \"$NC/$rel\"" > "$LOCAL/$flat" 2>/dev/null && [ -s "$LOCAL/$flat" ]; then
    # Poison-pill guard: a real memo is audio/video. If an iOS share-sheet ever
    # uploads a *web page* (text/html) into voice/ named like a recording, whisper
    # 415s forever and — since we only mark SEEN on success — we'd re-pull it every
    # run (the 2026-06-16 Bluesky-page flood). Anything that isn't plausibly media
    # is a permanent failure: mark SEEN and skip, never POST.
    ftype="$(file -b --mime-type "$LOCAL/$flat" 2>/dev/null)"
    case "$ftype" in
      audio/*|video/*|application/octet-stream) : ;;  # plausibly a real recording
      *) note "POISON-SKIP $rel (not audio: $ftype) — marking SEEN, not ingesting"; echo "$rel" >> "$SEEN"; rm -f "$LOCAL/$flat"; continue ;;
    esac
    resp="$(curl -s -m 240 -X POST "$CAPTURE_URL" -H "Authorization: Bearer $TOKEN" -H "Content-Type: audio/m4a" --data-binary @"$LOCAL/$flat" -w '\n%{http_code}')"
    httpcode="$(printf '%s' "$resp" | tail -1)"
    notepath="$(printf '%s' "$resp" | sed -n 's/.*"note":"\([^"]*\)".*/\1/p' | head -1)"
    # /capture returns 200 even when whisper/gemma errored (writing an error note).
    # Only mark SEEN on a genuine transcription, so transient failures auto-retry.
    if [ "$httpcode" = "200" ] && [ -n "$notepath" ] && ! printf '%s' "$resp" | grep -q '"model":"error"'; then
      note "ingested: $rel -> $(basename "$notepath")"; echo "$rel" >> "$SEEN"; count=$((count+1))
    elif printf '%s' "$resp" | grep -qiE 'Failed to decode|whisper 41[0-9]|unsupported'; then
      # PERMANENT decode failure (corrupt/unsupported file), distinct from a transient
      # whisper outage (connection refused / 5xx / timeout). Don't retry forever.
      note "POISON-PERMA $rel (whisper can't decode; marking SEEN): $(printf '%s' "$resp" | head -c 120)"; echo "$rel" >> "$SEEN"
    else
      note "RETRY-LATER $rel (http=$httpcode): $(printf '%s' "$resp" | head -c 120)"
    fi
    rm -f "$LOCAL/$flat"   # derived note holds the transcript; original stays on NextCloud
  else
    note "pull failed: $rel"; rm -f "$LOCAL/$flat"
  fi
done
[ "$count" -gt 0 ] && note "run complete: $count new memo(s) ingested"
exit 0
