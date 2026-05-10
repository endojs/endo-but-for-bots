# Steward state snapshot — 2026-05-10T07:02Z (delta @ 21:05Z)

## Delta since 07:02Z

- **#142 MERGED** (per-package `@endo/bytes` reshape, 6 commits). Upstream
  replay still BLOCKED on push access; branch ready at
  `~/endo-wt/upstream-bytes` HEAD `63fb5330cb`.
- **#181 rebased onto current `llm`** (was CONFLICTING after #142 landed).
  HEAD now `ba08af670f`. Conflict was `designs/README.md` only — combined
  the "Recently added" sentence (kept `trust-on-first-bind` + added
  `retention-path-notation`) and updated Totals to `27/15/43/3/3/3/2/1/1
  (98 designs)`. Force-pushed; CI will rerun.
- **kumavis Open Question on #170/#169** (first-subscribe hook): kumavis
  confirmed Option A (callback in `makeSubscribableKit`, scoped to
  PassStylePromise, error-early on non-PassStylePromise). Answered his
  follow-up on #169 (sample code for chain-walking via
  `HandledPromise.subscribe`). Still waiting on kriskowal to confirm
  Option A vs Option B before dispatching the design+impl rework.
- **PRs awaiting kriskowal review** (CI green or all-feedback-addressed):
  #170, #178, #179, #181, #186, #187, #182, plus older
  #122, #128, #134, #151, #160, #163, #164, #165.
- **Dependabot batch #188-#197**: opened 2026-05-10 19:53Z by
  dependabot. Awaits maintainer triage; no bot action in scope per
  `roles/shepherd.md`.
- **Stale TaskList**: monitor task IDs `bi3ivosg5`, `bezu4scns` from
  prior contexts are still emitting events alongside the freshly
  re-armed `ba86i6wob`. Harmless duplication; TaskList is empty so they
  cannot be stopped via TaskStop.

---

# Original snapshot — 2026-05-10T07:02Z

A point-in-time capture of every load-bearing in-flight workstream
the steward is babysitting. Written so a context compaction or a
fresh steward boot can pick up without losing work.

If you are reading this after a context reset:

1. Read `roles/steward.md` for the canonical loop.
2. Read `process/PR-DISPATCH-STATE.md` for the merge-cycle log.
3. Then read this document for the in-flight surface.
4. Run `gh pr list --repo endojs/endo-but-for-bots --state open --json
   number,title,reviewDecision,mergeable,updatedAt --jq 'sort_by(.updatedAt)
   | reverse | .[] | "\(.number)\t\(.reviewDecision // "PENDING")\t\(.mergeable)\t\(.title[0:60])"'`
   to confirm current PR state vs the snapshot below.

## Repo merge settings (changed today)

`endojs/endo-but-for-bots` was updated 2026-05-10 ~06:35Z to:

- `merge_commit_title: PR_TITLE` (PR title plus `(#nnn)` becomes the merge
  commit subject)
- `merge_commit_message: PR_BODY` (PR body becomes the merge commit body)
- `squash_merge_commit_title: PR_TITLE`
- `squash_merge_commit_message: PR_BODY`

The PATCH was applied by the user; the bot token (`kriscendobot`)
returned 404 (no admin scope on the repo).

Implication for every subsequent PR: **the PR title and body are
the permanent merge commit message.** Conductor and builder/fixer
dispatches must verify both look authoritative before merge.

## In-flight builder / fixer / designer agents (background)

These were dispatched in the steward loop today and have not
returned. Each dispatch's lifecycle is independent of this session;
their progress is observable via PR push events on the bots repo.

