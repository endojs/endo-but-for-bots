# Reactji acknowledgment

## When to use

**At the moment the activity is noticed and a response shape begins
to form** — leave a reactji on the source comment as the "received
and processing" signal. The reply, commit, dispatch, or deferral that
follows is the substantive answer; the reactji is the cheap immediate
acknowledgment that prevents the contributor from wondering whether
the bot saw the comment yet.

**The triage role owns the reactji, not the dispatched worker.** When
the steward, director, or liaison notices a new comment and decides
to dispatch a fixer / builder / shepherd / conductor in response,
the **triage role posts the reactji at the moment of decision**, not
the worker after dispatch starts. Worker latency (10-30 minutes
from dispatch to first action) is unacceptable for the
"received" signal; the human sees the reactji within seconds of
posting, when the steward's Monitor or per-cycle sweep first reads
the comment.

This means:

- **Steward** (per ~/garden/roles/steward.md): on every Monitor wake
  for a `PullRequestReviewEvent` / `IssueCommentEvent` /
  `PullRequestReviewCommentEvent`, the steward's first action after
  reading the comment(s) is to post the reactji. Then dispatch.
- **Director** (per ~/garden/roles/director.md): on every per-PR
  sweep, react on each freshly-surfaced comment before deciding the
  per-PR action.
- **Liaison** (per ~/garden/roles/liaison.md): on every per-issue
  pass, react on each unaddressed comment before deciding the
  per-issue action.
- **Worker roles** (`fixer`, `builder`, `conductor`, `shepherd`,
  `cleaner`, `weaver`, `designer`, `scribe`, `juror`) inherit the
  reactji from the triage role and do NOT need to re-react on
  comments the dispatch brief surfaced. The worker's reading is
  for substance; the acknowledgment was already posted at triage
  time.

Exception: when a worker reads a comment that the triage role did
NOT pre-surface (e.g. the worker discovers a relevant earlier
comment by enumerating all inline comments under a review id, or a
contributor comments on the PR while the worker's dispatch is in
flight), the worker reacts on those comments at the moment of
discovery. The rule is "first to notice", not "only the steward".

## Reaction vocabulary

- **`eyes`** (👀) — default. "Saw this; the response is in flight or
  no response is warranted." Use for the vast majority of cases.
- **`+1`** (👍) — "Saw this; agree or thanks." Reserve for comments
  that recommend a path forward and the agent endorses it, OR for
  thanks/celebration comments where a reactji-only response is
  sufficient.
- **`rocket`** (🚀) — "Saw this; celebrating a landed PR or shipped
  feature." Reserve for celebration comments after a substantive ship.
- **`heart`** (❤️) — rare. Reserve for thanks-style comments that
  warrant warmer acknowledgment than `+1`.
- **`hooray`** (🎉) — rare. Same shape as rocket but more general.
- **`confused`** / **`-1`** / **`laugh`** — do not use. Confusion
  warrants a reply (asking for clarification); negative reactions
  carry tone the bot should not project.

The default is `eyes`. The cost of mis-picking another reactji is
higher than the cost of always defaulting to `eyes`.

## How

```sh
# Reaction on a top-level comment (issue or PR conversation thread)
gh api -X POST \
  repos/<owner>/<repo>/issues/comments/<COMMENT_ID>/reactions \
  -f content=eyes

# Reaction on an inline review comment (a thread on a specific line)
gh api -X POST \
  repos/<owner>/<repo>/pulls/comments/<COMMENT_ID>/reactions \
  -f content=eyes

# Reaction on the issue body itself (rare; usually the issue body
# warrants a reply, not just a reactji)
gh api -X POST \
  repos/<owner>/<repo>/issues/<N>/reactions \
  -f content=eyes
```

The `<COMMENT_ID>` is the numeric ID returned by the same query that
surfaced the comment (`gh api .../issues/<N>/comments` or
`gh api .../pulls/<N>/comments`); it is also encoded in the URL of
the `gh pr view --json comments` output (the URL ends
`#issuecomment-<ID>` or `#discussion_r<ID>`).

The path differs:
- `/issues/comments/<ID>` for **conversation comments** (a top-level
  reply on a PR or issue).
- `/pulls/comments/<ID>` for **inline review comments** (a comment
  on a specific line of a diff).

GitHub returns 404 if you mix them up. The `gh api` for both shapes
returns the same `id` field shape; the `path` field on the JSON
distinguishes inline (has `path`) from conversation (no `path`).

## Idempotency

Posting the same reactji twice from the same identity is a no-op
(GitHub deduplicates). The agent does not need to check whether a
reactji is already present; just post it.

## When NOT to use

- Comments authored by the same gh-auth identity as the agent
  (avoid `+1`-ing your own comment).
- Comments on closed PRs or closed issues — closed state is inert
  per `CLAUDE.md`; do not signal engagement on a settled artifact.
- Comments that are themselves automated (CI status posts, bot
  acknowledgments). Only react to human-authored or contributor-
  authored comments.
- Comments on review-only mirror PRs (per
  `pr-mirror-for-offline-review.md`) — those should be addressed
  upstream.

## Reviews are NOT reactable; comments are

GitHub's REST API exposes reactions on issue comments
(`/issues/comments/<id>/reactions`) and PR review comments
(`/pulls/comments/<id>/reactions`) but **not on PR reviews
themselves**. A "review" is a structured artifact (with state
`APPROVED` / `CHANGES_REQUESTED` / `COMMENTED`) that carries an
optional body; the body has no reactions endpoint. When a maintainer
posts a review with a substantive body (e.g., a top-level
"COMMENTED" review asking for a follow-up), the agent's
acknowledgment is a substantive top-level conversation comment
(`gh pr comment <N> --body "Acknowledged: ..."`) rather than a
reactji. Reserve the reactji for actual comments.

If unsure whether the artifact is a review or a comment: the
`gh pr view <N> --json reviews` block lists reviews (no reactions
endpoint); the `--json comments` block lists conversation comments
(reactable via `/issues/comments/<id>/reactions`). The `gh api
.../pulls/<N>/comments` returns inline review comments (reactable
via `/pulls/comments/<id>/reactions`).

## Relationship to the substantive response

The reactji is **always** in addition to the substantive response,
never instead of it (unless the response shape itself is
"reactji-only", per the liaison's classification: contributor-to-
contributor banter, off-topic interjection, informational with no
ask). For every other case, the agent posts the reactji
**first** (cheap, acknowledges receipt) and then does the
substantive work (reply / commit / dispatch / re-request review /
defer). The reactji is what prevents the contributor from feeling
ignored during the time between when they posted and when the
substantive response lands.

## Pitfall: the reactji is not the response

A reactji says "I saw this." It does not say "I am addressing this"
or "I am ignoring this" — those are different decisions the agent
must communicate via the substantive response. Posting only a
reactji on a comment that asks a direct question is the same
silent-strand failure mode the panel-to-fixer chain was designed to
prevent at the PR-review level. The reactji is the cheap first half;
the substantive response is the load-bearing second half.
