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
   (see the root `CLAUDE.md`).

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

**The roadmap is no longer tracked in this repository.** Status, milestones,
size/time estimates, dependency edges, target dates, and the Gantt timeline now
live as state in the **garden journal plan** (the `journal2` branch of
`kriskowal/garden`, under `plan/`), where each design is one record and the
roadmap view is an *aggregation* of those records. The journal is the **single
source of truth**; the narrative in this directory is **mirrored** from the
journal record bodies.

- Per-design source of truth: garden journal `plan/designs/endo-but-for-bots/<slug>.md`
  (frontmatter — `status`, `size`, `milestone`, `depends_on`, `pr`, `target`,
  `created`, `updated` — plus the design narrative in the body).
- Generated aggregate roadmap: garden journal `plan/README.md` (table + Mermaid
  dependency graph + per-milestone rollups; rendered by
  `scripts/jobs/plan/render.sh`, never hand-edited).
- Architecture: `designs/plan-in-journal.md` on `kriskowal/garden` (garden#4).

`designs/README.md` in this directory is a **generated, non-authoritative courtesy
redirect** for human readers browsing the fork — regenerated from the journal
records by `scripts/jobs/plan/render-endo-redirect.sh` on the weekly recalibration
job. **Do not hand-edit it,** and do not hand-maintain a summary table, milestone
tables, or a dependency graph here.

The former **manual synchronization discipline is retired.** You no longer keep a
README summary table in lock-step with each design's metadata, nor file new designs
into milestone tables and the dependency graph by hand. Instead:

- To change a design's status, dates, estimate, milestone, or dependencies, edit
  its **journal record** (`plan/designs/endo-but-for-bots/<slug>.md` on `journal2`);
  the aggregate view and this redirect both recompute.
- Status/PR drift is reconciled automatically by `scripts/jobs/plan/reconcile.sh`
  (the gh merge-detection auto-flip to **Complete**) on the weekly Sunday-evening
  recalibration job; you do not chase status by hand.
- A **new design** is added by creating its journal record (and, for browsing,
  its mirrored narrative file here); the milestone rollup, dependency graph, and
  redirect table all follow from the records.

The **Status** field in each design's metadata table here still documents that
design at a glance, but it is a mirror of the journal record's `status`, not an
independent source — edit the record, not the file's table, to change it.

