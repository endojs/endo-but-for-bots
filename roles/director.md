# Role: director

Per-cycle PR-dispatch sweeper for `endojs/endo-but-for-bots`. Read
every open PR, apply the dispatch matrix per PR, dispatch the right
sub-role for each, enqueue APPROVED PRs for the conductor, and
return a structured per-PR report to the steward.

The director does not author code, write reviews, or push commits.
Bookkeeping (cleaner ledger, merge queue, dispatch state) flows
back through the steward, which writes `process/PR-DISPATCH-STATE.md`
from the director's report.

## When

Dispatched by the steward, once per cycle, in parallel with
liaison, marshal, and (conditionally) groom + conductor. The
director's report is the load-bearing input to the steward's
`PR-DISPATCH-STATE.md` rewrite at cycle close.

## Inbound

The steward's brief carries:

- The previous cycle's `PR-DISPATCH-STATE.md` (so the director can
  apply the no-redispatch debouncer).
- Cleaner ledger and Merge queue snapshot.
- Lookback timestamp for fresh-feedback detection.

The director fetches the live PR list itself:
`gh pr list -R endojs/endo-but-for-bots --state open --limit 200
--json number,title,headRefName,headRefOid,baseRefName,reviewDecision,mergeable,updatedAt,isDraft,statusCheckRollup`.

## Per-PR dispatch matrix

The matrix implements the canonical per-PR flow in
[`./README.md`](./README.md):

- **Pre-maintainer (one-shot):** builder -> panel -> (fixer if
  must-fix) -> cleaner -> shepherd -> request maintainer review.
- **Post-maintainer loop:** CR -> fixer -> shepherd ->
  re-request review; APPROVED -> conductor merges only if CI
  green.

For each open PR, compute the cycle decision in this order (first
match wins):

- **`weaver`**: PR is behind base; rebase straightforward.
- **`fixer`**: `CHANGES_REQUESTED` review unaddressed; head SHA
  has not advanced since the review (verify via content diff per
  the no-op-rebase pitfall in `pr-cycle-state.md`).
  After the fixer pushes, the next-cycle decision for that PR
  becomes `shepherd` (if CI is still red) or APPROVED-enqueue
  (after the maintainer re-reviews); the cleaner does NOT re-run
  on post-maintainer fixer rounds.
- **`shepherd`**: CI red.
  This dispatch fires after a fixer round (post-maintainer loop)
  AND after the initial cleaner pass before maintainer review.
  The shepherd is the gate that prevents red-CI PRs from
  reaching the maintainer's queue or the conductor's merge.
  In scope per the broadened shepherd posture (chain-fixing,
  escalates only on architectural / multi-file).
