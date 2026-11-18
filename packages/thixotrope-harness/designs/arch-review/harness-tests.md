# Architecture review HR-TEST: tests, perf checks, scripts and tooling of the harness

Unit HR-TEST of the harness architecture review. Read-only: no source, test or config file was
changed, and no test, supervisor or perf check was run. Snapshot: branch `claude/thix-arch` at
`b62ab85a10`. Paths are relative to `packages/thixotrope-harness/` unless they start with
`packages/`. Vocabulary follows `core-ontology.md` section 5. Evidence marks: **read** (the code
was read), **measured** (a script counted it), **inferred**.

Scope: `test/**` (unit, adapter, integration, browser, template, fixtures, spikes), `perf/**`,
`scripts/**`, `config/**`, `package.json`, the AVA configuration, README test instructions.
Started 2026-11-18T12:52:57Z; the end time is in journal entry J-9991.

---

## 1. Summary

The test tree works and is disciplined where the owner asked for discipline: every integration
file and perf check runs under the run lock and a 10-minute box, state starts from a cloned
template instead of a 45-second cold start, every perf row goes through one emitter with a budget
verdict, and no product module imports test code. What it lacks is a **shared support layer**.
Each milestone wrote its own scaffolding next to its tests, in files named for the milestone, and
later milestones and the perf checks imported whichever one was nearest. The result is a
test/perf import cycle, four supervisor wrappers, two "served state" models, three template-key
policies, ten window loops and fourteen medians. None of this is wrong today. All of it makes the
next test cost more than it should, and two of the copies have already drifted from what they copy.

**Three things most worth changing**

1. **Build one test-support layer and one served-state model** (HR-TEST-1, HR-TEST-2). Move the
   de-facto library (`test/integration/_m1a-slice.js`, `_m1b*.js`, `_m4.js`, `_m2-lifecycle.js`,
   the template, the row emitter) into `test/support/` with behaviour names, and make
   `perf/_harness.mjs provision` a thin layer over `startFromTemplate`. This removes the
   `test/integration` <-> `perf` cycle (58 and 44 imports) and three of the four supervisor
   wrappers.
2. **One template-key policy, and no test concerns in product provisioning** (HR-TEST-4,
   HR-TEST-5). Template ids are a content hash in one place, patched by hand in three others; the
   `m3-300` perf template is keyed by a hand-bumped version and can serve stale imported state.
   `scripts/provision-steps.js` carries ~110 lines of test-template code and a registered product
   step that evaluates a test fixture.
3. **One window loop and one quantile in perf** (HR-TEST-7). `runWindow` is used by 13 of 37
   perf scripts; the rest use 9 private helpers and 13 inline loops, two of which can return zero
   samples; 22 window variables bypass `PERF_WINDOW_SCALE`, which README says scales every window.

**Three things most worth keeping**

1. **The state template** (`test/template/index.js`): a cleanly stopped, provisioned state
   directory, cloned per test (APFS clonefile), keyed on the runtime identity, published by one
   rename under a build lock, never served at the path it is stored under. It is what makes 59
   integration files affordable at all.
2. **The run lock and per-file time box** (`scripts/run-lock.mjs`,
   `scripts/test-integration.mjs`): measured, enforced, logged. Of 423 logged runs, 4 timed out
   and each is visible in `runs.jsonl`.
3. **One emitter for perf rows** (`perf/_harness.mjs` `emit`/`finishRow`): every row carries
   identity, load, crank budget, lock mode and a budget verdict; `summarize` is tested as
   nearest-rank. The rows are comparable across milestones because of it.

---

## 2. Map of the area

Sizes are lines of `.js`/`.mjs`/`.sh` [measured].

| module | lines | job |
| --- | ---: | --- |
| `test/unit/` (81 files, 7 `_` helpers, 2 benches) | 32,068 | guest and UI logic in Node with object-level fakes; `_m1a-prelude.js` puts the vat prelude on `globalThis` (imported by 161 files) |
| `test/adapter/` (62 files, 9 `_` helpers, 6 benches) | 21,279 | agent-host adapter modules in Node, fake HTTP servers |
| `test/integration/` (48 test files, 11 `_` helpers) | 16,072 | real supervisor from a cached template; gated by `THIX_HARNESS_INTEGRATION=1` |
| `test/browser/` (4 files + `_harness.mjs`) | 1,526 | Playwright against a served gateway; gated by `THIX_HARNESS_BROWSER=1` |
| `test/template/` (`index.js`, its test) | 855 | template build, cache, copy, supervisor child, run-lock hooks |
| `test/fixtures/` | 2,401 | fake provider, subscription and OAuth servers, SSE files, m5 fixture objects, run-lock taker |
| `test/spikes/` (s1..s9, `_spike.js`, `_crash.js`) | 3,757 | M0 measurement programs; gated by `THIX_HARNESS_SPIKES=1` |
| `test/*.js` (run lock, serve, bundle, lint, limits, perf harness) | 2,604 | tooling tests |
| `perf/` (37 `*.perf.mjs`, 9 `_` modules) | 13,306 | fixed-window perf checks, cached long-session templates |
| `scripts/` product: `serve`, `provision(-steps)`, `export`, `gateway`, `subscription-login`, `bundle-guest`, `guest-prelude`, `_init` | 3,538 | operator and runtime entry points |
| `scripts/` tooling: `run-lock`, `test-integration`, `process-time`, `new-lane.sh` | 2,552 | build-process tooling |
| `config/` (`defaults.js`, `defaults-m4.js`) | 217 | Node-side limits |

