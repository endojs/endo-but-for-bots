# Thixotrope build, test and performance tooling, with a baseline

Survey date 2026-11-16. Machine: Apple M3 Max, 16 cores, 48 GiB RAM, macOS (Darwin 25.6), Node v22.23.4,
rustc 1.91.1 (pinned by `rust-toolchain.toml`). Work tree `/Users/xyz/Development/endo-thixotrope-harness`,
branch `claude/thixotrope-harness` at `48d6f3e08b`. Paths below are relative to that work tree unless absolute.

Caveat for every number here: other survey agents were running Ironhorse probes and tests in the same
work tree at the same time (load average 2.2 to 4.3 on 16 cores). Latency numbers were steady across
five separate runs (cold start 31.8 to 33.2 s, ping median 64 to 67 ms), so I believe they hold, but
treat them as one machine's numbers, not a guarantee.

Raw logs: `/private/tmp/claude-501/-Users-xyz-Development-endo-host--claude-worktrees-endo-harness-spec-24b228/7823793b-369b-42a3-83f1-79bee62aa520/scratchpad/thix/logs/`
(`cargo-ironhorse.log`, `cargo-xs.log`, `test-js.log`, `test-js-rerun.log`, `test-ironhorse.log`,
`bench-*.log`). The benchmark script is saved at
`/private/tmp/claude-501/-Users-xyz-Development-endo-host--claude-worktrees-endo-harness-spec-24b228/7823793b-369b-42a3-83f1-79bee62aa520/scratchpad/thix/survey/baseline.mjs`.

## 0. The short version

- Builds are cheap: the Ironhorse worker builds in 46 s and the JS bundles in about 1.4 s each.
- The XS worker does not build. It needs the `c/moddable` git submodule, which is not checked out.
  The three XS test files skip themselves.
- JS suite: 1,023 passes over three SES configurations, 8 failures. Every failure is AVA's 2-minute
  test timeout, hit while heavy tests ran in parallel. All 17 tests in the four affected files pass
  when run alone. The native Ironhorse lane passes 55 of 55 in 23 minutes.
- **One crank in a durable Ironhorse vat costs about 65 ms**, whatever it does (82 ms in a workspace
  vat). That is the floor for one eventual call. A vat runs one crank at a time, so pipelining gains
  nothing: one vat can take about 15 calls per second at most.
- **A string argument longer than about 16,000 characters kills the vat** (HeapExhausted, and the
  vat is quarantined). Up to that limit the cost grows with length: 1 s for 8,000 characters.
- **More than about 250 eventual sends in one crank kills the vat** (500 sends gave MeterAbort;
  2,000 gave HeapExhausted). Each send costs about 4.6 ms of guest time.
- A sent message that gets an answer costs one extra delivery back into the vat when the answer
  arrives. Notifications sent with `E.sendOnly` are 20 times faster than with `E()`.
- Heap size barely matters for crank latency: 20 M characters of strings moved the ping from 64 ms
  to 66 ms. It does matter for disk: about 3.3 bytes per character in the snapshot.
- Vat creation is slow: a new vat takes 4.4 s, about 18 MB of snapshot and up to 160 MB of resident
  memory while awake. A supervisor cold start takes 32 s.
- Restart is acceptable at this size: 1.9 s to close and 5.7 s to serve again. Waking a sleeping
  vat costs about 50 to 60 ms plus its first delivery.

## 1. Building

### 1.1 What the tests need

| Artifact | Built by | Used by |
| --- | --- | --- |
| `target/release/thixotrope-ironhorse-worker` | `cargo build --locked --release -p thixotrope-ironhorse-worker` (repository root) | The default supervisor engine (`packages/thixotrope/src/control/supervisor.js:185-201`, path override `THIXOTROPE_IRONHORSE_WORKER`), `test:ironhorse`, `scripts/ironhorse-demo.mjs`, `scripts/measure-mail.mjs`, `test/_remote-process-fixture.js:37-45` |
| `packages/thixotrope/dist-ironhorse/{boot.js,worker-peer.js}` | `corepack yarn build:ironhorse-bundles` (`scripts/bundle-ironhorse-worker.mjs`) | Same as above (`supervisor.js:197-199`) |
| `target/release/thixotrope-xs-worker` | `cargo build --locked --release -p thixotrope-xs-worker` | `test/worker-peer-xs.test.js:37-50`, `test/durable-worker-session-xs.test.js`, `test/worker-session-restart-xs.test.js`; these skip themselves when it is missing |
| `packages/thixotrope/dist-xs/{boot.js,worker-peer.js}` | `corepack yarn build:xs-bundles` (`scripts/bundle-xs-worker.mjs`) | The XS tests above |

