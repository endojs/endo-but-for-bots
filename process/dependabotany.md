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
| [188](https://github.com/endojs/endo-but-for-bots/pull/188) | `dorny/paths-filter` 3.0.2 → 4.0.1 | MERGE-NOW | n/a | OPEN | GH Actions bump. Single `uses:` line in `ci.yml` (workflow-paths filter step). v4 is a node20 → node24 runtime upgrade; v4.0.1 adds merge-queue support. Only consumed input `filters:` is unchanged. CI green. No CVEs. Manual merge by kriskowal required (bot lacks `workflow` scope). ([verdict comment](https://github.com/endojs/endo-but-for-bots/pull/188#issuecomment-4417083528)) |
| [189](https://github.com/endojs/endo-but-for-bots/pull/189) | `actions/upload-artifact` 4.6.2 → 7.0.1 | MERGE-NOW | n/a | OPEN | GH Actions bump. `browser-test.yml` and `familiar-release.yml` (4 call sites). v5/v6/v7 are runtime + ESM transitions; v7's new `archive` input is opt-in (default `true` matches v4). Consumed inputs (`name`, `path`, `if`) unchanged. CI green including the `browser-tests` job that exercises the upload step. No CVEs. Manual merge by kriskowal required. ([verdict comment](https://github.com/endojs/endo-but-for-bots/pull/189#issuecomment-4417084122)) |
| [190](https://github.com/endojs/endo-but-for-bots/pull/190) | `actions/configure-pages` 5.0.0 → 6.0.0 | MERGE-NOW | n/a | OPEN | GH Actions bump. Single `uses:` line in `typedoc-gh-pages.yml`. Pure node24 runtime upgrade. Project calls action with no `with:` block, so input semantics cannot regress. CI green. No CVEs. Manual merge by kriskowal required. ([verdict comment](https://github.com/endojs/endo-but-for-bots/pull/190#issuecomment-4417084480)) |
| [191](https://github.com/endojs/endo-but-for-bots/pull/191) | `nick-fields/retry` 3.0.2 → 4.0.0 | MERGE-NOW | n/a | OPEN | GH Actions bump. Two `uses:` lines in `ocapn-guile-interop.yml`. v4.0.0 release notes are auto-generated and empty; commit-log inspection shows the only substantive change is a node20 → node24 runtime upgrade. All four consumed inputs (`max_attempts`, `retry_wait_seconds`, `command`, `timeout_seconds`) unchanged. CI green except for an unrelated macos-15 ws-relay daemon flake (`1 unhandled rejection` in `@endo/daemon`, orphan-process cleanup error from runner). No CVEs. Manual merge by kriskowal required. ([verdict comment](https://github.com/endojs/endo-but-for-bots/pull/191#issuecomment-4417085121)) |
| [192](https://github.com/endojs/endo-but-for-bots/pull/192) | `actions/checkout` 4.3.1 → 6.0.2 | MERGE-NOW | n/a | OPEN | GH Actions bump. 9 workflow files, ~26 `uses:` lines. v5 = node24 runtime; v6 = "persist creds to a separate file" internal refactor (PR #2286, observable behavior unchanged, `persist-credentials` still defaults `true`); v6.0.1/v6.0.2 = small worktree and tag-handling fixes. All five consumed inputs (`path`, `token`, `repository`, `ref`, `submodules`) byte-identical between `action.yml@v4.3.1` and `action.yml@v6.0.2`. CI green. No CVEs. Resolves the standing `Node.js 20 actions are deprecated` CI warning. Manual merge by kriskowal required. ([verdict comment](https://github.com/endojs/endo-but-for-bots/pull/192#issuecomment-4417085990)) |

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
- **GH Actions bumps: diff `action.yml` between tags, not just
  the release notes.**
  Release notes for Actions tend to be marketing-flavored
  ("major release: node24 runtime!").
  The authoritative shape change is in the `action.yml` `inputs:`
  and `runs:` blocks of the published tag.
  Fetch both tags via
  `gh api 'repos/<owner>/<repo>/contents/action.yml?ref=<tag>'
  --jq '.content' | base64 -d` and compare.
  On the 2026-05-10 GH Actions sweep (PRs #188, #189, #190, #191,
  #192), this confirmed that the only substantive change across
  five major-version bumps was node20 → node24 runtime; every
  consumed input was byte-identical between old and new tags.
  Release notes alone would have left ambiguity about
  e.g. `nick-fields/retry@v4.0.0` whose generated changelog was
  empty.
- **A red CI check on a GH Actions bump is often an unrelated
  flake, not the action's fault.**
  On PR #191 the `test (20.x, macos-15)` job failed with
  `1 unhandled rejection` in an `@endo/daemon` ws-relay test and
  an orphan-process cleanup error from the macOS runner — the
  workflow exercising the bumped action (`ocapn-guile-interop.yml`)
  was green.
  Before reporting CI red on an Actions bump, identify which
  workflow file the failing job belongs to; if it isn't the one
  the PR changes, the failure is independent.
- **Quote `gh api` paths that contain `?ref=...`.**
  zsh expands `?` as a glob and the unquoted form fails with
  `no matches found`.
  Use `gh api 'repos/.../contents/x.yml?ref=v6.0.0'`
  (single-quoted) when fetching a file at a tag.
