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
- [`../skills/surface-module-pattern.md`](../skills/surface-module-pattern.md) —
  read when a maintainer review asks for a "physical `./<name>.js`"
  or flags a `"./<name>.js": "./src/<name>.js"` entry; the surface
  module re-exports the public subset and masks test-only helpers.
- [`../skills/no-backward-compat-stage.md`](../skills/no-backward-compat-stage.md) —
  read when a maintainer review says "just remove" on a backward-
  compat alias / shim / deprecation block in daemon, familiar, or
  chat; the rule is rename / remove and update call sites in the
  same PR, no deprecation period.

## Posture

- **Reuse the PR's dedicated worktree at
  `~/endo-wt/pr-<N>`** per
  [`../skills/worktree-per-pr.md`](../skills/worktree-per-pr.md).
  The builder created it; later fixers reuse the same path. If
  the directory already exists, `cd` in, `git fetch
  bots-ssh/<head-ref>`, and `git reset --hard` to align with
  the PR's current head before applying any fix. If it does not
  exist (the conductor cleaned up but the PR was reopened, or
  the fixer is the first to touch the PR), `git worktree add`
  it from the PR's current head. Do not work in
  `~/garden` (the steward's seat) or any other shared
  tree.
- Read all comments before touching code, including any panel
  report. Group them by area before fixing them. **The triage
  role (steward / director / liaison) already posted the `eyes`
  reactji at the moment the comment was first noticed**, per
  [`../skills/reactji-acknowledgment.md`](../skills/reactji-acknowledgment.md);
  the fixer does NOT need to re-react. The fixer's reading is
  for substance, not acknowledgment.

  Exception: when the fixer enumerates ALL inline comments under
  a review's `pull_request_review_id` and discovers comments the
  triage brief did not pre-surface (older drafts, comments on
  files the brief did not mention), react on those at the moment
  of discovery. The rule is "first-to-notice"; the triage role
  is usually first, but not always.
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
- **A dispatch that asks for a test against a function that lives in
  a different open PR cannot be satisfied in the current PR's lane.**
  When the dispatch summary says "add a test for `funcName` in
  `packages/<pkg>/test/`" and `grep -rn 'funcName'` across the
  current PR's worktree only finds the call site (no definition),
  check `git log --all --grep='funcName'` for the function's actual
  origin. A function defined in PR #129 that PR #151 calls but does
  not introduce cannot be tested from PR #151's diff: the test
  module would fail to import on PR #151's base. The dispatch author
  may have assumed the function was local to the PR they dispatched
  against. Apply whatever is in-lane (a console.log → console.error
  fix, a JSDoc clarification), surface the test as cross-PR
  coordination work in the reply, name the PR where the function
  lives, and seed a regression-evidence brief the steward can hand
  to the next dispatch (construction inputs, the call to make,
  the assertion shape, an edge case). Do NOT pull the function
  definition into the current PR (it conflicts with the other PR's
  diff) and do NOT push to the other PR from the current dispatch
  (cross-PR action without explicit dispatch). Session example:
  PR 151's dispatch asked for a daemon test for `listWorkerTenants`;
  the function is in PR #129's `host.js`, not PR #151's CLI-only
  diff; landed the in-lane diagnostic fix and surfaced the test
  placement issue.
- **Coordinated cross-PR moves dispatched explicitly by the steward
  (PR A removes content; PR B, based on PR A, gains the content as
  a new package) follow a strict sequence.** First land PR A's
  removal commit and push. Then in PR B's worktree, fetch PR A's
  new tip and rebase. If PR B's only commit was `add X to file Y`
  and PR A just deleted file Y, the cleanest path is to drop PR
  B's commit during the rebase rather than fight conflicts:
  `git rebase --onto bots-ssh/<PR-A-branch> <old-PR-A-tip>`
  with PR B's old base SHA leaves the working tree at PR A's new
  tip with PR B's original commit dropped, ready for a fresh
  package-creation commit on top. Apply the equivalent change as
  a new commit (here, "create the new package" rather than "modify
  the deleted file"). Push PR B with `--force-with-lease` because
  the rebase rewrote history. Session example: PR 75 removed
  `packages/random/fast-check.js`; PR 107 was based on a tip that
  added v8 adapters to that file. Rebase dropped the v8 commit;
  the fresh commit created `packages/random-fast-check/` with
  both v5 and v8 adapters bundled into the new package.
- **When relocating an adapter to its own package, restate the
  thin upstream types locally rather than depend on the source
  package exposing its `*.types.d.ts` subpath.** A cross-package
  `@import { Foo } from '@upstream/pkg/types.d.ts'` requires
  `@upstream/pkg`'s `package.json` to list `./types.d.ts` (or
  `./*.d.ts`) as an export. If the upstream is being narrowed in
  the same coordinated move (so its exports list shrinks), adding
  the type subpath back conflicts with the narrowing. The
  decoupled choice is to restate the small contract type in the
  new package's own `*.types.d.ts`. The duplication is ~5 lines
  and removes an artificial dependency. Session example:
  `RandomSource` (a one-line `(out: Uint8Array) => void` type) was
  duplicated in `packages/random-fast-check/random-fast-check.types.d.ts`
  rather than imported from `@endo/random/random.types.d.ts`,
  because PR 75 narrowed `@endo/random`'s exports surface and
  re-adding a `./random.types.d.ts` subpath would have been
  inconsistent with that narrowing.
- **"Extract this feature into its own package" is a self-contained
  fixer dispatch shape, distinct from a rename and from the
  cross-PR coordinated move above.** A maintainer reviewing a
  feature added inside an existing package (e.g. a new exo dropped
  into `packages/daemon/src/`) may CHANGES_REQUESTED with a
  one-line ask to lift it into a new sibling package, often citing
  a name pattern (e.g. "named for the backend it adapts, like
  `@endo/exo-<backend>`"). The maintainer's example name is
  authoritative; do not second-guess it even if the current
  implementation is a fake/skeleton (the name names what it
  adapts, not what is currently shipping). The flow:
  `git mv packages/<src>/src/<file>.js packages/<new>/src/<file>.js`
  plus the matching `test/*.test.js` files (relative imports stay
  intact when source and tests move together); scaffold
  `package.json` / `tsconfig.json` / `tsconfig.build.json` /
  `index.js` / `README.md` / `LICENSE` / `SECURITY.md` modeled on
  a recent simple sibling (`packages/hex/` is a good template);
  declare every `@endo/*` the moved code imports as a
  `dependency` and every test-only import (e.g.
  `@endo/eventual-send`, `@endo/far`, `@endo/init`,
  `@endo/ses-ava`, `@endo/pass-style`) as a `devDependency`;
  update the design document to cite the new package path.
  No daemon-side import-cleanup is needed if the moved file was
  only consumed by its own tests; verify with `grep -rn
  '<moved-symbol>' packages/<source-pkg>/`. Ship as
  `refactor(<new-name>): extract <thing> into its own package
  (#<N> review)` plus the obligatory separate `chore: Update
  yarn.lock`. The `workspaces: ["packages/*"]` glob auto-discovers
  the new package, so no `lerna.json` or root `package.json`
  edits are required. Session example: PR 106's
  `Browser` exo was extracted from `@endo/daemon` into
  `@endo/exo-playwright` per a one-line maintainer review,
  bringing 36 tests across two test files; the daemon's
  `package.json` `exports` and `tsconfig` include globs continued
  to work unchanged.
- **`git stash` followed by `git stash pop` loses the index's
  rename detection on `git mv`-staged files.** A staged rename
  becomes an unstaged `D` + an unstaged `A` after pop; `git
  status` shows them as separate operations rather than a
  rename. Re-`git add` the deleted paths to bring the deletion
  back into the index, and the rename is re-detected on the next
  `git status`. The content of the new path is unaffected; only
  the index's pairing of the two paths is lost. This is
  particularly easy to hit when bracketing a check (e.g. a
  control-comparison lint run) with `git stash` / `git stash
  pop`. Prefer `git diff --cached -- <path>` to inspect a
  staged file in place, or use a separate worktree for the
  comparison run, rather than stashing.
- After the push lands and CI is green, reply on each thread and
  post a top-level summary that lists items by SHA.
- **After fix-up commits land, dispatch a `shepherd` to drive CI
  to green BEFORE re-requesting maintainer review.** Per
  maintainer directive 2026-05-08 (kriskowal on PR #157): "After
  any proposed change between build and approve, the shepherd
  should be invoked to get CI green and the conductor should
  only merge changes that are passing in CI." A red-CI PR in
  the maintainer's review queue forces the maintainer to decide
  whether the red is "yours" or "mine" before reviewing
  substance; the bot's job is to remove that ambiguity.
  - If the fixer can drive CI to green inline (rerun a known
    flake, push a tiny CI-only fix-up), do so without dispatching
    a separate shepherd; one agent acting as both fixer and
    shepherd is fine when the boundary is clean.
  - Only `gh api` calls to `pulls/<N>/requested_reviewers`
    (re-request) belong AFTER CI is green, not before.
- **The cleaner does NOT re-run on fixer rounds in response to
  maintainer feedback.** Per the new builder hand-off chain (see
  ~/garden/roles/builder.md "Then dispatch a `cleaner` against
  the most-affected package(s) BEFORE the maintainer ever sees
  the PR"), the cleaner is the LAST bot-side preparation step
  on the initial build. After that, the fixer's loop is:
  fixer → shepherd → re-request maintainer; no cleaner. The
  rationale: the cleaner already established a coverage baseline
  for the package; small fix-up changes don't warrant a fresh
  package-wide coverage pass, and dispatching a cleaner in the
  middle of an active fixer loop races the next maintainer
  review and produces orphan test commits. If a fix-up round
  significantly expands the diff (a new branch, a new file, a
  reshape across multiple call sites), THEN dispatch a cleaner
  before re-requesting review; small fix-ups skip the cleaner.
- **A `CHANGES_REQUESTED` review that asks for both a code change
  AND a PR-body rewrite is two deliverables, not one.** When the
  maintainer's review combines an inline-comment fix ("scope this
  doc more narrowly") with a top-level ask ("rewrite the PR
  description to capture the substance and not the methodology"),
  treat the body rewrite as a peer of the code commit. Land the
  code fix first (so the new SHA is real and citable), then
  `gh pr edit <N> --body-file <path>` per
  [`../skills/pre-pr-checklist.md`](../skills/pre-pr-checklist.md)'s
  PR-body-template + no-methodology-leak rules, then post the
  top-level summary that cites BOTH the addressing SHA AND the
  body rewrite. If you re-request review having only pushed the
  code fix, the maintainer's body-rewrite ask is still
  unaddressed and the next round bounces. Pre-existing PR bodies
  that grew out of split / re-open / cycle dispatches are the
  most common methodology leakers; reset to the template
  structure rather than appending. Session example: PR 109's
  CHANGES_REQUESTED review asked for both a README scope tighten
  and a body rewrite; addressing only the code change would have
  left "Implementation half of the split of #29 per the
  maintainer's ... review" prose in the body that was the
  maintainer's specific complaint.
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
  Multiple reviewers: repeat `-f reviewers[]=<login>`. Under zsh
  the `[]` triggers a "no matches found" glob error; in that shell
  use `--input - <<<'{"reviewers":["<login>"]}'` instead, which
  passes the JSON body verbatim. If the
  reviewer is the PR author, GitHub rejects the request with
  `422 Review cannot be requested from pull request author`; in
  that case post a `@<login>` mention in the top-level summary
  instead. **Do NOT fall back to requesting the bot's own
  identity** (`kriscendobot` requesting itself) as a workaround.
  The bot reviewing its own work is meaningless and breaks the
  signal: the maintainer never sees the PR re-enter their queue,
  and `requested_reviewers: [kriscendobot]` is what a stalled
  PR looks like in the dispatch state. PR 59 sat with this
  exact misconfiguration for hours before a maintainer pointed at
  the `pullrequestreview-4233224044` review and asked why it was
  going nowhere; the fix was `DELETE requested_reviewers[]=kriscendobot`
  + a top-level `@<author>` ping. Verify the post-request state
  with `gh pr view <N> --json reviewRequests`; if the bot is in
  the list, you have not done the right thing.
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
- **A maintainer `CHANGES_REQUESTED` that promotes a panel's
  should-fix to must-fix overrides any prior deferral plan and
  must land in the current PR.** When the panel's report classified
  an item as a should-fix (deferable to a follow-up) and a later
  maintainer review explicitly cites that item with language like
  "is not a deferrable feature and must be incorporated in this
  PR", the dispatch context flips: the deferral path is closed,
  the original panel verdict is overridden, and the fixer's job
  is to land the substantive fix in the same PR. Do not open a
  follow-up issue, do not surface the work as a "for the steward"
  cross-PR coordination item, and do not skip-with-reason; the
  maintainer has already weighed the in-scope cost and decided.
  Treat the maintainer's one-line review as the authoritative
  scope expansion and inherit the panel's symptom description as
  the implementation brief. Session example (PR 99 review id
  4233429522): the panel had logged "transitive tree descendants
  leak" as a should-fix; kriskowal's `CHANGES_REQUESTED` review
  promoted it to must-fix and the fixer landed
  `collectTransitiveTreeHashes` plus three regression tests in
  the same PR rather than as a follow-up.
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
- **A "further isolate the repro" maintainer directive on a
  failing-regression-test PR wants a sentinel test in addition to,
  not in place of, the failing regression.** When the repro PR's
  whole purpose is to ship a test that fails until a future fix
  lands, a directive like "this should be possible to repro without
  the daemon" is asking the bot to demonstrate the underlying
  language fact (or library fact) at a layer that does NOT need the
  system under repair. The cleanest shape is two artifacts:
  1. A **sentinel** test in the package that owns the relevant
     protocol or shape (here: captp owns the `CTP_DISCONNECT`
     envelope), asserting the broken-but-language-defined behavior
     directly (`t.is(JSON.stringify(Error('x')), '{}')`). This passes
     today and will keep passing after the fix; it documents WHY the
     symptom occurs and serves as a tripwire if the language fact
     ever changes.
  2. The original **regression** test stays as integration coverage,
     asserting the post-fix invariant; it fails today and will pass
     after the fix.
  Resist collapsing both into one assertion: a sentinel-shaped
  assertion that flips after the fix would mean asserting that the
  language behavior changes, which it does not. Cite both files in
  the reply: which is the sentinel, which is the regression, and why
  one cannot replace the other. Session example: PR 174 (#171
  repro) — added `packages/captp/test/disconnect-error-display.test.js`
  as the language-fact sentinel; kept
  `packages/daemon/test/disconnect-error-display.test.js` as the
  failing regression on `messageToBytes`.
- **`yarn format` (and the project's `format` script in general) walks
  the whole tree, not just your staged files.** A pre-existing file
  in the PR's diff that the original committer did not pre-format
  will get reformatted on your machine and show up as a spurious
  modification when you stage. Revert with
  `git checkout <path>` before committing your own work; if the
  pre-existing format drift is genuinely the maintainer's concern,
  ship it as a separate `chore: prettier` commit, not folded into
  the substantive change. Use `node node_modules/prettier/bin/prettier.cjs
  --check <your-new-file>` to format-check a single file in
  isolation. Session example: PR 174 fixer pass — `yarn format`
  reformatted a previously-existing daemon test file in the PR's
  diff; reverted with `git checkout` before committing the new
  captp test.
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
- **Deferred-pending-maintainer-pick rename items follow a specific
  re-engagement shape.** When the original fixer left a rename
  deferred with a list of candidate names and the maintainer later
  picks a name (possibly *not* on the candidate list), the second
  fixer must:
  1. Treat the maintainer's pick as authoritative even if it
     wasn't among the offered candidates. Session example: PR 59's
     `Locator` rename offered `CapabilityRegistry`, `Holdings`,
     `SwissnumDirectory`; the maintainer picked `NonceLocator`
     based on prior art in E.
  2. Re-verify each file in the original deferred-note's
     "affected files" list before editing. The original fixer's
     estimate may over-include: PR 59's note listed
     `docs/cbor-encoding.md` as affected, but that file's
     `Locator` reference was the URI form (the OCapN Peer
     locator), not the cap-table type being renamed; trusting the
     list verbatim would have changed the wrong file. Use `grep
     -nE '\b<OldName>\b'` and read each hit in context.
  3. Distinguish the *type* (Title-cased) from same-named
     identifiers (lowercase parameter / variable / option) and
     limit the rename to the type unless the maintainer asked
     for both. PR 59's cap-table type went `Locator` →
     `NonceLocator`; the lowercase `locator` parameter and option
     name stayed (it's a fine common noun, and the public API
     surface).
- **Pure-type renames want regression evidence via `@type`
  annotations on previously-unused imports.** A `@typedef` rename
  has no runtime presence, so a runtime test cannot detect the
  rename was applied incompletely. The cheap structural-evidence
  move is to find a file that already imports the type via
  `@import` but doesn't reference it, and add a one-line `/**
  @type {<NewName>} */` annotation on an existing local. That
  makes the import load-bearing: any partial revert of the
  rename now fails `tsc` closed with "Module has no exported
  member" errors. PR 59 used this on
  `packages/ocapn/test/_util.js`'s locator binding; reverting
  the typedef name alone produced two tsc errors in the files
  whose `@import` chains depended on the new name.
- **A "duplicative with ava test executor methods" review note on a
  hand-rolled deep-equal helper means delete, not rewrite.** When
  the maintainer flags a custom `equals` / `assertDeepEqual` /
  similar with that note, the canonical fix is to verify nothing in
  production code calls it (a `grep -n` across the whole tree, not
  just the package's tests; tests using it should be using
  `t.deepEqual` instead) and drop the helper. Ava's `t.deepEqual`
  already handles bigints, NaN-equals-NaN via `Object.is`,
  Uint8Array byte-by-byte comparison, and nested structures via
  `concordance`. The custom helper's only "extras" are typically
  ad-hoc shapes the maintainer doesn't want shipped (e.g. an
  `actual.tag !== undefined` case treating any object with a `tag`
  field as a tagged-value). If dropping the helper leaves the
  containing file empty, delete the file too and prune its
  re-exports from the package's index; the absence of the file is
  the load-bearing signal that the helper is gone. Session example:
  PR 111's `cbor/diagnostic/util.js` `equals` helper (no production
  callers; tests used `t.deepEqual` directly); dropped the helper
  and the now-empty file in commit `0116aa1283`.
- **A dispatch's stated diagnosis of a CI failure can be wrong; reproduce
  the failure and read the trace before applying the proposed fix
  shape.** The dispatch summary may identify a plausible-but-incorrect
  cause and recommend a strategy menu (Options A/B/C). If the recommended
  options don't match the actual root cause, applying any of them adds
  noise without fixing the failure. The discipline:
  1. Reproduce the failure locally on the PR's HEAD before touching
     code (`node node_modules/ava/entrypoints/cli.mjs <one-failing-test>`
     in the affected package; corepack-yarn-install first if node_modules
     is missing).
  2. Read the actual stack trace, not the dispatch's summary of it.
     Where does the throw originate? `cauterizeProperty` lives in SES,
     not in the package the dispatch named.
  3. Re-check the design doc the PR implements against the actual diff.
     If the design calls out a specific change (a permits entry, a
     migration step, a back-compat shim) and the PR's diff is missing
     it, that gap is the most likely cause of the failure, regardless
     of what the dispatch hypothesised.
  4. If the design doc has an obvious typo or inconsistency the PR
     would have inherited (the design said `UniqueSymbol(delegate)`;
     the actual SES form for `Symbol.for(...)` is `RegisteredSymbol(...)`
     per the precedent at `packages/ses/src/permits.js:519`), apply the
     correct form, not the typo. Cite the precedent in the commit.
  Session example: PR 186's CI failed with `Cannot delete property
  'Symbol(delegate)' of function Promise()` across all 15 test cells.
  The dispatch hypothesised the failure came from tests deleting the
  slot between cases and offered three test-restructuring options.
  No test deleted the slot: SES's own `lockdown()` did, as the standard
  intrinsic-cauterization step on a Promise property it didn't recognise.
  The fix was the SES permits entry the design doc explicitly called
  for at lines 393-405 and 766 but the implementation PR forgot to
  land. None of the dispatch's three options would have solved it.
- **A lazy adapter that wraps a constructor surface MUST be `new`-able;
  arrow functions and frozen plain objects throw `TypeError: X is not
  a constructor` when invoked with `new`.** When migrating a legacy
  constructor (`new HandledPromise(executor, handler)`) behind a
  lazy/install-on-first-use adapter, the natural-looking shape is a
  frozen object literal whose methods are arrow functions that defer
  to `getDelegate()` on call. That shape supports static methods
  (`X.resolve(...)`) but throws `X is not a constructor` at every
  legacy `new X(...)` call site, and the failure surfaces only at
  consumer packages whose tests exercise the constructor (e.g.
  `@endo/captp`'s `crosstalk`, `gc`, `trap`, `loopback` tests), not
  at the producer package's own tests (which may only cover the
  static surface). The fix is a regular `function` declaration (or a
  `class`); the constructor body forwards to the same lazy delegate
  call that produces a settler bag, then runs the executor against it
  and returns the promise. Static methods attach as own properties
  exactly as in the object-literal version. The `Object.freeze`
  discipline still applies (the function object is frozen after
  property assignment). Verify by `grep -rn 'new <Adapter>' packages/`
  before declaring the adapter shape final, and by reproducing the
  failure on a downstream consumer's test (not just the producer's
  own suite). Session example: PR 186's `lazyHandledPromise` was
  initially a `Object.freeze({ resolve: (...args) => getDelegate().
  resolve(...args), ... })` literal; recovered via a `function
  lazyHandledPromise(executor, handler) { const { promise, resolve,
  reject, resolveWithPresence } = getDelegate()(handler);
  executor(resolve, reject, resolveWithPresence); return promise; }`
  declaration with the static methods attached after.
- **`t.is(X.foo, Y.foo)` on functions is a reference-identity assertion;
  AVA's diff prints the function `name` because that is the visible
  difference, but renaming the actual will not flip `===`.** When a
  dispatch hypothesises that a `Function {}` vs `Function foo {}` AVA
  diff is "the static methods are unnamed arrow functions; give them
  names", verify the underlying claim before applying the rename: ARE
  the two function values the same reference, just printed differently
  due to a name property quirk, or are they actually distinct closures?
  If they are distinct closures (one an arrow wrapper that defers to a
  realm singleton, the other a method on the realm singleton itself),
  naming the wrapper changes its `.name` for printing but `t.is` still
  fails because identity remains different. The real fix is to make the
  two values the *same reference*, typically by routing both through a
  getter that returns the singleton's own property after first install.
  Session example: PR 186's `t.is(E.resolve, HandledPromise.resolve)`
  failed because `E.resolve` was an arrow `(x) => getDelegate().
  resolve(x)` and `HandledPromise.resolve` (set by the eager shim) was
  the realm constructor's `staticMethods.resolve`. Naming the arrow
  would have produced "Function resolve {}" for both sides of the diff
  but `===` would still fail. The fix replaced the arrow statics on the
  lazy adapter with `Object.defineProperty` getters returning
  `getDelegate().HandledPromise[name]`, and deferred `makeE()` until
  first use so its eagerly-captured statics also referenced the realm
  constructor's own methods. This preserved the lazy-install invariant
  (no install at module load) AND restored identity across the eager
  and lazy paths.
- **When a dispatch summary's restatement of a maintainer comment
  appears to contradict an already-settled prior decision in the
  same PR, trust the maintainer's actual comment (re-read inline)
  and the prior settlement, not the dispatch's paraphrase.** Brief
  authors writing fixer dispatches do not always re-read the full
  PR review history; their summary of "what to do" can drift into
  shapes the maintainer never asked for. The discipline: before
  applying a substantive change, enumerate `gh api repos/<o>/<r>/
  pulls/<N>/comments` and read every prior maintainer comment plus
  every prior `kriscendobot` reply. If a prior comment thread
  settled a question the dispatch now appears to re-open, the fix
  is to apply the maintainer's *actual* L<line> comment (which is
  almost always a narrower edit than the dispatch summary
  suggests), not to undo the prior settlement. Session example:
  PR 153 round 2 dispatch said "make `--text` a UTF-8 convenience
  that encodes to bytes and stores as a blob"; the prior round
  had already settled (per maintainer review 4256759685 reply
  3212448305: "We use `--blob` for blob storage and `--text` for
  a primitive string") that `--blob` and `--text` produce
  *different formula kinds*. The maintainer's actual L327
  comment ("blobs are bytes") was about killing the now-stale
  Open Question's premise of a `cat`-time render distinction on
  blobs, not about reshaping `--text`'s formula kind. The fixer
  preserved the prior settlement and applied only what L327
  actually asked.
- **A maintainer review that reframes a design's primary surface
  ("X is the primary surface, not Y") demands a top-to-bottom
  rewrite, not a new section appended to the existing structure.**
  When the maintainer's directive inverts the design's framing (e.g.
  "agents drive the daemon via tool-calls, so the daemon API is
  primary; the CLI is a thin wrapper"), the prior structure of the
  document is built on the wrong axis. Rewrite the headings, the
  capability section, the rationale ("Why X-side and not Y-side"
  flips to "Why Y-side and not X-side"), the worked examples, and
  the open questions to align with the new framing. Adding an
  "EndoGuest API surface" section while the rest of the doc still
  reads as "this is a CLI verb that composes existing capabilities"
  produces a document that contradicts itself; a reviewer reading
  it will land on whichever section they read first and the
  maintainer's correction is wasted. The fix is uncomfortable
  because it touches more lines than the inline comment count
  suggests, but it is what "EndoGuest-API-first reshape" actually
  means. Session example: PR 162's `cli-edit-verb.md` review id
  4258583660 inverted "CLI is primary; daemon-side editText is a
  Future extension" into "EndoGuest.edit is primary; CLI is a thin
  wrapper"; the fixup commit rewrote 617/260 lines of a 616-line
  doc rather than the ~20 lines an inline-only response would have
  touched.
- **A maintainer verb-naming directive that lists candidates ("trap, tame,
  occlude, mask") wants a pick from the established codebase vocabulary,
  not a tournament of synonyms.** When the review offers several near-
  synonyms for a verb, the right move is to scan the codebase for which
  family already has currency (`grep -rn '\b<candidate>[A-Z]'` across
  `packages/`) and pick the one with prior art. In Endo specifically,
  `tame*` is everywhere (`tame-math-object`, `tame-regexp-constructor`,
  `tame-domains` in `@endo/ses` alone) and connotes "render an ambient
  capability safe to surface across a membrane", which is usually what
  the function under rename does. `mask`, `occlude`, `trap` are valid
  English but invent new vocabulary the reader has to learn; `tame`
  matches an existing mental model. Cite the rationale in the inline
  reply so the maintainer can see you considered the alternatives and
  picked deliberately. Session example: PR 122's `confineAclErrors` →
  `tameAclErrors` rename, picked from a four-way candidate list.
- **An abbreviated identifier with a "do not abbreviate; if shadows,
  elaborate one or both" directive is a request to invent a non-
  shadowing expansion, not just to drop the abbreviation.** The
  obvious expansion (`makeDir` → `makeDirectory`) usually shadows
  another in-scope binding (the outer module-level export, an exo
  method of the same name); the maintainer is asking for a third
  name that is unabbreviated AND distinct from the existing two.
  Pick a descriptive suffix from the parameter or the role: e.g.
  `makeDirectoryAt` (parameterised by `currentPath`) reads as "make
  a Directory at the given path" and is non-shadowing. Run a
  `grep -n '\b<name>\b'` over the file before renaming so all call
  sites are updated atomically. Session example: PR 122's
  `makeDir` → `makeDirectoryAt` (the inner recursive Directory-exo
  factory; both the outer `makeDirectory` export and the exo's
  own `makeDirectory` method would have shadowed a plain expansion).
- **A "drop the cause" security directive is not a JSDoc edit alone;
  the prose around it must flip too.** When the maintainer says
  "stop threading the cause; we leak what we purport to hide", the
  edit is `throw new Error(msg, { cause: e })` → `throw new Error(msg)`
  AND a JSDoc rewrite from "the original error is preserved on
  `cause` for host-side debugging" to "the original error is dropped,
  not threaded as `cause`: a `cause` chain would re-export the
  OS-level structure (path, errno, syscall) we are deliberately
  occluding". Leaving the JSDoc claiming the old (now-untrue)
  invariant is worse than the original code; a future reader trusts
  the doc. Session example: PR 122's `tameAclErrors` (formerly
  `confineAclErrors`) — both the throw site and the surrounding
  JSDoc paragraph were rewritten in one edit.
- **Position-based inline comments need careful diff-line accounting
  when the dispatch summary cites only the position number.** GitHub's
  `position` field is 1-indexed and counts every line in the unified
  diff after the first `@@` hunk header for that file (context, `+`,
  and `-` lines all count, but the `@@` line itself does not). When
  the dispatch hands over a list of `(path, position, body)` triples
  without the resolved file line, the fixer maps each position to its
  diff line with:
  ```sh
  git diff <base>..HEAD -- <path> | awk '
  BEGIN { pos=0; in_hunk=0 }
  { if (/^@@/) { in_hunk=1; print "POS="pos": "$0; next }
    if (in_hunk) { pos++; print "POS="pos": "$0 } }
  '
  ```
  Then `sed -n` to the position cited in the dispatch. A position
  that lands on a closing brace, JSDoc closer, or property line is
  often a "footnote" cite — the maintainer is commenting on the
  *containing* function or block, not the specific token. Read 5-10
  lines of surrounding context before deciding what the comment is
  about. PR 111's position-53 comment on `cbor/diagnostic/util.js`
  landed on the `*/` closing the `equals` JSDoc, but the comment
  was about the whole `equals` function below it.
- **A `1 unhandled rejection` from a daemon-class test on CI that
  doesn't reproduce locally is most often a teardown timing race,
  not a code-path regression.** Daemon tests fork full processes,
  rely on socket lifecycle, and run an `afterEach.always` that calls
  `stop(config)` then `cancel(Error('teardown'))`. The test files
  themselves often acknowledge this with comments like "Stopping
  first avoids an unhandled rejection race". When the failure
  surfaces as an empty `{}` rejection (the JSON-stringified form of
  an Error sent across the wire as `CTP_DISCONNECT.reason`, since
  Error properties are non-enumerable), it is the disconnect path
  rejecting a settler whose silencer is racing the unhandled-rejection
  bookkeeping. The sequence to follow:
  1. Pull the FULL job log (`gh run view <id> --repo <r> --log >
     /tmp/full.log`) and grep for `Unhandled rejection in test/`,
     not just `unhandled rejection`. The "filter for failed steps"
     output (`gh run view --job <id> --log-failed`) sometimes shows
     only the verbose-output tests and hides the actual file name.
  2. Verify the dispatch's identification of the failing test against
     the log. The `--log-failed` filter may surface a test that
     happened to be the LAST verbose-output test before the run-summary
     line, when the actual rejection came from a different file
     entirely. PR 170 round 3 dispatch identified `ws-relay.test.js`
     as the failing file; the actual rejection was in
     `endo.test.js` (verifiable via `gh run view --log | grep
     "Unhandled rejection in test/"`).
  3. Audit the new code paths for: callbacks-without-onRejected
     in `subscribe`-like primitives, settler.reject without a
     silencer, default rejection handlers that surface to the
     host's unhandled-rejection path. If all paths check out and
     a 500+ test suite plus a focused solo-run pass locally, this
     is a CI-only flake. Document the analysis with the SHA you
     reproduced against, and let the fresh push's CI provide a
     second sample.
  Do NOT add a band-aid `.catch(() => {})` to mask the rejection
  if a panel review has already rejected that pattern as a
  must-fix. The honest fixer outcome is "lint fix landed, daemon
  failure documented as suspected flake, CI rerun arming."
  Session example: PR 170 round 3 — lint failure was real and
  fixed mechanically; daemon `1 unhandled rejection` did not
  reproduce across a 524-test full daemon-package run plus a
  154-test solo `endo.test.js` run, despite extensive code-path
  analysis identifying no plausible new leak in the
  default-mode (non-pass-style-inbound) CapTP path.
- **A "preserve byte-identical tree" reshape rebases onto the
  ORIGINAL base, not the current upstream tip.** When a steward
  dispatch asks for a commit-grouping reshape with a load-bearing
  "tree must equal `<safety-tag>`" invariant, the rebase target
  is the merge-base of the safety tag and the upstream branch,
  not the upstream branch's current head. Rebasing onto the
  current head pulls in unrelated upstream churn (workflow SHA
  bumps, transitive dep upgrades, `@types/node` major bumps)
  and the diff-vs-safety-tag invariant fails. Compute the base
  with `git merge-base <safety-tag> <upstream-branch>` and use
  THAT as the rebase target. The reshape's own dispatch may say
  "rebase onto `bots-ssh/<branch>`"; treat the upstream-branch
  reference as a hint pointing at the merge-base, not at the
  current tip. If the maintainer wants the PR re-based onto the
  fresh tip too, that is a separate move (different reshape,
  different verification: tree changes per the upstream churn).
  Session example: PR 147's `providers` reshape — original base
  `7015f2082e`, current `bots-ssh/llm` `2755cd23df`; rebasing
  onto `2755cd23df` produced a non-empty diff vs. `pr147-pre-tidy`
  showing `@types/node` v20→v25 + workflow SHA bumps; rebasing
  onto `7015f2082e` produced an empty diff.
- **A `.catch(() => undefined)` (or `.catch(() => {})`) wrapped
  around a recording-side helper masks programmer errors as
  ruthlessly as it masks transient I/O.** When a fixer dispatch
  cites "not a valid formula identifier" (or any "invalid X" /
  "wrong shape" assertion) inside a helper that is wrapped in a
  `.catch(() => undefined)` at every call site, the helper has
  almost certainly been silently failing in production: the catch
  swallows the assertion, the caller sees `undefined`, and the
  feature appears to "work" without ever recording anything.
  Before fixing the assertion error, audit every call site for the
  catch pattern and decide whether the catch should stay (transient
  storage I/O) or go (validation belongs as the caller's
  precondition). The surface fix (replace the bad input with a
  good one) is necessary but the underlying catch-everything pattern
  is what let the bug live to review. Session example: PR 179's
  `cmd-resolve-N-Date.now()` synthetic strings failed
  `assertFormulaNumber` inside `deliver`; every `recordCommand`
  call site had `.catch(() => undefined)`, so no command was ever
  persisted and the chat-side rendering quietly displayed nothing.
- **`await x; return nextSequence - 1n` is interleaving-broken even
  when the await is on a serialized queue.** The pattern looks
  microtask-safe (the resolve and the next statement land adjacent
  on the microtask queue), but a serial-jobs queue's `unlock` runs
  synchronously inside `enqueue`'s `finally`, which immediately
  starts the next queued job. That next job can run to its first
  internal await BEFORE my continuation reads the sequence, and
  has by then incremented the sequence past my message. The fix is
  to capture the assignment INSIDE the critical section (e.g.
  return the assigned number from the queued function) or to use a
  per-message identifier minted before deliver (a 64-hex random)
  rather than reading the post-deliver sequence value. The latter
  is also the right answer for any "do not leak our message-number
  sequence to other parties" review note: the bigint sequence
  stays internal; an opaque random crosses the boundary. Session
  example: PR 179's `recordCommand` originally did
  `await deliver(message); return nextMessageNumber - 1n;` which
  raced concurrent `deliver` calls under `mailboxStoreJobs`; the
  fix returned a freshly-minted `messageId` (already used as the
  threading key for `send`/`request`) so neither the sequence nor
  the leak hazard remained.
- **A contributor PR's head repo is the contributor's fork, not
  `bots-ssh`.** Before pushing a fixer reshape, verify the head
  repo with `gh pr view <N> --json headRepository,headRefName`.
  When the dispatch says "push: `git push --force-with-lease
  bots-ssh providers`" but the PR's `headRepository.nameWithOwner`
  is `<contributor>/endo-but-for-bots`, push to that contributor's
  remote (already configured as `<contributor>-ssh` in the worktree)
  instead. Pushing to `bots-ssh` will create a new branch on
  `endojs/endo-but-for-bots` (the dispatch's view) without updating
  the PR head; the PR sits at the original tip and the maintainer
  has no signal anything happened. Cleanup: `git push bots-ssh
  --delete <branch>` to remove the accidentally-created branch.
  Verify the PR head SHA updated with `gh pr view <N> --json
  headRefOid` before claiming the reshape is complete. Session
  example: PR 147's `providers` was on `0xpatrickdev/endo-but-for-bots`;
  the first push to `bots-ssh` created an orphan `providers`
  branch on the endojs fork while the PR stayed at `e41542b9b7`;
  the corrective push to `0xpatrickdev-ssh` updated the PR.

## Self-improvement

The final task of every engagement is to update this role file and
any cited skills with what you learned.
See [`../skills/self-improvement.md`](../skills/self-improvement.md)
for thresholds and discipline.
A vivid surprise warrants a new pitfall or example.
A pattern across multiple engagements warrants a new rule.
Report the change (or "nothing this time") in your final response.