There are no prebuilt binaries in the tree: `rust/endo/xsnap/prebuilt/libxs.a` is absent, and no
`target/` existed before this survey. The ordinary JS suite (`corepack yarn test`) mostly uses Node
replay doubles (`src/core/peer-replay-engine.js`, for example `test/builtins.test.js:11`), so it
needs no Rust build. Only `test/_remote-process-fixture.js` starts the real binary. `test:ironhorse`
needs both the binary and the bundles, and fails rather than skips when either is missing
(`packages/thixotrope/README.md:670`).

### 1.2 Commands and measured cost

From `/Users/xyz/Development/endo-thixotrope-harness`:

```sh
cargo build --locked --release -p thixotrope-ironhorse-worker      # 46.4 s wall, 124 s user; exit 0
cd packages/thixotrope
corepack yarn build:ironhorse-bundles                              # 1.4 s; dist-ironhorse 2.0 MB
corepack yarn build:xs-bundles                                     # 1.2 s; dist-xs 1.4 MB
cd ../..
cargo build --locked --release -p thixotrope-xs-worker             # FAILS after 6.2 s (see below)
```

Disk use: `target/` was 234 MB after the Ironhorse build and is 344 MB after the failed XS attempt.
The worker binary is 11.4 MB. The registry cache in `~/.cargo/registry` (417 MB) already held every
crate.

XS worker failure (`rust/endo/xsnap/build.rs:34`):

```
Moddable XS sources not found at .../rust/endo/xsnap/../../../c/moddable/xs/sources and no prebuilt
libxs.a at .../rust/endo/xsnap/prebuilt/libxs.a. Run `git submodule update --init c/moddable` ...
```

I did not initialise the submodule, because this phase is read-only for git. If an owner allows it,
`git submodule update --init c/moddable` followed by the cargo command should build it. Size and
time for that are not measured. XS is not the production engine (the supervisor defaults to
Ironhorse), so the harness can ignore XS unless a later phase needs it.

Side effects to know about: `build:xs-bundles` writes four stub files into `rust/endo/xsnap/src/`
(`ses_boot.js`, `worker_bootstrap.js`, `daemon_bootstrap.js`, `archive_text_endowments.js`). They
are git-ignored. Every build output listed here shows as `!!` (ignored) in
`git status --short --ignored`. Nothing shows as modified or untracked.

## 2. Test suites

### 2.1 `corepack yarn test` (packages/thixotrope)

`ses-ava` runs the whole suite three times, once per SES configuration (`lockdown`, `unsafe`,
`endo`; `packages/thixotrope/package.json` `sesAvaConfigs`). The AVA timeout is 2 minutes per test
(`ava-base.config.mjs:3`), and files run in parallel.

```sh
cd /Users/xyz/Development/endo-thixotrope-harness/packages/thixotrope
corepack yarn test --verbose          # 1,214 s wall (20 min), exit 1
```

| Config | Passed | Failed | Skipped | Notes |
| --- | ---: | ---: | ---: | --- |
| lockdown | 336 | 3 | 3 | plus 1 uncaught exception |
| unsafe | 342 | 4 | 3 | AVA "Timed out while running tests"; 4 files failed to exit |
| endo | 345 | 1 | 3 | |

The skips are the three XS files ("build thixotrope-xs-worker and dist-xs first").

Every failure is `Error: Test timeout exceeded`:
- `install-application › a pending factory holds neither removal, collection nor other installations` (lockdown, unsafe)
- `native-install › directory installs use separate manager vats and independent startup notices` (all three)
- `native-install › shutdown does not wait for an installation being bundled` (lockdown)
- `guest-prelude › every vat has the guest prelude as globals` (unsafe)
- `builtins › the workspace provides a clock and a mailbox as installations in their own vats` (unsafe)

The uncaught exception came after a timed-out teardown in lockdown:
`ENOENT: no such file or directory, open '/tmp/thix-install-close-.../workers/<id>/journal.jsonl.<uuid>.tmp'`.
It was thrown at `writeTextAtomic` (`src/platform/node/sync-files.js:46`), reached from
`appendJournal` (`src/store/store-fs.js:170`) through a gc-batch flush
(`packages/ocapn/src/codecs/gc-batch.js:19`). A GC finalizer wrote to a worker journal after its
test directory had been removed. That looks like a teardown-ordering defect exposed by the timeout,
not a separate failure [inferred].

