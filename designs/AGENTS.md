# Design Document Conventions

## Metadata Table

Every design document begins with a level-1 heading (the title), followed
immediately by a metadata table using this format:

```markdown
# Title

| | |
|---|---|
| **Created** | YYYY-MM-DD |
| **Updated** | YYYY-MM-DD |
| **Author** | Name (prompted) |
| **Status** | Not Started |
```

Required fields: **Created**, **Author**, **Status**.
**Updated** is included when the document has been revised after creation.

Optional fields (used when applicable):
- **Source** — provenance if extracted from another document (e.g., `Extracted from packages/chat/DESIGN.md`).
- **Supersedes** — path to the design this one replaces (e.g., `designs/chat-reply-chain-visualization.md`).

### Author convention

The author field uses the format `Name (prompted)` to indicate the document
was authored by a human directing an LLM.

### Date format

All dates use ISO 8601 (`YYYY-MM-DD`). Update the **Updated** field whenever
the document is materially revised.

## Status Values

| Status | Meaning |
|--------|---------|
| Not Started | Design written, no implementation work begun |
| Proposed | Design under discussion, not yet accepted |
| In Progress | Implementation underway |
| **Complete** | Fully implemented (bolded) |
| Implemented | Synonym for Complete (some docs use this) |
| Active | Living document, continuously maintained |
| Reference | Informational; not an implementation target |
| Deprecated | Superseded by another design |

Complete/Implemented status is sometimes bolded (`**Complete**`) for visual
emphasis in the metadata table and in the README summary table.

## Document Structure

After the metadata table, documents follow this general structure:

1. **Status section** (optional) — a prose `## Status` section appears after
   the metadata table in documents that have been partially or fully
   implemented. It lists what has been built, file paths, and any deviations
   from the original design.

2. **Problem statement** — typically `## What is the Problem Being Solved?`
   or `## Motivation`. Explains why the work is needed.

3. **Design** — the main body. Uses subsections, tables, and code blocks
   as needed. Code examples use the project's Hardened JavaScript conventions
   (see the root `AGENTS.md`).

4. **Dependencies** — table of related designs and their relationship.

5. **Phased implementation** — numbered phases when the work can be
   delivered incrementally.

6. **Design Decisions** — numbered list of key choices and their rationale.

7. **Known Gaps and TODOs** — checklist items (`- [ ]`) for remaining work.
   Used sparingly; most documents do not have open checklists.

Not every document uses all sections. Simpler designs may omit phases,
dependencies, or gaps.

### Capturing the prompt

Each design document should include the prompt that was used to generate it,
typically as a blockquote or fenced block at the end of the document under
a `## Prompt` heading. This preserves the intent and context behind the
design for future readers.

## Progress Tracking

Progress is tracked at two levels:

### Per-document

- The **Status** field in the metadata table is the primary indicator.
- The optional `## Status` prose section provides implementation details:
  file paths built, design deviations, and what remains.

### Cross-document

- `designs/README.md` maintains a summary table of all designs with
  Created, Updated, and Status columns.
- The README also contains a Mermaid dependency graph, milestone tables
  with exit criteria, size/time estimates calibrated against observed
  velocity, and a Gantt timeline.
- **Any modification to a design document — especially its metadata —
  must be synchronized with `designs/README.md`.** Update the summary
  table row to reflect the current Status, Updated date, and any other
  changed fields.
- **New designs must be incorporated into the README plan.** This means:
  adding a row to the summary table, assigning the design to a milestone,
  adding it to the appropriate milestone table, inserting it into the
  dependency graph if it has dependencies or dependents, adding a
  per-design size/duration estimate, and updating the milestone totals
  and timeline if the new work changes the critical path.

## Archiving Completed Milestones

`designs/README.md` is a working document; it should describe the work
that is still ahead, not carry the full weight of everything already
delivered. When an entire milestone is done, move it out of the README
into `designs/ARCHIVE.md` so the working plan stays short.

### When a milestone qualifies

A milestone is archivable when **both** hold:

1. **Every design in the milestone is landed** — its Status is
   `Complete`, `Implemented`, or an equivalent terminal state (a
   `Deprecated`/`Superseded` row whose successor has itself landed does
   not block archiving; a `Reference` row that was only ever
   informational does not block it either).
2. **The milestone's exit criterion is met** — the prose exit criterion
   in the milestone section is satisfied in the shipped product, not
   merely on paper.

Do not archive a milestone with any `Not Started`, `Proposed`, `In
Progress`, or `Active` design still open. A milestone that is *mostly*
complete stays in the README; archiving is all-or-nothing per milestone.

### Where it goes and what stays behind

- **Move** the entire milestone section — goal, design table, exit
  criterion, and actual duration — into `designs/ARCHIVE.md`. The archive
  entry must stand alone: a reader should be able to understand what the
  milestone delivered without opening the README. Preserve the milestone
  number and title as its archive heading.
- **Leave behind** in `designs/README.md`, where the milestone section
  used to be, a single one-line pointer of the form:
  `#### Milestone N: <Title> — **Complete**; archived to [ARCHIVE.md](ARCHIVE.md).`
  This keeps the milestone numbering contiguous and tells the next reader
  where the detail went.
- The archived milestone's designs **remain rows in the README summary
  table** (the table is the whole-corpus index, and their `Complete`
  status is still true); only the milestone *section* and its
  per-milestone estimate/timeline rows move. Note in the summary that
  those designs are archived.

### Archive ordering

`designs/ARCHIVE.md` is ordered by milestone number (M1 first). Newly
archived milestones append in number order, so the archive reads as the
delivery history in the same sequence the README once presented it.
