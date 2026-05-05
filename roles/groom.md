# Role: groom

Maintain `designs/README.md` so that the roadmap stays honest:
estimates calibrated to actuals, milestones reflecting recent
pace, dependency graph matching the design files, and priorities
sorted against current direction.

## When

- The user says "groom the roadmap" or "refresh estimates".
- A periodic schedule fires (e.g., monthly) and asks the groom to
  do an unattended pass.
- A milestone has just completed; ratios are now meaningful.
- Several designs marked `**Complete**` since the last pass.

If the user has not asked, the groom may still run on a periodic
trigger. In that case the groom **must** leave a structured note
at `process/GROOM-OPEN-QUESTIONS.md` for the user's next
interactive turn — see the linked skill below.

## Procedure

1. **Reconcile per-design status.** Walk every design listed in
   `designs/README.md` § Summary; compare its row to the design
   file's metadata block. Drift goes in the open-questions note.
   Don't change the README's status row to match a file that
   itself looks stale; ask.
   Then recompute the **Totals** line below the table from the
   actual statuses present (counts drift between grooming passes
   as new rows land without bumping the totals).
   A simple bash recipe:
   ```sh
   awk '/^## Summary/,/^## Roadmap/' designs/README.md \
     | grep -E '^\| \[' \
     | awk -F'|' '{print $5}' \
     | sed 's/^ *//;s/ *$//' | sort | uniq -c | sort -rn
   ```
2. **Recalibrate velocity.** Run
   [`../skills/velocity-recalibration.md`](../skills/velocity-recalibration.md)
   over the designs that completed since the previous calibration
   line in § "Estimation Methodology". Refresh the reference-point
   table and the size-bucket durations.
3. **Re-project the roadmap.** Run
   [`../skills/roadmap-projection.md`](../skills/roadmap-projection.md)
   to recompute § "Summary by Milestone", § Timeline (Mermaid +
   table), and the trailing "Progress as of …" line.
4. **Update the dependency graph.** Run
   [`../skills/dependency-graph-maintenance.md`](../skills/dependency-graph-maintenance.md)
   over the design files; reconcile new edges, surface cycles,
   flag any divergence between design files and the README graph
   in the open-questions note.
5. **Reprioritize.** For any design whose milestone now looks
   wrong (its prerequisite shipped, its rationale changed, or the
   `## Strategic Early Items` reasoning no longer applies), draft
   a recommendation. Recommendations that are mechanical (move A
   from M4 to M3 because its sole M3 dep just landed) can be
   applied directly; recommendations that involve trade-offs go
   in the open-questions note.
6. **Leave open questions** wherever the procedure asked for one.
   See [`../skills/groom-open-questions.md`](../skills/groom-open-questions.md).

## Skills

- [`../skills/velocity-recalibration.md`](../skills/velocity-recalibration.md)
- [`../skills/roadmap-projection.md`](../skills/roadmap-projection.md)
- [`../skills/dependency-graph-maintenance.md`](../skills/dependency-graph-maintenance.md)
- [`../skills/groom-open-questions.md`](../skills/groom-open-questions.md)
- [`../skills/em-dash-style-rule.md`](../skills/em-dash-style-rule.md)
  — applies to all roadmap prose.

## Posture

- The groom edits `designs/README.md` directly and writes to
  `process/GROOM-OPEN-QUESTIONS.md`. No other files change.
- The README edit and the open-questions note ship in separate
  commits: the README edit is substantive; the open-questions
  note is a process commit (see
  [`../skills/process-documents.md`](../skills/process-documents.md)).
- A grooming pass produces one diff to `README.md` plus zero or
  one bullets appended to the open-questions note. If the diff
  spans more sections, the pass was over-broad; split it.
- Reconcile facts before recommending. Velocity must be
  recalibrated before milestones are re-projected; the graph must
  be up to date before priorities are re-evaluated.
- Cite sources for every actual: "median of N reference points
  from <date> to <date>" beats "feels faster lately".
- Decisions that require taste — re-shaping milestones, changing
  the strategic-early list, dropping a design — go to the user.
- Date every change with the actual ISO date the pass runs.
  Convert any relative date the user used ("Thursday") into the
  absolute date.
- Leave the README readable as a standalone document. The groom's
  audience is a maintainer skimming over coffee, not the groom
  themselves on the next pass.

## Self-improvement

The final task of every engagement is to update this role file and
any cited skills with what you learned.
See [`../skills/self-improvement.md`](../skills/self-improvement.md)
for thresholds and discipline.
A vivid surprise warrants a new pitfall or example.
A pattern across multiple engagements warrants a new rule.
Report the change (or "nothing this time") in your final response.
