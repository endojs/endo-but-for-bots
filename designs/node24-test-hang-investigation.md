# Node-24 CI Test Hang Investigation

| | |
|---|---|
| **Created** | 2026-06-21 |
| **Updated** | 2026-06-21 |
| **Author** | kumavis (prompted) |
| **Status** | **Complete** (root cause confirmed, fix landed on PR #471) |

## Status

**Resolved.** The hang is upstream Playwright bug
[microsoft/playwright#41000](https://github.com/microsoft/playwright/issues/41000):
`playwright install chromium` hangs during Chromium extraction on **Node
24.16.0** (an `extract-zip`/`yauzl` regression,
[nodejs/node#63487](https://github.com/nodejs/node)). It surfaced because PR
#471's diff pulls `@endo/preact-container` — whose test is
`playwright install chromium && vitest run` (vitest browser mode) — into
turbo's affected set, and its pinned `playwright@1.56.1` is in the broken
range. Fix: bump `playwright` to `^1.60.0` (resolved to `1.61.0`) in
`packages/preact-container/package.json`. Verified in isolation on Node
24.16.0: `1.56.1` hangs (killed at 240s); `1.61.0` installs Chromium and runs
all 147 browser tests in ~2s. Landed on `claude/chat-preact-setup-r95thr`
(PR #471). See "Resolution" at the end for the confirming evidence.

Branch under repair: `claude/chat-preact-setup-r95thr` (PR #471)

## Symptom

On PR #471 the CI `test (24.x)` jobs (both `ubuntu-latest` and `macos-15`)
hang indefinitely — the step runs for hours and is only killed by GitHub's
global job timeout. Every other job is green:

| Job (same commit) | Result |
| --- | --- |
| `test (24.x, ubuntu-latest)` — plain `ava` via turbo | **hangs forever** |
| `test (24.x, macos-15)` | **hangs forever** |
| `test (22.x, *)` | ✅ pass (~1.5 min) |
| `cover (24.x, ubuntu)` — `c8 ses-ava` | ✅ pass (~90 s) |
| `cover (22.x, ubuntu)` | ✅ pass |

The hang is **Node-24-specific** and reproduces on **both** Linux and macOS.

## What CI actually runs

The `test` job runs:

```
yarn turbo run test --filter='...[origin/llm]'
```

The leading `...` selects every package changed versus `origin/llm` **plus
their dependents**. The PR's diff is large (the whole confined-Preact
migration), so the affected set is **not just `@endo/chat`**. The packages in
the set that actually have a `test` script with tests are:

| Package | `test` script | Runner | # test files |
| --- | --- | --- | --- |
| `@endo/chat` | `ava` | AVA + happy-dom + SES (worker threads) | 57 |
| `@endo/space-file-explorer` | `ava` | AVA + happy-dom + SES (worker threads) | 12 |
| `@endo/preact-container` | `playwright install chromium && vitest run` | **vitest browser mode + Playwright Chromium** | 6 |

turbo runs these **in parallel**. A single hung task wedges the whole
`turbo run` invocation, which wedges the CI step.

## The breakthrough

For most of the investigation `@endo/chat` was assumed to be the culprit
(it has by far the most tests). That assumption was **wrong**:

- A diagnostic probe that runs chat's full suite under worker threads with a
  watchdog preload shows **chat's `ava` exits cleanly: `632 tests passed`,
  exit 0, watchdog never fires** — yet the CI **job still hangs**.
- On **macOS** the job hangs even though chat's `ava` **never ran** (the
  probe script aborted on `timeout: command not found`, a macOS GNU-coreutils
  gap — see "Artifacts" below). If chat never executed and the job still
  hangs, the hang is **not** in chat's tests.

Therefore the hang is in **another package in the affected set**, and the
prime suspect is:

### `@endo/preact-container` — vitest browser mode + Playwright Chromium

```jsonc
// packages/preact-container/package.json
"scripts": {
  "test": "playwright install chromium && vitest run"
}
```

```js
// packages/preact-container/vitest.config.mjs
test: {
  globals: true,
  include: ['test/**/*.test.js'],
  browser: {
    enabled: true,
    provider: playwright(),
    headless: true,
    instances: [{ browser: 'chromium' }],
  },
}
```

This launches a **real headless Chromium** plus a vitest browser server. If
that browser/server subprocess is not torn down cleanly, it survives the
`vitest` process and **holds the CI step's stdout pipe open** — GitHub (and
turbo) wait for that file descriptor to close, so the step hangs forever even
though the test run logically finished.

This hypothesis explains **every** observation:

- **Job hangs while chat's `ava` exits 0** — the leaked process is in
  `preact-container`, not chat.
- **macOS hangs even though chat never ran** — `preact-container`'s vitest
  runs there too.
- **Node 22 passes, Node 24 hangs** — Node's child-process / subprocess
  teardown changed between 22 and 24; the browser child is reaped on 22 and
  lingers on 24. (`globals: true` and the `describe` BDD style also confirm
  this is a vitest, not AVA, suite.)
- **`cover (24.x)` passes** — the `cover` job runs `test:c8` (`c8 ses-ava`),
  which does **not** invoke `vitest`/Chromium, so it never spawns the browser.
- **Never reproducible locally** — `vitest`, `@vitest/browser-playwright`,
  and the Playwright Chromium cache are **absent from this container's
  `node_modules`**, so `preact-container`'s real (browser) suite cannot even
  start here. Running `ava` against those files (as the early parallel repro
  attempt did) just errors with `describe is not defined` — it never
  exercises the browser path.

## Eliminations (things proven NOT to be the cause)

- **A single leaked `setTimeout` in a chat component.** An early per-file
  probe with an 8 s watchdog flagged `microblog.test.js` and
  `channel-thread.test.js`, but timing them with plain `ava` shows they
  simply run **slowly** (11.2 s / 8.8 s) and then **exit 0 cleanly**. The 8 s
  watchdog was firing *during* a still-running suite — a **false positive**.
  A full timer-lifecycle trace confirmed `created == fired + cleared +
  pending` with the "pending" timers created mere milliseconds before the
  watchdog, i.e. healthy in-flight work, not a leak.
- **AVA worker threads.** Setting `workerThreads: false` (child processes) on
  chat **still hung** `test (24.x)` (~3.5 h) while `cover` passed — so it is
  not a worker-thread teardown bug, and the leak survives any process model.
- **Node minor version.** Reproduced the hang attempt on Node 24.0.0 and
  24.17.0 (CI's latest) locally — both **exit cleanly**.
- **Core count / `CI` env / lockdown options.** Matched 4 cores, `CI=true`,
  and `LOCKDOWN_OPTIONS` locally — still exits cleanly.
- **Stale dependencies / build artifacts.** Chat's deps resolve to source
  (`@endo/preact-container` exports map to `./src/*.js`); no stale `dist`.
- **`domainTaming`.** Adding/removing `domainTaming: 'unsafe'` did not change
  the chat outcome.
- **happy-dom timers.** happy-dom timers are unref'd and exit clean on Node
  24.
- **`@endo/chat` itself.** Its `ava` exits 0 with the probe; the job hangs
  regardless.
- **`@endo/space-file-explorer` in isolation.** Its `ava` suite (80 tests)
  exits 0 in ~12 s locally on Node 24, and exits cleanly when run in parallel
  with chat. (Still uses the same AVA + happy-dom + SES stack, so it remains a
  secondary suspect on CI, but it is not the browser-spawning package.)

## Artifacts / gotchas encountered

- **macOS runners lack GNU `timeout`** — any probe shell step using `timeout`
  exits 127 on `macos-15`. All macOS probe/segment results are invalid; only
  `test (24.x, ubuntu-latest)` is a trustworthy signal for the probe scripts.
- **In-progress GitHub Actions logs return 404** via the API — a hung job's
  log cannot be read until it concludes, which is why a fast, self-terminating
  probe (watchdog + `process.exit`) was needed instead of a passive one.
- **AVA 8 / `ava` invocation** uses `entrypoints/cli.js` (not `cli.mjs`);
  `--node-arguments="--import=<ABSOLUTE path>"` is required for a preload
  (relative paths silently fail to load).
- **`@endo/init/debug.js` lockdown does NOT swap `globalThis.setTimeout`** —
  so a `setTimeout`-wrapper instrumentation is reliable across lockdown.
- **`async_hooks` `destroy` for timers fires on GC, not on fire** — so
  `async_hooks` cannot distinguish "pending" from "fired-but-not-collected";
  `process.getActiveResourcesInfo()` is the authoritative "still holding the
  loop" signal.

## Confirmation experiment

An isolated `hang-probe` workflow (off `llm`) ran **only**
`@endo/preact-container`'s real test on Node 22 vs 24, bounding it with
`timeout` and redirecting vitest output to a file (so a stuck process can't
wedge the step), then dumping the exit code and any leftover browser:

```bash
timeout -s KILL 240 yarn workspace @endo/preact-container run test >/tmp/v.out 2>&1
echo "exit=$?"; tail -40 /tmp/v.out
ps -eo pid,ppid,etimes,comm,args | grep -iE 'chrom|headless|vitest|playwright' | grep -v grep
```

This is **not** a vitest/browser-teardown leak as first suspected — the hang
is in `playwright install chromium`, *before* vitest ever prints `RUN`.

## Resolution

Confirmed on `24.x, ubuntu-latest` (`node v24.16.0`), changing only the
Playwright version:

| | `playwright@1.56.1` | `playwright@1.61.0` |
|---|---|---|
| Node 24.16.0 | download `100% of 173.9 MiB`, then **hang** → killed at 240s (`exit=137`); vitest never starts | ✅ Chromium installs, **`147 passed` in ~2s**, no leftover process, clean exit |
| Node 22.x | ✅ `147 passed`, 2.78s | ✅ `147 passed` |

**Root cause:** [microsoft/playwright#41000](https://github.com/microsoft/playwright/issues/41000)
(dup of #40998) — a Node 24.16.0 `extract-zip`/`yauzl` regression
([nodejs/node#63487](https://github.com/nodejs/node)) hangs Chromium
extraction. `playwright<=1.57` is affected; **1.60.0+ fixes it**. The runner's
`24.x` resolves to 24.16.0, and the `&&` in `playwright install chromium &&
vitest run` means a stuck install wedges the whole `test (24.x)` job (both
ubuntu and macos) for hours, taking the turbo run — and therefore PR #471's
CI — down with it.

**Fix (landed on PR #471):** bump `playwright` `1.56.1` → `^1.60.0`
(resolved `1.61.0`) in `packages/preact-container/package.json`, with the
lockfile update in its own commit.

This was not a chat / SES / AVA / worker-thread issue at all; the long detour
through chat came from the turbo affected set mixing `@endo/chat`,
`@endo/space-file-explorer`, and `@endo/preact-container` into one `test` job,
so chat's (passing) AVA output was the last thing visible before the
(unrelated) preact-container task wedged the run.
