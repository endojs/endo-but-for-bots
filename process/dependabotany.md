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
| [194](https://github.com/endojs/endo-but-for-bots/pull/194) | `@libp2p/websockets` 9.2.19 → 10.1.11 | REJECT | n/a | OPEN | Major API break: `WebSocketsInit.filter` removed, `./filters` subpath missing from v10.1.11 tarball, transitive `@libp2p/interface` 2→3 cascades type errors. Lint and `viable-release` jobs red. Migration to `connectionGater.denyDialMultiaddr` requires a human-authored PR. Recommend follow-up issue and close PR as superseded. ([verdict comment](https://github.com/endojs/endo-but-for-bots/pull/194#issuecomment-4416647046)) |

## Scheduled engagements

A standing list of "do this on date X" items, separate from the
per-PR table because some engagements span multiple PRs.

| Date | Action | Trigger |
|---|---|---|
| (none yet) | | |

## Botanist self-notes

Pitfalls and patterns surfaced during prior engagements; informs
future dispatches without re-discovering them.

- **Read CI's failing logs early.**
  On PR #194 the lint and `viable-release` jobs had already
  diagnosed the API break (`Cannot find module
  '@libp2p/websockets/filters'`, `'filter' does not exist in type
  'WebSocketsInit'`).
  CI's red signal short-circuits a long source read: pull
  `gh api repos/<repo>/actions/jobs/<id>/logs` for every failing
  required check before reaching for `npm pack`.
- **`enableScripts: false` is already the project default.**
  `endo-but-for-bots/.yarnrc.yml` sets `enableScripts: false`
  globally, so an `npx corepack yarn install` in a worktree is
  already passive.
  No need to set it again per worktree; just confirm the file's
  contents.
- **An upstream `package.json` `exports` map can lie.**
  `@libp2p/websockets@10.1.11` declares `"./filters"` in
  `exports`, but the actual `dist/src/filters.js` is missing
  from the published tarball.
  When a PR fails with `ENOENT` on a deep import path, verify
  by `tar tzf` on the tarball, not by trusting the `exports`
  map.
- **A `@deprecated` tag in vN often becomes "removed" in vN+1.**
  v9 marked `@libp2p/websockets/filters` as JSDoc-`@deprecated`,
  with the migration path being a libp2p-level
  `connectionGater.denyDialMultiaddr`.
  The v10 major bump completed the removal.
  When reading source for a major bump, search the prior major
  for `@deprecated` JSDoc tags on the consumed surface; those
  are the things the new major has likely deleted.
