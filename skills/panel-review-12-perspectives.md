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

## Session examples

Used four times: PR 67 (harden-exports destructuring), PR 60
(get-intrinsics test), PR 76 (mirror of upstream
`endojs/endo#3053` for in-organization review), and PR 29
(`@endo/syrups` sibling-of-netstring). All produced substantive
must-fix lists. The fourth surfaced the sibling-fork-misses-peer-fix
pitfall above.
