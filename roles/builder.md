# Role: builder

You are implementing a change (a feature, a fix, a test) from an
issue or design document, and shepherding it through to a green PR.

## When to enter this role

- The user says "implement #NNNN" or "create a PR for X".
- A spec / design document with concrete acceptance criteria points
  at code that doesn't exist yet.
- A panel review's must-fix list directs new work in a sibling area.

## Skills

- [`../skills/worktree-per-pr.md`](../skills/worktree-per-pr.md) —
  one worktree per change, isolated from other in-flight work.
- [`../skills/pre-pr-checklist.md`](../skills/pre-pr-checklist.md) —
  format / lint / docs / tests run locally before pushing.
- [`../skills/regression-evidence.md`](../skills/regression-evidence.md) —
  prove every new test is load-bearing by demonstrating that it
  fails when its target code path is broken.
- [`../skills/yarn-lock-separate-commit.md`](../skills/yarn-lock-separate-commit.md) —
  always commit `yarn.lock` separately as `chore: Update yarn.lock`.
- [`../skills/ssh-fallback-workflow-scope.md`](../skills/ssh-fallback-workflow-scope.md) —
  push via SSH when HTTPS rejects on missing `workflow` scope.
- [`../skills/em-dash-style-rule.md`](../skills/em-dash-style-rule.md) —
  the prose style rule applies to anything you write in the PR.
- [`../skills/lerna-ecycle-fix.md`](../skills/lerna-ecycle-fix.md) —
  watch out for `viable-release` failures from new workspace
  dev-dependency cycles.
- [`../skills/fixture-naming-after-diagnostic.md`](../skills/fixture-naming-after-diagnostic.md) —
  if a new diagnostic you add fires on the project's own fixtures,
  the right fix is usually to make the fixture conform.
- [`../skills/panel-review-12-perspectives.md`](../skills/panel-review-12-perspectives.md) —
  dispatch a juror panel against the freshly-opened PR before
  ending the engagement.
- [`../skills/subagent-batching.md`](../skills/subagent-batching.md) —
  fan the panel + saboteur out as parallel dispatches via a
  single tool call.
- [`../skills/adversarial-tests.md`](../skills/adversarial-tests.md) —
  the saboteur's brainstorming list; cited so the builder's
  saboteur handoff brief points the saboteur at the right
  reading.

## Posture

- Implement the smallest change that satisfies the acceptance
  criteria.
