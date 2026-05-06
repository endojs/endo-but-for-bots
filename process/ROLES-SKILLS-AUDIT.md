# Roles and skills editorial audit

Date: 2026-05-04.
Scope: bring `roles/*.md` and `skills/*.md` into alignment with
the trigger-and-filter convention (`skills/README.md`), the PR
body discipline (`skills/pre-pr-checklist.md`), the closed-PR
and Claude-attribution rules (`CLAUDE.md`), and the em-dash
prose rule (`skills/em-dash-style-rule.md`).

This pass is editorial, not a rewrite.
The engagement was capped at eight substantive commits to keep
the work focused; broader systemic findings are recorded here
for a follow-up dispatch.

## Pass 1: trigger-and-filter compliance

### Roles whose `## Skills` list lacks per-skill trigger lines

These role files list their cited skills as bare paths or with
only a noun-fragment tag, leaving the reader no signal about
when to follow the link.
The convention (parent overbroad, child filter-narrow) wants a
one-sentence trigger per cited skill.

- `roles/cleaner.md`: bare list of seven skill paths, no trigger
  lines. Fixed in this engagement.
- `roles/saboteur.md`: bare list of five skill paths, no trigger
  lines. Fixed in this engagement.
- `roles/stratego.md`: skill list uses noun-fragment tags
  ("the per-commit `git log` recipes...") rather than trigger
  lines. Fixed in this engagement.
- `roles/groom.md`: skill list mostly bare (one entry has the
  em-dash continuation). Fixed in this engagement.

### Roles whose `## Skills` list already follows the convention

`builder`, `conductor`, `designer`, `fixer`, `investigator`,
`juror`, `maestro`, `scout`, `shepherd`, `steward`, `triager`,
`weaver` all carry per-skill trigger lines.

### Skill files that lead with an explicit trigger

Most skills lead with `## When to use`, `## Trigger`,
`## Triggers`, `## The rule`, `## Principle`, or `## The
error`. All work as triggers; the variation in heading is
cosmetic.

`pre-pr-checklist.md` previously opened with `## The minimum`
(no trigger heading). Fixed in this engagement: a `## Trigger`
section now leads, explicitly covering both `gh pr create` and
`gh pr edit --body` paths.

### Skills that have accreted unrelated pitfalls

The exemplar refactor was `review-feedback-followup-commits.md`,
which extracted `verify-upstream-state-before-pinning.md` and
`package-rename-cascade.md` as focused siblings.

No other skill currently shows the same accretion symptom.
`shepherd.md`'s `## Recurring patterns` section is a near-miss
(four pitfalls of distinct shapes), but it lives in a role file
where the inlining is appropriate; the candidates that would
extract cleanly are the dependabot-Prettier and unmasked-second-
failure entries, both of which are CI-shepherding-specific. Not
fixed; not flagged either.

## Pass 2: PR-body discipline

- No `Co-Authored-By: Claude` strings in any role or skill file.
- No example PR bodies cite `skills/<file>.md` or
  `roles/<file>.md` paths.
- The only example PR body content is in
  `skills/pr-mirror-for-offline-review.md`, which describes the
  mirror PR substance (upstream PR number, author handle,
  reviewer instructions). No methodology leak.

No commits required for this pass.

## Pass 3: closed-PR and Claude-workflow rules

- `roles/steward.md` already restates the closed-PR rule
  ("dispatches only against PRs whose `state` is `OPEN`",
  lines 60-65). No other role gives an example that would act
  on a closed PR or issue.
- No role or skill includes an example involving a
  `.github/workflows/claude*.yml` file.

No commits required for this pass.

## Pass 4: em-dashes in prose

The em-dash audit splits into three populations:

### Legitimate uses (do not sweep)

- Skill-list separators in `roles/README.md` and
  `skills/README.md`. Pre-existing convention; out of scope per
  the engagement brief.
- Role files that mirror the convention in their own `## Skills`
  list (builder, designer, fixer, investigator, juror, maestro,
  namer, scout, shepherd, triager, weaver). The dash separates
  the link target from a one-line trigger; replacing it with a
  colon would be the cleaner long-term shape but is too large a
  diff for an alignment audit.
- Em-dashes inside code formatting: `roles/steward.md` line 239
  (`grep "—"` literal), `skills/em-dash-style-rule.md`'s entire
  body (the rule references the character).

### Em-dashes in role-file intro prose

Recently-added intro paragraphs that snuck the character past
the rule:

- `roles/builder.md` line 3
- `roles/cleaner.md` lines 34, 36, 39
- `roles/designer.md` line 4
- `roles/groom.md` lines 19, 121, 122
- `roles/investigator.md` lines 3, 5
- `roles/juror.md` line 3
- `roles/namer.md` line 3 (intro), line 84 (skill list)
- `roles/scout.md` lines 3, 4

These are the load-bearing fixes in this engagement.

### Em-dashes in skill-file prose (systemic)

Pervasive across the skill corpus:
`benchmark-comparative-report.md`, `pr-mirror-for-offline-review.md`,
`rebase-hygiene-audit.md`, `pre-pr-checklist.md`,
`groom-open-questions.md`, `self-improvement.md`,
`conflict-resolution.md`, `panel-review-12-perspectives.md`,
`adversarial-tests.md`, `todo-link-classification.md`,
`coverage-driven-testing.md`, `process-documents.md`,
`babel-visitor-exhaustiveness.md`, `prompt-section-discovery.md`,
`dependency-graph-maintenance.md`.

Sweeping all of these exceeds the eight-commit cap.
Flagged for a follow-up dispatch dedicated to the em-dash sweep
across the skill corpus; the substitution choices (period vs.
parens vs. colon) are per-sentence judgment calls and reading
the prose is the load-bearing step.

## Cross-cutting observations

### Heading convention drift

Skill files use any of `## When to use`, `## Trigger`,
`## Triggers`, `## When`, `## The rule`, `## Principle`, etc.
to introduce the trigger.
A future pass could standardize on `## Trigger` (singular) per
the recently-trimmed exemplars
`review-feedback-followup-commits.md`,
`verify-upstream-state-before-pinning.md`, and
`package-rename-cascade.md`.

### Self-improvement boilerplate

Every role file ends with the same six-line "Self-improvement"
paragraph that repeats `skills/self-improvement.md`'s contract.
The repetition is fine when the role is read in isolation, but
every role-file edit reverberates through fifteen identical
copies.
A future pass could replace the per-role boilerplate with a
single short pointer at the canonical skill, paid for once at
the index.

### `roles/README.md` vs. `CLAUDE.md` role index

The two indexes drift because both restate the role list with
trigger lines.
The `CLAUDE.md` index is curated by the user directly per the
engagement brief.
A future pass could collapse one into the other (e.g., `CLAUDE.md`
points at `roles/README.md` for the trigger lines and only lists
the names) so role additions edit one file, not two.

## Commits this engagement

See git log for SHAs.
The engagement landed below the eight-commit cap and recorded
the systemic findings here for the user to dispatch a follow-up.
