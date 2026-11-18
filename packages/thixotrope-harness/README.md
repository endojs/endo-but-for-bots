# @endo/thixotrope-harness

The Endo daemon harness (hosted AI-assistant sessions) rebuilt on Thixotrope
(`packages/thixotrope`). Private; nothing here is published.

Vats are the system of record and make the decisions; Node adapters carry the data. Code that
runs in Ironhorse vats lives in `guest/` and reads the Thixotrope prelude (`E`, `Far`, `M`,
`makeExo`, ...) from `globalThis`; it imports only relative modules, so its bundles carry no
second copy of an `@endo/*` library.

- Plan: `designs/architecture.md` (facts, decisions, core changes, limits, the turn sequence,
  test and perf method, guest rules) and `designs/milestones.md` (work units, acceptance tests, perf
  checks; each finished milestone's outcome table; "Changes after M0 and M1a" at the end). What M0
  measured and changed, and every core-change candidate with its status (C-1..C-21):
  `designs/m0-results.md`. The M1a interface contract, crank by crank: `designs/m1a-interfaces.md`.
  Surveys and plan reviews: `designs/survey/`, `designs/review-*.md`.
- Journal: `JOURNAL.md` records what fits Thixotrope and what does not, and every perf
  measurement. Append in your milestone's number block; never rewrite an entry.
- Core changes: `CORE-CHANGES.md` journals every change made outside this package (Thixotrope,
  Ironhorse, other Endo packages) with its motivation; add an entry with each such change.
- Settings: `config/defaults.js` (`limits`: frame sizes, crank budget, sends per crank, exec
  source size, vat key names, crash bound), with the evidence for each value.

Paths below are relative to this package unless they start with the repository root
(`../../`).

## Build what the tests run

Integration tests, spikes and perf checks run the release Ironhorse worker and the Ironhorse
boot bundles. Build both after any change to the engine, the worker, the polyfills or
`packages/thixotrope/src`:

```sh
# at the repository root
cargo build --locked --release -p thixotrope-ironhorse-worker
# in packages/thixotrope
corepack yarn build:ironhorse-bundles
```

The worker is `../../target/release/thixotrope-ironhorse-worker`
(`THIXOTROPE_IRONHORSE_WORKER` overrides it); since `f0ff5e098b` (CC-022, the allocation collection
schedule) its sha256 is
`367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25` (it rebuilds to the same digest;
was `7cda4467...`). The boot fingerprint is `6c864841...` (pinned in `0a4bdb3826`, unchanged since).
A change of either the worker or the bundles changes the boot digest: existing state directories
are refused, and cached test templates are rebuilt automatically (their key includes both). To
check that the bundles match the tree without touching them, build into a scratch directory under
the run lock (`node scripts/bundle-ironhorse-worker.mjs <dir>` in `packages/thixotrope`) and compare
with `cmp`. Rebuild the worker and the bundles only under the run lock: another run would break if
they changed under it. Use `corepack yarn`, not a global yarn.

## Unit tests and lint

```sh
corepack yarn test        # unit lane (ses-ava, lockdown); integration files and spikes skip
corepack yarn lint        # tsc + eslint, including the guest rules in lint/guest-rules.js
```

Run prettier from the repository root on the files you changed
(`corepack yarn prettier --check <files>`). The guest rules forbid `Date`, timers, `console`,
`Math.random`, `WeakRef`, `fetch`, `eval`, dynamic `import()`, non-relative imports and string
growth in loops under `guest/`; review still catches what the string rule cannot see.

## The run lock

Only one Ironhorse workload may run on this machine at a time: integration tests, spikes, perf
checks and the `packages/thixotrope` Ironhorse lane all take `tmp/.run.lock`.

```sh
node scripts/run-lock.mjs --label NAME [--timeout-ms N] -- <command> [args...]
```

The lock is held while the taker or its workload is alive (pid plus start time, so a reused pid
does not hold it); a stale lock is taken over safely by generation. A command run under the lock
sees `THIX_HARNESS_RUN_LOCK=<generation>`, and nested takers inside it pass through, so a script
that takes the lock itself can be run under the CLI. Uncontended take and release costs about
5 ms; a waiter polls every 500 ms.

## Integration tests

Integration files run only with `THIX_HARNESS_INTEGRATION=1`. Each file takes the run lock with
`takeIntegrationLock(test, label)` and starts state from a cached template through
`test/template/index.js`:

```js
const template = await ensureTemplate({ id: 'm1a', provision: steps }); // built once, cached in tmp/t<key>
const state = await startFromTemplate(template, { t });                 // clone + serve, idleSleepMs 2,000
await state.client.call('lookup', 'something');
await state.kill();       // SIGKILL of the supervisor process only
await state.restart();    // serve the same copy again
// cleanup (stop, kill strays, delete the copy) runs from t.teardown
```

```sh
THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label it -- \
  corepack yarn test test/template/template.test.js
```

Run one integration file per invocation, or all of them with

```sh
corepack yarn test:integration   # every file under test/integration and test/template, one at a time
```

which takes the run lock once and runs AVA with `--serial --concurrency 1`. Never give
`corepack yarn test` several integration files at once: AVA runs files in parallel worker
processes, and each file's `takeIntegrationLock` passes through the outer lock (a nested taker),
so their supervisors would run side by side.

The M1b acceptance files are `m1b-live` (1, 6, 9), `m1b-content` (2, 7), `m1b-exec-tool` (4, 5,
11), `m1b-exec-tool-restart` (3, 10), `m1b-context-restart` (8: 200 turns, a clean restart then an
idle SIGKILL; `CONTEXT_TURNS`, `CONTEXT_RESTARTS`), `m1b-pool` and `m1b-pool-restart` (12);
`m1b-qc` holds the M1b QC regressions (256-call rounds, the exec key flood, an exec background
loop). Known failures are marked with AVA's `test.failing` (or `test.skip` behind an opt-in
variable) and the reason in the title.