Imports between areas (count of import statements crossing the boundary) [measured, scratch
script over every relative `import`/`export from`/`import()`]:

```
product (guest, resources, ui, config)  ->  test, perf, tooling scripts : 0      (good)
scripts                                 ->  test, perf                  : 0      (good)
perf             -> test/integration 58, test/template 11, test/fixtures 16,
                    test/adapter 2, test/unit 1, test/spikes 1, test/browser 1
test/integration -> perf 44   (perf/_harness.mjs: emit, runIdentity, loadAvg, stats ...)
test/adapter     -> test/integration 5 (_m2-secrets.js), perf 6
test/unit        -> test/adapter 3, perf 2
test/browser     -> test/integration 6, perf 1
```

Who imports the `_` helpers most: `test/integration/_m1a-slice.js` (26 perf imports plus most
integration files), `test/template/index.js` (56 integration, 11 perf),
`test/integration/_m2-lifecycle.js` (`writeSyntheticExport`, the large-state builder that
`designs/process.md` section 3 names as the rule, used by 6 perf modules).

Ways to start a supervisor [read]: `scripts/serve.mjs` `spawnSupervisorChild` is the one spawn
(environment allowlist, parent-death pipe). It is wrapped four times: `test/template/index.js`
`makeSupervisor` / `startFromTemplate`, `perf/_harness.mjs` `provision` (through `serveHarness`),
`perf/crash.perf.mjs` (own wrapper), `test/spikes/_crash.js` (own wrapper); plus
`test/spikes/_spike.js` and `test/browser/_harness.mjs` on top of those.

Template kinds and their keys [read]:

| kind | where | key | built by |
| --- | --- | --- | --- |
| base and milestone templates (`base`, `m1a-…`, `m1b-…`, `m1bp-…`, `m4-…`, `m5o-…`) | `tmp/t<key>` per worktree | runtime files + `WORKSPACE_VERSION` parsed from core source + crank budget + slot ceiling + GC/hub env + `id`; `id` from `templateIdFor` content hash, patched per template | `ensureTemplate` |
| `m3-300` (300 imported turns) | `tmp/t<key>` | as above, `id` = m1a id + hand-bumped `M3_TEMPLATE_VERSION` | `ensureTemplate` via `perf/_m3-client.mjs` |
| long-session (200/1,000/5,000 turns; busy 50 x 300) | `<THIX_HARNESS_HOME>/long-session/t<key>` machine-wide | `LONG_TEMPLATE_VERSION` + base key + digest of `_long-template.mjs`, `scripts/export.mjs`, `_m2-lifecycle.js`, `impl/archive/*` + spec + previous step | `perf/_long-template.mjs` `buildTemplate` (a second function of that name) |

The skipped tests [measured]: the default lane (`ses-ava`, files `test/**/*.test.*`) loads every
integration, spike and browser file and registers its tests as `test.skip`: 51
`integrationEnabled ? test.serial : test.skip` gates, 9 spike gates, 3 browser gates, 2 in
`test/serve.test.js`, 1 each in `m1b-live` and `m2-probes`, several inside loops. **Unit and
adapter files contain no skip at all.** The 109 skipped are the integration, spike and browser
suites seen from the unit lane, not hidden failures. The spikes and browser files also register
12 placeholder tests that pass (`t => t.pass()`).

What a new contributor reads to run one integration test [read]: README "Build what the tests
run" (a Rust release build at the repository root and `build:ironhorse-bundles` in
`packages/thixotrope`), "The run lock", "Integration tests" (the env gate, the run-lock CLI, never
several files at once) — about 90 lines of a 310-line README, accurate and dense. For one unit
test: `corepack yarn test <file>`, but see HR-TEST-14.

---

## 3. Findings

### HR-TEST-1 (major, questions 1, 2) No test-support layer: the shared library is milestone helper files, and test and perf import each other

- **Where.** 27 underscore helpers named for milestones: `test/integration/_m1a-slice.js`,
  `_m1b.js`, `_m1b-exec.js`, `_m1b-pool.js`, `_m2-archive-kill.js`, `_m2-lifecycle.js`,
  `_m2-secrets.js`, `_m2-w25.js`, `_m3-gateway.js`, `_m4.js`, `_m5-objects.js`; seven in
  `test/unit/`, nine in `test/adapter/`. `perf/_harness.mjs:107` (`emit`) imported by 56 test
  files.
- **Evidence.** [measured] perf imports `test/integration` 58 times (26 of them
  `_m1a-slice.js`), `test/integration` imports `perf` 44 times: a cycle between the two areas.
  `test/adapter` imports `test/integration/_m2-secrets.js` (5 files); `test/unit` imports
  `test/adapter/_m2-archive*.js` and `_m1b-blobs.js`; `perf/frames.perf.mjs:28` imports the M0
  spike helper `test/spikes/_spike.js`. `writeSyntheticExport`, the large-state rule of
  `designs/process.md` section 3, lives in `test/integration/_m2-lifecycle.js:144`. [read] Tests
  import `emit`, `runIdentity`, `loadAvg` from perf to print template build rows
  (`_m1b-exec.js:74-90`, `_m1b-pool.js:22-45`, `_m5-objects.js:63-97`: the same 12-line block
  three times).
