# @endo/thixotrope-harness

The Endo daemon harness (hosted AI-assistant sessions) rebuilt on Thixotrope
(`packages/thixotrope`). Private; nothing here is published.

Vats are the system of record and make the decisions; Node adapters carry the data. Code that
runs in Ironhorse vats lives in `guest/` and reads the Thixotrope prelude (`E`, `Far`, `M`,
`makeExo`, ...) from `globalThis`; it imports only relative modules, so its bundles carry no
second copy of an `@endo/*` library.

- Plan: `designs/architecture.md` (facts, decisions, core changes, limits, test and perf method,
  guest rules) and `designs/milestones.md` (work units, acceptance tests, perf checks; "Changes
  after M0" at the end). What M0 measured and changed: `designs/m0-results.md`. Surveys and plan
  reviews: `designs/survey/`, `designs/review-*.md`.
- Journal: `JOURNAL.md` records what fits Thixotrope and what does not, and every perf
  measurement. Append in your milestone's number block; never rewrite an entry.
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
(`THIXOTROPE_IRONHORSE_WORKER` overrides it). A change of either the worker or the bundles
changes the boot digest: existing state directories are refused, and cached test templates are
rebuilt automatically (their key includes both). Use `corepack yarn`, not a global yarn.

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

A template start takes about 5.6 s against about 35 s for a cold provision. Copies live in
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
`perf/crash.perf.mjs` exits 1 by design while a restart with a crashing vat misses its 15 s target
(core candidates C-8, C-9). Paste the lines into `JOURNAL.md` with a reading and a decision.

## The Ironhorse lane

The core's Ironhorse lane takes about 16-22 minutes; run it in the background under the lock and
wait for it:

```sh
cd ../thixotrope && node ../thixotrope-harness/scripts/run-lock.mjs --label lane -- \
  corepack yarn test:ironhorse > ../thixotrope-harness/tmp/lane.log 2>&1
```

It passes 65/65 at the end of M0.

## Serving a state directory

```sh
node scripts/serve.mjs STATE [--crank-budget N] [--max-delivery-attempts N] \
  [--idle-sleep-ms N] [--snapshot-every N]
```

The wrapper runs the supervisor in a child process whose environment is only an allowlist plus
`THIXOTROPE_CRANK_BUDGET` (default 50 M) and `THIXOTROPE_MAX_DELIVERY_ATTEMPTS` (default 5,
2..100); it refuses to lower the crank budget unless the last shutdown was clean
(`STATE/harness-serve.json` records it). The child stops cleanly when its parent dies, even by
SIGKILL. Stop with SIGINT or SIGTERM. If one vat crashes on every replay, the supervisor waits
for it to be retried out before it serves (36-69 s at the default bound): the control socket is
absent meanwhile.

## Other scripts

| Command | What it does |
| --- | --- |
| `node scripts/bundle-guest.mjs [program ...]` | Bundles `guest/<program>/main.js` into `dist-guest/<program>.js`, refusing any module outside `guest/` |

## Disk

State for tests and perf lives under `tmp/` (git-ignored) and is deleted by the code that made
it; cached templates (about 160 MB each) stay until `removeTemplates()` or a key change. A
sleeping vat takes about 17 MB.