The M2 acceptance files (milestones.md M2; each runs alone in under 5 minutes against the fake
provider server on 127.0.0.1, `test/fixtures/fake-provider-server.mjs`): `m2-providers` (1, 6,
8), `m2-turns` (2, 12; 3 at the real 1,024-round limit is opt-in with `M2_TURNS_ROUND_LIMIT=1`,
about 280 s of turn alone, J-0471), `m2-queue` (4, 5, 10), `m2-secrets` (7, and the grep of the
whole state directory for every encoding of the key values), `m2-history` (9), `m2-catalog`
(11), `m2-lifecycle` (13, 14; `M2_DELETE_KILL_DELAY_MS` and `M2_CREATE_KILL_DELAY_MS` move its
SIGKILL points), `m2-archive-restart` (16), `m2-probes` (the too-big probes). Acceptance 15 (a
5,000-turn session behaves like a 200-turn one) is `perf/history.perf.mjs`, whose sessions are
built by `importState`. Files that use a Secret set `THIX_HARNESS_SECRETS_KEY` to a key file under
`tmp/` (outside the state directory) and remove it.

`m1a-slice-restart.test.js` repeats its SIGKILL cases (acceptance 5, 6, 7 and the held-ports
case) once per kill delay with `M1A_KILL_DELAYS_MS=0,100,500,1500,4000` (20 tests, about 10
minutes); each run prints an `m1a.slice.restart.case` line before its assertions. The M1b SIGKILL
cases take kill points too: `EXEC_KILL_DELAY_MS` (acceptance 10, default 2,000; the test also checks
that the killed exec ran at most once and that the provider got the turn once), `CONTEXT_RESTARTS`
with `CONTEXT_KILL_DELAYS_MS` (acceptance 8) and `POOL_KILL_DELAYS_MS` (acceptance 12).
`m1b-followups` covers the M1b follow-ups in real vats (name-table flood, exec scope, call fence,
`exec.sends.answered`).

A template start takes about 5 s against about 35-40 s for a cold provision. Copies live in
`tmp/<6 chars>`: the control socket path must stay under 104 bytes (98 in this checkout), so keep
the checkout path short or pass `startFromTemplate(template, { root })`. `KEEP_STATE=1` keeps the
copy; `removeTemplates()` deletes cached templates. Never copy a running state directory.

## Spikes (M0)

`test/spikes/s1..s9.test.js` record M0's measurements. They run only with
`THIX_HARNESS_SPIKES=1`, take the run lock themselves, use throwaway state under `tmp/` and print
JSON lines (`SPIKE_OUT=file` appends them). Each file documents its knobs (for example
`S1_BUDGETS`, `S1_PARTS`, `S6_COUNTS`, `S9_PLAN`). Example:

```sh
THIX_HARNESS_SPIKES=1 S1_BUDGETS=50000000 node scripts/run-lock.mjs --label s1 -- \
  corepack yarn test test/spikes/s1.test.js
```

S1's inbound part takes about 7 minutes per budget; S6's creation of 50 spares about 2 minutes.

## Perf checks

