# Major-generalship

Per-package posture record for every direct dependency the
[major general](../roles/major-general.md) has scouted for a
major-version upgrade.
The steward consults this doc at the top of every cycle to
determine whether the major general is due for dispatch and
which embargoed candidates have matured.

## How to use this doc

- **Header**: the next scheduled engagement date (UTC).
  The steward reads this date per cycle.
  When today is on or after the date, dispatch the major general
  and let the dispatch update the date to today plus seven on
  completion.
- **Per-package row** in the table below: package name, pinned
  major, latest published major, verdict, embargo / re-scout
  date, current state, notes.
- **Verdicts**:
  - `PROPOSE` — adoption PR opened; the standard pre-maintainer
    chain (panel, fixer if must-fix, cleaner, shepherd) and the
    conductor carry the PR through merge.
  - `SKIP` — the project does not consume the deprecated surface;
    transparent bump PR opened with no changeset.
  - `DEFER` — migration cost is too entangled for a single PR;
    issue opened with the cost analysis, surfaced to the
    maintainer for prioritization.
  - `EMBARGO-YYYY-MM-DD` — new major published fewer than seven
    days ago; the next major-general dispatch on or after the
    embargo date re-scouts.
- **State transitions**:
  - `EMBARGOED` -> `PROPOSED` / `SKIPPED` / `DEFERRED` once the
    embargo matures.
  - `PROPOSED` -> `MERGED` / `CLOSED` per the PR's outcome.
  - `DEFERRED` -> `RE-SCOUT-YYYY-MM-DD` when a fresh patch /
    minor of the new major lands and the migration cost may
    have changed.

## Steward's per-cycle scan

Run this at the top of every steward cycle:

```sh
date_today=$(date -u +%Y-%m-%d)
echo "Major-general next scheduled engagement vs today $date_today:"
# Read the header below; if next-engagement <= today, dispatch the
# major general for a fresh enumeration sweep.
```

For every per-package row whose `EMBARGO-DATE` is on or before
today, the major general's next dispatch picks them up alongside
the fresh enumeration.

## Next scheduled engagement

**Date (UTC)**: `2026-05-17`

(Initialized at role-introduction commit; updated to today plus
seven by the major general on every completion.)

## Per-package posture

| Package | Pinned major | Latest major | Verdict | Embargo / re-scout date | State | Notes |
|---|---|---|---|---|---|---|
| (none yet) | | | | | | |

## Scheduled re-scouts

A standing list of "re-scout this package on date X" items,
separate from the per-package table because some re-scouts span
multiple packages (an interface-coupled family) and some are
prompted by an external event (an upstream RC graduating to
GA).

| Date | Package(s) | Reason |
|---|---|---|
| (none yet) | | |

## Major-general self-notes

Pitfalls and patterns surfaced during prior engagements; informs
future dispatches without re-discovering them.

(none yet)
