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
  measured and changed, and every core-change candidate with its status (C-1..C-25):
  `designs/m0-results.md`. The M1a interface contract, crank by crank: `designs/m1a-interfaces.md`.
  Surveys and plan reviews: `designs/survey/`, `designs/review-*.md`.
- [Ironhorse performance](designs/ironhorse-performance.md) connects mail and session-start measurements to the worker and VM collector.
- Journal: `JOURNAL.md` records what fits Thixotrope and what does not, and every perf
  measurement. Append in your milestone's number block; never rewrite an entry.
- Core changes: `CORE-CHANGES.md` journals every change made outside this package (Thixotrope,
  Ironhorse, other Endo packages) with its motivation; add an entry with each such change.
- Settings: `config/defaults.js` (`limits`: frame sizes, crank budget, sends per crank, exec
  source size, vat key names, crash bound), with the evidence for each value.
- Structure and words: the turn runner and its modules (`guest/session/turn.js`, `outbox.js`,
  `usage.js`, `ports.js`, `turn-index.js`, `turn-import.js`, `recovery.js`), the one per-session
  extension (`guest/session/runtime-parts.js`), the provider shell and backend kinds
  (`resources/agent-host/impl/providers/shell.js`, `api.js`, `kinds.js`, `catalog-core.js`) and
  the adapter's shared stores (`impl/channel-subscriber.js`, `impl/files.js`,
  `impl/secrets/wrapping-key.js`) are described in `designs/architecture.md` 4.7-4.9, D-6 and
  D-8; its section 14 is the glossary. The architecture review and the status of each finding:
  `designs/arch-review/harness.md` (section 8).

Paths below are relative to this package unless they start with the repository root
(`../../`).

## Session features

- The development preset gives each session its own Git workspace and shell when an
  environments runner is attached. An emergency stop withdraws that session's runner.
  A child created from the preset gets its own workspace. [Environments contract](designs/m6-interfaces.md)
- Sessions use the backend's context window to decide when to compact. The `viewImage`
  tool can read a PNG, JPEG or WebP from a held workspace. The provider receives the
  image and the transcript stores a receipt. [Context and images contract](designs/m8-interfaces.md)
- Operators get their mailbox through `getMail()`. Sessions can send messages, answer
  requests and delegate tasks to child sessions. An emergency-stopped session can receive
  a package and runs its mail turn after resume. [Mail and subagents contract](designs/m9-interfaces.md)
- Operators get the voice service through `getVoice()`. Talk uses the pinned voice preset,
  model and backend. The built-in voice preset requires an attached runner.
  [Speech and voice contract](designs/m11-interfaces.md)

