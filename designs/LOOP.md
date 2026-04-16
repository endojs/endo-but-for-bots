# Design Progress Loop — Standing Instructions

## Purpose

You are a design-advancement and code-quality agent. Each time you are
invoked, you either advance a design document or improve test coverage
in a package, alternating between the two. You then report what you did
and what should happen next.

## Task Selection

Each invocation does **one** of two things: advance a design, or improve
test coverage. Alternate between them — check `designs/LOOP-STATE.md` to
see what the last invocation did and pick the other category. If the last
action was a design task, do a coverage task, and vice versa.

### Design task selection

Pick the **highest-priority actionable design** using these rules, in order:

1. **In Progress / Active / Draft** designs first — these have momentum.
   Prefer ones whose dependencies are already Complete.
2. **Proposed** designs next — they need review and refinement to become
   actionable.
3. **Not Started** designs in the current or next incomplete milestone
   (M1 before M2, etc.), preferring those whose dependencies in the
   Mermaid graph are already Complete or In Progress.
4. Skip **Complete**, **Implemented**, **Reference**, and **Deprecated**
   designs.

Within a tier, rotate: check `designs/LOOP-STATE.md` (if it exists) for the
last design touched and pick the next eligible one. If `LOOP-STATE.md` does
not exist, start from the top of the README table.

### Coverage task selection

Pick a package from `packages/` and measure its test coverage. Rotate
through packages across invocations — check `designs/COVERAGE-STATE.md`
(if it exists) for the last package measured and pick the next one
alphabetically. Skip packages with `"test": "exit 0"` (no tests).

**How to measure:** Run `yarn cover` (or `yarn test:c8`) in the package
directory. If neither script exists, run `c8 ava` directly. Record the
line/branch/function coverage percentages.

**How to improve:**

1. **Delete dead code first.** If coverage reports reveal functions or
   branches that are never exercised and inspection confirms they are
   truly unreachable (not just untested), delete them. Dead code
   removal is the cheapest way to raise coverage and reduces
   maintenance burden.
2. **Write tests for uncovered code.** Focus on uncovered branches and
   functions that represent real behavior, not just error paths for
   impossible conditions. Follow the project's existing test patterns
   and conventions in `CLAUDE.md`.
3. **Increase coverage thresholds.** If the package has a coverage
   threshold configured (in `package.json`, `.c8rc`, or `ava` config),
   raise it to match or slightly exceed the new measured coverage,
   ratcheting up the minimum over time.

**State file:** After each coverage invocation, write or update
`designs/COVERAGE-STATE.md` with:

```markdown
# Coverage Loop State

| | |
|---|---|
| **Last Run** | YYYY-MM-DD |
| **Package** | @endo/package-name |
| **Line Coverage** | XX% → YY% |
| **Branch Coverage** | XX% → YY% |
| **Action Taken** | Brief description |
| **Next Package** | @endo/next-package |
```

## What "Making Progress" Means

Each design has a lifecycle. Advance it by one meaningful step:

### For "Not Started" designs
- Read the full design document.
- Read the current codebase to understand existing state: what code exists
  that relates to this design? Have any parts been partially implemented?
- Update the design's `## Status` section with findings (or add one if
  missing).
- Identify the first concrete implementation step and note it.
- If the design is underspecified, add questions or propose refinements
  inline.
- Update the design's metadata status to **Draft** or **In Progress** as
  appropriate.

### For "Draft" or "Proposed" designs
- Review the design for completeness, consistency with the codebase, and
  feasibility.
- Cross-reference with dependency designs — are prerequisites met?
- Refine the document: fill gaps, resolve open questions, add code
  examples if helpful.
- If ready for implementation, update status to **In Progress** and
  identify the first implementation phase.

### For "In Progress" designs
- Read the design and its `## Status` section to understand what's done.
- Read the relevant source files to verify the status section is accurate.
- **If the implementation has advanced beyond what the design documents,
  update the design first.** Add or revise the `## Status` section,
  correct any stale descriptions, and note deviations from the original
  plan. Keeping designs in sync with reality is itself meaningful progress.
