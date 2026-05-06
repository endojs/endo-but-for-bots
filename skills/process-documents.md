# Process documents and process commits

## What is a process document

A process document is artifact-of-the-work, not artifact-of-the-product:

- Audit reports (TODO scan, rebase-hygiene audit, PR coverage map).
- Gap reports (designs without an in-flight PR, issues whose
  implementation has already landed, agent-ready item lists).
- Snapshot reports (status of in-flight PRs at a moment in time).
- Decision logs and open-question notes
  (`process/GROOM-OPEN-QUESTIONS.md`, dispatch summaries).
- Curated work-handoff lists between user and agent.

Process documents are **for the conversation between the user and
the agents**, not for the codebase.
They describe how the work was done, who decided what, and what
remains.

## Where they live

`process/` at the triage root.
One file per report, named for the report's subject in
`kebab-case.md` or `SCREAMING-CASE.md` (legacy reports keep their
original casing).
Subdirectories are allowed when reports cluster (`process/audits/`,
`process/handoffs/`).
A `process/README.md` indexes the current set with a one-line
description per file.

## The isolation rule

**Process commits are isolated**: a commit either contains only
`process/` changes (plus possibly the index update), or it contains
no `process/` changes at all.
Never mix.

The reason: when a maintainer ports work from this triage repo (or
from `endojs/endo-but-for-bots`) to upstream `endojs/endo`, the
process commits should drop cleanly.
A maintainer running

```sh
git log --oneline upstream/master..triage \
  | grep -v '^[a-f0-9]\+ process'
```

should see exactly the substantive commits worth porting.
Mixing process and substance pollutes the upstream history with
artifacts that have no value there.

## Commit-message convention

Process commits use the prefix `process` (no scope) or
`process(<role>)` when the document was produced by a specific
role:

- `process: TRIAGE.md snapshot 2026-04-26`
- `process(triager): agent-ready issues report`
- `process(groom): designs-without-pr gap report`
- `process(shepherd): PR-rebase audit on bots`

The prefix makes process commits trivially `grep`-able by porting
scripts.

## When to write a process document

Roles that habitually produce process documents:

- `triager` — classification reports.
- `investigator` — hygiene scans.
- `shepherd` — multi-PR snapshots.
- `groom` — open-question logs and roadmap snapshots.
- `steward` — dispatch summaries and cycle logs.

A role that does *not* produce a process document should not write
one. The product is the deliverable (the PR, the design, the
benchmark comment); the process document is supplementary.

## What does **not** belong in `process/`

- **Source code or tests.** Those go in `packages/`.
- **Design documents.** Those go in `designs/`. A design's
  per-instance status table is part of the design, not a process
  doc.
- **Role and skill files.** Those go in `roles/` and `skills/`.
  Process documents reference roles and skills, but never live in
  their directories.
- **PR descriptions or comments.** Those live on the PR. Quote
  them in a process document if needed for context, but the
  authority is the PR itself.
- **Anything that would be confusing to a maintainer porting
  upstream.** If the file would make a reviewer ask "why is this
  in our history?", it is process.

## Pitfalls

- **Forgetting the isolation rule.** A `git add -A` followed by a
  commit message about substantive work silently captures any
  modified process file. Always `git status` before staging and
  stage selectively.
- **Process documents that describe themselves.** A snapshot of
  the current process system is itself process. The
  `process/README.md` index is process; this skill is not (it
  belongs in `skills/`, not `process/`, because it is a reusable
  technique).
- **Cross-cutting commits during refactors.** When a process
  document gets a structural overhaul that also moves
  authoritative content into a non-process location (e.g.
  promoting a decision-log entry into `designs/CLAUDE.md`), make
  the move in two commits: the substantive promotion first, then
  the process cleanup.
- **Stale snapshots.** A report dated 2026-04-26 that hasn't been
  updated by 2026-09-01 is misleading. Either refresh, mark
  superseded with a one-line header, or move to
  `process/archive/`.