The four files, rerun alone:

```sh
corepack yarn ava --config ../../ava-endo-lockdown.config.mjs --verbose \
  test/native-install.test.js test/install-application.test.js test/guest-prelude.test.js test/builtins.test.js
# 17 tests passed, 169 s wall, exit 0
```

Verdict: these are load and timeout flakes on this machine, not functional failures. The timed-out
tests took 14 to 41 s each when run alone, against the 2-minute limit, so running in parallel on top
of other agents' work slowed them by 3x or more. Later builders should run single files while
iterating, and should not run the full suite at the same time as other heavy work.

Slowest tests (all in the Node replay-double "(replay)" variants; most of the time goes to journal
replay in Node):

| Test | Time |
| --- | ---: |
| mailbox-integration › two supervisors recover offline mail (replay) | 2 m 56 s to 3 m 7 s |
| mailbox-integration › two supervisors exchange capabilities through the mail TUI (replay) | 2 m 42 s to 2 m 56 s |
| http-integration › installed HTTP application restores state and listener after restart (replay) | 2 m 7 s to 2 m 21 s |
| alarm-integration › installed reminder retains its original listener across overdue restart (replay) | 1 m 44 s to 1 m 52 s |
| builtins › the workspace provides a clock and a mailbox as installations in their own vats | 1 m 32 s to 1 m 44 s |
| workspaces › a daemon serves many workspaces, each with its own inventory and mailbox and the one clock | 1 m 30 s |

### 2.2 `corepack yarn test:ironhorse`

`ava.ironhorse.config.mjs` runs 13 files serially (`concurrency: 1`, 3-minute timeout).

```sh
corepack yarn test:ironhorse --verbose    # 55 tests passed, 0 failed, 1,394 s wall (23 min), exit 0
```

Slowest:

| Test | Time |
| --- | ---: |
| mailbox › two supervisors recover offline mail (ironhorse) | 2 m 12 s |
| mailbox › two supervisors exchange capabilities through the mail TUI (ironhorse) | 1 m 35 s |
| supervisor › observable inventory crosses a persistent guest and ephemeral views ... | 1 m 28 s |
| http › installed HTTP application restores state and listener after restart (ironhorse) | 1 m 17 s |
| http-crash › SIGKILL drops orphaned HTTP clients while preserving accepted effects ... | 1 m 8 s |
| alarms › installed reminder retains its original listener across overdue restart | 1 m 3 s |
| alarm-crash › SIGKILL preserves an admitted alarm and its original guest listener | 1 m 2 s |

These times follow mostly from the 32-second supervisor cold start measured in section 4.1, paid
once or twice per test.

## 3. What the design notes already document

All of these are mail-path measurements from October 2026 (macOS arm64, Node 22.21.1). They measure
from send acceptance to a pushed inbox state, use samples of 3 to 9 sends, and claim no tail
latency.

- **One end-to-end mail operation** fell over a series of changes. The original bridge and hub took
  7,253 ms and made 495 hub rewrites (`designs/mail-performance-plan.md:159-166`). The figure then
  dropped to 418, 364, 229, 185 and finally 145 ms with an atomic hub, or 133 ms with an experimental
  append log (`mail-latency-colocated.md:10-11`, `mail-optimization-strategies.md:13-17`,
  `mail-durable-transfer-batching.md:19-26`, `mail-observer-outbox.md:16-22`). The provisional
  target of 50 ms typical and 100 ms p99 is recorded as not met (`mail-performance-plan.md:6-7,174`).
- **Where the time goes in one 156 ms send** (`mail-vm-detail.md:10-47`): 129 ms in the VM and 22 ms
  in the filesystem. In the VM, the initial script took 5.7 ms and the promise jobs 53.5 ms (51
  reaction jobs). **Two full GC rounds took 67.4 ms**, of which marking was 34.6 ms, sweeping
  14.8 ms and chunk compaction 14.0 ms. Each round started from 901 roots and marked about 49,500
  slots. The worker runs a full `collect_garbage()` after every crank, and keeps sweeping while
  finalizers produce more garbage (`rust/thixotrope-ironhorse-worker/src/main.rs:240-265`). The
  design keeps this deliberately, so that gc frames replay deterministically
  (`designs/production-cost-model.md:305-321`). Treat it as fixed.
