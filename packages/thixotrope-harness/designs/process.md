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
   if you touched JavaScript there; the unit lane passes. Do not weaken an existing test.
2. Every new or changed test file and perf check fits section 3.
3. Commit with explicit paths, house-style subjects (`feat(thixotrope-harness): ...`). Nothing
   machine-local in the commit: no absolute paths, host names, keys or personal addresses.
4. Journal entries in your block: what was built or measured, the numbers, good or poor fit.
5. `date -u +%Y-%m-%dT%H:%M:%SZ`; report start, end, the commands over 60 s, and what is done,
   partial, blocked and not verified.
