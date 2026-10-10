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
| Redirected | The implementation continues under a named successor design or PR |
| Consolidated | The scope was absorbed into a named broader design rather than shipping standalone |
| Superseded | A later design or landed change makes this design moot; the successor must be named |
| Abandoned | No successor, landed implementation, or open implementation PR remains |

Complete/Implemented status is sometimes bolded (`**Complete**`) for visual
emphasis in the metadata table and in the README summary table.

`Redirected`, `Consolidated`, `Superseded`, and `Abandoned` are dispositions,
not synonyms for inactivity. A document using one of them must name the
successor, consolidating design, or evidence for abandonment in its Status
section. Do not leave a design as `Not Started` merely because its original PR
closed: check for replacement PRs, renamed packages, and broader designs first.

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
- The inventory for a full reconciliation is every Markdown file matched by
  `designs/*.md` and `packages/*/designs/*.md`. Ledger/support files
  (`README.md`, `ARCHIVE.md`, `AGENTS.md`, compatibility pointers, and package
  design-directory indexes) are recorded as explicit exclusions rather than
  silently disappearing from the count. Nested research records already
  indexed by the summary remain counted and are called out separately from the
  two glob populations.
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
- **A full grooming pass verifies every indexed record and every untallied
  corpus file against current PR and branch state.** Split the corpus into
  recorded, disjoint batches. For each design, inspect its status prose, search
  all PR states by slug and title, and check the roadmap-branch log when a PR
  alone does not prove that work landed. The pass records a claimed-to-verified
  drift table with PR or commit citations for every correction, names all
  redirects/supersessions/consolidations/abandonments, and states how many
  unchanged rows were confirmed.
- **Totals are re-derived, never incremented from the preceding prose count.**
  Fold only the current summary-table Status cells into the documented status
  vocabulary, report any deliberately qualified partial statuses separately,
  and verify that the bucket sum equals the number of summary rows. Also report
  the raw corpus-file count and explicit exclusions so a row tally cannot be
  mistaken for a tree walk.
- A full pass also re-fits review/merge velocity from dated PR evidence,
  reprojects milestone dates, checks the milestone dependency-order invariant,
  regenerates and parses the Mermaid dependency graph, and archives a milestone
  only when every implementation row in it is complete or a non-implementation
  reference/disposition.