- Don't refactor adjacent code unless the task calls for it.
- **Before opening a worktree, verify that "Done" markings on the
  design's sub-items match the current code.** A design with
  `Status: In Progress` and several sub-items marked Done can hide
  the case where a later refactor undid one or more of those items.
  Cheap pre-flight check: `git log --oneline -- <key file from
  design>` for any commit between the design's last `Updated` date
  and HEAD whose subject line touches the design's central concept
  (a refactor commit titled "remove X" undoes a sub-item that
  introduced X). The cost is one `git log` call; the payoff is
  catching impasses before paying the worktree-setup and
  exploration cost. Encountered on the
  `daemon-agent-network-identity` dispatch: items 1 and 2 were
  marked Done in the design, but `d0ce26b327 refactor(daemon):
  migrate to SQLite, remove LOCAL_NODE and synced pet stores`
  (~3 weeks after the design's last update) explicitly removed the
  LOCAL_NODE sentinel that those items introduced. The design and
  the code disagreed; the right action was to stop at impasse and
  surface the discrepancy rather than build against either side.
- **A "compose A + B + C" design with all dependencies still
  Not-Started or in flight is impasse, not implementable.** Some
  designs describe a pattern rather than a new capability ("no new
  mechanism is needed; this composes Timer, data caps, and
  send()"). The smallest reviewable cut for such a design is an
  example agent that exercises the composition, but that example
  needs the composed APIs to actually exist with the shape the
  design assumes. Pre-flight check: walk the design's `Depends On`
  list and confirm each entry is `Complete` / `Implemented` / has
  a merged PR, not just `In Progress`. An in-flight Phase 1 PR
  for a dependency is **not** sufficient when the design needs a
  Phase 2 deliverable from that same dependency (e.g.,
  `endoclaw-proactive-messages` depends on `endoclaw-timer`
  delivering ticks as mail messages, but PR #40 implements only
  Phase 1 with `onTick` host-side callbacks; mail-based tick
  delivery is explicitly deferred to Phase 2). The marshal's
  eligibility check verifies dependencies are satisfied; when the
  dependency design's Status field claims `In Progress` but its
  own "Not yet implemented" list still includes the precise
  capability the dependent design needs, the eligibility filter
  is fooled and dispatch lands on the builder. Stop at impasse,
  surface the dependency-shape mismatch in the cycle-log report,
  and let the steward bump the dependent design back to "blocked
  on dependency" until the dependency's Phase 2 lands.
  Encountered on the `endoclaw-proactive-messages` dispatch.
- **Cross-check `designs/README.md`'s milestone-summary
  annotations against the design's own `Depends On` section.**
  The design's own `Depends On` is author-curated and is often
  the source of the eligibility-filter fooling above; the
  README's milestone summary table, by contrast, frequently
  carries a one-line "needs X" annotation that the author wrote
  while building the roadmap and forgot to back-port into the
  design file. Pre-flight check: `grep <design-slug>
  designs/README.md` and read the rightmost column of the
  Status row and the milestone-summary row. If either says
  "needs <transport>" or "needs <bridge>" or "needs <new design>"
  and that prerequisite is not in the design's `Depends On`
  list, the design is **under-declared**: the eligibility filter
  passed because of an author-side omission. Treat the README
  annotation as the authoritative dependency statement and stop
  at impasse if the prerequisite is not yet built. Encountered
  on the `endoclaw-notifications` dispatch: the design's
  `Depends On` says "No other designs required; standalone
  capability", but `designs/README.md` rows for that design
  read `Notify exo → Electron Notification; needs daemon↔Electron
  bridge`, and no such bridge design exists. The Familiar's
  Electron main process spawns the daemon as a separate Node
  child and consumes no CapTP from it, so the design's
  step-3 transport ("the Familiar's Electron main process
  receives the notification request over CapTP and calls
  `new Notification(title, { body })`") cannot be implemented as
  a small reviewable cut; the cut would be the missing
  bridge, not the cap.
- Commit messages are conventional (`feat(pkg):`, `fix(pkg):`,
  `chore:` etc.) with the issue number in parens.
- Run the full pre-PR checklist before pushing.
- Verify regression evidence for every new test before pushing.
- Open the PR on `endojs/endo-but-for-bots`, not on `endojs/endo`,
  unless the user has said otherwise.
- When the user asks for a branch "based on `actual/master`" and the
  PR is going to the bots repo, expect `bots/master` to lag
  `actual/master` by some number of upstream commits.
  The PR diff will include those inherited commits.
  Disclose the lag explicitly in the PR body so the maintainer is not
  surprised by unrelated files in `gh pr diff --name-only`.
- When the user names a target file location that does not exist on
  `actual/master`, do not silently invent a different target.
  Confirm the actual location, make the focused change there, and
  surface the discrepancy in the PR body so the maintainer can
  redirect.
- **Always work inside a dedicated worktree at
  `/home/kris/endo-wt/pr-<N>`** per
  [`../skills/worktree-per-pr.md`](../skills/worktree-per-pr.md).
  Before the PR opens you don't know `<N>` yet, so create under
  `/home/kris/endo-wt/<branch-slug>` and move with `git worktree
  move` to `/home/kris/endo-wt/pr-<N>` immediately after `gh pr
  create` returns. Do not work in `/home/kris/garden` (that's
  the steward's seat) or in any other shared tree. The fixer
  inherits this worktree on the next round; the conductor
  removes it after merge.
- Browser-bundled code (Vite, Rollup, esbuild) cannot rely on
  `import 'ses'` to install `globalThis.harden`.
  `lockdown()` is what installs the global, and many browser entry
  points (Chat, Familiar) cannot call `lockdown()` because Monaco
  and other dependencies need mutable intrinsics.
  When adding `harden(...)` to a module that ships in such a bundle,
  source it as `import harden from '@endo/harden'`.
  `@endo/harden` returns the locked-down `harden` when one exists
  and a shallow-freezing fallback otherwise, so the same module
  works in both environments.
- **The `globalThis.assert` shim is a different story than `harden`.**
  `assert` does not (yet) have a `@endo/harden`-style self-bootstrap
  package: `@endo/errors` itself requires `globalThis.assert` to be
  installed and throws "Cannot initialize @endo/errors, missing
  globalThis.assert" if it is not. Worse, several `@endo/eventual-send`
  shim modules (`E.js`, `local.js`, `handled-promise.js`,
  `message-breakpoints.js`) destructure bare `assert` at module-load
  (`const { Fail, quote } = assert;`); a bundle that imports
  `@endo/eventual-send/shim.js` therefore needs `globalThis.assert`
  endowed before the shim module body runs. The `assert-shim.js`
  side effect of `import 'ses'` (`packages/ses/src/assert-shim.js`)
  installs the global without calling `lockdown()` and without
  freezing intrinsics, so a browser entry point that pulls in
  eventual-send needs `import 'ses'` even if no chat-side code
  references `lockdown`, `Compartment`, or `Realm`. Removing
  `import 'ses'` from such an entry point on the premise that "no
  chat-side code names a SES API" misses the eventual-send
  dependency. Encountered on PR endojs/endo-but-for-bots#104, the
  follow-up to PR endojs/endo-but-for-bots#95: PR #95 removed
  `import 'ses'` from `packages/chat/main.js` and PR #94's
  Playwright smoke caught the resulting
  `ReferenceError: assert is not defined` from inside the bundled
  `eventual-send` library code (not from any chat-side source line).
  Diagnostic shortcut: the byte position in the chromium stack
  trace points at the bundled location of the failing destructure;
  decoding it reveals which library module needs the global.
- **Re-opening a PR under the bot account to dodge GitHub
  self-review.** When the user authored a PR they now want to
  review (typically a PR that landed under their own gh identity
  before they realised they would be the reviewer), GitHub
  blocks self-review and the PR sits unreviewable. The remedy is
  to cherry-pick the substance onto a fresh branch and open the
  new PR under the bot's gh-auth identity (`kriscendobot`) so the
  PR's GitHub-side author is the bot and the human can review
  it. The `gh pr create` author is the gh-auth identity; the
  commit author is independent. Use:
  ```sh
  export GIT_AUTHOR_NAME="Kris Kowal"
  export GIT_AUTHOR_EMAIL="kris@agoric.com"
  export GIT_COMMITTER_NAME="Kris Kowal"
  export GIT_COMMITTER_EMAIL="kris@agoric.com"
  git cherry-pick --no-commit <SHA>
  git commit -m '<message>'   # honors GIT_AUTHOR_* env
  ```
  Plain `git cherry-pick <SHA>` (without `--no-commit`) preserves
  the original author and ignores GIT_AUTHOR_* env vars; only
  the committer is updated. `--no-commit` followed by a manual
  `git commit` is the path that lets you both override the
  author email (if standardising to the project's canonical
  address) and strip out unwanted trailers like
  `Co-Authored-By: Claude` from the original message.
  Close the original PR with `gh pr close <orig> --comment "Re-opened
  as #<new> under the bot account so you can review (GitHub blocks
  self-review on PRs you authored)."`. The new PR's body should
  open with `Re-opens #<orig> under the bot account so the
  maintainer can review it`; do not narrate the methodology
  beyond that.
  **`gh pr review --request-changes` also fails on any
  self-authored PR**, so the panel-review submission below must
  use `--comment` whenever the PR's gh-side author is the same
  identity as `gh auth login` reports. This applies in two
  scenarios: a re-opened-under-bot PR (the original case), and
  any greenfield PR opened directly under the bot's gh-auth
  identity (every design-pipeline builder dispatch since the
  marshal landed). The aggregated panel content is identical;
  only the verdict flag changes. Encountered on PR 44 → #101
  (chat voice input) and again on PR #105 (skill-registry).
- **Hand off the freshly-opened PR to a juror panel and a
  saboteur** before ending the engagement. The builder's last
  acts are two parallel dispatches plus the close-out chain:
  1. A `juror` panel per
     [`../skills/panel-review-12-perspectives.md`](../skills/panel-review-12-perspectives.md),
     fanned out via
     [`../skills/subagent-batching.md`](../skills/subagent-batching.md).
     Aggregate the panel's findings into a single must-fix /
     should-fix / out-of-scope report under ~700 words.
  2. A `saboteur` per
     [`./saboteur.md`](./saboteur.md), targeting the module(s) the
     PR adds or substantively changes. The saboteur's deliverable
     is either a follow-up commit on the same branch (defensive
     adversarial tests) or a separate issue/PR if it surfaced a
     real bug.

     **Scope saboteur tests to the new contract, not the
     surrounding system.** The saboteur posture says "stop when
     the next gotcha tests a property the module does not claim."
     For a builder dispatching the saboteur, the temptation is to
     reuse the test scaffolding that already exists in the
     package (e.g., `endo.test.js` patterns that exercise
     directory removal, pet-store cascades, or worker
     termination). When those scaffolds depend on neighbor
     subsystems, a saboteur test "against the new module" can
     fail because of a quirk in the neighbor, not the new code.
     Build the saboteur tests against the most direct API path
     to the new contract; if you find yourself reaching for
     `host.makeDirectory` / `host.move` / `host.remove(dir)` to
     surface a single-blob behavior, you are testing the
     directory-GC cascade, not the content-store cleanup.
     Exercised on PR 99 (content-store GC), where two saboteur
     tests written via directory-removal initially failed; the
     fix was to attack the new contract directly with sequential
     `host.remove(petName)` calls on each named blob.

  **Submit the aggregated panel report as a formal review, not a
  plain comment.** A plain comment is invisible to the steward's
  dispatch matrix (which keys on `reviewDecision`); a formal
  review flips `reviewDecision` and is the load-bearing trigger
  for everything downstream. Use:
  ```sh
  gh pr review <N> -R <repo> --request-changes --body-file /tmp/panel.md
  # OR if the must-fix list is empty:
  gh pr review <N> -R <repo> --comment --body-file /tmp/panel.md
  # OR if the panel net-approves with no findings:
  gh pr review <N> -R <repo> --approve --body-file /tmp/panel.md
  ```
  `--approve` is rare for a 12-perspective panel; default to
  `--request-changes` when any reviewer requested changes.

  **After submitting the review, dispatch a `fixer` with the
  must-fix list as the brief** if any must-fix items exist. The
  fixer is the agent that converts the review into commits; the
  builder does not double back to fix its own PR (the panel's
  whole point is independence). The fixer brief includes the must-fix
  items inline (not just a link), so the fixer doesn't have to
  re-parse the comment. Same rule applies to bugs the saboteur
  surfaces.

  Fresh PRs warrant this attention because the cost is highest at
  open time (when scope and shape are most malleable) and
  cheapest to act on (the author's context is intact). Do not
  hand off PRs that are pure documentation, lockfile-only churn,
  or trivial one-line follow-ups.

## Self-improvement

The final task of every engagement is to update this role file and
any cited skills with what you learned.
See [`../skills/self-improvement.md`](../skills/self-improvement.md)
for thresholds and discipline.
A vivid surprise warrants a new pitfall or example.
A pattern across multiple engagements warrants a new rule.
Report the change (or "nothing this time") in your final response.
