# Roadmap projection from current pace

## When to use

After velocity is recalibrated (see
[`velocity-recalibration.md`](./velocity-recalibration.md)), regenerate
the milestone totals, the Mermaid Gantt, and the target dates in
`designs/README.md` § Timeline so they reflect the latest pace.

## Inputs

- The recalibrated S/M/L/XL bucket durations (from velocity
  recalibration).
- The "Per-Design Estimates" table in
  `designs/README.md` § "Size and Time Estimates".
- The current set of in-flight, in-progress, and completed designs
  (Status column of the summary table).
- Today's date.

## Procedure

1. **Refresh per-design status**, not estimates. For each design,
   check the README summary table against the design file's
   metadata block; reconcile any drift before projecting. (See the
   sibling skill on annotation reconciliation.)
2. **Re-sum each milestone.** Add the post-recalibration durations
   for each remaining design in the milestone, accounting for
   in-progress designs at half-credit unless evidence says
   otherwise. Output as `<low>-<high> weeks` matching the existing
   "Total Estimate (1 dev, serial)" column.
3. **Update the Mermaid Gantt.**
   - The completed milestones get a `:done,` marker with the actual
     `<start>, <end>` dates (use the earliest Created and the
     latest completed Updated date among that milestone's designs).
   - Each in-progress milestone uses `2026-MM-DD, <weeks>w` with
     `<weeks>` taken from the new total.
   - Subsequent milestones use `after mN, <weeks>w` so the chain
     re-flows automatically when an upstream milestone changes.
4. **Update the milestone-totals table.** The "Cumulative" column
   adds the new per-milestone duration to the previous row. The
   "Target Date" column adds the cumulative duration to the
   roadmap's start date or to the last completed milestone's
   actual finish date.
5. **Compare against the previous projection.** If the new
   projection slipped by more than two weeks for any milestone,
   note the slip in the "Progress as of …" footer with one
   sentence on the cause (e.g., "M2 grew by three weeks because
   ocapn-noise-network was upgraded from L to XL after design
   review").

## Output

A diff to `designs/README.md` covering § "Summary by Milestone",
§ "Timeline" (both the Mermaid block and the table), and the
trailing "Progress as of …" line.

## Pitfalls

- The Mermaid `after mN` chain is brittle: if you remove a
  milestone, every dependent `after` reference breaks silently.
  Render the diagram with `mmdc` (or paste into Mermaid Live
  Editor) before committing.
- Slip is asymmetric. Earlier slip cascades into later milestones;
  earlier-than-projected completion does not pull later
  milestones in unless the work overlaps. Keep the projection
  conservative.
- "Target dates" are projections, not commitments. Use language
  like "Late April 2026" not "April 25, 2026" so a few-day
  variance does not trigger a roadmap update.
- Do not project for milestones that contain a design rated XL
  with significant unknowns ("research-heavy"). Mark them
  "TBD pending design review".
