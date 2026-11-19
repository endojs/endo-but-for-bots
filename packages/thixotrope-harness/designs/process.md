# How the harness is built: lanes, test slots, time boxes, time record

For the agents that build `packages/thixotrope-harness` and the PM who runs them. Owner's
rules (2026-11-18): the machine is mostly idle, so work in parallel and use the disk; record how
the time is spent; nothing we test may take hours ("this should probably be a rate per fixed time
test").

## 1. Lanes

A lane is one git worktree for one independent line of work (a milestone, a tooling unit). Lanes
sit next to each other: `<parent>/endo-thix-<name>` on the local branch `claude/thix-<name>`, cut
from the main harness branch `claude/thixotrope-harness`.

```sh
packages/thixotrope-harness/scripts/new-lane.sh NAME [BASE]   # create or bring up to date
packages/thixotrope-harness/scripts/new-lane.sh --remove NAME  # only when fully merged
```

`new-lane.sh` adds the worktree, runs `corepack yarn install --immutable`, links the release
Ironhorse worker (no cargo, below), builds the Ironhorse boot bundles, and prints each step's
time. It is idempotent and refuses a directory that is not that lane. Measured (J-9520): about
23 s to create a lane with a warm yarn cache, 5 s to re-run it; 1.3 GB on disk as `du` counts it,
about 0.3 GB of new blocks (the pnpm linker hard-links packages from the shared store).

The worker: tests and `scripts/serve.mjs` run `THIXOTROPE_IRONHORSE_WORKER`, else
`<repo>/target/release/thixotrope-ironhorse-worker`. `new-lane.sh` copies the release worker once
per content to `$THIX_HARNESS_HOME/worker/<sha256 prefix>/` (default
`~/.cache/thixotrope-harness`) and links the lane's `target/release/thixotrope-ironhorse-worker`
to it. The default lookup then works without any environment, all lanes share one copy, and a
rebuild in the core lane never swaps the binary under a lane's running test. The directory name
says which worker a lane runs; `shasum -a 256` of the link target is the full digest.

Rules:

- **The PM merges; lanes never push.** No `git push`, rebase, amend, reset, stash or clean in a
  lane. Commit with explicit paths.
- **Merge order: main into the lane, then the lane into main.** The PM merges
  `claude/thixotrope-harness` into the lane first, runs the lane's regression run there (section
  3), and only then merges the lane into main, so main only ever receives a tested combination.
- **A lane does not change the core or the engine** (`packages/thixotrope`, `rust/**`, other
  Endo packages) without a `CORE-CHANGES.md` entry in the same commit series, and **does not
  build with cargo** unless it is the core lane. A new worker reaches other lanes through the PM:
  core lane merged, then `new-lane.sh NAME` re-run in each lane.
- **Numbers are reserved per unit.** The PM gives each unit a block of journal numbers
  (`J-9520..J-9529`) and, when it may change the core, a block of CC numbers. Use only your
  block; ask the PM for more.
- **Append-only files merge by union.** The repository's `.gitattributes` sets `merge=union` for
  this package's `JOURNAL.md`, `CORE-CHANGES.md` and `TIMELOG.md`: two lanes that append different
  entries merge with no conflict and both are kept (trial: J-9521). Union merge cannot:
  - notice two entries with the same number: both are kept. After a merge the PM runs
    `grep -o '^### J-[0-9]*' JOURNAL.md | sort | uniq -d` (and the same for `^### CC-`); any output
    is a clash to renumber.
  - order entries: the result is base, then ours, then theirs.
  - keep the blank line between two entries appended at the same place: it can join them. Run
    prettier on the file after the merge.
  - merge a table or paragraph edited on both sides: it keeps both versions of the lines, which
    looks clean and is wrong. Review the diff of every union-merged file whose existing lines (not
    only its end) changed on both sides.
- `new-lane.sh --remove NAME` removes a lane only when its branch is in
  `claude/thixotrope-harness` (or in the branch given as a second argument) and it has no
  uncommitted or untracked files.

## 2. Test slots

