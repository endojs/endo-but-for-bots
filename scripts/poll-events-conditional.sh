#!/usr/bin/env bash
# Poll the GitHub repo events API on a 30s cadence with conditional
# GET (ETag), printing a single distinctive line per new event batch.
#
# Designed to run as a long-lived background process whose stdout is
# watched by a Monitor task; each printed line is a wake-up trigger.
# 304 responses (no new events) are silent so the Monitor stays quiet
# until something actually happens.
#
# Usage:
#   nohup bash scripts/poll-events-conditional.sh > /tmp/poll-events.log 2>&1 &
#   # then arm a Monitor watching the log file or the process stdout
#
# State (ETag + last seen `created_at` timestamp) persists at
# $STATE_FILE so a restart does not re-fire on every prior event.
#
# Conditional GET 304s do NOT count against the API rate limit, so a
# 30s poll is essentially free under the 5000 req/hr authenticated cap.
#
# Note: GitHub event IDs are NOT monotonic across event types
# (PushEvent IDs occupy a different ID space from
# IssueCommentEvent / IssuesEvent / PullRequestEvent IDs), so the
# filter compares `created_at` ISO timestamps, not the numeric .id.

set -uo pipefail

REPO="${REPO:-endojs/endo-but-for-bots}"
INTERVAL="${INTERVAL:-30}"
STATE_FILE="${STATE_FILE:-${HOME}/.cache/endo-events-poll-state}"
mkdir -p "$(dirname "$STATE_FILE")"

# Trap clean shutdown.
trap 'echo "[$(date -u +%H:%M:%S)] polling stopped" >&2; exit 0' TERM INT

# gh-auth identity, used to filter the bot's own events.
SELF="$(gh api user --jq '.login')"
TOKEN="$(gh auth token)"

ETAG=""
LAST_SEEN_TS=""
if [ -f "$STATE_FILE" ]; then
  ETAG="$(sed -n '1p' "$STATE_FILE")"
  LAST_SEEN_TS="$(sed -n '2p' "$STATE_FILE")"
fi

# Diagnostics on stderr so Monitor stdout stays quiet until the
# "NEW:" trigger line fires.
echo "[$(date -u +%H:%M:%S)] polling $REPO every ${INTERVAL}s (filter excludes $SELF)" >&2
echo "[$(date -u +%H:%M:%S)] starting state: etag=${ETAG:-<none>} last_seen_ts=${LAST_SEEN_TS:-<none>}" >&2

while true; do
  RESP_HEADERS="$(mktemp)"
  RESP_BODY="$(mktemp)"

  # Build curl args. -w prints the status code on its own line at the end.
  CURL_ARGS=(
    -sS
    -D "$RESP_HEADERS"
    -o "$RESP_BODY"
    -w "%{http_code}"
    -H "Authorization: token $TOKEN"
    -H "Accept: application/vnd.github+json"
    -H "X-GitHub-Api-Version: 2022-11-28"
  )
  if [ -n "$ETAG" ]; then
    CURL_ARGS+=(-H "If-None-Match: $ETAG")
  fi

  CODE="$(curl "${CURL_ARGS[@]}" "https://api.github.com/repos/${REPO}/events?per_page=30" 2>/dev/null || echo "000")"

  if [ "$CODE" = "200" ]; then
    NEW_ETAG="$(grep -i '^etag:' "$RESP_HEADERS" | head -1 | sed -e 's/^[Ee]tag:[[:space:]]*//' -e 's/\r$//')"

    # Filter to events newer than LAST_SEEN_TS and not by SELF.
    # Filter on .created_at (ISO 8601, lexically comparable) since
    # event IDs are NOT monotonic across event types — a PushEvent
    # ID and an IssueCommentEvent ID occupy disjoint ID spaces.
    NEW_EVENTS="$(jq --arg self "$SELF" --arg lastts "$LAST_SEEN_TS" '
      [.[]
        | select(.actor.login != $self)
        | select(($lastts == "") or (.created_at > $lastts))
      ]
    ' "$RESP_BODY" 2>/dev/null || echo "[]")"

    COUNT="$(echo "$NEW_EVENTS" | jq 'length' 2>/dev/null || echo "0")"

    if [ "$COUNT" -gt 0 ]; then
      # Per-event detail to stderr (the log).
      echo "$NEW_EVENTS" | jq -r '.[] | "  \(.created_at) \(.type)\(if .payload.action then ":\(.payload.action)" else "" end) by \(.actor.login) on #\(.payload.issue.number // .payload.pull_request.number // "?")"' 2>/dev/null >&2 || true

      # The Monitor trigger: ONE line on stdout per batch. Includes
      # the count + a tail-of-payload digest so the steward gets
      # actionable detail in the notification. Concatenation form
      # avoids the shell-escape pain of \"-\" inside jq's
      # "\(...)" string interpolation.
      DIGEST="$(echo "$NEW_EVENTS" | jq -r '[.[] | (.type) + "/" + ((.payload.action // "-") | tostring) + "@#" + ((.payload.issue.number // .payload.pull_request.number // "?") | tostring)] | join(", ")' 2>/dev/null || echo "?")"
      echo "[$(date -u +%H:%M:%S)] NEW $COUNT on $REPO: $DIGEST"

      LAST_SEEN_TS="$(echo "$NEW_EVENTS" | jq -r 'max_by(.created_at) | .created_at' 2>/dev/null || echo "$LAST_SEEN_TS")"
    fi

    ETAG="$NEW_ETAG"
    printf '%s\n%s\n' "$ETAG" "$LAST_SEEN_TS" > "$STATE_FILE"

  elif [ "$CODE" = "304" ]; then
    : # no new events; stay silent on both stdout and stderr
  elif [ "$CODE" = "000" ]; then
    echo "[$(date -u +%H:%M:%S)] curl failed (network or auth); will retry" >&2
  else
    BODY_HEAD="$(head -c 200 "$RESP_BODY" 2>/dev/null || echo "")"
    echo "[$(date -u +%H:%M:%S)] HTTP $CODE: $BODY_HEAD" >&2
  fi

  rm -f "$RESP_HEADERS" "$RESP_BODY"
  sleep "$INTERVAL"
done