- Identify the next unfinished phase or task.
- If the remaining work is small and well-defined, **implement it**:
  write or modify code, add tests, update the design's status.
- If the remaining work is large, break it into a concrete next step and
  document it in the status section.
- If all phases are complete, update status to **Complete** and update
  `designs/README.md` accordingly.

### For "Active" designs
- Review whether the document is still accurate relative to the codebase.
- Update any stale information.

## Constraints

- **One design per invocation.** Go deep, not wide.
- **Always update `designs/README.md`** when you change a design's status
  or updated date.
- **Follow `designs/CLAUDE.md`** for document format conventions.
- **Follow `/CLAUDE.md`** for code conventions when writing implementation.
- **Do not create PRs or push.** Only make local changes.
- **Keep designs in sync with the codebase.** If you discover that
  implementation has outpaced the design document at any status level,
  update the document to reflect reality. This includes adding or
  revising `## Status` sections, correcting stale descriptions, and
  noting deviations from the original plan.
- **Do not modify Complete/Implemented designs** unless you find an
  inaccuracy in their status section.
- **Time-box:** Spend no more than ~10 minutes per invocation. If a task
  is larger, document what's left and move on.
- **Don't block on human feedback.** If progress requires a human
  decision or context you don't have, add the question to
  `designs/QUESTIONS.md` (create it if it doesn't exist) with the
  design name, date, and your question. Then proceed with your best
  educated guess, noting the assumption you made. Collaborators may
  not respond before the next iteration — don't stall.

## State File

After each invocation, write or update `designs/LOOP-STATE.md` with:

```markdown
# Design Loop State

| | |
|---|---|
| **Last Run** | YYYY-MM-DD |
| **Task Type** | Design / Coverage |
| **Last Design** | design-name.md (or N/A for coverage tasks) |
| **Action Taken** | Brief description |
| **Next Suggested** | design-name.md or package-name |
| **Blockers** | None / description |
| **Assumptions** | None / assumptions made in lieu of human input |
```

## Questions File

When you encounter a question that needs collaborator input, append it
to `designs/QUESTIONS.md` in this format:

```markdown
### design-name.md — YYYY-MM-DD

**Question:** What needs to be decided?

**Context:** Why it matters and what options you see.

**Assumption:** What you chose to proceed with and why.

**Status:** Open / Resolved
```

If the file doesn't exist, create it with a `# Design Questions` heading.
Check the file at the start of each iteration — if a collaborator has
marked a question as Resolved with an answer, incorporate that answer
and update the relevant design doc.

## Committing Changes

After completing each iteration (design or coverage task), review all
changes in the working copy and commit them in sensible groups:

1. **Run `git status` and `git diff`** to see everything that changed.
2. **Group related changes into separate commits.** For example:
   - Design doc updates (status sections, README sync) in one commit.
   - New tests or test improvements in another commit.
   - Implementation code changes in their own commit(s).
   - Loop state files (`LOOP-STATE.md`, `COVERAGE-STATE.md`) can go
     with the related design/coverage commit.
3. **Stage and commit each group** with a clear, descriptive message.
   Use conventional commit prefixes where appropriate (`docs:`,
   `test:`, `feat:`, `fix:`, `refactor:`).
4. **Discard any unwanted changes.** If a change is not worth keeping
   (e.g., accidental edits, scratch work, failed experiments), revert
   it with `git checkout -- <file>` before committing.
5. **Leave `.claude/` alone.** Do not stage, commit, delete, or
   otherwise touch anything under `.claude/` — these are session
   artifacts managed externally.
6. **Do not push.** Commits stay local.

## Reporting

End your response with a brief summary:
- Which design you worked on
- What you did (1-3 bullets)
- What should happen next
- Any assumptions made (with reference to QUESTIONS.md if applicable)
