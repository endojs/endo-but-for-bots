# Dependabotany

Per-PR posture record for every Dependabot PR the
[botanist](../roles/botanist.md) has assessed.
The steward consults this doc at the top of every cycle to
determine which embargoed PRs are due for re-dispatch.

## How to use this doc

- **Per-PR row** in the table below: PR number, headline
  upgrade, verdict, maturity date (for embargoes), state.
- **Verdicts**:
  - `MERGE-NOW` — the conductor merges on the next cycle.
  - `EMBARGO-YYYY-MM-DD` — the steward re-dispatches the
    botanist on that date for a final read; if the upgrade is
    still benign and CI is green, the conductor merges.
  - `REJECT` — the PR is closed with the reason in the comment.
- **State** transitions: `OPEN → MERGED` (verdict was
  MERGE-NOW), `OPEN → EMBARGOED → OPEN-MATURE → MERGED` (an
  embargo cleanly matured), `OPEN → CLOSED` (REJECT, or
  embargoed indefinitely because upstream withdrew).

## Steward's per-cycle scan

Run this at the top of every steward cycle:

```sh
date_today=$(date -u +%Y-%m-%d)
echo "Maturity dates due on or before $date_today:"
# read the table below; any row with EMBARGO-DATE <= today is due
```

For every due row, dispatch the botanist with the PR number and
the prior verdict's "next dispatch" instruction.

## Per-PR posture

| PR | Headline upgrade | Verdict | Maturity date | State | Notes |
|---|---|---|---|---|---|
| (none yet) | | | | | |

## Scheduled engagements

A standing list of "do this on date X" items, separate from the
per-PR table because some engagements span multiple PRs.

| Date | Action | Trigger |
|---|---|---|
| (none yet) | | |

## Botanist self-notes

Pitfalls and patterns surfaced during prior engagements; informs
future dispatches without re-discovering them.

(none yet)