- **Durable commit cost**: each hub commit is an atomic file replacement with a file fsync and a
  directory fsync. At 16 commits these cost 155 to 173 ms (`mail-latency-colocated.md:69`). At 2
  commits plus one journal append, hub persistence costs about 19 ms (`mail-observer-outbox.md:18`).
  One worker-journal append and fsync costs about 4 ms (`mail-performance-plan.md:276-279`). Every
  inbound frame is appended to the worker's `journal.jsonl` and fsynced before delivery
  (`production-cost-model.md:61-67`).
- **Checkpoint and snapshot**: the heap is not committed per crank; that changed with item 1.1
  (`production-cost-model.md:121-148`). A snapshot closes the worker, hashes and copies its SQLite
  file, and relaunches it. Snapshots happen at idle sleep (30 s default), on an explicit sleep, at
  shutdown, and every 256 deliveries for a worker that never idles (`supervisor.js:141-142`,
  `production-cost-model.md:227-246`). The operator's production report measured averages of 6.7 s
  per snapshot and 40 s per wake on bloated heaps (`production-cost-model.md:19-21`).
- **GC traffic**: before batching, bursts of `op:gc-answers` and `op:gc-exports` gave outliers of
  3.4 s and 122 deliveries. Ordered client-and-hub batching (up to 64 positions per frame) brings
  the largest sample down to 0.7 s and 20 deliveries (`mail-gc-batching.md:24-54`).
- **Startup and restart in production** (`production-cost-model.md:26-29,85-86`): a 15-minute boot,
  and a 30-minute replay of a 3,744-entry journal. Snapshotting awake workers (item 2.1) now bounds
  each worker's journal suffix to 256 entries.
- **Engine microbenchmarks** (`rust/engine/benches/baseline.json`, measured on a shared 4-core Linux
  host): a steady-state full GC takes 4.6 ms at 20,000 slots and 19.1 ms at 80,000 slots, about
  0.24 µs per slot. Sweep costs about 35 ns per slot. Eager wake is 2.6 ms and lazy wake 0.64 ms.
  The harness there is `python3 rust/engine/benches/run.py --check-baseline`: a median of 3 runs,
  21 samples per measurement, and a regression floor of 1.25x (`rust/engine/benches/README.md:1-60`).
- **Engine limits that matter here** (`README.md:726-739`, `designs/ironhorse-limits.md:78-81`):
  - crank budget: 10 M computrons;
  - slot ceiling: 1 M (at most 44.7 M);
  - chunk ceiling: 256 MiB (at most 512 MiB);
  - request watchdog: 60 s.
  `Array(1050000)` hits "property key space exhausted" no matter how the ceilings are set.
  `src/core/evaluate-source.js:4-9` states that Ironhorse's text decoder copies every prefix of a
  message, so a message costs heap quadratic in its length and halts a little under 16 k characters.
  My measurements below confirm this.

There are no throughput numbers in the notes apart from the 1.5 deliveries per second in the
operator's report.

## 4. Baseline measured here

Script: `baseline.mjs` (saved copy at the path above). It starts its own supervisor through
`serveThixotrope` (`src/control/supervisor.js:136`) and an admin client through
`connectLocalControl` (`src/control/local-control.js`), the same way `scripts/measure-mail.mjs`
does. The state directory is a short path, `packages/thixotrope/tmp/hp<pid>` (git-ignored by
`packages/*/tmp/`), created with mode 0700. The bench object is a plain `Far` closure-state object,
by default installed as its own application vat (`install('bench', '({ make: () => ... })', [])`).
With `TARGET=workspace` it is evaluated into the workspace vat instead. Options:
`idleSleepMs: 3_600_000` (or `IDLE_MS`) and the default `snapshotEveryDeliveries: 256`, so periodic
snapshots are included in the numbers.

To repeat:

