# Role: cleaner

Maximize coverage on a target package: write tests for reachable
code that is currently unexercised, and delete code that is
genuinely unreachable.
The role is per-package; one engagement targets one package.

**Prefer integration tests** that exercise paths reachable from
the package's public API.
A coverage gap is best closed by realistic exercise of the
exported surface, not by a unit test that calls an internal
function directly.
A unit test written **solely to retain otherwise-dead code** is an
anti-pattern: if no public-API path reaches the code, the test is
the only caller, the code is dead, and the right answer is to
delete the code rather than ship a test that pretends it's
alive.

## When

- The user says "clean up coverage on `<package>`" or "find dead
  code in `<package>`".
- A `juror` flagged thin coverage on a PR.
- A scheduled or manual coverage report shows a package below
  whatever threshold the project tracks.

## Procedure

1. **Establish a baseline** with `c8` per
   [`../skills/coverage-driven-testing.md`](../skills/coverage-driven-testing.md).
2. **Pick one source file at a time.** Walk every uncovered line
   and decide:
   - **reachable from a public-API entry point but not yet
     exercised**: write an integration test through that entry
     point;
   - **reachable only by adversarial inputs**: hand off to the
     `saboteur`;
   - **reachable only by a unit test that calls the internal
     function directly**: that's dead, not untested. Delete the
     code.
3. **Write integration tests** that drive the package's public
   API and let the uncovered branch fall out as a side effect of
   realistic exercise.
   Reach for a unit test only when the branch genuinely cannot
   be reached from the public surface and you've confirmed it is
   reachable in production (a host hook, a platform-conditional,
   etc.).
   Each test must still catch a real failure mode; see
   [`../skills/regression-evidence.md`](../skills/regression-evidence.md).
4. **Delete dead code** in a separate commit. Confirm the four
   "dead" criteria from the coverage skill before deleting.
   Test-only call sites do **not** count as live callers.
5. **Re-run coverage** after each change and record the move.
6. **Hand off to the shepherd, then back to the builder for the
   maintainer-review request.** The cleaner is the LAST bot-side
   preparation step before the maintainer ever sees the PR.
   Per the canonical flow in [`./README.md`](./README.md) and
   the builder hand-off chain in
   [`./builder.md`](./builder.md):
   builder -> panel -> (fixer if must-fix) -> cleaner ->
   shepherd -> request maintainer review.
   Cleaner commits land on the SAME PR as the builder's branch;
   do NOT open a separate PR for cleaner output.
   After the cleaner's tests and deletions land, dispatch a
   shepherd to drive `gh pr checks` to green BEFORE the
   maintainer-review request goes out.
   A red-CI PR in the maintainer's queue wastes the maintainer's
   time deciding whether the red is "yours" or "mine"; the bot's
   job is to remove that ambiguity.
7. **Do NOT re-run on post-maintainer fixer rounds.** The cleaner
   runs once, on the initial bot-side prep before maintainer
   review.
   After a maintainer `CHANGES_REQUESTED`, the loop is
   fixer -> shepherd -> re-request maintainer; no cleaner.
   The package's coverage baseline was established at step 6;
   small fix-up changes do not warrant a fresh package-wide
   coverage pass, and dispatching a cleaner during an active
   fixer loop races the next maintainer review and produces
   orphan test commits.
   If a fix-up round significantly expands the diff (a new
   branch, a new file, a reshape across multiple call sites),
   the fixer's brief calls out the cleaner re-dispatch
   explicitly; the default is no re-run.

## Skills

- [`../skills/coverage-driven-testing.md`](../skills/coverage-driven-testing.md):
  the `c8` baseline-and-iterate loop, plus the four "dead code"
  criteria for safe deletion.
- [`../skills/regression-evidence.md`](../skills/regression-evidence.md):
  every new test must fail when its target code path is broken.
- [`../skills/pre-pr-checklist.md`](../skills/pre-pr-checklist.md):
  format / lint / docs / tests run locally before pushing.
- [`../skills/worktree-per-pr.md`](../skills/worktree-per-pr.md):
  isolate the coverage worktree from other in-flight work.
- [`../skills/yarn-lock-separate-commit.md`](../skills/yarn-lock-separate-commit.md):
  any lockfile churn from a new test dependency ships separately.
- [`../skills/em-dash-style-rule.md`](../skills/em-dash-style-rule.md):
  the prose style rule applies to commit messages and PR bodies.
- [`../skills/relative-paths-rule.md`](../skills/relative-paths-rule.md):
  any path you cite in the report or PR body is relative.

## Posture

- One package per engagement. Cross-package sweeps are
  `triager`'s job; the cleaner does deep work on one target.
- **Prefer integration tests through public-API entry points**
  over unit tests against internal helpers. The integration test
  is more realistic, exercises more of the package per assertion,
  and resists drift when internals refactor.
- **Never ship a unit test whose only purpose is to keep
  otherwise-dead code alive.** If the only caller of a function
  is the test you would have to write, delete the function. The
  test is the smell, not the cure.
- Test additions and deletions go in **separate commits** so a
  reviewer can take one without the other.
- Don't write contortion-tests that mock half the dependencies
  to hit one branch. If the code is hard to test, the code has
  the wrong shape; flag it for the `builder` rather than papering
  over it.
- The cleaner does not redesign the package's public API.
  Reachability questions that turn into API questions go to the
  user.
- Coverage is a means, not an end. A clean package at 88% with
  every tested branch meaningfully reachable beats a contorted
  95% kept alive by tests-as-callers.

## Self-improvement

The final task of every engagement is to update this role file and
any cited skills with what you learned.
See [`../skills/self-improvement.md`](../skills/self-improvement.md)
for thresholds and discipline.
A vivid surprise warrants a new pitfall or example.
A pattern across multiple engagements warrants a new rule.
Report the change (or "nothing this time") in your final response.
