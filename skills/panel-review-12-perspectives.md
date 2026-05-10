# Panel review with twelve perspectives

## When to use

When a PR is large or important enough that a single reviewer's lens
would miss something, dispatch a panel of reviewers each operating
from one canonical perspective. Aggregate their findings into a
single must-fix / should-fix / out-of-scope report.

## The twelve canonical perspectives

Pick from this menu, dropping or substituting a slot for any
perspective genuinely not applicable to the change:

1. Correctness
2. Test coverage
3. TypeScript / type-system enforcement
4. API stability / breaking-change accuracy
5. Diff hygiene (unrelated files, stray fixups)
6. Error-message quality
7. Performance
8. Naming and prose (style guide compliance)
9. Changeset accuracy and severity
10. Backwards compatibility (existing-user impact)
11. Documentation / metadata (README, rule index, changelog)
12. Security / capability surface
13. Adversarial / saboteur — runs the
    [`adversarial-tests.md`](./adversarial-tests.md) brainstorming
    list and the
    [`saboteur-adversarial-review.md`](./saboteur-adversarial-review.md)
    pattern catalog against the diff, surfacing concrete attack
    vectors with verdicts (real concern / mitigated / out of scope).
    The deliverable is review findings, not test files; the
    test-writing variant lives in [`../roles/saboteur.md`](../roles/saboteur.md)
    and is dispatched separately when explicitly asked. The
    adversarial juror folds into the same single panel verdict as
    the other twelve, so the steward's hand-off is one fixer
    dispatch, not two parallel ones. Per maintainer direction
    2026-05-07: "fold the saboteur into the jury, as one of the
    assigned juror roles, then it is straight forward to
    synchronize a verdict and hand off to a fixer."

For specific kinds of PRs, swap in:

- Tests: realm-state, reference-derivation independence,
  failure-mode legibility, regression-evidence verification.
- Refactors: migration story, OCapN/marshal-spec conformance, test
  determinism, commit-history reviewability.
- Lint rules: lint-rule meta (registration, README), monorepo
  sweep result.

## How

If the orchestrator has Agent tool access, dispatch 12 sub-subagents
in parallel via a single tool call. If the Agent tool is not exposed
(this happened twice in the session), simulate the panel: read the
diff once, then write twelve separate review blocks each from one
perspective.

**When the PR bundles N independent capabilities** (e.g., PR 40
shipped scheduler + HTTP client + webhook + TickResponse in one
diff), elevate **diff hygiene** from the standard slot to a
load-bearing perspective with `request-changes` posture by default.
The bundling itself becomes the strongest finding; without an
elevated diff-hygiene lens, the panel will produce N lists of
substantive code findings while missing the meta-finding that the
PR should not have been a single PR. The split-recommendation is
then the panel's anchor; per-capability findings hang from it.

Either way, each reviewer returns:

```
### Reviewer N — <perspective name>

**Verdict:** approve / request-changes / comment-only

**Findings:**
- (concrete actionable, file:line where applicable)

**Notes (out of scope but worth flagging):**
- …
```

Each block under 400 words. "Comment-only" is for taste; anything
that warrants a code change is "request-changes".

## Aggregation

Group findings into:

- **Must fix before merge** (any "request-changes" with concrete
  code/test/doc impact).
- **Should fix in this PR** (taste/clarity items raised
  independently by ≥2 reviewers).
- **Out of scope / follow-up** (useful but not blocking).

Dedupe overlapping findings. Where reviewers disagree, present both
views and pick the side most consistent with `CLAUDE.md` /
`AGENTS.md`.

## Posting and dispatching the fixer

**Submit the aggregated report as a formal review, not a plain
comment.** A plain `gh pr comment` posts a comment that the
steward's dispatch matrix (which keys on `reviewDecision`) does
not see; the PR ends up reviewed-but-invisible-to-orchestration.
Use `gh pr review` so `reviewDecision` flips and the fixer
trigger fires:

```sh
gh pr review <N> -R <repo> --request-changes --body-file /tmp/panel.md
# OR if must-fix is empty but should-fix has items:
gh pr review <N> -R <repo> --comment --body-file /tmp/panel.md
# OR if the panel net-approves:
gh pr review <N> -R <repo> --approve --body-file /tmp/panel.md
```

The body is the same aggregated under-700-words report. Cite
reviewers by perspective grouped where they agreed; don't list
individual agent names.

**After submitting the review, dispatch a fixer with the must-fix
list inline as the brief**, if any must-fix items exist. The
panel's whole point is independent review; the orchestrator (the
builder for fresh PRs, the steward for cold ones) hands the
verdict to a fixer rather than doubling back on its own work.
The fixer brief includes the must-fix items inline, not just a
link to the review, so the fixer doesn't re-parse comment markup.

The chain is: dispatch panel → aggregate → submit as formal
review → dispatch fixer. Skipping the formal-review step strands
the PR (no orchestration trigger fires); skipping the fixer
dispatch strands the verdict (no agent picks it up).

## Pitfall: panel-report prose is not exempt from the project style rules