| Agent | Subject | Brief / status |
|---|---|---|
| **Builder A** | `~/garden/process/AGENT-READY-ISSUES.md` queue 1 (issues #3052, #3081, #3156, #3202, #1845, #2834, #2879) | Open one PR per issue, sequentially, against `bots-ssh:master`. ~9 hours budget. Each PR small (single-digit files). |
| **Builder B** | AGENT-READY-ISSUES queue 2 (issues #2390, #2632, #2749, #2742, #922, #1298, #947) | Same shape as Builder A, parallel queue. |
| **Fixer (PR #178)** | V2 locator failures: 5 channel-relay/ws-relay tests fail. Branch `refactor/daemon-locator-v2`, head `97735ab0af` after migration. | Diagnose V1-emission sites, push fixup commits per failure. |
| **Fixer (PR #151)** | Rebase + 2 inline asks: `console.log → console.error`, add test for `listWorkerTenants`. | Two fixup commits + force-push. |
| **Designer (retention-path notation)** | New design `designs/retention-path-notation.md` for CLI/Chat UI rendering of retention paths + fast collection. | Open new design PR against `master`, comment on #151 with link. |
| **External claude-p subprocess** | PR #122 mount.js bug fix + tests. Saboteur identified one must-fix (read-side ACL leak at `mount.js:339-345, :481-485, :492-496`) plus 11 attack-vector regression tests. | Subprocess outside this session's tracking; PID 3084653, task `b2u1cdfej`. Observable via PR #122 push events. |

(Other agents may still be running from earlier cycles; check via
`gh api repos/endojs/endo-but-for-bots/events?per_page=30` for recent
pushes or comments by `kriscendobot`.)

## CI Monitors (parent-context)

These poll `gh pr view <N> --json statusCheckRollup` every 90s and
exit on convergence or HEAD change:

| PR | Monitor task ID | HEAD | Notes |
|---|---|---|---|
| #134 | `bqqm8fp8v` (most recent re-arm) | `b25a2dc41f` | Post-rebase; weaver completed |
| #142 | `bh612hktl` (most recent re-arm) | `e33273682e` | 3-commit reshape; was 15/14 last check |
| #140 | `bn0tiq31z` | `a347fa3f72` | Single consolidated commit; APPROVED; awaiting CI to fire conductor merge |
| #164 | `br3uv8y1v` (most recent re-arm) | `337329bdd0` | macos-15 rerun in flight (was 27/1 with 1 daemon flake) |
| #179 | `b4yjbmz62` | `97735ab0af` | Migrated #45 |

CI Monitors die with the parent session. If recovering after a
context reset, re-arm against the actual HEAD of each PR.

## Per-PR state (open PRs as of 07:02Z)

| PR | Title-tag | State | Notes |
|---|---|---|---|
| #122 | platform-fs daemon integration | OPEN, CR | ASCII-fixer + normative-reframe done; saboteur subprocess running mount.js-bug fixer; awaiting kriskowal re-review (he said "I'm very nearly convinced ready") |
| #128 | CLI additions | CR | Older; multiple inline review threads |
| #134 | docker self-hosting | CR | Rebased; paused for #173 Endo Gateway design |
| #140 | design @endo/bytes | OPEN, APPROVED | Single consolidated commit; CI in flight; conductor will merge on green |
| #142 | feat @endo/bytes pkg + migrations | OPEN, CR (5 reshape rounds today, latest is "looks good with minor inlines") | 3-commit shape at `e33273682e`; CI in flight; safety tags `pr142-pre-reshape`, `pr142-pre-perpkg-reshape`, `pr142-pre-resplit`, `pr142-pre-reshape-4` |
| #147 | OpenRouter provider + OpenAI shape converters | OPEN | 6-commit reshape; 28/28 green; awaiting `0xpatrickdev` approval (kriskowal deferred) |
| #151 | endo workers verb | OPEN, CR | Fixer in flight (rebase + 2 inlines); separate retention-path designer dispatched |
| #153, #155, #162, #165, #166, #169, #170, #175, #176, #177 | various designs/impls | mixed | All have addressed prior reviews; several awaiting kriskowal re-review |
| #160 | exo-zip package | OPEN | #161 unblocker merged; re-requested kriskowal review |
| #163 | HTTP client design | OPEN, CR | Designer-fixer fleshed out Exo interfaces; awaiting kriskowal re-review |
| #164 | trust-on-first-bind | OPEN, APPROVED | Reference-status fixup landed; CI rerun in flight (1 macos-15 flake) |
| #167 | (merged) | MERGED | typed-array casts; unblocked #142+#161 |
| #169 | pass-style promise design | OPEN | Q1-Q5 feedback integrated; env-flag name candidates surfaced; awaiting kriskowal pick |
| #170 | pass-style promise impl | OPEN | Re-requested kriskowal; 28/28 green |
| #171, #172, #173 | (issues) | OPEN | #171 → repro #174 + design #176; #172 → design #175 + builder #177; #173 (Endo Gateway) → discussion |
| #174 | repro for #171 | OPEN | Sentinel + regression tests; re-requested kriskowal |
| #175 | design eventual-send shim race | OPEN | Designer done; builder dispatched against #177 |
| #176 | design unhandled-rejection display | OPEN | Designer done; awaits kriskowal review |
| #177 | builder for #175 | OPEN | Phase 1+2 impl + 5 design gaps surfaced; panel done as `--comment` (bot-self) |
| #178 | refactor daemon locator V2 (migrated from #34) | OPEN | Fixer in flight for 5 channel-relay/ws-relay V1-emission sites |
| #179 | commands-as-messages (migrated from #45) | OPEN | Local pre-PR clean; CI Monitor armed |

Recently MERGED today: #136, #141, #143, #161, #103, #167, #146.
Recently CLOSED today: #144 (superseded by #163), #145 (superseded by
#165), #46 (superseded by #59), #34 (migrated to #178), #45 (migrated
to #179).

Recently CLOSED by kriskowal (no bot follow-up needed): #54.

## Open issues filed today

- **#171**: unhandled-rejection trap empty-`{}` for Error reasons
  (PR #174 repro + PR #176 design)
- **#172**: HandledPromise shimming with race-to-install
  (PR #175 design + PR #177 builder)
- **#173**: Endo Gateway requirements (system-service HTTP virtual
  host for OCapN); under discussion before designer dispatch.

## Garden-side updates pushed today (roles/skills)

All committed to `garden` branch on `bots-ssh`:

- `roles/conductor.md`: downstream-unblocking via steward; pre-flight
  CI green is the steward's job (not the conductor's "wait for CI")
- `roles/shepherd.md`: watch-CI-only briefs belong as parent-context
  Monitors, not shepherd dispatches
- `roles/fixer.md`: byte-identical reshape uses original merge-base;
  contributor PR pushes to fork remote; trailer-strip via
  `filter-branch --msg-filter`; sentinel-plus-regression test pattern;
  daemon-class CI-flake diagnostic sequence
- `roles/weaver.md`: rebase after upstream squash-landed substance —
  use `--skip` per-commit and `--empty=drop`, do not synthesize
- `roles/builder.md`: read the cited reference source line-by-line
  ("modeled on X" abbreviates X); trailer-strip recipe for re-opened
  multi-commit PRs
- `skills/coverage-driven-testing.md`: AVA intercepts unhandled
  rejections; the contortion path is anti-pattern, document the gap
- `skills/panel-review-12-perspectives.md`: `--request-changes`
  blocked on bot-self PRs (fall back to `--comment`); design+impl-in-one-PR
  needs explicit design-assessment posture

## Memories saved today (in `~/.claude/projects/-home-kris-endo-repo/memory/`)

- `feedback_changesets_not_news.md`
- `feedback_pr_template.md`
- `feedback_realm_vs_platform.md`

(Plus pre-existing: `feedback_workflows.md`, `feedback_node_buffer.md`.)

## Re-entry checklist for a fresh steward

If this snapshot is what you're reading after compaction:

1. **Status check**:
   ```
   date -u +"%Y-%m-%dT%H:%M:%SZ"
   tail -10 /tmp/poll-events.log
   gh pr list --repo endojs/endo-but-for-bots --state open --json number,title,reviewDecision,mergeable,updatedAt --jq 'sort_by(.updatedAt) | reverse | .[0:30] | .[] | "\(.number)\t\(.reviewDecision // "PENDING")\t\(.mergeable)\t\(.title[0:55])"'
   ```
2. **Re-arm Monitor on poll log**:
   ```
   Monitor description="poll-events.log new lines for any GitHub activity"
     command="tail -F -n 0 /tmp/poll-events.log 2>&1 | grep --line-buffered -E 'NEW|ERROR|Failed|exit'"
     persistent=true timeout_ms=3600000
   ```
3. **Check on each PR with state-changing work in flight** (per the
   "In-flight builder / fixer / designer agents" table). Likely
   actions:
   - PRs whose CI you can no longer Monitor: re-arm the Monitor.
   - PRs whose fixer/builder result you missed: check the PR's latest
     push and comment on it (`gh pr view <N> --json comments,commits`).
   - PRs awaiting maintainer review: just wait.
4. **Look for new GitHub events since the last steward tick** (the
   poll log will accumulate them):
   ```
   gh api 'repos/endojs/endo-but-for-bots/events?per_page=30' --jq '.[] | "\(.created_at) \(.type) #\(.payload.pull_request.number // .payload.issue.number // .payload.number // "?") by \(.actor.login)"' | head -20
   ```
5. **Pick up any kriskowal directive** that arrived during the
   compaction window.
6. **ScheduleWakeup** with 1500s delay and `prompt: "/loop the steward."`.

## Disciplines worth re-reading after a reset

- `roles/steward.md` — the canonical loop.
- `roles/builder.md`, `roles/fixer.md`, `roles/conductor.md`,
  `roles/shepherd.md`, `roles/weaver.md` — the day's pitfalls
  (committed today).
- `roles/README.md` — the per-PR state-machine.
- `CLAUDE.md` — the SES + PR-template + diagnostic discipline rules.
- `skills/regression-evidence.md`, `skills/pre-pr-checklist.md`,
  `skills/em-dash-style-rule.md`, `skills/relative-paths-rule.md`.

## Open question for the next steward (if same human)

Several of today's PRs (`#142`, `#170`, `#177`, `#175`) are part of
the pass-style-promise / @endo/bytes / eventual-send-shim cluster
and may require coordinated landing. The conductor will surface
inter-PR dependencies in `process/PR-DISPATCH-STATE.md` per the
pre-flight rule, but a future steward should keep an eye on the
ordering.
