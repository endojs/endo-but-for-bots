# Role: watchman-schedule

Owns the calendar of date-keyed engagements.
Reads one index file per cycle, surfaces what is due, regenerates
the index at close from the per-source process docs.

The watchman-schedule is **not** an independent agent dispatch;
it is an inline subsection of the
[`steward`](./steward.md)'s per-cycle procedure.
A separate-agent watchman could return a vacuous report when it
should have surfaced work, exactly the failure mode the existing
cycle-close gate prevents for [`liaison`](./liaison.md) and
[`marshal`](./marshal.md).
Inlining keeps the gating tight: the cycle log must contain a
labeled `watchman-schedule:` section per cycle.

See [`../designs/watchmen.md`](../designs/watchmen.md) for the
design rationale and the audit that motivates this split.

## When

Runs on every steward cycle as the second half of the per-cycle
sweep (alongside [`watchman-events`](./watchman-events.md) for
event-driven dispatches).
The watchman-schedule answers "what date-keyed engagements are
due on or before today?"

## State files

- [`../process/scheduled-engagements.md`](../process/scheduled-engagements.md) —
  the index, regenerated each cycle's close from per-source docs;
  one row per pending engagement, sortable by date.
- Per-engagement source-of-truth docs continue to live where they
  do today:
  - [`../process/dependabotany.md`](../process/dependabotany.md) —
    per-PR Dependabot embargo maturity dates and verdicts.
  - [`../process/major-generalship.md`](../process/major-generalship.md) —
    the next scheduled major-general engagement date and the
    per-package re-scout dates.

The index file never holds substance; it always points at the
source doc for the per-engagement detail.
Each role remains responsible for its own state.

### Why an index file at all

The watchman-schedule needs O(1) per cycle to know whether
anything is due.
Reading every per-source doc per cycle would be O(n) and would
re-introduce the silent-skipping risk: a per-source doc the
steward forgets to consult is a missed engagement.
The index is the single read; the per-source docs hold the
substance.

The index is **regenerated, never hand-edited**; this avoids
drift between index and truth.

## Per-cycle discipline

1. Read [`../process/scheduled-engagements.md`](../process/scheduled-engagements.md).
2. For every row whose `Date` column is on or before today (UTC),
   surface a dispatch tuple `(role, brief, source-doc-row-id)` to
   the steward.
3. After the steward dispatches and the dispatched role reports,
   the dispatched role updates **its source-of-truth doc** (e.g.
   [`../process/dependabotany.md`](../process/dependabotany.md))
   with the new verdict and the next-engagement date if
   applicable.
4. The steward's close step rewrites
   [`../process/scheduled-engagements.md`](../process/scheduled-engagements.md)
   from the per-source docs (one row per due-or-future
   engagement).

The watchman-schedule does **not** dispatch sub-roles itself; it
surfaces tuples to the steward.

### The today-greater-than-or-equal-to-scheduled rule

The date check is `today >= scheduled`, not `today == scheduled`.
If a session ends and the next session starts after the date, the
engagement still fires on first cycle.
This is the cheapest reliable mechanism for date-keyed
engagements and is the recommended substrate for every per-source
doc that contributes rows to the index.

The mechanism's failure modes are limited:

- The cycle does not fire at all (session is dead, no
  `ScheduleWakeup` is in flight, no maintainer kick has arrived).
  Recoverable on the next maintainer interaction.
- The cycle fires but skips the watchman-schedule sweep.
  This is the silent-skipping failure mode and is exactly what
  the per-watchman labeled subsection in the cycle-log close-gate
  prevents.

### Overdue detection

The watchman-schedule sweeps every row in the index, not just
rows whose date matches today.
A row whose date is, say, 8 days in the past fires now (because
"today >= date") regardless of why it sat overdue.

If overdue by more than 7 days, the watchman-schedule also
surfaces a maintainer note: "scheduled engagement X was overdue
by N days; verify the prior cycles' state."
A 7-day overdue is incompatible with the steward's 9-h cadence
upper bound; it indicates the loop was dead for that period and
the maintainer should know.

## The two source-of-truth docs today

### Dependabotany

[`../process/dependabotany.md`](../process/dependabotany.md) is
the [`botanist`](./botanist.md)'s per-PR posture record.
Its **Scheduled engagements** sub-table holds date-keyed
re-dispatches for embargoed PRs.

The steward's per-cycle scan of dependabotany already does the
date check today; under the watchmen refactor, the same check
moves into the watchman-schedule sweep, fed by the index.
Each `EMBARGO-YYYY-MM-DD` row in the per-PR table contributes
one index row when the date is on or before today.

### Major-generalship

[`../process/major-generalship.md`](../process/major-generalship.md)
is the [`major-general`](./major-general.md)'s per-package
posture record.
Its header carries the **next scheduled engagement** date for
the weekly enumeration sweep.
Its `Scheduled re-scouts` sub-table holds per-package re-scout
dates for embargoed candidates.

The header date is the primary input to the watchman-schedule:
when today is on or after the header date, the major general is
due for its weekly sweep, and the watchman-schedule surfaces the
dispatch tuple.

## Closing the cycle: regenerate the index

At the steward's close step, after every dispatched role has
reported and updated its own source-of-truth doc, rewrite
[`../process/scheduled-engagements.md`](../process/scheduled-engagements.md)
from those docs.
For each per-source doc:

- Walk every embargo / scheduled-engagement row.
- Emit one index row per engagement whose date is in the future
  or on today.
- Skip engagements that have completed (verdict is final, no
  follow-up date).

The index is a snapshot; commit history (`git log -p
process/scheduled-engagements.md`) is the audit trail.

## Skills

- [`../skills/process-documents.md`](../skills/process-documents.md) —
  the index ships in isolated process commits, not bundled with
  code changes.
- [`../skills/relative-paths-rule.md`](../skills/relative-paths-rule.md),
  [`../skills/em-dash-style-rule.md`](../skills/em-dash-style-rule.md).

## Posture

- **Index is regenerated, never hand-edited.**
  Per-source docs are the truth; the index is a snapshot for
  fast lookup.
- **`today >= date`, not `today == date`.**
  Overdue engagements fire on the next cycle, not the next
  matching date.
- **Surface, do not dispatch.**
  The watchman-schedule surfaces tuples to the steward; the
  steward decides whether to dispatch in the current cycle or
  queue in `PR-DISPATCH-STATE.md`.
- **Cycle-log gating.**
  A cycle without a labeled `watchman-schedule:` line in the
  cycle log does not close.

## Self-improvement

Final task of every engagement: update this role file with
patterns that recur across cycles.
See
[`../skills/self-improvement.md`](../skills/self-improvement.md).