The aggregated panel report is markdown that ships in a public PR
review. The same prose rules apply as everywhere else in the repo:
no em-dashes (per [`em-dash-style-rule.md`](./em-dash-style-rule.md)),
no methodology leaks (per
[`pre-pr-checklist.md`](./pre-pr-checklist.md)). The temptation to
write the report quickly with em-dash parentheticals is real because
the writer thinks of it as ephemeral commentary; it is not. Sweep the
panel body for `—` before submitting.

Encountered on PR 106 (endoclaw-browser builder), where the panel
report shipped with several em-dashes that the builder's own source
files and PR body had carefully avoided. The PR review body is
non-revisable in practice (you can edit it but the original lands in
the timeline first), so this is a "before-submit" sweep, not an
after-submit fix.

## Pitfall: a "shadow" finding may be a panel hallucination

Variable-shadowing claims by the TypeScript or naming juror need a
30-second sanity check before promoting them to a should-fix item:
literally re-read the offending lines and confirm they are in the
same lexical scope. A panel run that reads the diff once can mis-name
a parameter as shadowing an outer const that lives in a different
function. Panel findings are independent reviewer outputs; treating
them as ground truth without a quick scope check leads to
make-work fixer dispatches that the fixer correctly refuses.

Encountered on PR 106 where Reviewer 3 flagged
`closures.map(closer => closer.close())` (inside `revoke`) as
shadowing an outer `const closer = harden(...)` (inside `makePage`).
The two scopes are disjoint; there is no shadow. The builder caught
this before dispatching the fixer; if the panel had auto-dispatched,
the fixer would have either refused the change or surfaced an
embarrassing no-op commit.

## Pitfall: sibling-package forks miss recent peer fixes

When a PR introduces a package by forking an existing peer (e.g.
`@endo/syrups` from `@endo/netstring`), check the peer's `git log`
for fixes that landed *between* the fork point and the PR's
submission. The correctness juror should `git log -p
packages/<peer>/<file>` over the last 30 days and diff against the
new sibling. PR 29 shipped without a per-chunk-promise rejection
handler that had landed in `@endo/netstring/writer.js` 3 days before
the rename PR pushed; the original fork predated the peer fix and
the rename did not pick it up. This is a one-line check that pays
for itself on every sibling-fork PR.

## Pitfall: GitHub blocks `--request-changes` on your own PR

`gh pr review <N> --request-changes` returns a GraphQL error
("Can not request changes on your own pull request") when the
authenticated user is also the PR author. This is a GitHub-enforced
constraint, not a permissions issue. Because the bots-mirror flow
has a single bot identity authoring both the PR and the panel
review, this triggers on every panel run on a bot-authored PR.

Fall back to `--comment` with the full aggregated body (must-fix
items still listed under the must-fix heading). The panel verdict
is preserved in the body; the difference is only that
`reviewDecision` does not flip to `CHANGES_REQUESTED`. The
steward's dispatch matrix that keys on `reviewDecision` will need
to also key on the body content (e.g., the "Must-fix before merge"
heading) for bot-authored PRs.

Encountered on PR 170 (pass-style promise + HandledPromise.settle):
the panel ran cleanly, the body was 8 must-fix and 2 should-fix
items, and the submission failed on `--request-changes`. Resubmitted
as `--comment` with the same body; verdict is in the body, not in
the GitHub state.

## Pitfall: design+implementation in one PR needs a design-assessment posture

When a PR implements all phases of a design as a single deliverable
explicitly to assess the design's completeness (rather than for
staged landing), the panel's job grows beyond "is this code
correct" to include "did the design specify enough to implement,
and where did the builder fill in gaps the design did not anticipate?"

The builder's report on such a PR typically includes a list of
"design gaps I had to invent answers for." Treat each one as a
load-bearing input to the panel: every juror whose perspective
applies should explicitly verdict each gap question. The aggregate
body should carry an "Out of scope but worth flagging (design
feedback)" section listing the panel's answers, intended as input
back to the design PR rather than as fixer-brief items.

Two failure modes if the panel skips this:
- The fixer brief over-collects design-question items as code
  must-fixes, generating make-work changes that the design has not
  actually committed to.
- The design PR misses panel-relevant feedback and lands without
  the gaps surfaced.

Encountered on PR 170 (pass-style promise design at #169 implemented
in one PR per maintainer directive). The six builder-flagged gaps
included the package-boundary question (Q1: should the carrier
shape live in a third package?) and the SES permits question (Q5:
should the design have called out the permits requirement?). Both
are design-relevant but neither is a code change on this PR; the
panel report split them cleanly into the design-feedback section.

## Session examples

Used five times: PR 67 (harden-exports destructuring), PR 60
(get-intrinsics test), PR 76 (mirror of upstream
`endojs/endo#3053` for in-organization review), PR 29
(`@endo/syrups` sibling-of-netstring), and PR 170 (pass-style
promise + HandledPromise.settle). All produced substantive
must-fix lists. The fourth surfaced the sibling-fork-misses-peer-fix
pitfall above. PR 106 (endoclaw-browser greenfield) surfaced both
the panel-prose-em-dash and the false-shadow pitfalls above. PR 170
surfaced the own-PR `--request-changes` block and the
design-assessment-posture pitfall above.