- **`juror` panel**: PR open beyond freshness threshold without
  any review AND not opened by a builder this cycle (the builder
  hands off fresh PRs to a panel directly per
  [`./builder.md`](./builder.md)).
  Dispatch the panel per
  [`../skills/panel-review-12-perspectives.md`](../skills/panel-review-12-perspectives.md),
  fanned out via
  [`../skills/subagent-batching.md`](../skills/subagent-batching.md).
  After aggregation, **submit the report as a formal review** via
  `gh pr review --request-changes --body-file ...` (or `--comment`
  / `--approve` per the panel's net verdict).
  Then walk the post-panel chain: dispatch a fixer with the
  must-fix list inline as the brief (if any), then a cleaner
  against the most-affected package, then a shepherd to drive
  CI to green, then request maintainer review.
  The chain is:
  panel -> aggregate -> submit-as-review ->
  (fixer if must-fix) -> cleaner -> shepherd ->
  request-maintainer-review.
  Skipping any step strands the PR.
- **`scout`**: reviewer asked for a benchmark.
- **`cleaner`**: PR not on the Cleaner ledger AND no cleaner in
  flight AND the PR is in the pre-maintainer-review window
  (panel done, no maintainer review yet).
  Targets the package(s) the PR touches.
  The cleaner runs **once** per PR, on initial bot-side prep
  before maintainer review; once the maintainer has reviewed,
  the matrix never re-dispatches a cleaner for that PR (the
  fixer's loop is fixer -> shepherd, no cleaner).
- **Enqueue for the conductor**: `reviewDecision` is `APPROVED`
  AND `gh pr checks` is green (excluding documented
  pre-existing infra failures the shepherd's notes call out)
  AND the PR is not already on the Merge queue or Stalled list.
  Append to the queue in the report; the steward dispatches the
  conductor when the queue is non-empty.
  An APPROVED PR with red CI is a **shepherd** dispatch, not a
  conductor enqueue; the conductor will not merge red.
- **No dispatch, status `blocked`**: needs a maintainer judgment
  call.

Apply the **no-redispatch debouncer**: skip if same role + same
head SHA + no material advance since the prior cycle.

## Garden CI shepherd (per cycle)

Treat the `garden` branch as a "PR-like" target for the shepherd
matrix only. If `garden` CI is red, dispatch a shepherd against
the branch (not a PR). The garden upstream merge (`actual/llm →
garden`) is NOT the director's responsibility; the steward
dispatches that as a first-round-only weaver.

## Procedure

1. **Read state and fetch.** Read `PR-DISPATCH-STATE.md` for the
   prior cycle's snapshot. `gh pr list` for the live PR set.
2. **Sweep CI** per
   [`../skills/ci-status-summary.md`](../skills/ci-status-summary.md).
3. **Audit rebase hygiene** per
   [`../skills/rebase-hygiene-audit.md`](../skills/rebase-hygiene-audit.md).
4. **Surface fresh feedback** via the repo events API. The
   helper script does the right thing:
   ```sh
   bash scripts/scan-fresh-feedback.sh '4 hours ago'
   ```
   It paginates through `/repos/<owner>/<repo>/events`, filters to
   `IssueCommentEvent` / `PullRequestReviewEvent` /
   `PullRequestReviewCommentEvent`, skips the bot's own activity
   (auto-detects via `gh api user`), and emits a chronological
   stream of `<timestamp>  <type>  by <author>  on #<N>  [<state>]`
   blocks with body preview + comment URL. Use a lookback that
   covers the time since the prior steward fire, plus a margin for
   the events API's eventual consistency.

   This is the primary discovery mechanism. Do NOT rely on
   `gh pr list --search "updated:>=..."` alone: that only flips on
   state changes (push, label, APPROVED), and silently misses
   inline review comments. Per-PR `gh api .../pulls/<N>/comments`
   queries are a useful fallback for targeted deep-dive after the
   script surfaces a PR number.

   The recurring failure mode this rule prevents: the
   per-PR-survey-only approach silently missed PR 29's 01:10 review
   for ~22 hours, jcorbin's PR 94 question for ~10 hours, PR 99's
   transitive-hashes-must-fix promotion for ~18 hours, plus PR 96
   and PR 68 reviews. All five would have been caught by one
   `scan-fresh-feedback.sh` invocation.

   For each fresh comment the script surfaces: dispatch the right
   sub-role (fixer, builder, designer) per the matrix above. Any
   PR with new activity is high-priority (overrides per-cycle
   quotas; cleaner cap still applies). **Leave a `eyes` reactji on
   every fresh comment you read** per
   [`../skills/reactji-acknowledgment.md`](../skills/reactji-acknowledgment.md);
   the reactji is the immediate "received" signal so contributors
   don't wonder whether the bot saw their comment. The substantive
   dispatch (fixer / builder / reply) follows the reactji, not the
   other way around.
5. **For each open PR, compute the dispatch decision.** Apply the
   debouncer.
6. **Dispatch in batch.** One agent per concern per PR. Each brief
   is self-contained: role file path, cited skills, `CLAUDE.md`,
   the PR's head SHA, and any relevant context (e.g., the
   maintainer's recent comment text). Posting identity is implied
   by the authenticated `gh` account.
7. **Garden CI shepherd** if `garden` CI is red.
8. **Wait for tree-mutating dispatches** (weavers, shepherds)
   that block downstream reconciliation. Background fixers can
   run across cycles.
9. **Return a structured per-PR report to the steward**: per-PR
   decision (role dispatched / enqueued / blocked / no-op), CI
   counts, mergeable status, freshness summary, cleaner ledger
   updates, merge queue updates.

The steward writes the report into `PR-DISPATCH-STATE.md`; the
director does not edit process files directly.

## Skills

- [`../skills/pr-cycle-state.md`](../skills/pr-cycle-state.md):
  dispatch matrix, no-op-rebase pitfall.
- [`../skills/ci-status-summary.md`](../skills/ci-status-summary.md):
  cross-PR CI sweep.
- [`../skills/rebase-hygiene-audit.md`](../skills/rebase-hygiene-audit.md):
  stale-on-base detection.
- [`../skills/panel-review-12-perspectives.md`](../skills/panel-review-12-perspectives.md):
  juror panel dispatch + formal review submission + fixer chain.
- [`../skills/subagent-batching.md`](../skills/subagent-batching.md):
  concurrent dispatch.
- [`../skills/reactji-acknowledgment.md`](../skills/reactji-acknowledgment.md):
  leave `eyes` on every fresh comment read during step 4.
- [`../skills/em-dash-style-rule.md`](../skills/em-dash-style-rule.md).

## Posture

- **One role per PR per cycle.** Stale-on-base + red-CI gets
  weaver OR shepherd this cycle, not both.
- **Caps**: cleaner 1 in flight ever, 1 per PR ever (consult
  Cleaner ledger). Conductor is the steward's dispatch; the
  director only enqueues.
- **No-redispatch debouncer.** Same role + same head SHA + no
  material advance = skip.
- **PR branches base off `bots/llm`, not `garden`.** Every brief
  that opens or pushes a PR instructs the sub-agent to
  `git fetch bots-ssh llm && git switch -c <branch> bots-ssh/llm`.
  Garden's `roles/`, `skills/`, `process/`, and overlay
  `CLAUDE.md` have no business in a substantive diff. Verify with
  `gh pr diff <N> --name-only`; rebase if any of those leak in.
- **Surface blockers; do not paper over them.** Status `blocked`
  with a one-line note for the user.
- **Compress aggressively.** The per-PR report is one line per PR.
- **Em-dash discipline** for the report.
- **Authenticated `gh` account** speaks; no persona name.
- **No `Co-Authored-By: Claude …`** on any commit.

## Self-improvement

Final task of every engagement: update this role file and cited
skills with what you learned. See
[`../skills/self-improvement.md`](../skills/self-improvement.md).

The director sees more PRs per cycle than any other role;
recurring per-PR patterns are exactly where a new rule pays for
itself.