- **Why it matters.** A contributor writing a new test cannot find "the" helper for a served
  state, a client view, a wait or a fake; they find the one their milestone used. Every other
  finding in sections 3.2-3.3 that lists copies is a consequence.
- **Smallest fix.** Create `test/support/` with behaviour names: `served-state.js` (template +
  supervisor, HR-TEST-2), `client-view.js` (today's `makeSlice`), `templates.js` (HR-TEST-4),
  `wait.js` (`waitFor`, `drain`), `ids.js` (`requestId`, `AT`), `synthetic-export.js`,
  `rows.js` (the emitter, moved from perf so tests stop importing perf). Perf imports support;
  support imports neither tests nor perf. Move by `git mv` plus import rewrites.
- **Size.** About 5,000 lines moved (not rewritten) from ~20 files; import lines in ~150 files.
- **Risk.** Mechanical; `tsc` and the unit lane catch broken imports, the integration suite
  catches behaviour. Template ids that hash file paths (`templateIdFor` hashes
  `provision-steps.js`) rebuild once.

### HR-TEST-2 (major, questions 2, 4) Four supervisor wrappers and two models of a served state

- **Where.** `test/template/index.js:227-298` (`makeSupervisor`), `:534-620`
  (`startFromTemplate` -> `TemplateState`); `perf/_harness.mjs:456-543` (`provision` ->
  `Provisioned`); `perf/crash.perf.mjs:236-300`; `test/spikes/_crash.js:95-160`.
- **Evidence.** [read] All four call `spawnSupervisorChild`, collect stderr crash lines, close
  the client, SIGKILL or SIGTERM with a 60 s fallback. `TemplateState` has `kill`, `stop`,
  `restart()`, `cleanup`, `crashLog`; `Provisioned` has `restart(label)` (which also emits a
  perf row) and `close`, and no kill. `test/integration/_m4.js:122-127` documents taking "a
  template state (tests) or a perf harness `Provisioned` (perf checks: no kill or stop)". The
  copies have drifted: `test/template/index.js:213` `CRASH_LINE` includes `gave up|giving up`;
  `perf/crash.perf.mjs:265-268` writes its own narrower regex without them, so the crash perf
  check does not see the give-up line the tests see.
- **Smallest fix.** One `startServedState({ template | fresh, root, ... })` in
  `test/support/served-state.js` returning the `TemplateState` shape; `perf/_harness.mjs
  provision` calls it and adds the row; `crash.perf.mjs` and `_crash.js` use `crashLog()`.
- **Size.** About 300 lines removed, 4 files changed, 3 callers adjusted.
- **Risk.** Perf `*.restart` rows must keep their fields (`closeMs`, `stateKiB`, RSS);
  `test/perf-harness.test.js` covers rows, `test/template/template.test.js` the template;
  crash.perf has no test and should be run once by hand after the change.

### HR-TEST-3 (moderate, question 5) The integration suite no longer fits the owner's 20-minute regression rule, and the process record says it does

- **Where.** `designs/process.md` section 3 ("a milestone's whole regression run finishes in 20
  minutes of wall time") and 3.1 (the table: 25 files, 1,040 s at M2).
- **Evidence.** [measured] From `<THIX_HARNESS_HOME>/runs.jsonl`, the last passing run of each
  of 53 integration files held 8,068 s of slot time in all (longest `m5-presets` 334 s,
  `m4-restart` 290 s, `m1b-followups` 266 s). With perfect packing that is at least 22.4 min at
  6 slots and 33.6 min at the 4 jobs the process names. [inferred] The cause is structural: each
  file starts its own supervisor from a template, and one subject is tested in several milestone
  files (HR-TEST-9: `interfaces` in 6, `session`, `provision`, `gateway`, `ui` in 3 each).
- **Smallest fix.** Update 3.1 with the current list. Then, per subject, merge files that start
  the same template for independent scenarios into one file with one supervisor and a fresh
  workspace per test where the scenario allows it; leave restart and SIGKILL files alone.
- **Size.** Table: one section. Merges: about 10 file pairs, test bodies unchanged.
- **Risk.** Tests sharing a supervisor can couple through vat state; keep restart, crash and
  quota tests in their own files.

### HR-TEST-4 (moderate, questions 2, 3, 5) Three template-key policies; the `m3-300` template can serve stale imported state

- **Where.** `test/template/index.js:142-177`; `scripts/provision-steps.js:466-510`
  (`templateIdFor`); `test/integration/_m4.js:72-95`; `test/integration/_m5-objects.js:63-80`;
  `perf/_m3-client.mjs:47`, `:69-75`; `perf/_long-template.mjs:256-306`.
- **Evidence.** [read]
  - The base key reads the core's `WORKSPACE_VERSION` by regex over
    `packages/thixotrope/src/control/supervisor.js` source (`index.js:153-158`, falling back to
    `'?'` silently if the line changes shape).
  - `templateIdFor` hashes the bundles, step files, every `.js` beside `durable.js` and
    `guest/lib`. `_m4.js:79-95` then hashes `durable-subscriptions.js` again, with a comment
    (`:72-78`) saying `templateIdFor` hashes `durable.js` "without its imports";
    `durable-subscriptions.js` sits beside `durable.js` and is already hashed
    (`provision-steps.js:498-506`). The patch is redundant and the comment is stale.
  - `m3-300` imports 300 turns with `importState` and `writeSyntheticExport`, through the
    archive implementation, but its id is the m1a id plus `M3_TEMPLATE_VERSION = 1`, bumped by
    hand. The long-session templates, built the same way, hash `scripts/export.mjs`,
    `_m2-lifecycle.js` and `impl/archive/*`. A change to the export format or the archive leaves
    `m3-300` cached, and `perf/gateway-session.perf.mjs` and `ui.perf.mjs` measure the old state.
  - Two caches (`tmp/` per worktree and `<THIX_HARNESS_HOME>/long-session` per machine), two
    functions named `buildTemplate`, three version constants.
- **Smallest fix.** One `templateId({ prefix, files, dirs, extra })` in `test/support/templates.js`
  that every template uses, with the import-built templates listing the export and archive files
  once. Export `WORKSPACE_VERSION` from the core (or read it from a served state's record) instead
  of parsing source. Drop the `_m4.js` patch.
- **Size.** About 80 lines, 5 files.
- **Risk.** Every template id changes once (one rebuild per worktree, about 40 s to 9 min for the
  long-session chain). `template.test.js` covers `templateKey`; no test covers id coverage.

### HR-TEST-5 (moderate, question 1) Product provisioning carries test-template code and a test-only step

- **Where.** `scripts/provision-steps.js:83-103`, `:446-571`;
  `scripts/provision-steps/50-m5-fixtures.js:18-33`.
- **Evidence.** [measured] `templateIdFor`, `m1aTemplateOptions`, `m1bTemplateOptions`,
  `standinSessionEntry`, `standinExecEntry` are imported only by `test/` and `perf/` (3, 4, 5, 3
  and 2 files; 0 product files), about 110 lines. [read] The registered product step
  `50-m5-fixtures.js` runs at every provisioning and, when a test passes `options.m5Fixtures`,
  evaluates the fixture's source string in the workspace vat and keeps the result in inventory.
  The product default pool is named `M1A_POOL` ("M1a's states create cold", `:34`), while
  `provision` passes `{}` (`:443`): two defaults for one option.
- **Smallest fix.** Move the template options into `test/support/templates.js`; give
  `ensureTemplate`'s `provision` an `extraSteps` list and pass the m5 fixture step from the test
  template, not from the product registry. Rename `M1A_POOL` to what it is (`NO_SPARES`).
- **Size.** About 150 lines moved, 6 files.
- **Risk.** Template ids change (rebuild once). `test/unit/m5-w55-powers.test.js:281` tests the
  step and moves with it.

### HR-TEST-6 (moderate, question 5) `yarn test:browser` without arguments runs no browser test

- **Where.** `package.json:40`; `scripts/test-integration.mjs:60-67`.
- **Evidence.** [read] `test:browser` is `THIX_HARNESS_BROWSER=1 THIX_HARNESS_INTEGRATION=1 node
  scripts/test-integration.mjs`. With no file argument, `defaultFiles` lists only
  `test/integration` and `test/template`, and only names ending `.test.js`; the browser files are
  `test/browser/*.test.mjs`. The command runs the integration suite and none of the four browser
  files. It works only when a file is named (as README line 146 does).
- **Smallest fix.** `defaultFiles` takes the directories and suffix from a flag; `test:browser`
  passes `--dir test/browser`.
- **Size.** About 10 lines, 2 files.
- **Risk.** None; nothing tests `defaultFiles` today (add one case beside
  `test/run-lock.test.js`).

### HR-TEST-7 (moderate, questions 2, 3, 4) Perf: one window loop in principle, ten in practice; fourteen medians; the scale knob misses half the windows

- **Where.** `perf/_window.mjs:49-66` (`runWindow`); private loops `perf/queue.perf.mjs:61`,
  `frames.perf.mjs:91`, `_hub.mjs:267`, `_m4.mjs:46`, `provider.perf.mjs:87`,
  `presets.perf.mjs:52`, `_m3-client.mjs:217`, `_long-session.mjs:266`, `mentions.perf.mjs:106`.
- **Evidence.** [measured]
  - `runWindow` is imported by 13 of 37 perf scripts. Besides it: 9 named private window
    helpers and 13 inline `while (performance.now() < end)` loops (`creation-m5` x3, `ui` x2,
    `tools` x2, `gateway`, `gateway-session`, `exec-m5`, `throughput`, `crash`,
    `_long-session:496`).
  - `measureWindow` (`_m3-client.mjs:217`) and `inWindow` (`_m4.mjs:46`) test the clock before
    the first operation and can return zero samples; `summarize` throws on zero
    (`_harness.mjs:121`). `runWindow` guarantees `min` (default 1).
  - The row field `window` is a number in 7 rows (`queue:72`, `provider:98`, `throughput:213`,
    `import:122`, `_long-session:544,653,678`) and `{ ms, elapsedMs }` in every `runWindow` row;
    `_long-session.mjs:275` returns elapsed time under the name `windowMs`.
  - 18 window lengths go through `windowMs()` (scaled by `PERF_WINDOW_SCALE`); 22 are read as
    `Number(process.env.X ?? n)` and are not scaled. README:217 and `_window.mjs:15` say the
    variable "scales every window".
  - Median or quantile is written 14 more times beside `summarize` (`gc:85`, `_hub:331`,
    `subscriptions-lifecycle:61`, `turn:91`, `crash:223`, `throughput:194`, `provider:261,356,
    382,531`, `_long-session:244`, `import:63` — the last two identical — and 3 in integration
    tests). All use the same nearest-rank index; they differ on an empty input (throw, `null`,
    `NaN`, `undefined`).
- **Smallest fix.** Give `runWindow` the options the private copies exist for (`warmup`, `cap`,
  a file-clock `deadline`), export `quantile` from `_harness.mjs`, emit `window` only through
  `windowFields`, read every window through `windowMs()`. Then replace the private helpers.
- **Size.** About 400 lines touched in ~20 files; net about -250.
- **Risk.** Row field shapes change for 7 rows (anything reading `runs`/`PERF_OUT` by field
  should be checked). `runWindow` and `windowFields` have no test today; add one to
  `test/perf-harness.test.js` first.

### HR-TEST-8 (moderate, question 2) Unit and adapter scaffolding written per file

- **Where.** Across `test/unit/` and `test/adapter/`.
- **Evidence.** [measured]
  - Turn-the-event-loop helpers (`drain`, `flush`, `tick`, `settle`) in 25 files, waiting 1, 6,
    20 or 30 `setImmediate` rounds, or one 20 ms timer (`m2-w22-catalog.test.js:80`).
  - Poll-until-true helpers defined 13 times with three signatures: `(pred, ms)`,
    `(pred, ms, what, every)`, `(pred, what, ms)` (`_m1a-slice.js:52`, `_m2-w21b-round.js:32`,
    `m2-w26-turns.test.js:67`, `m1a-agent-host.test.js:60`, `m2-w21a-openrouter.test.js:61`,
    `m1b-blobs-provider.test.js:52`, `_m1b-blobs.js:128`, `m5-w58-mentions.test.js:134`,
    `m5-w58-presets.test.js:180`, `m1a-provision.test.js:90`, `run-lock.test.js:302`,
    `run-lock-slots.test.js:40`, `serve.test.js:382`).
  - The `AT`/`requestId`/`usage` block in 11 files; `requestId` defined 14 ways; `harnessRoot`
    14 times (4 exported); `round1` 10 times.
  - `stubExo` and `pathsOf` copied into all six `m*-interfaces.test.js` (23-29 lines each,
    4,401 lines in the six files). The duplicate finder (`designs/arch-review/tools/
    find-duplicates.mjs --min 8`) puts 3.3 % of normalised test/perf/script lines in repeated
    blocks (1,999 of 61,045; the core measured 0.8 %).
  - The hub's retired break is written three ways: the literal string in 9 files,
    `` `ocapn hub: ${RETIRED_TEXT}` `` in 9, the exported `HUB_RETIRED_MESSAGE` in 8.
- **Smallest fix.** `test/support/wait.js` and `ids.js` (HR-TEST-1); a `drain(rounds)` with one
  documented default; import `HUB_RETIRED_MESSAGE`; one `test/support/interfaces.js` for
  `stubExo`/`pathsOf`. The interface-split work in the integration workflow is changing the six
  interfaces tests now: fold the shared helpers in there.
- **Size.** About 600 lines removed across ~60 files.
- **Risk.** Tests that pass only because of a particular number of event-loop turns will show
  themselves; that is a gain, but budget time for it.

### HR-TEST-9 (moderate, question 4) Tests are named for milestones and work units, not behaviours

- **Where.** `test/unit`, `test/adapter`, `test/integration`, `test/browser`.
- **Evidence.** [measured] 178 of 196 test and bench files start with a milestone (`m1a-` …
  `m5-`), 47 of them also with a work unit (`m2-w23-`, `m5-w58-`, `m2-t1-`). 16 subjects are
  split across milestones: `interfaces` (6 files), `ui`, `session`, `provision`, `gateway` (3
  each), `wire`, `secrets`, `reachability`, `queue`, `prompt`, `pool`, `manager`, `factory`,
  `exec`, `composer`, `catalog` (2 each). [read] This was deliberate:
  `designs/milestones.md` "Conventions" made milestone-prefixed files a directory registry so
  parallel lanes never edit the same file. It did its job for the build; it now makes "where are
  the tests of the queue" a grep over five milestones.
- **Smallest fix.** After the lanes close, one mechanical rename commit into subject
  directories (`test/unit/session/queue.test.js`), and an acceptance index in README mapping
  milestone acceptance numbers to files (README already keeps most of that list).
- **Size.** About 190 renames; README and process tables.
- **Risk.** JOURNAL entries cite old names (historical; leave them). Template ids hash some
  paths (rebuild once).

### HR-TEST-10 (moderate, question 5) Hidden global state through the environment

- **Where.** `perf/_m4.mjs:62-67`, `test/integration/_m4.js:100-106`,
  `test/integration/_m3-gateway.js:40-48`, `m2-catalog.test.js:97`, `m2-providers.test.js:102`,
  `m2-secrets.test.js:111`; `test/template/index.js:88-90`.
- **Evidence.** [read] The Secrets key file is passed to supervisors by setting
  `process.env.THIX_HARNESS_SECRETS_KEY` in the test process, "every supervisor started
  afterwards inherits it": 6 sites, 3 helpers with three names (`useKeyFile` twice, with
  different signatures, and `useTestWrappingKey`), directory names carrying the work unit tag
  `w48`. [measured] Test, perf and script code reads 128 distinct environment variables; 78 are
  named neither in README nor in `designs/process.md`. [read] `integrationEnabled` is also true
  under `THIX_HARNESS_SPIKES=1`, so asking for spikes turns every integration file on, and
  `corepack yarn test` would then run them in parallel AVA workers, which README forbids.
- **Smallest fix.** Pass `secretsKeyFile` as an option of `startFromTemplate` /
  `spawnSupervisorChild` (which already builds the child's environment from an allowlist);
  delete the three helpers. List the knobs in one `test/support/env.js` with a comment each.
  Separate the spike gate from the integration gate. The integration workflow's "sealing secret
  writes" work touches these helpers; this may be in hand.
- **Size.** About 60 lines, 8 files.
- **Risk.** A test that starts a second supervisor relying on the inherited key must pass it
  explicitly; the m2/m4 secrets integration files cover it.

### HR-TEST-11 (moderate, questions 2, 5) A unit fixture re-assembles the session program and has drifted from it

- **Where.** `test/unit/_m2-w25-session.js:1-9`, `:187-215`; `guest/session/session.js:89-130`.
- **Evidence.** [read] The helper says it assembles the turn runner "as session.js assembles
  it". It does not: `session.js` passes `maxToolRounds`, `sources` and `getRuntime` to
  `makeTurnRunner` and `cancelCurrent` to `makeQueue`; the helper passes none of them. The 835
  lines of `m2-w25-archive*.test.js` run against this assembly. [measured] It is the only test
  file that calls `makeTurnRunner` directly; 10 others build sessions through `makeSession`.
- **Smallest fix.** Export the assembly from `session.js` (a `makeSessionCore` that returns
  runner, queue and core) and use it in both places.
- **Size.** About 40 lines, 2 files.
- **Risk.** The archive unit tests may change behaviour where the missing options mattered
  (send-now cancel). The session program's bundle budget is tight (J-9933): an export adds no
  code.

### HR-TEST-12 (moderate, question 3) Eight benches in `test/` that nothing runs and that break the window rule

- **Where.** `test/unit/m1a-queue.bench.mjs`, `m1a-session.bench.mjs`;
  `test/adapter/m1a-channels.bench.mjs`, `m1b-blobs.bench.mjs`, `m1b-context-cache.bench.mjs`,
  `m2-archive.bench.mjs`, `m2-w22-catalog.bench.mjs`, `m2-w23-secrets.bench.mjs`.
- **Evidence.** [measured] 1,742 lines; no `package.json` script, no perf runner and no README
  section runs them (AVA's glob is `*.test.*`); none uses `runWindow` (counted loops, for example
  `m1a-queue.bench.mjs:77`), against `designs/process.md` section 3. Each imports
  `perf/_harness.mjs` for rows. One is cited as evidence in `designs/m1a-interfaces.md:133`.
- **Smallest fix.** Move the ones whose numbers still matter to `perf/` as Node-level
  `*.perf.mjs` on `runWindow` (so `yarn perf` runs them); delete the rest, leaving their journal
  entries as the record.
- **Size.** 8 files moved or removed.
- **Risk.** None for correctness.

### HR-TEST-13 (minor, question 5) A known-failure test that passes when its probe did not run

- **Where.** `test/integration/m2-probes.test.js:46`, `:131`, `:140-145`.
- **Evidence.** [read] The `test.failing` reads the module-level `frontier`, set by the previous
  test, initial `[0, 0]`. Its guard `t.true(frontier[0] > 0, 'the probe above ran')` fails when
  the probe did not run (`--match`, or the probe threw), and AVA reports a failing
  `test.failing` as the expected failure. The guard can never surface.
- **Smallest fix.** Assert the current behaviour inside the probe test
  (`t.is(frontier[1], frontier[0] + 1, '[known failure W2.9] the vat guard refuses it')`), so
  both a broken probe and a fix make it fail loudly.
- **Size.** 10 lines.
- **Risk.** None.

### HR-TEST-14 (minor, question 5) The "unit" lane needs the release worker and the boot bundles

- **Where.** `test/template/template.test.js:37-70`; `test/template/index.js:142-152`.
- **Evidence.** [read] Three tests in the default lane call `templateKey`, which streams the
  worker binary and `dist-ironhorse/boot.js` and `worker-peer.js` into a hash and rejects when
  a file is missing. [inferred, not run] On a checkout without the Rust build, `corepack yarn
  test` fails these three; README's "Unit tests and lint" section names no build.
- **Smallest fix.** Gate the three with `integrationEnabled`, or let `templateKey` take its
  runtime-file list as a parameter and test it with scratch files.
- **Size.** 10 lines.
- **Risk.** None.

### HR-TEST-15 (minor, question 5) Process-id truncation in build and state directory names

- **Where.** `test/template/index.js:411`, `:679-684`; `test/spikes/_crash.js:98`.
- **Evidence.** [read] Build directories are `b${pid % 100_000}`; `removeTemplates` decides a
  build is live with `isProcessAlive(Number(b))`, the truncated number. [inferred] On a host whose
  pids exceed 99,999 (Linux defaults go to 4,194,304) a live build can be judged dead and
  removed, and two builders whose pids collide modulo 100,000 share one directory, which
  `buildTemplate` starts by deleting (`:412`). macOS pids stay below 100,000, so it has not bitten.
- **Smallest fix.** `shortName('b')` plus a pid file inside the build directory.
- **Size.** 15 lines.
- **Risk.** None.

### HR-TEST-16 (minor, question 1) `scripts/` mixes product entry points with build-process tooling

- **Where.** `scripts/`.
- **Evidence.** [measured] Product: `serve.mjs`, `provision.mjs`, `provision-steps*`,
  `export.mjs`, `gateway.mjs`, `subscription-login.mjs`, `bundle-guest.mjs`,
  `guest-prelude.js`, `_init.mjs` (3,538 lines). Tooling: `run-lock.mjs`,
  `test-integration.mjs`, `process-time.mjs`, `new-lane.sh` (2,552). `process-time.mjs` (1,040
  lines, with a 300-line test) analyses agent transcripts for `TIMELOG.md`; it is about how the
  harness is built, not the harness. It re-derives the `THIX_HARNESS_HOME` default
  (`process-time.mjs:1012`) instead of importing `harnessHome` (`run-lock.mjs:119`).
- **Smallest fix.** `scripts/dev/` (or a `tools/` directory) for the four tooling files; import
  `harnessHome`.
- **Size.** 4 moves, ~10 path references in README and `process.md`.
- **Risk.** The `packages/thixotrope` Ironhorse lane and every lane's habits call
  `scripts/run-lock.mjs` by path: keep a one-line forwarder for a while.

### HR-TEST-17 (minor, questions 1, 5) Perf and tests read the core's on-disk layout

- **Where.** `perf/_harness.mjs:239-254` (`hubJsonBytes`), `perf/_long-session.mjs:106-186`,
  `perf/_crank.mjs:173-236`, `perf/_hub.mjs:112`, and 14 more test/perf modules.
- **Evidence.** [measured] 18 test and perf modules open `workers/*/meta.json`,
  `heaps/hub-image.json`, `hub-log.jsonl` or snapshot files; three shell out to `sqlite3` on a
  snapshot (`vatImage` is written twice, `_crank.mjs:191` and `_long-session.mjs:119`).
  `hubJsonBytes` is named for `hub.json`, which since CC-024 is only a marker; it measures the
  image and log. This is the harness side of the core review's "concepts passed as files, not
  objects" (core.md section 1, item 2): the planned hub row-format work (C-2) will break these
  perf modules. Black-box greps of a state directory for leaked secrets
  (`test/integration/_m2-secrets.js:97-136`) are a legitimate use and should stay.
- **Smallest fix.** One `perf/_state-files.mjs` that owns every path and format read (and is the
  one place to change with C-2); rename `hubJsonBytes` to `hubStoreBytes` (rows keep the field
  name or are versioned).
- **Size.** About 200 lines moved, 6 files.
- **Risk.** Perf rows only.

### HR-TEST-18 (minor, question 2) The two fake provider servers share a plan interpreter by copy

- **Where.** `test/fixtures/fake-provider-server.mjs:548-662`,
  `test/fixtures/fake-subscription-server.mjs:491-604`.
- **Evidence.** [measured] An 83-line repeated block (plan entry, status, headers, SSE pacing,
  disconnect, hang). The subscription server's header says it answers "as M2's
  `fake-provider-server.mjs` does … same plan entries".
- **Smallest fix.** `test/fixtures/plan-server.mjs` with the routing table as a parameter.
- **Size.** About 120 lines removed, 3 files.
- **Risk.** Adapter wire tests (`m2-w21*`, `m4-wire-*`) cover both servers.

### HR-TEST-19 (minor, question 3) The M0 spikes are still in the tree, and a perf check depends on one

- **Where.** `test/spikes/` (3,757 lines); `perf/frames.perf.mjs:28`.
- **Evidence.** [read] The spikes record M0's measurements (journal J-0140 onward). They register
  9 placeholder tests that pass in the unit lane, carry their own supervisor wrapper
  (`_crash.js`), emitter (`_spike.js:119`, `SPIKE_OUT` beside perf's `PERF_OUT`) and medians, and
  `perf/frames.perf.mjs` imports `PROBE_PROGRAM`, `giveHistory` and `makeProgram` from
  `_spike.js`. S8 (a state directory serves from a new path) is the proof the template relies on
  (`test/template/index.js:9-10`).
- **Smallest fix.** Keep S8 as an integration test next to the template; move the three helpers
  `frames.perf.mjs` uses into perf; remove the other spikes, which git history and the journal
  keep.
- **Size.** About -3,000 lines.
- **Risk.** Re-measuring an M0 number needs a checkout of an old commit.

### HR-TEST-20 (minor, question 3) The default lane loads every gated file to skip it

- **Where.** `../../ava-endo-lockdown.config.mjs` (`files: ['test/**/*.test.*']`),
  `package.json:35`.
- **Evidence.** [measured] 109 skipped tests in the unit lane are the integration, spike and
  browser suites (section 2); 12 more placeholder tests pass. Each gated file is imported, which
  for integration files loads the template module and the run lock.
- **Smallest fix.** A package-local AVA `files` list for the default lane
  (`test/unit/**`, `test/adapter/**`, `test/*.test.js`, the template's pure tests); the
  integration runner already passes files explicitly. Then the per-file `test.skip` gates and
  placeholders can go.
- **Size.** One config entry; ~60 gate lines later.
- **Risk.** A file left out of both lists is silently never run: add a check that every
  `*.test.*` is in exactly one lane.

### HR-TEST-21 (minor, question 4) Test-support vocabulary

- **Evidence.** [read]
  - **"harness"** names the package, the `harness` object a client looks up
    (`slice.harness`, `status()`), `perf/_harness.mjs` and `test/browser/_harness.mjs`.
  - **A served state** is `state` (`TemplateState`), `run` / `served` (`Provisioned`), `slice`
    (the client view, 162 files say `slice`) and `m4` (`m4View`). "Slice" is M1a's "vertical
    slice" and means nothing to a reader now.
  - **"template"** names three caches with different keys and homes (section 2).
  - **The Secrets key file** is "key file", "wrapping key" and `secrets.key`; work-unit tags
    survive in runtime strings (`w48-` directories, the `fake-w48-` token prefix,
    `test/integration/_m4.js:67-71`).
  - `config/defaults-m4.js` is a milestone-named product file (Node-side subscription
    defaults), kept equal to `guest/lib/limits-m4.js` by a test.
- **Smallest fix.** In the support layer of HR-TEST-1: `servedState`, `clientView`,
  `templateOf`, `secretsKeyFile`; rename the browser and perf `_harness` modules (`_browser.mjs`,
  `_perf.mjs`); `config/subscriptions.js`. Use core-ontology section 5's "workspace" only for the
  user's vat.
- **Size.** Rides on HR-TEST-1 and HR-TEST-9.
- **Risk.** None beyond the renames.

### HR-TEST-22 (minor, question 5; plausible) Two fakes break a lease with a message the hub never sends

- **Where.** `test/unit/_m2-queue-session.js:64`, `test/unit/m5-w57-packages.test.js:244`;
  `guest/lib/retired.js:25-49`; `guest/session/turn.js:1264-1278`.
- **Evidence.** [read] On a dead adapter incarnation, these fakes reject `holdTurn` with
  `` `hub: ${RETIRED_TEXT}` ``, while their `publish` and their restart path use
  `` `ocapn hub: …` ``. `isRetiredBreak` matches the whole message exactly, so the turn runner
  treats the fake's lease break as an ordinary error and settles the turn `failed`
  (`turn.js:1274-1277`); the real hub's break takes the restart path. [inferred] A test whose
  session calls `holdTurn` on stale ports after `restartAdapter()` exercises a branch production
  does not reach. The second file looks copied from the first.
- **Smallest fix.** Use `HUB_RETIRED_MESSAGE` in both fakes.
- **Size.** 2 lines.
- **Risk.** A queue test may change outcome; if one does, it was testing the fake.

---

## 4. Good, and to be kept

- **Dependency direction of product code** [measured]: guest, resources, ui and config import
  nothing from tests, perf or tooling; scripts import nothing from tests or perf. HR-TEST-5 is
  the one place where test concerns reach product code, and it is by data, not import.
- **The state template** [read]: clone-not-copy, rename-into-place, build lock, keyed on what
  makes a state unusable, `killStrays` after every stop. The ideas are right; HR-TEST-4 is
  about the id inputs, not the mechanism.
- **One spawn path** [read]: every supervisor in every test, spike and perf check is a
  `spawnSupervisorChild` child with the environment allowlist and the parent-death pipe, so a
  SIGKILLed test leaves no daemon. HR-TEST-2 is about the four wrappers around it.
- **The run lock, the 10-minute box and `runs.jsonl`** [measured]: the time rules are enforced,
  and the record made HR-TEST-3 measurable in one script.
- **Perf rows** [read]: one `emit`, budget slack stated and tested, identity and load on every
  row, `fewSamples` instead of running longer. `runWindow` itself is small and right.
- **Unit and adapter lanes** [measured]: no skipped test, object-level fakes rather than mocks
  of modules, the guest prelude helper used uniformly (161 files), the guest lint rules tested
  (`test/guest-lint.test.js`).
- **Black-box security checks** [read]: `assertNoSecretInState` greps the whole state
  directory for every encoding of a secret value (`test/integration/_m2-secrets.js:60-136`).
- **README's test sections** [read]: long, but accurate against the code in every place this
  review checked, except `PERF_WINDOW_SCALE` (HR-TEST-7) and the unit lane's build needs
  (HR-TEST-14).

---

## 5. Not covered

- No test, perf check or supervisor was run; HR-TEST-14 and HR-TEST-15 are inferred from code.
- The assertions of individual tests were sampled, not read file by file; whether each of the
  ~1,200 test titles matches what it asserts is not established.
- `scripts/run-lock.mjs` internals (1,121 lines, 1,290 lines of tests), `scripts/export.mjs`
  and `scripts/subscription-login.mjs` were reviewed for their place in the structure, not for
  correctness.
- The UI fakes (`test/unit/_m3-fake-powers.js`, one 1,300-line function at `:94-1394`, and
  `_m4-ui-fakes.js`) and the browser tests were mapped, not reviewed.
- `lint/`, `tsconfig.json` and the SSE fixture contents.
- The perf numbers themselves and whether budgets are right.
- `guest/factory/standin-*.js` (test stand-ins in the guest tree) belong to the guest review.
