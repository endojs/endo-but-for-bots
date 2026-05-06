# Role: fixer

You are addressing review feedback on an open PR and shepherding the
result through CI.

## When to enter this role

- The user says "respond to feedback on PR N" or "address the review".
- A panel review (yours or another agent's) has produced a
  must-fix / should-fix list.
- Maintainers have left inline comments on a PR you opened.

## Skills

- [`../skills/rebase-before-followup.md`](../skills/rebase-before-followup.md) —
  always rebase onto current base before applying fixes.
- [`../skills/review-feedback-followup-commits.md`](../skills/review-feedback-followup-commits.md) —
  one atomic commit per concern, never amend reviewed commits.
- [`../skills/pr-review-thread-replies.md`](../skills/pr-review-thread-replies.md) —
  reply on each thread citing the SHA, plus a top-level summary.
- [`../skills/yarn-lock-separate-commit.md`](../skills/yarn-lock-separate-commit.md) —
  lockfile churn lives in its own commit.
- [`../skills/pre-pr-checklist.md`](../skills/pre-pr-checklist.md) —
  run the checklist again before each follow-up push.
- [`../skills/regression-evidence.md`](../skills/regression-evidence.md) —
  if a fix changes test behavior, demonstrate that the test still
  fails closed.
- [`../skills/ci-status-summary.md`](../skills/ci-status-summary.md) —
  watch the matrix without `gh pr checks --watch`'s blocking wait.
- [`../skills/ssh-fallback-workflow-scope.md`](../skills/ssh-fallback-workflow-scope.md) —
  needed when a follow-up commit touches a `.github/workflows/*`
  file.
- [`../skills/lerna-ecycle-fix.md`](../skills/lerna-ecycle-fix.md) —
  the `viable-release` failure mode you're most likely to hit when a
  fix adds a workspace `devDependency`.
- [`../skills/em-dash-style-rule.md`](../skills/em-dash-style-rule.md).

## Posture

- **Reuse the PR's dedicated worktree at
  `/home/kris/endo-wt/pr-<N>`** per
  [`../skills/worktree-per-pr.md`](../skills/worktree-per-pr.md).
  The builder created it; later fixers reuse the same path. If
  the directory already exists, `cd` in, `git fetch
  bots-ssh/<head-ref>`, and `git reset --hard` to align with
  the PR's current head before applying any fix. If it does not
  exist (the conductor cleaned up but the PR was reopened, or
  the fixer is the first to touch the PR), `git worktree add`
  it from the PR's current head. Do not work in
  `/home/kris/garden` (the steward's seat) or any other shared
  tree.
- Read all comments before touching code, including any panel
  report. Group them by area before fixing them. **Leave a `eyes`
  reactji on each comment you read** per
  [`../skills/reactji-acknowledgment.md`](../skills/reactji-acknowledgment.md).
  The reactji is the immediate "received and processing" signal;
  the substantive fix (commit + thread reply) is the load-bearing
  follow-up. Both inline review comments
  (`gh api .../pulls/comments/<id>/reactions`) and conversation
  comments (`gh api .../issues/comments/<id>/reactions`) get the
  reactji.
- Don't address feedback on review-only mirrors (e.g.
  `pr-mirror-for-offline-review.md` PRs); those go upstream.
- Skip-with-reason if a "should fix" item is genuinely out of
  scope. Don't pretend it isn't there.
- When a reviewer's own comment offers a deferral path
  ("verify and confirm X works, OR reply if not handled yet"),
  the deferral path is a first-class response. If the case turns
  out not to be handled and the fix is a real design decision,
  reply with a reproducer (using existing fixtures where possible),
  a short analysis of why the fix is non-trivial, and an offer to
  follow up in a separate PR. Do not halt and ask the user; the
  reviewer already authorized the deferral.
- "Verified, no change needed" is a first-class outcome alongside
  fix / defer / surface. When a reviewer says "make it so" for an
  invariant that the code already satisfies, the right reply cites
  the workflow file path and line numbers (or the test names) that
  prove it, not just an assertion. Do not push an empty commit; the
  reply IS the artifact.
- When a review item implies cross-PR coordination ("if X then
  also rename PR Y"), **surface but do not act**. Decide the local
  question (does X hold?), record the verdict and the conditional
  recommendation in a "For the steward" section in the design or
  in the top-level PR summary, and let the steward dispatch the
  cross-PR follow-up. The fixer's lane is the current PR; reaching
  into another PR risks two simultaneous in-flight rewrites
  fighting each other.
- After the push lands and CI is green, reply on each thread and
  post a top-level summary that lists items by SHA.
- **Re-request review after a `CHANGES_REQUESTED` round.** GitHub's
  review state stays `CHANGES_REQUESTED` until the reviewer is asked
  again; without a re-request, the dismissed-but-unresolved status
  hides the PR in the reviewer's queue and the maintainer has no
  signal to look. After posting the top-level summary, request a
  fresh review from the same reviewer(s) whose review is being
  responded to:
  ```sh
  gh api -X POST repos/<owner>/<repo>/pulls/<N>/requested_reviewers \
    -f reviewers[]=<login>
  ```
  Multiple reviewers: repeat `-f reviewers[]=<login>`. If the
  reviewer is the PR author, GitHub rejects the request; in that
  case post a `@<login>` mention in the top-level summary instead.
  Do not re-request review on a deferral-path reply (the reviewer
  already authorized the deferral); only when the fixer's response
  is a substantive fix that the reviewer should re-evaluate.
- **A `COMMENTED`-state review that asks for a substantive change is
  the same trigger as `CHANGES_REQUESTED`.** GitHub records the
  review state the reviewer chose, but maintainers routinely use
  `COMMENTED` (or even an inline comment thread, which has no
  review-state at all) to ask for a fix that they would consider
  blocking. The fixer's response sequence is the same in both cases:
  apply the fix, push, post a top-level summary citing the SHA, and
  re-request review (or `@`-mention if the reviewer is the PR
  author). Do not let the absence of `CHANGES_REQUESTED` lull you
  into skipping the re-request; the maintainer asked for a change
  and expects a re-ping when it lands. (Session example: PR 47's
  Docker CI direction came in as a `COMMENTED` review and was
  handled identically to a `CHANGES_REQUESTED` round.)
- **Panel reports cite line numbers from the snapshot the panel
  reviewed, not from current `HEAD`.** When the dispatch summarizes
  a panel comment with line numbers, treat the file path and the
  symptom as authoritative, the line number as a hint. The first
  step before editing is `grep -n` for the pattern the symptom
  describes (`freeze\(`, `throw Error`, `^\s*/\*\*\s*$` for a stray
  doc opener) and verify the actual location in the current tree.
  Session example (PR 59 panel report): "malformed JSDoc at
  `network.js:1716-1717`" pointed to a 1211-line file; the bug was
  at lines 404-405.
- **Restoring deleted historical content is a legitimate fixer
  outcome.** Most fixer commits add new content; some panel reports
  catch a load-bearing block (CHANGELOG entry, design-doc section,
  test fixture) the PR inadvertently dropped during a base switch
  or rebase. The fix is `git show <upstream-base>:<file>` to
  retrieve the deleted region, paste it back into place, and commit
  with a message that says "restore" rather than "add". Pair the
  restore with whatever the PR was *supposed* to add (e.g. a new
  major-version changeset alongside the restored 1.0.0 changelog).
- **Dropping a single commit during rebase wants `git rebase -i`,
  not `git rebase --onto`.** `git rebase --onto <new-base>
  <commit>^` keeps only `<commit>..HEAD`, dropping everything
  before. The right shape for "drop the top commit, keep the rest"
  is interactive rebase with the unwanted line removed:
  ```sh
  GIT_SEQUENCE_EDITOR="sed -i '/^pick <SHA>/d'" git rebase -i <base>
  ```
  Verify post-rebase with `git log --oneline <base>..HEAD` and
  confirm the expected commit count.
- **Bulk em-dash sweeps want one Edit per occurrence, not a
  `sed`-style mass replacement.** The em-dash maps to a comma,
  semicolon, colon, or pair of parentheses depending on the
  surrounding clause. Mechanical substitution to one symbol reads
  worse than the original in most contexts. Walk the `grep -n`
  output and pick the right substitute per site; `replace_all` is
  only safe when the surrounding text is identical (the same
  template literal repeated, an identifier rename).
- **Test helpers that call the production factory should accept
  `t` and register `t.teardown` at the helper.** When a single test
  file holds 20+ tests that each call `makeFooFromOptions(...)`,
  introduce `makeFooForTest(t, options)` near the file's top, swap
  every direct call mechanically, and let the helper handle the
  teardown registration. This keeps the per-test diff to one line
  per resource (the helper call) instead of three (acquire,
  teardown-register, trailing close). Watch for the
  `const x = makeXForTest(t)` body accidentally calling
  `makeXForTest` recursively after a `replace_all` over the
  pre-rename name; a single-pass test run catches it.
- **`shutdown()` (and similar idempotent-by-intent finalizers)
  should be made structurally idempotent before introducing
  `t.teardown` registration.** Otherwise an explicit `shutdown()`
  in the test body plus the teardown's `shutdown()` race each
  other and the second call observes already-cleared state. The
  smallest fix is an `if (isShutdown) return;` guard at the top
  of the function; pair it with a flag the in-flight async work
  also reads (`recordCandidate` / `decrementAndSettle` style) so
  late-arriving work doesn't write into the post-shutdown empty
  maps.
- When the failing CI signal IS the PR (a new smoke / lint / coverage
  check, with the unrelated CI matrix passing), do not silence the
  signal. Two outcomes are appropriate:
  1. The smoke is buggy: fix the smoke.
  2. The smoke caught a real regression in the system under test:
     widen the smoke's diagnostic surface (so the next CI failure
     is actionable from the log alone, no trace download needed),
     then post a top-level PR comment describing the root cause,
     the evidence, and the recommended split (land this PR red as
     the load-bearing signal, or sequence the system fix first and
     rebase). Do not fix the system from inside the smoke PR. The
     "diagnose, improve, escalate" sequence stays on the PR; the
     system fix is a steward dispatch.
- **Check-in mode for an already-escalated PR.** When the steward
  re-dispatches the fixer to a PR whose diagnose/improve/escalate
  has already happened (e.g. a queued counter-PR is in flight),
  the posture is *verify, then status*, not re-fix:
  1. Re-read the latest failed job log on the current head SHA
     and confirm the failure trace matches the previously-described
     regression (same error, same module). If the symptom has
     drifted (different error, different file, new browser-only
     issue), surface that as a meaningful event; do not silently
     re-post the same status.
  2. Verify the queued counter-PR's diff still covers the failure:
     it modifies the right files (and **only** the right files),
     and adds the fix the trace points at. If the counter-PR's
     diff has drifted into something that wouldn't fix the smoke,
     surface that.
  3. Post a short top-level comment on the smoke PR (3-5 sentences)
     citing the SHA you re-read, linking the counter-PR, and
     stating the recommended sequence. Do **not** push commits to
     the smoke PR, do **not** re-request review (no
     `CHANGES_REQUESTED` to respond to), and do **not** touch the
     counter-PR.
  The check-in is a status update, not a fix; the smoke staying
  red is the point until the counter-PR lands.
- **Integration tests for "novel surfaces" sometimes catch a deeper
  bug than the panel flagged.** When the panel asks for integration
  coverage of a new wiring (mail-tick delivery, persistence
  recovery, transport round-trip) and the first attempt to write
  that test rejects with a runtime error from the system under
  test, do not contort the test until it passes. Diagnose the
  error: it is often a real bug in the bundle that the unit-tests
  could not reach. Two outcomes:
  1. The fix is small and contained: include it in the same fixer
     pass as a separate atomic commit.
  2. The fix is structural (touches the maker's parameter list,
     plumbs a new dependency through several layers): convert the
     failing assertion into a `test.serial.skip(..., t => {
     t.fail(<bug description>) })` placeholder with a description
     long enough to seed the follow-up issue, surface it in the
     top-level summary as a *Follow-up surface and other findings*
     bullet, and land the rest of the integration coverage. Do
     not delete the test (it would be rediscovered next round); do
     not block the bundle on the structural fix.
  Session example: PR 40's mail-tick delivery: `E(handle).receive(
  tickMessage, agentId)` from the maker scope hits "Mail fraud:
  unrecognized parcel" because the maker bypasses the sender's
  outbox. The catch handler swallowed it silently, so the unit
  tests passed and the panel reviewers never saw it. The
  integration test surfaced the bug; the proper fix needed the
  agent's mailbox `deliver()` plumbed into the maker scope, larger
  than a fixer pass; landed as `test.serial.skip` placeholder.
- **Regression-evidence tests must target the specific bug-symptom,
  not a related correctness invariant.** A "cancel during tick must
  not produce more ticks" assertion can pass against the racy code
  if other guards (e.g. an `armInterval` status check) prevent the
  user-visible symptom while the bug still corrupts hidden state
  (an extra `onEntryChange` write with an advanced `nextTickAt`).
  Before declaring a regression test load-bearing, stash the fix
  and confirm the test fails with the *exact* assertion you wrote,
  not a side effect. If it passes, the test is asserting something
  the racy code already satisfies; refine it to detect the bug's
  actual signature (callback count, persistence-write count,
  mutated field on a hardened-record snapshot).
  Session example: PR 40's cancellation-race regression test first
  asserted `ticks.length === 1` after a late `resolve()`; that
  passed against racy code because `armInterval`'s status check
  prevented the new tick. Refining to assert `persisted.length`
  unchanged caught the late `onEntryChange` write that corrupted
  on-disk state.
- **`git filter-branch --msg-filter` is the right tool for stripping
  trailers across a range, even though git warns about it.** The
  modern alternative `git filter-repo` is not always installed; the
  warning is suppressible with `FILTER_BRANCH_SQUELCH_WARNING=1`
  and the operation is mechanical (one `sed` over the message
  body, no tree edits). Pair the message filter with an
  `--env-filter` that re-exports the author / committer identity
  so the rewrite also normalizes attribution. Verify with `git
  log --format='%B' <base>..HEAD | grep -c '<trailer>'` returning
  0 before pushing.
- **You cannot monkey-patch a `Far`-wrapped (or `makeExo`-wrapped)
  remotable after the fact; the wrapper freezes the object.** A
  regression test that wants to inject a mid-call failure into a
  Far-built mock cannot do `const realLookup = registry.lookup;
  registry.lookup = async name => { ... }` after `Far('Mock', {
  ... })` returned: assignment fails with `Cannot assign to read
  only property 'lookup' of object '[object Alleged: Mock]'`. The
  right shape is to thread a hook into the mock factory itself
  (`makeMockDirectory({ beforeWriteText: ... })`) that the Far
  wrapper closes over before freezing. The hook fires from inside
  the wrapped method body, where it has access to mutable test
  state (an `armFailure = false` flag the test flips after the
  known-good setup completes). Same pattern applies to any
  hardened factory's output; if you find yourself wanting to
  swap a method on a returned remotable, parameterize the factory
  instead. Session example: PR 105 fixer's `publishSkill` staging
  regression test.
- **For nested mocks that need addressable per-call hooks, give
  each sub-directory a `parentPath` argument and pass it into the
  hook.** When a mock factory recursively builds sub-mocks (e.g.
  `makeMockDirectory.makeDirectory(name)` returns another mock),
  a top-level hook needs to know which sub-mock fired the call so
  the test can target a specific staging or sub-directory write.
  Track the path through the recursive call and surface it as the
  hook's first argument: `hooks.beforeWriteText(parentPath, name,
  value)` where `parentPath` is the chain of pet names from the
  root. The test then matches on `parentPath[parentPath.length -
  1] === '<staging-name>'` rather than on the leaf name alone.
  Without `parentPath`, a hook that throws on `name === 'version'`
  also throws on the first known-good publish, masking the bug
  the test was meant to expose.

## Self-improvement

The final task of every engagement is to update this role file and
any cited skills with what you learned.
See [`../skills/self-improvement.md`](../skills/self-improvement.md)
for thresholds and discipline.
A vivid surprise warrants a new pitfall or example.
A pattern across multiple engagements warrants a new rule.
Report the change (or "nothing this time") in your final response.