```sh
cd /Users/xyz/Development/endo-thixotrope-harness/packages/thixotrope
mkdir -p tmp/harness-perf
cp /private/tmp/claude-501/-Users-xyz-Development-endo-host--claude-worktrees-endo-harness-spec-24b228/7823793b-369b-42a3-83f1-79bee62aa520/scratchpad/thix/survey/baseline.mjs tmp/harness-perf/
node tmp/harness-perf/baseline.mjs start ping append                # a, b, c
node tmp/harness-perf/baseline.mjs start push heap restart          # e, d, g
node tmp/harness-perf/baseline.mjs start pushSingle                 # e (one-crank sizes; kills the vat)
node tmp/harness-perf/baseline.mjs start text                       # f (kills the vat)
TARGET=workspace PING_N=200 node tmp/harness-perf/baseline.mjs start ping
IDLE_MS=2000 node tmp/harness-perf/baseline.mjs start wake          # h
rm -rf tmp/harness-perf tmp/hp*                                     # clean up (KEEP_STATE=1 keeps state)
```

The script prints one JSON object per line. Each run takes 1 to 6 minutes, and 32 s of that is the
cold start.

### 4.1 (a) Cold start of a supervisor and a workspace

Five runs:

| Step | Time |
| --- | --- |
| `serveThixotrope` on an empty directory | **31.8 to 33.2 s** |
| first `status` | +0.15 s |
| `createWorkspace('bench')` | **12.0 to 12.8 s** |
| `install` of one application vat | **4.37 to 4.55 s** |
| `evaluate` into an existing workspace vat | 0.25 s |
| first call | 65 to 87 ms |

State directory after cold start plus one application vat: 139 MB. Of that, 124 MB is heap
incarnations and 14 MB is `runtime/`, private copies of the worker binary. A fresh vat snapshot is
about 18.2 MB of SQLite. Eight worker processes were resident, using 1.17 to 1.28 GB RSS in total
(about 150 to 160 MB each). With `IDLE_MS=2000`, sleeping workers exit: one resident worker used
48 MB.

Interpretation [inferred]: every new vat boots the SES and OCapN bundles (`dist-ironhorse`, 2 MB)
inside the Ironhorse interpreter, at about 4.4 s per vat. The cold start creates about seven vats
(registry, clock, control, default workspace and mailbox, ...). Nothing reuses a booted image:
`src/ironhorse/ironhorse-engine.js` has no template or fork path.

### 4.2 (b) Round trip of a trivial eventual call (`E(bench).ping()`)

| Target | n | median | p95 | p99 | max | engine ms per delivery |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| application vat | 300 | **66.8 ms** | 72.0 | 179.4 | 690 | 50.4 (346 deliveries, 1 snapshot of 93 ms) |
| workspace vat | 200 | **82.5 ms** | 85.5 | 303.3 | 459 | 65.2 |

Pipelined: 300 concurrent pings took 19.06 s, about 63.5 ms each. There is no gain from
pipelining: deliveries to one vat are serialized, and each pays the whole crank.

About 50 ms of each call is the worker's delivery (dispatch, promise jobs, a full GC of the 18 MB
base heap, finalizers and extraction). The other 15 ms is host routing plus the hub commit and
journal fsyncs. The workspace vat is slower because its live graph (inventory, mail, prelude) is
larger and GC marks all of it every crank [inferred from `mail-vm-detail.md`].

### 4.3 (c) Appending 1,000 small records, then restarting

- 1,000 separate `append({i, kind, text})` calls: per call median 66.9 ms, p95 71.1, p99 79.2, max
  454. Total 67.7 s. Four periodic snapshots added 291 ms in all, about 73 ms each.
- `appendMany(1000)` in one call: 270 ms.
- Close: 1.89 s (it snapshots every awake worker).
- Restart: serve took 5.67 s, and the first answered call came at 6.27 s. The 2,000 records were
  intact. State: 155 MB. Six workers resident after restart, 747 MB RSS. Restart wakes workers
  eagerly.

### 4.4 (d) Large heap: 20 M characters of strings (about a long transcript)

The heap was grown in 100 calls of 100 strings, each string 2,000 characters.

- Per `grow` call: median 66.9 ms, p95 71.2 ms.
- Ping at 5, 10, 15 and 20 M characters: medians 64.3, 66.0, 66.2 and 66.1 ms. Strings live in
  chunk storage, which GC marking hardly touches.
- 200 pings with the big heap: median 66.0 ms, p95 70.8 ms, one snapshot of 230 ms.
- Close: 2.0 to 2.1 s. Serve: 5.84 to 5.91 s. First call: 6.73 to 6.83 s, about 0.5 s more than
  without the big heap. Pings after restart: median 64 to 65 ms.
- Disk: the vat's snapshot grew from 18.2 MB to 84.5 MB, about 3.3 bytes per character. While
  running, the state directory reached 589 to 612 MB, because the incarnation copies sit next to
  the snapshots. At rest it was 297 MB, with 8 snapshots of which two were 84.5 MB.