Ironhorse workloads (integration tests, spikes, perf checks, the core's Ironhorse lane) take the
run lock `scripts/run-lock.mjs`. It was one exclusive lock per checkout (`tmp/.run.lock`); it is
now a machine-wide pool of slots (the script's header comment is the reference):

- **Where:** `<THIX_HARNESS_HOME>/run-lock/slot`, `slot.1`, ... `slot.<N-1>`, shared by every
  worktree. N is `THIX_HARNESS_RUN_SLOTS` (default 6 since 2026-11-18, was 4); every taker on the machine must use the
  same N.
- **Shared** (default): take any free slot, wait while none is. **Exclusive** (`--exclusive`):
  wait until every slot is free and hold all of them. A process whose own arguments name a
  `perf/*.perf.mjs` file is exclusive by default, whether it is the CLI wrapper (`--shared`
  overrides) or the perf check itself (`node perf/x.perf.mjs`; `yarn perf` starts each check that
  way), so perf numbers are not taken on a loaded machine. An exclusive waiter sets an intent
  marker that stops new shared takers, so it is not starved.
- **Exclusive mode is for a milestone's recorded numbers only.** While an exclusive taker waits
  for the slots to drain, and while it runs, every lane is stopped. Measured from `runs.jsonl`
  over the lanes' first 2.5 hours (2026-11-18): 17 exclusive runs held 37 minutes in all, yet runs
  waited 4.4 hours against 3.3 hours held. So: a builder's perf smoke during a unit runs with
  `--shared`, records the load average, and marks the row "under load"; only a lane's integration
  unit and a review take exclusive mode, and they run their perf files back to back in one batch
  rather than spread through the work.
- **Time box (CLI wrapper only):** `--max-ms` (default 600,000; `THIX_HARNESS_RUN_MAX_MS`): a
  workload that runs longer gets SIGTERM, then SIGKILL 10 s later, and the wrapper exits **124**.
  Waiting for a slot does not count. Processes a workload leaves in its group when it exits are
  ended the same way before its slot is freed. A taker in process (`takeIntegrationLock`,
  `runPerf`, a spike's `takeRunLock`) has no box: run it under the CLI wrapper, as
  `corepack yarn test:integration` does for every integration file.
- **Attribution:** every exit of the CLI wrapper appends a line to `<THIX_HARNESS_HOME>/runs.jsonl`
  with the lane (worktree name), `THIX_AGENT`, label, mode, slot, time waited, time held, exit code
  and whether it timed out. A taker in process that is not nested in a wrapper logs the same line
  on release, with exit code null; a process that dies without releasing logs nothing. Set
  `THIX_AGENT` to your unit (for example `I-3`).
- Nested takers inside a held slot pass through (`THIX_HARNESS_RUN_LOCK`), as before.
- **Transition:** a worktree whose branch predates the slot lock still takes its own
  `tmp/.run.lock` and does not see the slots, so an exclusive perf run is machine-exclusive only
  once every running worktree has merged it.

Do not run a lane's full unit suite and its integration files at the same time against one
`tmp/`.

## 3. Time boxes

The owner's rule: we do not test anything that takes hours.

- **No test file and no perf check runs longer than 10 minutes.** The CLI wrapper enforces it
  (exit 124); `corepack yarn test:integration` wraps each file separately. A file that needs
  longer is split or redesigned; it is not exempted.
- **A perf check measures a rate or a latency over a fixed window** (default 60 s per measured
  point), not a count of operations, and reports per-minute or per-operation figures (turns per
  minute, deliveries per second, median and p99 ms per operation, with the number of samples the
  window held). A point with too few samples says so; it does not run longer.
- **Large states are built by import, never by replaying turns.** A long session or many
  sessions are written as an export (`writeSyntheticExport`) and loaded with `importState`, or
  copied from a cached template; a check never runs thousands of turns to get there. A state that
  takes more than a few minutes to import is cached as a template (keyed like
  `test/template/index.js`) and built once per worker and bundle change.
- **A milestone's whole regression run finishes in 20 minutes of wall time**, using the slots: unit
  lane, adapter lane and integration files spread over the shared slots. The perf checks are a
  separate pass, one at a time in exclusive mode, each inside its own 10-minute box. The PM keeps
  the list of what is in each and its last wall time.
- Anything that cannot fit is redesigned (smaller window, imported state, a Node-level test of the
  logic, a cached template), and the reason goes in the journal.

### 3.1 The regression run (the PM's list)

What a regression run contains, with each file's held time from `runs.jsonl` and the wall time.
Commands from the package, one batch each (S2, HR-SYN-18): `corepack yarn test:regression:core`
(the unit and adapter lanes, then the core files) and `corepack yarn test:regression:milestones`
(the M3, M4 and M5 files with their browser files); each prints every file's held and waited time
and the batch's wall time. The lists live in `scripts/test-integration.mjs` `regressionLists`, and
a unit test keeps every integration, template and browser file in exactly one list.

M6 uses `corepack yarn test:integration --list environments` for the preset, shell, restart,
stop/export and browser settings files. In a deep checkout, set `THIX_HARNESS_TMP` to a short,
private directory dedicated to this checkout so its Unix socket paths fit the host limit.

Last run: the step 3 close-out (T3-CLOSE, J-10251), 2026-11-19 00:09-00:37 UTC, at
`804398c4d9` (lane `endo-thix-clean`, after the review's step 3, documents edited), 6 jobs in
shared slots, load 2.0-4.3, with the long-session template chain (section 3.2) holding one slot
beside it. **Core list: 25 files, 4,344 s held, 922 s wall (989 s with the unit lane, 16.5 min);
milestones list: 31 files (26 + 5 browser), 3,326 s held, 665 s wall (11.1 min).** Both fit the
20-minute rule; all 56 files passed. The CL-CLOSE column is the run before (2026-11-18
21:03-21:31 UTC at `bd4c811b7b`, J-10191).

**The one-run rule no longer holds.** With M3, M4 and M5 the run is 1 unit lane, 51 integration
files and 5 browser files: **7,263 s held** (unit lane not counted), and the measured wall time was
67 s + 1,433 s + 202 s = **1,702 s (28.4 min)** run one part after the other, against the
20-minute rule. Even on an idle machine with all six slots it cannot fit: 7,263 / 6 = 1,211 s
(20.2 min) plus the unit lane, before any slot is lost to packing. **PM ruling (2026-11-18,
recorded by K1, J-10075): the regression run is split as follows**, each list one batch that
finishes inside 20 minutes of wall at six slots:

- **Core list** (every lane runs it): unit and adapter lanes, M0-M2 integration files and the
  template test: 25 files, 4,029 s held, about 13-14 minutes at 5-6 jobs (longest file 297 s).
- **Per-milestone list** (a lane runs its own; a merge runs all): M3 (3 integration files, 391 s,
  plus 3 browser files, 422 s), M4 (11 files, 1,114 s, plus `m4-ui`, 95 s), M5 (12 files,
  1,107 s, plus `m5-ui`, 105 s): together 26 + 5 files, 3,234 s held, about 10 minutes at 6
  jobs.
- A merge regression is the two lists as two batches (about 25 minutes of wall in all); each batch
  stays inside 20 minutes. Waits for slots are reported apart from held time.

| list | part | file | held s | waited s | exit | CL-CLOSE held s |
|---|---|---|---|---|---|---|
| core | unit + adapter | `ses-ava` (1,328 passed, 116 skipped; no slot) | 67 (wall) | - | 0 | 67 (wall) |
| core | integration | `m1a-provision` | 222 | 0 | 0 | 227 |
| core | integration | `m1a-slice` | 236 | 0 | 0 | 236 |
| core | integration | `m1a-slice-crash` | 134 | 0 | 0 | 127 |
| core | integration | `m1a-slice-restart` | 247 | 0 | 0 | 241 |
| core | integration | `m1b-content` | 134 | 18 | 0 | 135 |
| core | integration | `m1b-context-restart` | 239 | 0 | 0 | 228 |
| core | integration | `m1b-exec-tool` | 182 | 88 | 0 | 163 |
| core | integration | `m1b-exec-tool-restart` | 115 | 0 | 0 | 117 |
| core | integration | `m1b-followups` | 297 | 44 | 0 | 268 |
| core | integration | `m1b-live` | 184 | 0 | 0 | 174 |
| core | integration | `m1b-pool` | 190 | 0 | 0 | 162 |
| core | integration | `m1b-pool-restart` | 185 | 0 | 0 | 166 |
| core | integration | `m1b-qc` | 150 | 21 | 0 | 139 |
| core | integration | `m2-archive-restart` | 175 | 0 | 0 | 168 |
| core | integration | `m2-archive-restart-2` | 199 | 0 | 0 | 195 |
| core | integration | `m2-catalog` | 95 | 0 | 0 | 88 |
| core | integration | `m2-history` | 231 | 0 | 0 | 214 |
| core | integration | `m2-lifecycle` | 197 | 0 | 0 | 193 |
| core | integration | `m2-lifecycle-export` | 257 | 140 | 0 | 273 |
| core | integration | `m2-probes` | 80 | 0 | 0 | 80 |
| core | integration | `m2-providers` | 85 | 0 | 0 | 84 |
| core | integration | `m2-queue` | 152 | 0 | 0 | 155 |
| core | integration | `m2-secrets` | 79 | 0 | 0 | 78 |
| core | integration | `m2-turns` | 208 | 0 | 0 | 216 |
| core | integration | `test/template/template.test.js` | 71 | 0 | 0 | 69 |
| M3 | integration | `m3-gateway` | 155 | 0 | 0 | 143 |
| M3 | integration | `m3-reconnect` | 175 | 0 | 0 | 165 |
| M3 | integration | `m3-sessions` | 133 | 0 | 0 | 130 |
| M3 | browser | `m3-ui` | 113 | 0 | 0 | 116 |
| M3 | browser | `m3-ui-restart` | 216 | 0 | 0 | 215 |
| M3 | browser | `m3-ui-history` | 110 | 47 | 0 | 92 |
| M4 | integration | `m4-accounts` | 89 | 0 | 0 | 89 |
| M4 | integration | `m4-catalog` | 89 | 0 | 0 | 88 |
| M4 | integration | `m4-pools` | 100 | 0 | 0 | 97 |
| M4 | integration | `m4-provision` | 104 | 0 | 0 | 96 |
| M4 | integration | `m4-reachability` | 86 | 0 | 0 | 83 |
| M4 | integration | `m4-renewal` | 92 | 0 | 0 | 96 |
| M4 | integration | `m4-restart` | 175 | 0 | 0 | 176 |
| M4 | integration | `m4-restart-renewal` | 107 | 0 | 0 | 108 |
| M4 | integration | `m4-retire` | 82 | 0 | 0 | 79 |
| M4 | integration | `m4-secrets` | 94 | 0 | 0 | 88 |
| M4 | integration | `m4-wire` | 110 | 191 | 0 | 109 |
| M4 | browser | `m4-ui` | 81 | 0 | 0 | 83 |
| M5 | integration | `m5-grants` | 79 | 0 | 0 | 79 |
| M5 | integration | `m5-grants-restart` | 114 | 0 | 0 | 107 |
| M5 | integration | `m5-labels` | 106 | 0 | 0 | 105 |
| M5 | integration | `m5-mentions` | 79 | 0 | 0 | 77 |
| M5 | integration | `m5-mentions-restart` | 97 | 0 | 0 | 114 |
| M5 | integration | `m5-objects` | 92 | 0 | 0 | 93 |
| M5 | integration | `m5-presets` | 120 | 10 | 0 | 123 |
| M5 | integration | `m5-presets-inventory` | 101 | 0 | 0 | 121 |
| M5 | integration | `m5-prompt` | 91 | 112 | 0 | 90 |
| M5 | integration | `m5-reachability` | 85 | 0 | 0 | 86 |
| M5 | integration | `m5-security` | 84 | 0 | 0 | 87 |
| M5 | integration | `m5-snapshot` | 75 | 0 | 0 | 72 |
| M5 | browser | `m5-ui` | 94 | 0 | 0 | 91 |

T3-CLOSE: 56 files, 7,670 s held (CL-CLOSE 7,494 s, +2.3 %), none over 5 minutes held (longest
`m1b-followups` 297 s, `m2-lifecycle-export` 257 s), none timed out, none failed (`m1b-exec-tool`,
CL-CLOSE's load flake, passed at 182 s held). Waits are slot waits behind the template chain
(`m4-wire` waited 191 s, `m2-lifecycle-export` 140 s). The milestone templates were rebuilt first
(guest and adapter bundles changed in step 3): 169 s wall for the six in parallel (J-10250).
CL-CLOSE: 56 files, 7,494 s held (X-CLOSE 7,263 s), none over 5 minutes held (longest
`m2-lifecycle-export` 273 s, `m1b-followups` 268 s), none timed out. Waits are slot waits behind
the template chain and the list's own files (`m3-ui-history` waited 340 s for a slot). The one
failure, `m1b-exec-tool` acceptance 11, expected the exec call killed on every attempt to end with
the exec-terminated text and got the call's own answer `4`: the killer did not end the worker
inside the call's 4 s sleep at load 4-5. It passed alone at once and passed in every earlier
recorded run (M2-R3, M2-CLOSE, X-CLOSE); read as a load flake of a kill-timing test, not a
cleanup defect; not fixed. Before the run the milestone templates were rebuilt in shared slots
(all six keys changed with the fold: 166 s wall in parallel; `m1a` 66 s, `exec` 71 s, `pool`
72 s, `m4` 58 s, `m3-300` 107 s, `m5o` current). X-CLOSE's run (51 + 5 files, 7,263 s held,
1,433 + 202 s wall at 5 jobs, one run) is in J-10060; the M2 close-out's (25 files, 1,040 s wall
at 4 jobs) in J-9495.

### 3.2 The perf pass (the PM's list)

Every `perf/*.perf.mjs`, one after another, each as
`node scripts/run-lock.mjs --exclusive --label perf-<name> -- node perf/<name>.perf.mjs`, in one
batch (it stops every lane); `perf/ui.perf.mjs` also needs `THIX_HARNESS_BROWSER=1`. Templates
must exist first, built in shared slots: the long-session ones (`node perf/_long-template.mjs
history journal throughput`; rebuilt after any guest-bundle change) and the milestone ones the
files copy (`m1a`, `exec` and `m5o` through their helpers, `m4`, and `m3-300` with
`node perf/_m3-client.mjs template`). Measured at X-CLOSE (shared slots, beside the regression
run, load 2-5): long 200 / 1,000 / 5,000 held 89 / 158 / 473 s; busy 10..50 held 440, 391, 381,
375, 357 s (one chain, 38 minutes of wall with waits); `exec` 58 s, `pool` 57 s, `m3-300` 94 s.

The whole list is now 25 + 13 = 38 files (M0-M2 69.5 minutes, M3-M5 about 55 minutes; K2 split `gateway-restart` out of `gateway-session`), more
than two hours of every lane stopped. **PM ruling (2026-11-18, recorded by K1,
J-10075):** a milestone's recorded perf pass is its own files plus the cross-check `session`,
`turn` and `exec` (the cross-check about 7 minutes); the whole list runs only when the PM asks
for it (a core or worker change). One command runs it (S2): `corepack yarn perf:pass <M2|M3|M4|M5|all>`
brings the templates up to date in shared slots, runs the files back to back in exclusive mode
and prints each file's held time; the lists are `perfLists` in `perf/_pass.mjs`, and a unit test
keeps every perf check in exactly one of them.

**M3, M4, M5 and the cross-check** (X-CLOSE, 2026-11-18 16:12-17:19 UTC, at `404e60ea3a`, load
1.0-2.8: 15 files, **4,004 s held (66.7 minutes), 66.8 minutes of wall**; exit 1 means a budget
missed, each listed):

| file | held s | exit | budget misses that set the exit |
|---|---|---|---|
| `perf/session.perf.mjs` | 156 | 0 | - (`session.createCold` 1.04 x is inside the 1.25 x rule) |
| `perf/turn.perf.mjs` | 129 | 0 | - |
| `perf/exec.perf.mjs` | 111 | 0 | - |
| `perf/gateway.perf.mjs` | 329 | 0 | - |
| `perf/gateway-session.perf.mjs` | 602 | **124** | none; every row measured by 555 s, then the clean stop after the SIGKILL window passed the box (fixed by K2: the restart rows are `perf/gateway-restart.perf.mjs`; K2 held 311 s, exit 0) |
| `perf/ui.perf.mjs` | 438 | 1 | `ui.hubGrowth` row 1.91 x |
| `perf/subscriptions.perf.mjs` | 208 | 1 | `subscriptions.servedWrites` 4.97 x (frames, GC included; K2 counts cranks: 1.00 per 60 s, exit 0); `subscriptions.bundles` (stale baseline) |
| `perf/subscriptions-lifecycle.perf.mjs` | 371 | 0 | - |
| `perf/secrets.perf.mjs` | 275 | 1 | `secrets.catalog` 2.58 x |
| `perf/accounts.perf.mjs` | 128 | 0 | - |
| `perf/presets.perf.mjs` | 199 | 1 | `presets.save` 1.66 x, `inventory.page` 3.65 x |
| `perf/creation-m5.perf.mjs` | 285 | 1 | `prompt.compose` (+408 ms, 1,499 ms) |
| `perf/exec-m5.perf.mjs` | 277 | 0 | - |
| `perf/tools.perf.mjs` | 348 | 1 | `tools.local` +126 ms |
| `perf/mentions.perf.mjs` | 148 | 1 | `mentions.turnStart` 388 ms, +247 ms, +0.6 deliveries |

Rows and readings: `JOURNAL.md` J-10061..J-10063; verdicts: `milestones.md` M3, M4 and M5
outcomes.

**K2 mini-batch** (2026-11-18 17:59-18:28 UTC, at `46cc84bb16`, the combination of the lane and
main with CC-026..CC-028, load 1.0-2.8: 7 files, **1,704 s held (28.4 minutes), 28.4 minutes of
wall**, slot waits under 0.1 s; templates current, none rebuilt; rows and readings `JOURNAL.md`
J-10077..J-10086):

| file | held s | exit | budget misses that set the exit |
|---|---|---|---|
| `perf/archive.perf.mjs` | 246 | 0 | - (`archive.stall.at200` p99 1,239 ms, 1.24 x: inside the 1.25 x rule; M2 1.40 x) |
| `perf/history.perf.mjs` | 236 | 1 | `archive.flat.turnStart.at1000` 1.99 x (261 ms against 131 at 200; both under 350) |
| `perf/hub.growth.perf.mjs` | 222 | 0 | - |
| `perf/frames.perf.mjs` | 106 | 0 | - |
| `perf/subscriptions.perf.mjs` | 209 | 0 | - (`subscriptions.bundles` stale baseline, reported, not counted) |
| `perf/gateway-session.perf.mjs` | 311 | 0 | - |
| `perf/gateway-restart.perf.mjs` (new, K2) | 375 | 0 | - |

**CL-CLOSE mini-pass after the review's steps 1 and 2** (2026-11-18 21:30:44-21:51:04 UTC, at
`70e7be3553` with only these documents edited, load 1.3-3.5: 6 files, **1,207 s held, 1,220 s of
wall**; the cross-check plus one file each of M3, M4 and M5 over folded code; templates rebuilt
under the new keys first, section 3.1; rows and readings `JOURNAL.md` J-10192):

| file | held s | exit | budget misses that set the exit |
|---|---|---|---|
| `perf/session.perf.mjs` | 158 | 0 | - (`session.createCold` 6,095 ms, X-CLOSE 6,249) |
| `perf/turn.perf.mjs` | 128 | 0 | - |
| `perf/exec.perf.mjs` | 108 | 0 | - |
| `perf/gateway.perf.mjs` | 329 | 1 | `ui.deltaFanout` 5 deliveries over 1,100 deltas (0.0045 per delta, budget 0; X-CLOSE 0, the lane 0.007-0.010: carried, intermittent) |
| `perf/subscriptions.perf.mjs` | 209 | 0 | - (`subscriptions.turnStart` median 248 ms, rerun 110 ms, held 207 s: one bimodal window) |
| `perf/exec-m5.perf.mjs` | 275 | 1 | `exec.tooBig.probe.b`: the 200 KB help is refused by the hub since CC-027 and the file's check does not accept that outcome (the integration test does since `385b8a703c`); not from the fold |

**T3-CLOSE mini-pass after the review's step 3** (2026-11-19 00:37:28-01:14:06 UTC, at
`804398c4d9` with only documents edited, load 1.6-4.3: 6 files, **1,159 s held, 2,198 s of wall**,
1,038 s of it waiting for the long-session chain's shared steps; the cross-check, plus `history`
and `archive` (the turn runner and the archive coupling moved) and `exec-m5` (the too-big probes);
each file run as `perf:pass` runs it, templates rebuilt first; rows and readings `JOURNAL.md`
J-10252):

| file | held s | exit | budget misses that set the exit |
|---|---|---|---|
| `perf/session.perf.mjs` | 160 | 0 | - (`session.createCold` 6,379 ms, CL-CLOSE 6,095) |
| `perf/turn.perf.mjs` | 129 | 0 | - (2 deliveries per turn start, 3 per round, 1 lease: unchanged) |
| `perf/exec.perf.mjs` | 110 | 0 | - |
| `perf/history.perf.mjs` | 240 | 1 | `archive.flat.turnStart.at1000` 1.83 x (258 ms against 141 at 200; K2 1.99 x, carried) |
| `perf/archive.perf.mjs` | 245 | 0 | - (`archive.stall.at200` p99 1,233 ms, K2 1,239) |
| `perf/exec-m5.perf.mjs` | 275 | 0 | - (`exec.tooBig.probe.b` now `helpUnavailable`, passes: CL-CLOSE's miss is gone) |

**M0-M2** (last run at the M2 close-out; not rerun at X-CLOSE except the cross-check above):

| file | held s | exit | budget misses that set the exit |
|---|---|---|---|
| `perf/exec.perf.mjs` | 107 | 0 | - |
| `perf/frames.perf.mjs` | 107 | 0 | - |
| `perf/turn.perf.mjs` | 127 | 0 | - |
| `perf/session.perf.mjs` | 146 | 0 | - |
| `perf/pool.perf.mjs` | 132 | 1 | `session.create.pool` 1.46 x |
| `perf/concurrency.perf.mjs` | 142 | 1 | `concurrency.10` turn start, crank p95 |
| `perf/gc.perf.mjs` | 298 | 0 | - |
| `perf/hub.perf.mjs` | 133 | 0 | - |
| `perf/hub.growth.perf.mjs` | 221 | 0 | - |
| `perf/hub.sessions.perf.mjs` | 281 | 1 | `hub.growth.slope` projected to 50 sessions |
| `perf/crank.perf.mjs` | 174 | 0 | - |
| `perf/crank.mid.perf.mjs` | 122 | 0 | - |
| `perf/crank.late.perf.mjs` | 224 | 0 | - |
| `perf/install.perf.mjs` | 57 | 0 | - |
| `perf/crash.perf.mjs` | 277 | 1 | `crash.restart.bound5` by design (C-8, C-9) |
| `perf/restart.perf.mjs` | 226 | 0 | - |
| `perf/restart.crash.perf.mjs` | 222 | 0 | - |
| `perf/queue.perf.mjs` | 33 | 0 | first run exit 255 after 13 s (a conversion defect, J-9495), fixed and rerun |
| `perf/provider.perf.mjs` | 93 | 0 | - |
| `perf/import.perf.mjs` | 118 | 0 | - |
| `perf/archive.perf.mjs` | 238 | 1 | `archive.stall.at200` 1.40 x (C-24) |
| `perf/history.perf.mjs` | 214 | 1 | `archive.flat.hubRow.at1000` 1.39 x (K2: 1.01 x; both reads still owed one answer after the 10 s quiescent wait; see the K2 mini-batch above) |
| `perf/history.restart.perf.mjs` | 165 | 0 | - |
| `perf/journal.perf.mjs` | 143 | 0 | - |
| `perf/throughput.perf.mjs` | 158 | 0 | - |

Last pass: M2 close-out (M2-CLOSE), 2026-11-18 10:48-11:58 UTC, at `6628dbf8a1`, load 1.1-2.4:
25 files, **4,171 s held in all (69.5 minutes), 69.7 minutes of wall**, no file over 5 minutes,
none timed out; exit 1 means a budget missed (each listed), not a harness error. The template
builds before it held 148 + 152 + 488 s (long 200, 1,000, 5,000) and 417 + 392 + 366 + 353 + 352 s
(busy 10..50) in shared slots, two chains side by side (about 32 minutes of wall). Rows and
readings: `JOURNAL.md` J-9495..J-9499; verdicts: `milestones.md` M2 outcome.

## 4. Time record

- Every agent records its start and end time (`date -u +%Y-%m-%dT%H:%M:%SZ` as its first and last
  command) and every command of its own that ran longer than 60 s, with its duration, and reports
  them with its result.
- The run lock logs every Ironhorse run that holds a slot, its wait and its hold, to
  `<THIX_HARNESS_HOME>/runs.jsonl` (section 2).
- `scripts/process-time.mjs` regenerates `TIMELOG.md` after every workflow from the PM session's
  transcripts (each agent's tool calls and model turns, timed from the transcript) and the run
  log; it does not read the agents' reports.
- The PM looks at: wall time per unit and per milestone; time spent waiting for the run lock or a
  slot against time running; the longest commands; and repeated work (rebuilt templates,
  reinstalls). A unit whose waits exceed its runs, or a command near the 10-minute box, is the
  next thing to fix.

## 5. Checklist for a unit

At the start:

1. `date -u +%Y-%m-%dT%H:%M:%SZ`.
2. Work only in your lane's worktree and only in the files your unit owns.
3. Read this file, `designs/architecture.md` sections 10-12, `README.md` and the files you own.
4. Wait for the lane's install to be ready if the PM says so; run `new-lane.sh NAME` if the
   worker or bundles may be stale. Set `THIX_AGENT` to your unit.
5. Note your journal (and CC) number block.

At the end:

1. Prettier and eslint on the files you changed (from the repository root), `tsc` in the package
   if you touched JavaScript there, `corepack yarn lint:duplicates` in the package (section 6); the
   unit lane passes. Do not weaken an existing test.
2. Every new or changed test file and perf check fits section 3.
3. Commit with explicit paths, house-style subjects (`feat(thixotrope-harness): ...`). Nothing
   machine-local in the commit: no absolute paths, host names, keys or personal addresses.
4. Journal entries in your block: what was built or measured, the numbers, good or poor fit.
5. `date -u +%Y-%m-%dT%H:%M:%SZ`; report start, end, the commands over 60 s, and what is done,
   partial, blocked and not verified.

## 6. Rules for all later work (from the harness review)

The architecture review (`arch-review/harness.md` section 4) found that most of its 38 findings
came from how lanes were run: each lane built against its contract by appending, and every merge
kept every layer. From M6 on (PM rulings, 2026-11-18; the naming and code rules are also in
`milestones.md` "Rules from the harness review"):

- **Names.** Files, exports, types and test files are named by vat or concept, never by
  milestone or work unit: no `m6-*`, no `interfaces-m6.js`, no W-numbers in file names; tests are
  named for the subject and the behaviour. A contract may be per milestone; the code is not. A
  unit that is asked for a milestone-named file proposes the concept name instead.
- **Fold unit.** Every merge of parallel lanes ends with a fold unit, planned with the group: it
  removes the views, widenings, seams, stubs, empty registries and copies the lanes left, and is
  done when a grep or test shows them gone. The PM does not close a group without it.
- **Export, don't copy.** A lane may export a helper from another lane's or an earlier
  milestone's module rather than copy it. The export is a one-line seam listed in the contract and
  reviewed by that module's owner. A copy of more than 15 lines is a review finding.
- **Duplicate ceiling.** `corepack yarn lint:duplicates` (part of `yarn lint`) runs
  `arch-review/tools/find-duplicates.mjs` over `guest`, `resources` and `ui` and fails above
  2.05 % of normalised lines in repeated blocks (set by `d94ad96129` in step 3; measured 1.80 %,
  478 of 26,614 lines in 23 clusters, at `804398c4d9`; 3.00 % after the fold under a 3.25 %
  ceiling; 3.22 % at `802bd2767c` under 3.5 %). A change that lowers the share lowers the ceiling
  in the same commit; nobody raises it.
- **A shared index is shared.** Units in one worktree share git's index: stage a deletion or
  rename in the same command as its commit (`git rm` and `git commit -- <paths>` together), and
  always commit with a pathspec. In step 3 a `git rm` staged ahead was carried into another unit's
  commit and left HEAD broken for one commit (J-10213, J-10223).
- **Fakes from the real guards.** A fake is a `makeExo` with the product's interface guard, or
  the product's own assembly; a hand `Far` object or a re-assembled program is a review finding,
  and so is a product branch only tests take.
- **Manager changes batched.** A change to the agent-host manager part is a reinstall that
  breaks live references: a contract states why it cannot live in the adapter, and a parallel
  group lands its manager changes as one batch (one reinstall), not one per unit.
- **Review question.** Every contract review asks: what here is a string that stands for an
  object, a reason or a position (a glob, an error text, a label lookup, a page offset)?
