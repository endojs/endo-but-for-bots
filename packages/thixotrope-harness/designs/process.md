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
Last run: cross-lane close-out (X-CLOSE), 2026-11-18 15:33-16:04 UTC, at `717e26789f` (lane
`endo-thix-int`, M3, M4 and M5 merged), shared slots, load 2.2-4.8, with the long-session
template chains (section 3.2) holding one or two slots beside it. Commands from the package:
`corepack yarn test`, `corepack yarn test:integration --jobs 5`, then
`corepack yarn test:browser --jobs 5 test/browser/*.test.mjs`.

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

| list | part | file | held s | exit |
|---|---|---|---|---|
| core | unit + adapter | `corepack yarn test` (1,244 passed, 115 skipped, 1 failed: `run-lock` "in-process takers racing" at load 4, passes alone; no slot) | 67 (wall) | 1, then 0 alone |
| core | integration | `m1a-provision` | 190 | 0 |
| core | integration | `m1a-slice` | 201 | 0 |
| core | integration | `m1a-slice-crash` | 114 | 0 |
| core | integration | `m1a-slice-restart` | 199 | 0 |
| core | integration | `m1b-content` | 104 | 0 |
| core | integration | `m1b-context-restart` | 226 | 0 |
| core | integration | `m1b-exec-tool` | 198 | 0 |
| core | integration | `m1b-exec-tool-restart` | 128 | 0 |
| core | integration | `m1b-followups` | 297 | 0 |
| core | integration | `m1b-live` | 167 | 1 (acceptance 9 rename row 638 ms against 500 at load 3-4; alone 117 s, exit 0, rename 61-158 ms) |
| core | integration | `m1b-pool` | 144 | 0 |
| core | integration | `m1b-pool-restart` | 125 | 0 |
| core | integration | `m1b-qc` | 117 | 0 |
| core | integration | `m2-archive-restart` | 166 | 0 |
| core | integration | `m2-archive-restart-2` | 202 | 0 |
| core | integration | `m2-catalog` | 87 | 0 |
| core | integration | `m2-history` | 218 | 0 |
| core | integration | `m2-lifecycle` | 189 | 0 |
| core | integration | `m2-lifecycle-export` | 252 | 0 |
| core | integration | `m2-probes` | 81 | 0 |
| core | integration | `m2-providers` | 92 | 0 |
| core | integration | `m2-queue` | 151 | 0 |
| core | integration | `m2-secrets` | 86 | 0 |
| core | integration | `m2-turns` | 213 | 0 |
| core | integration | `test/template/template.test.js` | 83 | 0 |
| M3 | integration | `m3-gateway` | 114 | 0 |
| M3 | integration | `m3-reconnect` | 159 | 0 |
| M3 | integration | `m3-sessions` | 118 | 0 |
| M3 | browser | `m3-ui` | 110 | 0 |
| M3 | browser | `m3-ui-restart` | 202 | 0 |
| M3 | browser | `m3-ui-history` | 110 | 0 |
| M4 | integration | `m4-accounts` | 86 | 0 |
| M4 | integration | `m4-catalog` | 86 | 0 |
| M4 | integration | `m4-pools` | 101 | 0 |
| M4 | integration | `m4-provision` | 103 | 0 |
| M4 | integration | `m4-reachability` | 86 | 0 |
| M4 | integration | `m4-renewal` | 93 | 0 |
| M4 | integration | `m4-restart` | 180 | 0 |
| M4 | integration | `m4-restart-renewal` | 101 | 0 |
| M4 | integration | `m4-retire` | 79 | 0 |
| M4 | integration | `m4-secrets` | 89 | 0 |
| M4 | integration | `m4-wire` | 110 | 0 |
| M4 | browser | `m4-ui` | 95 | 0 |
| M5 | integration | `m5-grants` | 86 | 0 |
| M5 | integration | `m5-grants-restart` | 118 | 0 |
| M5 | integration | `m5-labels` | 106 | 0 |
| M5 | integration | `m5-mentions` | 74 | 0 |
| M5 | integration | `m5-mentions-restart` | 93 | 0 |
| M5 | integration | `m5-objects` | 95 | 0 |
| M5 | integration | `m5-presets` | 110 | 0 |
| M5 | integration | `m5-presets-inventory` | 98 | 0 |
| M5 | integration | `m5-prompt` | 95 | 0 |
| M5 | integration | `m5-reachability` | 81 | 0 |
| M5 | integration | `m5-security` | 77 | 0 |
| M5 | integration | `m5-snapshot` | 75 | 0 |
| M5 | browser | `m5-ui` | 105 | 0 |

Integration: 51 files, 6,641 s held, **1,433 s wall** at 5 jobs (296 s of waits for a slot in
all, three files waiting behind the template chains); browser: 5 files, 622 s held, 202 s wall
at 5 jobs. No file over 5 minutes (longest `m1b-followups` 297 s), none timed out. Before it, the
milestone templates were built in shared slots (`exec` 58 s, `pool` 57 s, `m3-300` 94 s; `m1a`,
`m4`, `m5o` were current). The previous run (M2 close-out, `d7fce8e46c`, 25 files, 3,792 s held,
1,040 s wall at 4 jobs) is in J-9495.

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
for it (a core or worker change).

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
  3.5 % of normalised lines in repeated blocks (measured 3.22 %, 865 of 26,887 lines, at
  `802bd2767c`). A change that lowers the share lowers the ceiling in the same commit; nobody
  raises it.
- **Fakes from the real guards.** A fake is a `makeExo` with the product's interface guard, or
  the product's own assembly; a hand `Far` object or a re-assembled program is a review finding,
  and so is a product branch only tests take.
- **Manager changes batched.** A change to the agent-host manager part is a reinstall that
  breaks live references: a contract states why it cannot live in the adapter, and a parallel
  group lands its manager changes as one batch (one reinstall), not one per unit.
- **Review question.** Every contract review asks: what here is a string that stands for an
  object, a reason or a position (a glob, an error text, a label lookup, a page offset)?