### 4.5 (e) Pushing 2,000 small events from a guest to a subscribed Node client

The guest loops `E.sendOnly(listener).event(i)` (or `E(listener).event(i)`) to a `Far` listener held
by the admin client.

| Events per crank | Send kind | Total | Events/s | Deliveries |
| ---: | --- | ---: | ---: | ---: |
| 100 (20 cranks) | `E.sendOnly` | 9.29 s | **215** | 28 |
| 100 (20 cranks) | `E()`, answered | 209 s | **10** | 1,994 |
| 10 (200 cranks) | `E.sendOnly` | 22.9 s | 87 | 237 |
| 1 (300 cranks) | `E.sendOnly` | 20.3 s | **15** | 304 |
| 250 in one crank | `E.sendOnly` | 1.15 s | 217 | 1 |
| 500 in one crank | `E.sendOnly` | **MeterAbort; vat quarantined** | | |
| 2,000 in one crank | `E()` and `E.sendOnly` | **HeapExhausted; vat quarantined** | | |

Each send costs about 4.6 ms of guest time to marshal and encode inside the interpreter. With
`E()`, every answer comes back as a separate delivery, and each such delivery is a full crank.

### 4.6 (f) Extra: one string argument of N characters (`E(bench).echo(s)`)

| Characters | 1k | 2k | 4k | 8k | 12k | 15k | 20k |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Time | 118 to 229 ms | 254 ms | 530 ms | 1,010 ms | 1,264 ms | 1,388 ms | **HeapExhausted; vat quarantined** |

The halt retires the vat's session, and later calls reject with
`ocapn hub: the target session has been retired`. Raising `THIXOTROPE_CHUNK_CEILING` to its maximum
of 512 MiB would move the limit only to about 22 k characters [inferred from the quadratic cost].

### 4.7 (h) Waking an idle-slept vat

With `IDLE_MS=2000` and 5 samples, a ping after sleeping took 106 to 129 ms. Of that, the wake was
46 to 63 ms and the delivery 46 to 49 ms. No snapshot was taken.

### 4.8 What I could not measure

- XS-engine numbers: the worker did not build (section 1.2).
- An HTTP or WebSocket browser path: out of scope for this step.
- p99 for cold start or restart: these were 5 or fewer samples each.
- Restart with tens of session vats: each vat costs 4.4 s to create, so 50 vats would take about
  4 minutes just to set up. It is worth doing once a session vat exists.

## 5. Standard performance check for later builders

1. **Location.** Put perf checks in `packages/thixotrope/perf/<feature>.perf.mjs`, committed, next
   to a small shared helper, `perf/_harness.mjs`. The helper should hold the `startSupervisor`, `stats`,
   `emit` and `restart` functions from `baseline.mjs`, plus the engine counter deltas from
   `status().timings` (`src/control/measured-engine.js`). AVA does not pick these files up. Keep
   state under `packages/thixotrope/tmp/pf<pid>`: it is git-ignored, its socket path stays under
   103 bytes (`supervisor.js:171` refuses a longer one), and the helper must create it with mode
   0700 (`supervisor.js:179`). Always remove state in `finally`.
2. **Running.** `cd packages/thixotrope && node perf/<feature>.perf.mjs [--n N]`. Run one check at
   a time, never alongside the test suite, and with the release worker and fresh bundles. Record
   `git rev-parse HEAD` and the sha256 of the worker binary in the output.
3. **Output.** One JSON object per line on stdout:
   `{"metric":"<feature>.<operation>","unit":"ms","n":…,"median":…,"p95":…,"p99":…,"max":…,"engine":{"delivery":{count,ms},"snapshot":{…},"wake":{…}},"budget":{"median":…,"p95":…},"pass":true}`.
   Include the delivery count, so that a regression in protocol traffic (extra cranks) shows up even
   when wall time is noisy. The process exits with code 1 when any median exceeds 1.25x its budget,
   the same floor `rust/engine/benches/run.py` uses. Use at least 200 samples for latency and 5
   runs for start and restart.
4. **Journal.** Paste each check's summary lines into the running journal, together with the
   commit, so that regressions can be traced.
5. **Failure probes.** Every feature that moves data into a vat must also have a "too big" probe
   (string length, list length, sends per crank), so that a halt is found in a check and not in
   production. A halt quarantines the vat for good.

