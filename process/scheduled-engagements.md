# Scheduled Engagements

The [`watchman-schedule`](../roles/watchman-schedule.md) reads
this doc at the top of every cycle and surfaces every row whose
`Date` column is on or before today (UTC).
Per-engagement source-of-truth lives in the per-role process doc
named in the `Source` column.

This index is regenerated from those source docs at every cycle's
close; **do not hand-edit**.
The audit trail lives in commit history
(`git log -p process/scheduled-engagements.md`).

## Sources

The current source-of-truth docs are:

- [`./dependabotany.md`](./dependabotany.md) — per-PR Dependabot
  embargo maturity dates and the standing
  [scheduled-engagements](./dependabotany.md#scheduled-engagements)
  sub-table.
- [`./major-generalship.md`](./major-generalship.md) — the
  [next scheduled engagement](./major-generalship.md#next-scheduled-engagement)
  date for the weekly enumeration sweep, plus the
  [scheduled re-scouts](./major-generalship.md#scheduled-re-scouts)
  sub-table.

When a new role with date-keyed engagements lands, add its
process doc to this list and seed the index from it.

## Index

| Date | Action | Role | Source |
|---|---|---|---|
| 2026-05-17 | weekly major-general enumeration sweep | major-general | [major-generalship.md](./major-generalship.md) |

## How rows enter and leave

- A row enters the index when a per-source doc records a
  scheduled engagement (an embargo maturity date, a next-rescout
  date, the major-general's next-engagement header).
- A row leaves the index when the dispatched role updates its
  source-of-truth doc with a new date or marks the engagement
  complete; the next cycle's close-step regeneration drops the
  stale row and emits the new one.
- A row whose `Date` is in the past stays in the index until the
  watchman-schedule surfaces it and the dispatched role advances
  the source doc.

## Overdue rows

If `today - Date` exceeds 7 days for any row, the
watchman-schedule additionally surfaces a maintainer note:
"scheduled engagement X was overdue by N days; verify the prior
cycles' state."
A 7-day overdue is incompatible with the steward's 9-hour cadence
upper bound; it indicates the loop was dead for that period and
the maintainer should know.