```sh
node perf/frames.perf.mjs          # one check; it takes the run lock itself
corepack yarn perf                 # every perf/<feature>.perf.mjs in turn
```

Each script uses `perf/_harness.mjs`: state goes in `tmp/pf<pid>` and is removed afterwards
(`KEEP_STATE=1` keeps it), started through the same supervisor child as integration tests, from
fresh state by default or from the cached base template with `PERF_TEMPLATE=1` (about 17 s
faster). Every metric is one JSON line on stdout (also appended to `PERF_OUT` when set), carrying
the commit, worker sha256, crank budget and load average; the exit code is 1 when a median (or
p95, p99, max, value) is over 1.25 x its budget or deliveries per operation are over theirs.
`IDLE_MS` (default 1 h) and `SNAP_EVERY` set the supervisor's idle sleep and snapshot cadence;
`FRAMES_N`, `LOOP_N`, `INSTALL_N` and `CRASH_*` shorten individual scripts.
`perf/crash.perf.mjs` and `perf/restart.perf.mjs` exit 1 by design while a restart with a crashing
vat misses its 15 s target (core candidates C-8, C-9). Paste the lines into `JOURNAL.md` with a
reading and a decision.

| script | rows | about |
| --- | --- | --- |
| `perf/turn.perf.mjs` | `turn.start` (+ `.open`, `.dispatch`, `.client`, `.deliveries`), `turn.delta`, `turn.delta.client`, `turn.round`, `turn.lease`, `turn.tooBig.*`, `turn.frames` | 4 min (`TURN_N` 200) |
| `perf/session.perf.mjs` | `session.program`, `install.factory`, `session.createCold` | 3 min |
| `perf/restart.perf.mjs` | `restart.serving` (gate: woken session vats = 1, read from the worker rows' `wakes`), `restart.crashingSession` | 6 min |
| `perf/gc.perf.mjs` | `gc.burst.turnStart`, `gc.burst.frames`, `gc.burst.hub`, `gc.restart` (C-17) | 6 min |
| `perf/crash.perf.mjs` | M0's crash and restart phases (C-8..C-10) | 6 min |
| `perf/hub.perf.mjs` | `hub.gcBurst`, `hub.gcBurst.turnStart`, `hub.growth` (C-20, C-2; `HUB_GROWTH=0` skips growth) | 10-20 min |
| `perf/exec.perf.mjs` | `exec.first`, `exec.trivial`, `exec.sends.answered` (`.sendOnly` not measurable in M1b), `exec.runaway`, `exec.retire`, the too-big probes `tooBig.*` | 3 min |
| `perf/pool.perf.mjs` | `session.create.pool` (+ `.poolAwake`), `session.create.cold`, `pool.refill`, `pool.firstTurn` | 3 min |
| `perf/concurrency.perf.mjs` | `concurrency.single.turnStart`, `concurrency.10.turnStart`, `.turn`, `.crank` (from `status().deliveryHistogram`), `.rowPush`, `.gc` | 3 min |
| `perf/history.perf.mjs` | M2: the long-session table (J-9383 form) at 50 / 200 / 1,000 / 5,000 turns, each session built by `importState` (`perf/_long-session.mjs`): `history.turn.at<n>`, `.turn.start`, `.snapshot`, `.stall`, `.seal`, `.history.page` (newest, vat) and `.archived` (`History`), `.hub.row`, `.archive` (disk), `.walk` (newest turn back to turn 1), `.heap`, `.context.rebuild` (with `sameContext`), then `archive.flat.*` (1,000 and 5,000 against 200 turns, <= 1.25 x; acceptance 15) (`HISTORY_POINTS`) | 30-45 min |
| `perf/journal.perf.mjs` | the same rows under `journal.` at 1,000 / 10,000 / 30,000 imported turns (plain shape), `journal.snapshot.budget.at<n>` (500 ms / 1 s / recorded), `session.heap`, `checkpoint.stall` (`JOURNAL_POINTS`, `JOURNAL_SNAP_EVERY`) | 1-1.5 h |
| `perf/throughput.perf.mjs` | 50 sessions x 300 turns by `importState`; `restart.serving.m2` (15 s; gate: no idle vat woken) and `throughput` (20 busy sessions, deliveries per second) | 30-40 min |
| `perf/archive.perf.mjs` (W2.5), `perf/import.perf.mjs` (W2.7), `perf/queue.perf.mjs` (W2.4, Node), `perf/provider.perf.mjs` (W2.1a, W2.1b, in process) | the archive grown by running every turn; the import rate; queue costs; provider overhead and SSE rates | see each file |
| `perf/crank.perf.mjs` | `crank.worker.<heap>[.alloc][.<policy>]` (the worker run directly on a vat image: per-delivery cost and its collection share), `crank.ping`, `crank.turn.start.early/.mid/.late`, `crank.history.page[.late]`, `crank.context.rebuild`, `crank.grow`, `crank.heap`; with `CRANK_POINTS` also `.at<n>` rows per session length; `crank.grow` carries engine and hub deltas per 100 turns (`CRANK_TURNS`, `CRANK_WORKER_N`, `CRANK_GC_POLICIES`, `CRANK_START`) | 40-50 min at 1,000 turns; the long-session table (`CRANK_TURNS=5000 CRANK_POINTS=200,1000,4000 CRANK_START=mixed`, J-9383) about 2.5 h. A session takes at most 4,096 Composer submissions in 24 h (`maxReceipts`, J-9391): `mixed` starts the unmeasured turns with `startTurn` |
| `perf/install.perf.mjs`, `perf/frames.perf.mjs` | M0's install and frame rows (`INSTALL_N`, `FRAMES_N`, `LOOP_N`) | a few minutes each |

A vat is woken when its worker row's `wakes` (process-local) is above 0; `journalLength` is the
delivery frontier, and held GC frames (`heldFrames`) wait in the journal without a crank. `turn.delta`
reads an in-process subscriber in the adapter (the file `tmp/live-probe/enabled` switches it on;
the script does this itself).

## The Ironhorse lane

The core's Ironhorse lane takes about 16-22 minutes; run it in the background under the lock and
wait for it:

```sh
cd ../thixotrope && node ../thixotrope-harness/scripts/run-lock.mjs --label lane -- \
  corepack yarn test:ironhorse > ../thixotrope-harness/tmp/lane.log 2>&1
```

It passes 69/69 (worker `367e78ad...`, `50f1d348eb`, 12.2 min; J-9302, J-9336; three tests run
under both collection schedules). Run it again after any change to the worker, the bundles or
`packages/thixotrope/src`. Any engine wrapper that
intercepts `deliver` must also intercept `deliverBatch` (J-9126).

## Serving a state directory

```sh
node scripts/serve.mjs STATE [--crank-budget N] [--max-delivery-attempts N] \
  [--idle-sleep-ms N] [--snapshot-every N]
```

The wrapper runs the supervisor in a child process whose environment is only an allowlist plus
`THIXOTROPE_CRANK_BUDGET` (default 50 M), `THIXOTROPE_MAX_DELIVERY_ATTEMPTS` (default 5,
2..100) and `THIXOTROPE_SLOT_CEILING` (default 4,000,000 from `config/defaults.js`, M1b QC; a
state persists its ceiling and is refused at a lower one, so test templates key on it). The
allowlist also passes the collection schedule (`THIXOTROPE_GC_POLICY` `allocation` by default or
`every-crank`, `THIXOTROPE_GC_SLOT_ALLOWANCE`, `THIXOTROPE_GC_CHUNK_ALLOWANCE`,
`THIXOTROPE_GC_CRANK_INTERVAL`; CC-022, CC-023: fixed per state directory, a change needs fresh
state) and the hub store (`THIXOTROPE_HUB_STORE`, `log` by default or `file`; CC-025: a log
directory keeps `hub-image.json` plus `hub-log.jsonl`, `hub.json` is a marker, and the migration is
one way). Templates key on any of these that is set, and every perf row names `gcPolicy` and
`hubStore`. To bisect against the old behaviour, run fresh state with
`THIXOTROPE_GC_POLICY=every-crank` or `THIXOTROPE_HUB_STORE=file`. It refuses
to lower the crank budget unless the last shutdown was clean
(`STATE/harness-serve.json` records it). The child stops cleanly when its parent dies, even by
SIGKILL. Stop with SIGINT or SIGTERM. If one vat crashes on every replay, the supervisor waits
for it to be retried out before it serves (36-69 s at the default bound): the control socket is
absent meanwhile.

## Other scripts

| Command | What it does |
| --- | --- |
| `node scripts/bundle-guest.mjs [program ...]` | Bundles `guest/<program>/main.js` into `dist-guest/<program>.js` without comments, refusing any module outside `guest/` |

## Disk

State for tests and perf lives under `tmp/` (git-ignored) and is deleted by the code that made
it; cached templates (about 160 MB each) stay until `removeTemplates()` or a key change. A
sleeping vat takes about 17 MB.