## 6. Proposed latency budgets for harness features

All are in wall time on this class of machine. One durable crank is about 65 ms (C). Host-only work
is assumed to cost 1 ms or less [inferred; Node OCapN on loopback, not measured here].

| Feature (parity item) | Budget | Rationale and design consequence |
| --- | --- | --- |
| Streamed turn event, provider to browser (P-09) | 5 ms added per event, and 200 or more events/s per session | A durable vat manages 15 events/s at one per crank, so text deltas **must not** cross a durable vat one by one. Fan deltas out from a host or transient object. Durable state takes coalesced records (at most one crank per 250 ms, or per tool call or final). |
| Speech audio (P-30, P-31, P-34) | 1 ms or less per audio frame, never in a crank | Audio PCM and partial transcripts stay in native adapters or host streams. Only final transcripts and turn text reach vats. |
| Turn start, submit to provider request (P-08, P-11) | 300 ms or less (at most 3 to 4 cranks) | Receipt, queue entry and journal record should share one crank. |
| Tool-call record before run (P-08) | 1 crank (100 ms or less) per round, not per call | Batch the parallel calls of a round into one durable record. |
| Durable journal append per turn step (P-13) | 1 crank, and no string over 4 k characters per message | Chunk text into pieces of 4 k characters or less, or keep large blobs (tool output, transcripts) in a host blob store and pass a capability. Budget 0.5 s per 4 k characters until the text decoder is fixed. |
| Tool result truncation (P-21) | Choose a cut size of 8 k characters or less, or pass by handle | Anything over about 16 k characters in one message kills the vat. |
| Session list load (P-03) | 200 ms or less for 100 sessions | It must not wake or call each session vat (each wake is 50 to 120 ms, so 100 vats take 5 to 12 s). Keep one index or projection that is pushed to subscribers. |
| Session list subscription update | 1 crank (100 ms or less) | Use `E.sendOnly` for notifications (answered sends cost one extra delivery each). |
| Create session (P-03, P-04) | 5 s or less now; target 1 s | A vat per session currently costs 4.4 s, 18 MB on disk and up to 160 MB resident while awake. Either share vats or reuse a booted image (an engine change). |
| Page reload or late join snapshot (P-09, P-23) | 300 ms or less for a 1,000-message transcript | The read must be paged in chunks under the string limit. |
| Supervisor restart (P-14, P-29) | 15 s or less to serving with 50 sessions | Measured: 5.7 s with 6 vats, and wake is eager. Many session vats need lazy wake (the dormant-after-restart wish). |
| Clean shutdown | 5 s or less | Measured 1.9 to 2.1 s with 6 vats, about 0.3 s per vat. |
| Bursts | 200 or fewer outgoing sends per crank | 500 sends hit the 10 M computron budget. The harness must cap fan-out per crank. |

## 7. Journal entries from this step

Fits Thixotrope well:
- Orthogonal persistence of closure state is real and survives restart, with no guest-side
  serialization: 2,000 records came back after a restart without any code to save them.
- A big heap of strings does not slow cranks, so a transcript that lives in the heap is affordable
  for latency (but see disk use).
- Idle sleep is cheap: a 50 to 60 ms wake, after which the worker's memory is released.
- Batching inside one crank is cheap (1,000 records in 270 ms, against 67 s for 1,000 calls).

Does not fit, or needs design around:
- About 65 ms per crank, and one crank at a time per vat. Fine-grained calls (per token, per
  record, per notification) are far too slow. The harness must be designed around coarse messages.
- The text limit: strings of 16 k characters or more crash the vat, and cost grows quadratically
  below that. LLM text, tool output and file content routinely exceed this.
- Sends per crank are capped at about 250 to 500 (computron budget, then heap).
- Answered sends double the deliveries. Notification paths need `E.sendOnly`.
- Vat creation takes 4.4 s and about 160 MB resident, so a vat per session is expensive.
- Disk: 18 MB per fresh vat snapshot, plus incarnation copies while running. The state roughly
  doubles during a run. The disk on this Mac has about 20 GB free.

General incompatibilities and tooling notes:
- The XS worker needs the `c/moddable` submodule, which is not populated here.
- Unix socket paths are limited to 103 bytes, and the state directory must be mode 0700.
- The full JS suite is timeout-flaky under parallel load. Run single files while iterating.
- A vat halt is permanent (quarantine). Every size limit must be enforced before data reaches a
  durable vat.
