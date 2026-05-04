# Process documents

Process documents are artifact-of-the-work, not artifact-of-the-
product: audit reports, gap reports, snapshots, open-question
logs, work-handoff lists.
They describe how the work was done; they are for the
conversation between the user and the agents.

For the rules on what counts as a process document, where to put
new ones, and the isolation-commit discipline, see
[`../skills/process-documents.md`](../skills/process-documents.md).

## Current contents

| File | Type | Authored by | Snapshot date |
| --- | --- | --- | --- |
| [`AGENT-READY-ISSUES.md`](./AGENT-READY-ISSUES.md) | Curated handoff list | triager | 2026-04-28 |
| [`DESIGNS-WITHOUT-PR.md`](./DESIGNS-WITHOUT-PR.md) | Gap report | triager (designs annotation pass) | 2026-05-01 |
| [`PR-CYCLE-LOG.md`](./PR-CYCLE-LOG.md) | Append-only cycle log | steward | rolling |
| [`PR-DISPATCH-STATE.md`](./PR-DISPATCH-STATE.md) | Per-cycle PR snapshot | steward | rewritten each cycle |
| [`PR-REBASE-AUDIT.md`](./PR-REBASE-AUDIT.md) | Audit report | shepherd | 2026-04-30 |
| [`TRIAGE.md`](./TRIAGE.md) | Triage snapshot (open issues + open PRs) | triager | 2026-04-26 |
| [`UNLINKED-TODOS.md`](./UNLINKED-TODOS.md) | Hygiene scan + proposed-issue draft | investigator | 2026-05-01 |

## Conventions

- Process commits are isolated (only `process/` changes per commit,
  plus possibly this index). They drop cleanly when a maintainer
  ports work upstream.
- Commit messages start with `process:` or `process(<role>):`.
- Each new file should be added to the table above in the same
  process commit that introduces it.
- A snapshot that has been superseded gets a one-line header
  (`> Superseded by <newer file> on <date>.`) rather than being
  deleted; the audit trail is useful when the same question
  recurs.
