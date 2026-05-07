#!/usr/bin/env bash
# Scan endojs/endo-but-for-bots for fresh contributor activity (comments,
# reviews, inline review comments) using the GitHub repo events API. This
# is the director's primary discovery mechanism per roles/director.md
# step 4 + skills/reactji-acknowledgment.md.
#
# Usage:
#   scripts/scan-fresh-feedback.sh                    # default: last 4 hours
#   scripts/scan-fresh-feedback.sh '2026-05-06T05:00' # since explicit timestamp
#   scripts/scan-fresh-feedback.sh '6 hours ago'      # GNU date expression
#
# Output: one event per line group, sorted oldest-to-newest:
#   <timestamp>  <event-type>  by <author>  on #<N>  [<state>]
#     <body-preview>
#     <comment-url>
#
# Dependencies: gh (authenticated), jq, GNU date.
#
# Why the events API: a top-level `gh pr list --search "updated:>=..."`
# only flips on state changes (push, label, APPROVED) and silently misses
# inline review comments AND newly-opened issues without comments yet. The
# events API surfaces every comment and review in one paginated call, plus
# newly-opened/reopened issues and PRs (via IssuesEvent/PullRequestEvent
# with action=opened|reopened|ready_for_review). See roles/director.md
# for the discovery-gap rationale + recurring failures it prevents.
#
# Filter coverage:
#   - IssueCommentEvent          comments on issues + PR conversations
#   - PullRequestReviewEvent     formal PR reviews (approved/changes_requested/commented)
#   - PullRequestReviewCommentEvent  inline review comments on diffs
#   - IssuesEvent (opened|reopened)        new + reopened issues
#   - PullRequestEvent (opened|reopened|ready_for_review)  new + reopened PRs
#
# Filter out:
#   - PullRequestEvent (closed|merged|edited|labeled): tracked elsewhere
#     (conductor merge ledger, dispatch-state)
#   - PushEvent / CreateEvent / DeleteEvent: noise here, surfaces via
#     `gh pr list` survey on PR objects

set -euo pipefail

REPO="${REPO:-endojs/endo-but-for-bots}"
LOOKBACK_INPUT="${1:-4 hours ago}"

# Convert lookback to ISO 8601 UTC. Accept ISO timestamps verbatim and
# GNU date expressions ("6 hours ago").
if [[ "$LOOKBACK_INPUT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2} ]]; then
  LOOKBACK="$LOOKBACK_INPUT"
else
  LOOKBACK="$(date -u -d "$LOOKBACK_INPUT" +'%Y-%m-%dT%H:%M:%SZ')"
fi

# The gh-auth identity, so the bot's own events are filtered out.
SELF="$(gh api user --jq '.login')"

# Page through events until we hit one older than the lookback. The events
# API returns ~30 events per page (we ask for 100), reverse chronological,
# max 300 events (10 pages). For lookbacks longer than the cap, the script
# reports the truncation explicitly.
EVENTS_TMP="$(mktemp)"
trap 'rm -f "$EVENTS_TMP"' EXIT

PAGE=1
HIT_END=0

while [ "$PAGE" -le 10 ] && [ "$HIT_END" -eq 0 ]; do
  RESP="$(gh api "repos/${REPO}/events?per_page=100&page=${PAGE}" 2>/dev/null || echo '[]')"
  COUNT="$(echo "$RESP" | jq 'length')"
  if [ "$COUNT" -eq 0 ]; then
    break
  fi

  # Append the page's events that fall within the lookback to a single
  # JSON-array file we sort + format at the end.
  #
  # Filter: comments + reviews on PRs/issues (always), plus
  # opened/reopened/ready_for_review actions on issues + PRs (the
  # action-needed signals). Other PullRequestEvent / IssuesEvent
  # actions (closed, merged, edited, labeled) are tracked elsewhere
  # (conductor merge ledger, dispatch-state) so they're noise here.
  echo "$RESP" \
    | jq --arg lookback "$LOOKBACK" --arg self "$SELF" '
        [.[] |
         select(.created_at >= $lookback) |
         select(.actor.login != $self) |
         select(
           (.type | test("Comment|Review"))
           or
           ((.type == "IssuesEvent" or .type == "PullRequestEvent")
            and (.payload.action == "opened"
                 or .payload.action == "reopened"
                 or .payload.action == "ready_for_review"))
         )]
      ' >> "$EVENTS_TMP"

  # Stop paging if the oldest event in this page is older than the lookback.
  OLDEST="$(echo "$RESP" | jq -r '.[-1].created_at // ""')"
  if [[ -n "$OLDEST" && "$OLDEST" < "$LOOKBACK" ]]; then
    HIT_END=1
  fi
  PAGE=$((PAGE + 1))
done

if [ "$PAGE" -gt 10 ] && [ "$HIT_END" -eq 0 ]; then
  echo "warning: hit 1000-event pagination cap; lookback may be incomplete" >&2
fi

# Concatenate the per-page arrays into one stream, sort oldest-to-newest,
# format. Each event becomes a 3-line block: header, body preview, URL.
# For Issues/PR opened events: pull title+body from the payload's issue
# or pull_request object (the body field on those events is the resource
# itself, not a comment).
jq -s '
  [.[] | .[]]
  | sort_by(.created_at)
  | .[]
  | {
      ts: (.created_at[:16]),
      type: .type,
      action: (.payload.action // ""),
      who: .actor.login,
      n: (.payload.issue.number // .payload.pull_request.number // "?"),
      body: (
        (.payload.comment.body // .payload.review.body
         // (if (.type == "IssuesEvent" or .type == "PullRequestEvent")
             then ((.payload.issue.title // .payload.pull_request.title // "") + " — " + (.payload.issue.body // .payload.pull_request.body // ""))
             else ""
             end)
         // ""
        ) | gsub("\r?\n"; " ") | .[:160]
      ),
      state: (.payload.review.state // ""),
      url: (.payload.comment.html_url
            // .payload.review.html_url
            // .payload.issue.html_url
            // .payload.pull_request.html_url
            // "")
    }
  | "\(.ts)  \(.type)\(if .action != "" then ":\(.action)" else "" end)  by \(.who)  on #\(.n)\(if .state != "" then "  [\(.state)]" else "" end)"
    + (if .body != "" then "\n  \(.body)" else "" end)
    + (if .url != "" then "\n  \(.url)" else "" end)
    + "\n"
' -r "$EVENTS_TMP"

# Summary on stderr so it does not clutter the parseable stdout.
COUNT_TOTAL="$(jq -s '[.[] | .[]] | length' "$EVENTS_TMP")"
echo "" >&2
echo "scanned events since $LOOKBACK (excluding $SELF)" >&2
echo "$COUNT_TOTAL fresh contributor events found" >&2
