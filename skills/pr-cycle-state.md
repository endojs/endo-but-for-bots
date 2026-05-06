# PR cycle state across context clears

## When to use

When a long-running role manages a queue of pull requests across
many invocations, where each invocation has a fresh context and
no in-process memory.
The state must live in files; the discipline below keeps the
files small enough to read every cycle and rich enough to make
the next decision.

## The two files

State for a PR queue lives in **two files** under `process/`,
both authored and maintained by the same role.

### `process/PR-DISPATCH-STATE.md`

A single-screen snapshot of every open PR's current state.
Rewritten in full each cycle so a fresh agent can read the
authoritative picture in one view.

```markdown
# PR dispatch state

Last cycle: 2026-05-04 14:30 UTC.

| PR | Title | Base | CI | Reviews | Last dispatch | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 82 | guix-ci-resilience | llm | green | 1 changes-requested | 2026-05-04 fixer | awaiting maintainer |
| 75 | @endo/chacha12 | master | green | none | 2026-05-02 juror panel | awaiting merge |
| 67 | harden-exports destructuring | master | green | none | 2026-05-01 fixer | awaiting maintainer |
| 59 | ocapn-noise restaged | master | green | 0 | 2026-04-30 fixer | awaiting review |
| … | … | … | … | … | … | … |

## Per-PR notes

### #82
Kumavis CHANGES_REQUESTED on the nightly-vs-pinned axis.
Fixer landed pinned 1.5.0 in `86e8b9b0e9` 2026-05-04.
Next cycle: skip unless review state changes.
```

The `Status` column uses a small controlled vocabulary: `awaiting
review`, `awaiting maintainer`, `awaiting CI`, `blocked`, `ready
for merge`, `stale-on-base`, `dispatched <role>`.

### `process/PR-CYCLE-LOG.md`

Append-only chronological log.
The newest cycle is at the top.
Each cycle is a small section.

```markdown
# PR cycle log

## 2026-05-04 14:30 UTC

Pulled `gh pr list -R endojs/endo-but-for-bots --state open`,
N PRs surveyed.

Dispatched:
- fixer for PR 82 (kumavis CHANGES_REQUESTED)
- juror panel for PR 67 (no reviews yet)

Observed:
- PR 75 stayed green, no review activity since previous cycle;
  nothing to do.
- PR 59 acquired new comments at 2026-05-04 13:12; defer to next
  cycle to let CI complete first.

## 2026-05-04 02:30 UTC
…
```

The log gives the user a forensic record of why each subagent was
launched.

## The cycle procedure

Every wake-up does these steps, in order, every time:

1. **Read both state files in full.** This is your only memory
   of the previous cycle.
2. **Pull the live PR list.**
   ```sh
   gh pr list -R endojs/endo-but-for-bots --state open --limit 200 \
     --json number,title,baseRefName,headRefName,isDraft,updatedAt,mergeable,reviewDecision \
     > /tmp/prs.json
   ```
3. **Sweep CI status** per
   [`ci-status-summary.md`](./ci-status-summary.md).
4. **Reconcile the state table** against live data. For each PR,
   compute the cycle decision:
   - **stale-on-base** (behind base, mergeable) → dispatch
     `weaver`.
   - **CHANGES_REQUESTED** review and the head SHA hasn't
     advanced since → dispatch `fixer`.
   - **No reviews and PR is older than a chosen threshold** →
     dispatch a `juror` panel directly per
     `panel-review-12-perspectives.md`.
   - **CI red** → dispatch `shepherd`.
   - **Blocked by maintainer call** (open question, design
     review, taste decision) → leave for the user, status
     `blocked`, no dispatch.
   - Anything else → leave alone.
5. **Apply the no-redispatch debouncer.** If the same role was
   dispatched against the same PR's current head SHA in a
   previous cycle, do not redispatch unless the PR has materially
   advanced (new commit, new review, CI flipped).
6. **Dispatch in batch.** Use one agent per concern; do not
   bundle multiple PRs into a single agent (each agent's
   self-improvement and reporting belong to one task).
7. **Append a section to the cycle log** describing what was
   surveyed and what was dispatched.
8. **Rewrite the dispatch state file** in full to reflect the
   reconciled snapshot.
9. **Commit the two state files** in a single process commit
   (per [`process-documents.md`](./process-documents.md)) so the
   audit trail is complete and the commit drops cleanly when
   the user ports work upstream.
10. **Schedule the next wakeup** or end the loop per
    [`autonomous-loop-pacing.md`](./autonomous-loop-pacing.md).

## What to write down, what to leave out

- **Always record:** the PR number, current head SHA, the role
  dispatched, the reason in one phrase.
- **Never record:** PR descriptions, full review bodies, CI logs.
  Those live on the PR. Cite the URL.
- **Compress aggressively.** Aim for the dispatch state to fit on
  one screen even with sixty open PRs. The cycle log can be
  longer but trims old sections older than thirty days into a
  rolling archive (`process/archive/PR-CYCLE-LOG-<YYYY-MM>.md`).

## Distinguishing "author addressed" from "author silent"

For PRs in `CHANGES_REQUESTED`, the cycle decision turns on whether
the head SHA has advanced since the review. Pull both timestamps
in one query and compare:

```sh
gh pr view <N> -R <owner>/<repo> --json headRefOid,reviews,commits \
  --jq '{
    head: .headRefOid,
    last_review_at: (.reviews | sort_by(.submittedAt) | last | .submittedAt),
    last_commit_at: (.commits | sort_by(.committedDate) | last | .committedDate)
  }'
```

If `last_commit_at > last_review_at`, the author already pushed a
fixup; status is `awaiting maintainer` (re-review). **Do not
dispatch a fixer.** If `last_review_at > last_commit_at`, the
review applies to the current head and the feedback is
unaddressed; dispatch a fixer.

A one-minute gap can go either way; verify by reading the latest
commit's message: a `fix:`/`docs:`/`test:` prefix usually means
the author was responding to feedback, while `chore: rebase` or
similar suggests no real response.

**No-op rebase pitfall.** A force-push that simply replays the
existing commits onto a fresh base produces a new head SHA
without addressing any review-content asks. The timestamp check
(head SHA newer than review) flags it as "author addressed", but
the design or code under review is byte-for-byte identical. When
the latest commit is a previous commit replayed, check the
*content* against the most recent review's inline comments
before declaring the feedback addressed. The simplest test:

```sh
git diff <prev-head>..<new-head> -- <files-cited-in-review>
```

If the diff is empty for the cited paths and the review's asks
are about content at those paths, the rebase is a no-op for the
review's purposes and a fixer is still warranted.

## Pitfalls

- **Forgetting to read state.** Each cycle has fresh context;
  the state files are the entire memory. Skipping the read
  produces redispatches and lost notes.
- **Dispatching too aggressively.** If every cycle re-launches a
  fixer on the same SHA, the bots-PR queue accumulates noise.
  The debouncer in step 5 is load-bearing.
- **State drift.** The dispatch table claims "fixer dispatched
  2026-05-04" but no fixer was actually launched because the
  agent crashed or the dispatch failed. Reconcile against the
  actual `gh pr view <N> --json comments` and commit history;
  trust live state over the state file when they disagree.
- **Mixing process and substance.** The two state files are
  process documents. Their commits are process commits. A
  cycle should never edit a non-`process/` file as part of its
  own bookkeeping; if the cycle dispatches a fixer that does,
  that's the fixer's commit, not the steward's.
- **Stale-section accumulation.** The cycle log grows
  unbounded. Trim into the archive on a schedule (every
  ~30 cycles or whenever the file exceeds a screen of recent
  entries).