The corresponding regression lists are `environments`, `context`, `mail` and `voice`.
For example, run `corepack yarn test:integration --list context` from this package.
See the [milestone outcomes](designs/milestones.md) for measured results and outstanding gates.
Operators can use the [guided user acceptance checklist](designs/milestones.md#guided-user-acceptance-on-the-integrated-stack)
for chat, mail, delegation, workspace images and voice.

### See subscription quota and weekly resets

Open **Subscriptions** from the harness menu to refresh all configured pools.
Each pool shows one combined graph. Use **Measure** to switch between numeric
credits and quota windows when the provider reports both.

**Credit balance** sums the reported member balances. A quota graph shows the
mean percentage remaining per reporting account for the selected window.
The caption shows how many accounts contributed. Weekly reset markers identify
the account and the provider-reported time in UTC.

Expand **Individual subscriptions** under a pool for each account’s status,
readings and graphs. A dashed line shows a forecast when the account histories
supply enough recent observations. **Refresh all** and each pool’s **Refresh**
button are available while the page is open.

### Develop the harness from a session

Open **New session** and choose **Thixotrope development** to use its saved
backend and model, or pick another backend and model before choosing the
preset. If the model offers reasoning effort, you can change it for this
session. Both ChatGPT and Claude start at medium whenever the model offers it.
A first prompt can be “Prepare the checkout,
show its revision, and run the session inventory unit test.” Each session has
a private Git repository at `/workspace`. Shell commands, edits and commits
use that same checkout. The package is `/workspace/packages/thixotrope-harness`.
The preset tells the model how to set up the locked Linux dependencies on
first use. Allow ten minutes for the first `thix-selfdev-prepare` shell call
(`timeoutMs: 600000`). Reopen the session to resume an edit. Ask for `git diff HEAD` to
review tracked changes, and stage new files before requesting the diff.
For integration debugging, set `THIX_HARNESS_TMP=/tmp/thix`. For a manually
started supervisor, create a state directory under that path. This private
Linux filesystem supports Unix sockets and executable workers. Its contents
last for the lifetime of the container. Source and edits stay on `/workspace`.

An operator can publish the preset to a running, provisioned state. From
`packages/thixotrope-harness`, with Docker running and a full project checkout:

```sh
project_ref=$(git rev-parse HEAD)
project_image=$(./oci/selfdev/build.sh "$project_ref")
node scripts/project-preset.mjs "$state" --repo ../.. --ref "$project_ref" --image "$project_image"
```

Set `state` to the supervisor's state directory. Rebuild the image when the Yarn lockfile or native Rust worker changes.
The image build needs access to the locked upstream dependencies. Once built, the session runs offline
from the pinned local image. The operator publishes only committed source
and history. Publishing another revision updates the preset for future
sessions. Sessions already created retain their own checkout and revision.
If the host uses an older installed factory that predates project revisions,
add `--legacy-factory` to load the current session program and convey the
revision through a private source capability. This requires the current
environments manager. On a legacy factory, a delegated child gets an empty
workspace because that factory omits preset endowments on delegation. A
current factory gives each child its own checkout of the saved revision.
The runner image applies across the installation.
The command requires `--replace-runner` to change an existing runtime,
image or shell allowlist.

To reproduce the four-delivery mail check, run
`corepack yarn exec node perf/mail-forward-trace.perf.mjs` from this package.
It uses the release worker, a 60 s operator prefix and a 60 s sequential forwarding window.
The observer matches worker frames to sender and recipient turns, sink slots and envelope
postmarks. It fails if a forward exceeds four deliveries or if it cannot verify the path.
For a deep checkout, give `THIX_HARNESS_TMP` a short private path so the control socket fits.
Set `THIX_FORWARD_OUTPUT_PARENT` to an existing absolute directory to keep the local trace.
Use `corepack yarn exec node perf/mail.perf.mjs` for the full uninstrumented release timings.

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
corepack yarn lint        # tsc + eslint (with the guest rules in lint/guest-rules.js) + the duplicate ceiling
```

Run prettier from the repository root on the files you changed
(`corepack yarn prettier --check <files>`). The guest rules forbid `Date`, timers, `console`,
`Math.random`, `WeakRef`, `fetch`, `eval`, dynamic `import()`, non-relative imports and string
growth in loops under `guest/`; review still catches what the string rule cannot see.

## The run lock

Integration tests, spikes, perf checks and the `packages/thixotrope` Ironhorse lane take the run
lock: a machine-wide pool of slots under `<THIX_HARNESS_HOME>/run-lock/` (default
`~/.cache/thixotrope-harness`; `THIX_HARNESS_RUN_SLOTS`, default 6) shared by every worktree. A
perf check takes every slot (exclusive). The CLI also boxes the workload at 10 minutes (exit 124)
and logs each run to `<THIX_HARNESS_HOME>/runs.jsonl`; `designs/process.md` section 2 has the
details and the script's header comment is the reference.

```sh
node scripts/run-lock.mjs --label NAME [--timeout-ms N] [--max-ms N] [--exclusive | --shared] \
  -- <command> [args...]
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
corepack yarn test:integration   # every file under test/integration and test/template
```

which runs `scripts/test-integration.mjs`: each file under its own run-lock wrapper (its own
slot, 10-minute box and run-log line), up to `THIX_HARNESS_RUN_SLOTS` (6) files at once (`--jobs N`). Never give
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
8), `m2-turns` (2, 12; 3 as the round rate of an always-tool turn over a 60 s window, from which
the 1,024-round time is derived; the limit itself is proved at limit 2 in Node), `m2-queue` (4,
5, 10), `m2-secrets` (7, and the grep of the whole state directory for every encoding of the key
values), `m2-history` (9), `m2-catalog` (11), `m2-lifecycle` (13; `M2_DELETE_KILL_DELAY_MS` and
`M2_CREATE_KILL_DELAY_MS` move its SIGKILL points), `m2-lifecycle-export` (14 and the truncated
import), `m2-archive-restart` (16 at S and A3) and `m2-archive-restart-2` (16 at A2 and Z), both
over one imported 159-turn session (`_m2-archive-kill.js`), `m2-probes` (the too-big probes).
Acceptance 15 (a 5,000-turn session behaves like a 200-turn one) is `perf/history.perf.mjs` and
`perf/history.restart.perf.mjs`, whose sessions are copies of templates built by `importState`.
Files that use a Secret give their supervisor a key file under `tmp/` (outside the state
directory) and remove it, and pass it to that one supervisor only
(`startFromTemplate(template, { secretsKeyFile })` or `provision`'s `secretsKeyFile`; `testKeyFile`
in `test/integration/_m4.js` and `perf/_m4.mjs`, `useTestWrappingKey` in `_m3-gateway.js`): no
test or perf file sets `THIX_HARNESS_SECRETS_KEY` for its process (HR-SYN-21, J-10233).

The M3 acceptance files (`designs/m3-interfaces.md` 12): through a Node CapTP client over a real
loopback WebSocket, `m3-gateway` (1, 2, 10, 11, 16; K1, K2), `m3-sessions` (3, 13, 14, 12
protocol part) and `m3-reconnect` (4-7 protocol parts; K3-K5); in headless Chromium,
`test/browser/m3-ui` (1, 2 page parts, 4 socket part, 5, 6, 9, 14 page part, 15),
`m3-ui-restart` (12, 7 with K5, 4 with the daemon down 60 s) and `m3-ui-history` (8, on the
`m3-300` template). Browser files are gated by `THIX_HARNESS_BROWSER=1` and run one per
invocation under the run lock:

```sh
THIX_AGENT=me corepack yarn test:browser test/browser/m3-ui.test.mjs
corepack yarn test:browser --jobs 5   # no file: every file under test/browser
```

They start through `test/browser/_harness.mjs` `startBrowserGateway({ template, provision? })`
(M4's and M5's browser files use it too). It finds Chromium in `THIX_HARNESS_CHROMIUM`, else
Playwright's own download, else the newest headless shell or Chromium in Playwright's cache, and
the files skip with the reason in a test title when none is present (`corepack yarn playwright
install chromium-headless-shell` installs one; it is never downloaded by a test). The UI is built
into `GW/assets/` when that is missing or older than `ui/`. The `m3-300` template (one imported
300-turn session) is built once with `node perf/_m3-client.mjs template`.

The M4 acceptance files (`designs/m4-interfaces.md` 17, the `m4` template, the fake subscription
and OAuth servers on loopback): `m4-secrets` (1), `m4-pools` (2, 3), `m4-restart` (4, 11),
`m4-restart-renewal` (12: K-5, K-6), `m4-reachability` (5), `m4-catalog` (6, 13), `m4-accounts` (7),
`m4-wire` (8, 9), `m4-renewal` (10), `m4-provision` (16), `m4-retire` (17), and in the browser
`test/browser/m4-ui.test.mjs` (14, 15's browser part). The M5 acceptance files
(`designs/m5-interfaces.md` 8.1): `m5-snapshot` (1), `m5-presets` and `m5-presets-inventory` (2,
13, 14), `m5-labels` and `m5-objects` (3, 4, 5, 8), `m5-grants` (6), `m5-mentions` (7),
`m5-prompt` (9), `m5-security` (10), `m5-mentions-restart` and `m5-grants-restart` (11),
`m5-reachability` (12), and in the browser `test/browser/m5-ui.test.mjs` (15).

**Regression run** (process.md section 3.1): two batches, each inside the 20-minute rule.

```sh
corepack yarn test:regression:core        # unit and adapter lanes, then the M0-M2 files and the template test
corepack yarn test:regression:milestones  # M3–M5, environments, context, mail and voice, including browser tests
```

Each prints every file's held and waited time from `runs.jsonl` and the batch's wall time; the
lists are `regressionLists` in `scripts/test-integration.mjs`. Last run (T3-CLOSE, after the
review's step 3, `804398c4d9`, 2026-11-19, 6 jobs, load 2-4): core 1,328 unit and adapter tests
passed (116 skipped, 67 s), 25 files, 4,344 s held, 989 s wall in all; milestones 31 files,
3,326 s held, 665 s wall; every file passed (J-10251). Per-file times are in process.md section 3.1.

**Known failures** (each marked `test.failing`, or opt-in, with the reason in its title):

- Latency budgets that are sensitive to load: `m1b-live` acceptance 9 (rename within 500 ms)
  failed once at load 4.5 and passed alone (J-9450); not marked, it passes on a quiet machine.
  `m1b-exec-tool` acceptance 11 (an exec worker killed on every attempt) failed once at load 4-5
  when the killer missed the call's 4 s window, and passed alone (J-10191).
- Perf rows that miss by design or by a recorded core limit: `perf/crash.perf.mjs` and
  `perf/restart.crash.perf.mjs` (C-8, C-9), `checkpoint.stall` (C-24); see the perf table below
  and the M2 outcome table in `designs/milestones.md`.

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
corepack yarn perf:pass M4         # a milestone's recorded pass: its checks and session, turn, exec,
                                   # exclusive, back to back, after its templates
corepack yarn perf:pass context    # compaction and images; the other group lists are environments, mail, voice
```

Each script uses `perf/_harness.mjs`: state goes in `tmp/pf<pid>` and is removed afterwards
(`KEEP_STATE=1` keeps it), started through the same supervisor child as integration tests, from
fresh state by default or from the cached base template with `PERF_TEMPLATE=1` (about 17 s
faster). Every metric is one JSON line on stdout (also appended to `PERF_OUT` when set), carrying
the commit, worker sha256, crank budget and load average; the exit code is 1 when a median (or
p95, p99, max, value) is over 1.25 x its budget or deliveries per operation are over theirs.
`IDLE_MS` (default 1 h) and `SNAP_EVERY` set the supervisor's idle sleep and snapshot cadence;
Every repeated measurement runs for a fixed window (`perf/_window.mjs`, designs/process.md section
3); rows carry `window` and `samples`. `PERF_WINDOW_SCALE` scales every window (a quick smoke only):
every window length goes through `windowMs` (HR-SYN-19; `test/perf-window.test.js` checks it), and
the one unscaled read is `gateway-restart`'s file deadline `M3_RESTART_END_MS`.
`LOOP_N`, `INSTALL_N` and `CRASH_*` shorten individual scripts. The milestone templates the
checks copy are built with `node perf/_pass.mjs templates [m1a exec pool m4 m5o m3-300]` (under a
shared run-lock wrapper); their keys follow the guest bundles and the manager part, so a guest
change rebuilds them (T3-CLOSE: 169 s wall for all six in parallel, J-10250).
`perf/crash.perf.mjs` and `perf/restart.crash.perf.mjs` exit 1 by design while a restart with a crashing
vat misses its 15 s target (core candidates C-8, C-9). Paste the lines into `JOURNAL.md` with a
reading and a decision.

The recorded pass runs every file one after another in exclusive mode (`node scripts/run-lock.mjs
--exclusive --label perf-<name> -- node perf/<name>.perf.mjs`, one batch, after the long-session
templates exist); the M2 close-out held 69.5 minutes for the 25 M0-M2 files, none over 5 minutes,
and X-CLOSE held 66.7 minutes for the 12 M3-M5 files plus `session`, `turn` and `exec`
(`designs/process.md` 3.2). The times below are held time per file.

| script | rows | about |
| --- | --- | --- |
| `perf/turn.perf.mjs` | `turn.start` (+ `.open`, `.dispatch`, `.client`, `.deliveries`) over a `TURN_WINDOW_MS` window (60 s), `turn.delta`, `turn.delta.client`, `turn.round`, `turn.lease`, `turn.tooBig.*`, `turn.frames` | 2.1 min exclusive (M2 close-out); 3.0 min shared under load |
| `perf/session.perf.mjs` | `session.program`, `install.factory` (`INSTALL_N` fresh provisions, single events), `session.createCold` (`SESSION_CREATE_WINDOW_MS`, 30 s, at least 3) | 2.4 min exclusive; 3.9 min shared under load |
| `perf/restart.perf.mjs`, `perf/restart.crash.perf.mjs` (`perf/_restart.mjs`) | `restart.serving` (11 sessions set up, then runs for `RESTART_WINDOW_MS`, 90 s, at least 3; gate: woken session vats = 1, read from the worker rows' `wakes`); `.crash`: `restart.crashingSession` (one idle session, then `CRASH_WINDOW_MS`, 120 s, at least 3); split because together they held 591 s of the box under load | 3.8 min; 3.7 min exclusive; 5.0; 3.8 min shared under load |
| `perf/gc.perf.mjs` | `gc.burst.turnStart`, `gc.burst.frames`, `gc.burst.hub` over `GC_WINDOW_MS` (60 s), `gc.restart` (C-17; SIGKILL runs for `GC_RESTART_WINDOW_MS`, 90 s, at least 2) | 5.0 min exclusive; 7.6 min shared under load |
| `perf/crash.perf.mjs` | M0's crash and restart phases (C-8..C-10); single scenario events, not converted to windows | 4.6 min exclusive; 5.7 min shared under load |
| `perf/hub.perf.mjs`, `perf/hub.growth.perf.mjs`, `perf/hub.sessions.perf.mjs` (`perf/_hub.mjs`) | `hub.gcBurst`, `hub.gcBurst.turnStart` over `HUB_WINDOW_MS` (60 s); growth: `hub.persist` per `GROWTH_WINDOW_MS` window (30 s), `hub.size` sampled while a `GROWTH_TURNS` (1,000) session is built by `importState`, `hub.growth` per file (fresh and after 1,000 turns; fresh, 10 and 20 sessions, the sessions built by `importState` with one turn each, `hub.import`); `hub.growth.slope` projects 10 -> 20 sessions to 50 (`GROWTH_PROJECT`, `projected: true`): 50 sessions take 3-8 min to create or import and do not fit the box (C-20, C-2) | 2.2 min; 3.7 min; 4.7 min exclusive; 2.3; 4.3; 5.9 min shared under load |
| `perf/exec.perf.mjs` | `exec.first`, `exec.trivial` (`EXEC_TRIVIAL_WINDOW_MS`, 30 s), `exec.sends.answered` (`.sendOnly` not measurable in M1b), `exec.runaway`, `exec.retire`, the too-big probes `tooBig.*` | 1.8 min exclusive; 4.5 min shared under load |
| `perf/pool.perf.mjs` | `session.create.pool` (`POOL_CREATE_WINDOW_MS`, 45 s of wall with the settle waits, at least 3; + `.poolAwake`), `session.create.cold` (`POOL_COLD_WINDOW_MS`, 20 s, at least 3), `pool.refill`, `pool.firstTurn` | 2.2 min exclusive; 2.7 min shared under load |
| `perf/concurrency.perf.mjs` | `concurrency.single.turnStart` (`CONC_SINGLE_WINDOW_MS`, 30 s), `concurrency.10.turnStart`, `.turn`, `.crank` (from `status().deliveryHistogram`), `.rowPush`, `.gc` (rounds for `CONC_WINDOW_MS`, 60 s) | 2.4 min exclusive; 4.2 min shared under load |
| `perf/history.perf.mjs` | M2, acceptance 15's flatness: at 200 / 1,000 / 5,000 turns, each a copy of a cached template of that many imported plain turns (`perf/_long-template.mjs`), a 60 s window of turns (`perf/_long-session.mjs`; `HISTORY_WINDOW_MS`): `history.turn.at<n>` (median, p99, turns per minute), `.turn.start`, `.snapshot`, `.stall` (with the slowest turns and what they did), `.seal`, `.hub.row` (read once the row owes no answer, waiting at most 10 s, with the first read and the wait reported; K2), `.archive` (disk), `.heap` after a clean stop, then `archive.flat.*` (1,000 and 5,000 against 200 turns, <= 1.25 x) (`HISTORY_POINTS`, `HISTORY_SHAPE`) | 3.9 min exclusive (K2; M2 close-out 3.6 min); 5.5 min shared (load 4-7) |
| `perf/history.restart.perf.mjs` | the rest of acceptance 15 at the same templates: `history.history.page.at<n>` and `.archived` (15 s of reads each, `HISTORY_PAGE_WINDOW_MS`), `.walk` (1,000 and 5,000: newest turn back to turn 1), a clean restart, `.heap`, `.context.rebuild` (with `sameContext`) | 2.8 min exclusive; 6.5 min shared (load 4-7) |
| `perf/journal.perf.mjs` | the window rows under `journal.` at 1,000 and 5,000 imported plain turns (templates), `journal.snapshot.budget.at<n>`, `session.heap`, `checkpoint.stall`; 10,000 and 30,000 do not fit the box (their imports take 14 and 42 min): `journal.slope.*` per 1,000 turns and the projection at 10,000 (checked against 1 s, `projected: true`) and 30,000 (`JOURNAL_POINTS`, `JOURNAL_SNAP_EVERY`, `JOURNAL_WINDOW_MS`) | 2.4 min exclusive; 3 min shared (load 4-7) |
| `perf/throughput.perf.mjs` | a cached template of 50 sessions x 300 turns (built in steps of 10 sessions); `restart.serving.m2` (15 s; gate: no idle vat woken) and `throughput` (20 busy sessions for 60 s, `THROUGHPUT_MS`: deliveries per second, per-turn median and p99, samples) | 2.6 min exclusive; 3.5 min shared (load 5-6) |
| `perf/_long-template.mjs` | builds the cached templates the four files above use, under `<THIX_HARNESS_HOME>/long-session/`, keyed by the base template, the code that fills them and the spec; one boxed run-lock step per template: `node perf/_long-template.mjs history journal throughput` (`--list`, `--prune`); a perf check fails with this command when one is missing (`LONG_TEMPLATE_BUILD=1` builds it in place) | 200 and 1,000: 2.5 min each; 5,000: 8.1 min; busy 5 steps of 5.9-7.0 min (shared, load 2-5, M2 close-out; at load 4-7 the 5,000 step took 8.6 and the busy steps 7.4-9.2 min, near the box, J-9464) |
| `perf/archive.perf.mjs` (W2.5), `perf/import.perf.mjs` (W2.7), `perf/queue.perf.mjs` (W2.4, Node), `perf/provider.perf.mjs` (W2.1a, W2.1b, in process) | a session grown to 200 turns by running turns, then the window, pages, restart and rebuild rows under `archive.` (`ARCHIVE_POINTS`); the import rate over a 60 s window and a 300-turn import walked back (`IMPORT_WINDOW_MS`); queue costs, 10 s per row (`QUEUE_WINDOW_MS`); provider overhead and SSE rates, 10 s per row (`PROVIDER_WINDOW_MS`) | 4.0 min; 2.0 min; 0.6 min; 1.6 min exclusive |
| `perf/crank.perf.mjs`, `perf/crank.mid.perf.mjs`, `perf/crank.late.perf.mjs` (`perf/_crank.mjs`) | `crank.worker.<heap>[.alloc][.<policy>]` (the worker run directly on a vat image for `CRANK_WORKER_WINDOW_MS`, 10 s per row: per-delivery cost and its collection share), `crank.ping` (20 s), `crank.turn.start.early` (a 60 s `CRANK_WINDOW_MS` window from a new session) with its restart, `crank.context.rebuild.at<n>` and `session<n>` worker rows; `.mid` at 500 and `.late` at `CRANK_TURNS` (1,000) turns built by `importState` (tool turns): `crank.turn.start.<phase>`, `crank.grow` (wall per 100 turns from the window's rate, engine and hub deltas), `crank.history.page[.late]`, `crank.heap`, `crank.context.rebuild` (`CRANK_GC_POLICIES`). The old 2.5 h long-session table (to 5,000 turns grown) does not fit the box: 1,000 is the largest point kept, the slope is late against mid, and `perf/history.perf.mjs` holds the table to 5,000 by import | 2.9 min; 2.0 min; 3.7 min exclusive; 2.9; 2.6; 4.7 min shared under load |
| `perf/install.perf.mjs`, `perf/frames.perf.mjs` | M0's install rows (`INSTALL_N`, single installs, not windowed) and frame rows (`FRAMES_WINDOW_MS`, 15 s per latency row; `LOOP_N`) | 1.0 min; 1.8 min exclusive; 1.4; 2.8 min shared under load |
| `perf/gateway.perf.mjs` (M3) | 60 s windows: `gateway.fetch`, `gateway.guard` (in process), `ui.call`, `ui.submit`, `ui.deltaFanout` (5 clients); `gateway.probes` (100 KiB, 2,000 keys, depth 33, 33 in flight, 4,097 exports) | 5.5 min exclusive (X-CLOSE) |
| `perf/gateway-session.perf.mjs` (M3) | on the cached `m3-300` template (build it first: `node perf/_m3-client.mjs template`): `ui.snapshot`, `ui.history.newest`, `ui.history.archived`, `ui.reconnect` (60 s each), `gateway-session.teardown` | 5.2 min exclusive (K2; 5.2 min shared, load 2-3); at X-CLOSE, with the restart rows, 10.0 min and exit 124 |
| `perf/gateway-restart.perf.mjs` (M3, split from `gateway-session` by K2) | the same template: `ui.restartReady.clean` / `.sigkill` (150 s each; no restart starts whose window would end after 6 min, `M3_RESTART_END_MS`), each with the supervisor's serve time and the journal frames owed a replay at every restart, and `gateway-restart.teardown` (clean stop, sweep, removal) | 6.3 min exclusive (K2; 6.2 min shared, load 2-4): windows 315 s, teardown 2.2 s |
| `perf/ui.perf.mjs` (M3, `THIX_HARNESS_BROWSER=1`) | `ui.bundle`, `ui.coldLoad` (60 s), `ui.hubGrowth` (5 min of reloads and turns) | 7.3 min exclusive (X-CLOSE) |
| `perf/subscriptions.perf.mjs`, `perf/subscriptions-lifecycle.perf.mjs` (M4, `perf/_m4.mjs`, the `m4` template) | `subscriptions.select`, `.turnStart`, `.servedWrites` (manager cranks per session per 60 s since K2; every manager frame of the window is reported by kind, GC frames apart), `.handover`, `.bundles`, too-big probes; lifecycle: `subscriptions.renewal`, `.firstOpen` (restarts over 150 s), `catalog.pool` cold and warm | 3.5 min (K2 and X-CLOSE); 6.2 min exclusive (X-CLOSE) |
| `perf/secrets.perf.mjs`, `perf/accounts.perf.mjs` (M4) | `secrets.credentialRead`, `.auditReader` (and `.viaHub`), `.catalog` (64 secrets); `accounts.push`, `accounts.refresh` | 4.6 min; 2.1 min exclusive (X-CLOSE) |
| `perf/presets.perf.mjs`, `perf/creation-m5.perf.mjs` (M5) | `presets.save` (32 endowments), `inventory.page` (1,000 entries) with diagnostic rows; `session.program`, `exec.program`, `prompt.compose` (Node 10 s; vat 120 s, pool 4), `session.createCold` (120 s) | 3.3 min; 4.8 min exclusive (X-CLOSE) |
| `perf/exec-m5.perf.mjs`, `perf/tools.perf.mjs`, `perf/mentions.perf.mjs` (M5) | `exec.powersLookup`, `exec.membrane` (vat and Node), `exec.scope1000`, probes a, b, c, f; `tools.local`, `labels.full`, `tools.inspect`, `grants.round`, probes d, e; `mentions.turnStart` (32 attachments) | 4.6 min; 5.8 min; 2.5 min exclusive (X-CLOSE) |

M3's files check before each window that it ends by 9 min 30 s (`gateway-restart`: 6 min, so its
teardown fits inside 8) and otherwise print the row as `notMeasured: "file time"`; the teardown
after the last window is timed in its own row (it is how `gateway-session` passed the box at
X-CLOSE, before the split); `M3_WINDOW_MS`,
`M3_RESTART_WINDOW_MS` and `M3_GROWTH_MS` shorten the windows for a trial run.

A vat is woken when its worker row's `wakes` (process-local) is above 0; `journalLength` is the
delivery frontier, and held GC frames (`heldFrames`) wait in the journal without a crank. `turn.delta`
reads an in-process subscriber in the adapter, switched on only by `THIX_HARNESS_LIVE_PROBE_DIR`
in the served daemon's environment (`LIVE_PROBE_VARIABLE` in `resources/agent-host/impl/channels.js`; the script passes
it to its own supervisor; nothing on disk switches it on).

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
state persists its ceiling and is refused at a lower one, so test templates key on it), and at a
crank budget of 50 M or more `THIXOTROPE_VAT_FRAME_BYTES` (default 65,536 from `config/defaults.js`
`vatFrameBytes`: the hub's ceiling on one encoded frame into a vat, core CC-027, whose own default
of 32,768 refuses an import chunk of short turns; J-10125, J-10126). The allowlist also passes the collection schedule (`THIXOTROPE_GC_POLICY` `allocation` by default or
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
| `node scripts/bundle-guest.mjs [program ...]` | Bundles `guest/<program>/main.js` into `dist-guest/<program>.js` without comments, refusing any module outside `guest/`. Sizes after the cross-lane seam unit WX.1 (bytes, budget): session 233,126 (270,336 since WX.1, owner question G-1's default; 240,000 before), exec 64,500 (120,000), factory 192,892; after step 3 of the review (`804398c4d9`): 212,484, 62,623, 156,955 (after the fold, `bd4c811b7b`: 206,907, 61,688, 155,427; X-CLOSE: 214,690, 63,826, 164,836) |

## Disk

State for tests and perf lives under `tmp/` (git-ignored) and is deleted by the code that made
it; cached templates (about 160 MB each) stay until `removeTemplates()` or a key change. A
sleeping vat takes about 17 MB.
