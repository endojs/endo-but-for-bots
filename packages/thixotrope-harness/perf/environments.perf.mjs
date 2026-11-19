// @ts-check
/**
 * Environments perf (`designs/m6-interfaces.md` section 10), on the
 * `environments` template with the fake runtime:
 *
 * - `environments.runTrue`: a `runCommand(true)` tool call, `tool_call` to
 *   `tool_result` arrival (the fake runtime's own spawn is about 1 ms,
 *   J-0811, and is not subtracted); budget median 150 ms. Frames per
 *   command: the session vats' journal growth over a turn of two
 *   `runCommand` calls in one round less that of a turn of one (budget 1),
 *   and the environments manager vat's growth over the window (budget 0
 *   per command).
 * - `environments.firstCommand`: the first command of a fresh `development`
 *   session (port open, workspace init, fake start); budget median 500 ms.
 * - `environments.sessionCreate`: `development` minus `chat-only` creation,
 *   alternating; budget median 175 ms.
 * - `environments.cancel`: `Turn.cancel()` during `sleep 600` to the turn
 *   settled `cancelled`; recorded.
 * - `environments.stopCleanup`: `EnvironmentControl.stop()` of an
 *   environment running `sleep 600` (provided by the admin) to no process
 *   of it alive; recorded.
 * - `environments.tooBig` (gate, 5 runs): 10 MiB of stdout, call to result
 *   recorded, each <= 2 s; the result valid JSON of at most 32,768 units;
 *   no vat halted.
 * - `environments.bundles` (gate): session program growth over the WX.1
 *   base against the lane's cap; the manager bundle against 80 KB; a fresh
 *   install of the resource against 5 s.
 * - `environments.coldStart` `[real-runtime]`: only with
 *   THIX_HARNESS_REAL_RUNTIME; otherwise a row says it was not run.
 *
 * Windows: ENVIRONMENTS_WINDOW_MS (default 60 s, PERF_WINDOW_SCALE applies).
 *
 *   node scripts/run-lock.mjs --shared --label env-perf -- node perf/environments.perf.mjs --shared
 */
import { performance } from 'node:perf_hooks';
import path from 'node:path';

import { emit, runPerf, single, stats, summarize } from './_harness.mjs';
import { runWindow, windowFields, windowMs } from './_window.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { makeBundle } = await import('@endo/compartment-mapper/bundle.js');
const { makeReadPowers } =
  await import('@endo/compartment-mapper/node-powers.js');
const fs = await import('node:fs');
const url = await import('node:url');
const crypto = await import('node:crypto');
const { bundleGuest } = await import('../scripts/bundle-guest.mjs');
const { sessionEntry, guestRoot } =
  await import('../scripts/provision-steps.js');
const { environmentsDirectory } =
  await import('../scripts/provision-steps/60-environments.js');
const { makeSlice, waitFor } =
  await import('../test/integration/_m1a-slice.js');
const { readField, runTurn, turnRecords } =
  await import('../test/integration/_m1b.js');
const {
  commandCall,
  commandTurn,
  environmentProcesses,
  environmentsTemplate,
  startEnvironmentSession,
  toolResultsOf,
} = await import('../test/integration/_environments.js');

const WINDOW_MS = windowMs('ENVIRONMENTS_WINDOW_MS', 60_000);
const WARMUP = 2;
/** The session program after WX.1 and the lane's cap over it (milestones.md). */
const SESSION_BASE_BYTES = 233_126;
const SESSION_CAP_BYTES = 6400;
/** WX.1's shared call table, first bundled by this lane (W6.4, J-12040). */
const CALL_TABLE_BYTES = 1857;

const script = harden({
  turns: [
    commandTurn('true', [[commandCall('true')]]),
    commandTurn('true twice', [[commandCall('true'), commandCall('true')]]),
    commandTurn('long', [[commandCall('sleep', ['600'])]]),
    commandTurn('big', [
      [commandCall('sh', ['-c', "head -c 10485760 /dev/zero | tr '\\0' a"])],
    ]),
  ],
});

/**
 * Journal lengths of the session vats and the environments manager vat.
 * @param {any} slice
 */
const frameCounts = async slice => {
  const rows = await slice.workers();
  let sessions = 0;
  let manager = 0;
  for (const w of rows) {
    const label = String(w.debugLabel ?? '');
    if (/(^| )session( |$)/.test(label)) sessions += Number(w.journalLength);
    if (label === 'native:environmentsAdmin') manager = Number(w.journalLength);
  }
  return { sessions, manager };
};

await runPerf('environments', async ({ provision }) => {
  const template = await environmentsTemplate();
  const run = await provision({ template });
  const slice = await makeSlice(run);
  const made = await slice.makeBackend(script);
  const content = await E(slice.admin).content();
  const admin = await run.client.call('lookup', 'environmentsAdmin');

  /**
   * One tool turn: `tool_call` to `tool_result` arrival, and its result.
   * @param {{ session: any, live: any }} s
   * @param {string} input
   */
  const toolTurn = async (s, input) => {
    const r = await runTurn(slice, s.session, s.live, input);
    const of = (/** @type {string} */ type) =>
      s.live.deliveries.find(
        (/** @type {any} */ d, /** @type {number} */ i) =>
          i >= r.from && d.event.type === type && d.event.turnId === r.turnId,
      );
    const callAt = of('tool_call')?.arrivedAt;
    const result = of('tool_result');
    return {
      status: r.end.status,
      ms: result.arrivedAt - callAt,
      result: result.event.result,
      turn: r.turn,
    };
  };
  const open = async (/** @type {string} */ preset = 'development') => {
    const session = await startEnvironmentSession(slice, made.backend, preset);
    const live = await slice.subscribe(session);
    return { session, live };
  };

  // ---- environments.runTrue, and frames per command
  const main = await open();
  for (let i = 0; i < WARMUP; i += 1) await toolTurn(main, 'true');
  const managerBefore = (await frameCounts(slice)).manager;
  /** @type {number[]} */
  const extraFrames = [];
  let commands = 0;
  const runTrue = await runWindow(
    async () => {
      const a = await frameCounts(slice);
      const t = await toolTurn(main, 'true');
      const b = await frameCounts(slice);
      const twice = await toolTurn(main, 'true twice');
      const c = await frameCounts(slice);
      commands += 3;
      extraFrames.push(c.sessions - b.sessions - (b.sessions - a.sessions));
      if (t.status !== 'completed' || twice.status !== 'completed')
        throw Error(`true: ${t.status}, ${twice.status}`);
      return t.ms;
    },
    { ms: WINDOW_MS },
  );
  const managerAfter = (await frameCounts(slice)).manager;
  const perCommand = summarize(extraFrames).median;
  await stats('environments.runTrue', runTrue.results, {
    budget: { median: 150 },
    ...windowFields(runTrue),
    extra: {
      what: 'runCommand(true): tool_call to tool_result arrival (fake runtime)',
      sessionFramesPerCommand: perCommand,
      managerFramesPerCommand: +(
        (managerAfter - managerBefore) /
        commands
      ).toFixed(3),
      by: 'W6.7',
    },
  });
  await single(
    'environments.runTrue.managerDeliveries',
    (managerAfter - managerBefore) / commands,
    {
      budget: { value: 0 },
      extra: {
        unit: 'frames',
        commands,
        what: 'environments manager vat frames per command after the first',
      },
    },
  );
  await single('environments.runTrue.sessionDeliveries', perCommand, {
    budget: { value: 1 / 1.25 },
    extra: {
      unit: 'frames',
      what: 'session frames of a two-command round less a one-command round (median)',
      samples: extraFrames.length,
    },
  });

  // ---- environments.firstCommand (a fresh session per sample)
  const first = await runWindow(
    async () => {
      await E(slice.harness).whenSettled();
      const s = await open();
      try {
        const t = await toolTurn(s, 'true');
        if (t.status !== 'completed') throw Error(`first: ${t.status}`);
        return t.ms;
      } finally {
        await s.live.stop();
        await E(slice.factory).deleteSession(s.session);
      }
    },
    { ms: WINDOW_MS, min: 3 },
  );
  await stats('environments.firstCommand', first.results, {
    budget: { median: 500 },
    ...windowFields(first),
    extra: {
      what: 'first runCommand of a fresh development session: port, workspace init, fake start',
    },
  });

  // ---- environments.sessionCreate (development minus chat-only)
  /** @type {Record<string, number[]>} */
  const created = { development: [], 'chat-only': [] };
  const createWindow = await runWindow(
    async i => {
      const kind = i % 2 === 0 ? 'development' : 'chat-only';
      // Each creation takes a spare from a full pool (refilled between).
      await E(slice.harness).whenSettled();
      const t = performance.now();
      const session = await startEnvironmentSession(slice, made.backend, kind);
      const ms = performance.now() - t;
      created[kind].push(ms);
      await E(slice.factory).deleteSession(session);
      return ms;
    },
    { ms: WINDOW_MS, min: 4 },
  );
  const dev = summarize(created.development);
  const chat = summarize(created['chat-only']);
  await single('environments.sessionCreate', dev.median - chat.median, {
    budget: { value: 175 },
    ...windowFields(createWindow),
    extra: {
      what: 'median createSession(development) - median createSession(chat-only)',
      development: dev,
      chatOnly: chat,
    },
  });

  // ---- environments.cancel
  const cancel = await runWindow(
    async () => {
      const receipt = await slice.submit(main.session, 'long');
      const turn =
        receipt.turn ??
        (
          await waitFor(
            () => E(main.session).getCurrentTurn(),
            30_000,
            'the turn',
          )
        ).turn;
      await waitFor(
        () => environmentProcesses(run.root).length > 0,
        30_000,
        'sleep 600 running',
        5,
      );
      const t = performance.now();
      await E(turn).cancel();
      await waitFor(
        async () => (await E(turn).getStatus()).state === 'cancelled',
        30_000,
        'cancelled',
        5,
      );
      return performance.now() - t;
    },
    { ms: WINDOW_MS, min: 3 },
  );
  await stats('environments.cancel', cancel.results, {
    ...windowFields(cancel),
    extra: {
      what: 'Turn.cancel() during sleep 600 to the turn settled cancelled',
      recorded: true,
      expectedMs: 1000,
    },
  });

  // ---- environments.stopCleanup
  const kit = await E(admin).provide(harden({ workspace: true, shell: true }));
  const stopCleanup = await runWindow(
    async () => {
      const before = new Set(environmentProcesses(run.root).map(p => p.pgid));
      E(kit.shell)
        .runCommand('sleep', ['600'])
        .catch(() => {});
      const group = await waitFor(
        () => environmentProcesses(run.root).find(p => !before.has(p.pgid)),
        30_000,
        'sleep 600 running',
        5,
      );
      const t = performance.now();
      await E(kit.control).stop();
      await waitFor(
        () => !environmentProcesses(run.root).some(p => p.pgid === group.pgid),
        30_000,
        'the group gone',
        5,
      );
      return performance.now() - t;
    },
    { ms: WINDOW_MS, min: 3 },
  );
  await stats('environments.stopCleanup', stopCleanup.results, {
    ...windowFields(stopCleanup),
    extra: {
      what: 'EnvironmentControl.stop() to no process of the environment (fake)',
      recorded: true,
    },
  });
  await E(admin).release(kit.control);

  // ---- environments.tooBig (gate, 5 runs)
  /** @type {number[]} */
  const bigMs = [];
  const wrong = [];
  for (let i = 0; i < 5; i += 1) {
    const t = await toolTurn(main, 'big');
    const text = await readField(content, t.result);
    let valid = false;
    try {
      valid = typeof JSON.parse(text).stdout === 'string';
    } catch {
      valid = false;
    }
    bigMs.push(t.ms);
    if (t.ms > 2000) wrong.push(`run ${i}: ${Math.round(t.ms)} ms`);
    if (!valid || text.length > 32_768)
      wrong.push(`run ${i}: ${text.length} units, valid ${valid}`);
  }
  const halted = (await slice.workers())
    .filter((/** @type {any} */ w) => w.failure)
    .map((/** @type {any} */ w) => w.debugLabel);
  const lastRecords = toolResultsOf(
    await turnRecords((await toolTurn(main, 'true')).turn),
  );
  const nextTurnRan = lastRecords.length === 1 && !lastRecords[0].failed;
  if (!nextTurnRan) wrong.push('the following command failed');
  await single('environments.tooBig', Math.max(...bigMs), {
    budget: { value: 2000 },
    extra: {
      gate: wrong.length === 0 && halted.length === 0,
      runs: bigMs.map(ms => Math.round(ms)),
      wrong,
      halted,
      nextTurnRan,
    },
  });
  if (wrong.length > 0 || halted.length > 0)
    throw Error(
      `Large-output gate failed: ${JSON.stringify({ wrong, halted })}`,
    );

  // ---- environments.bundles (gate)
  const session = await bundleGuest(sessionEntry, { guestRoot });
  const sessionBytes = session.bytes;
  const readPowers = makeReadPowers({ fs, url, crypto });
  const managerBytes = Buffer.byteLength(
    await makeBundle(
      readPowers,
      url.pathToFileURL(path.join(environmentsDirectory, 'durable.js')).href,
    ),
  );
  const tInstall = performance.now();
  await run.client.call(
    'installNative',
    'environmentsAdminProbe',
    environmentsDirectory,
  );
  const installMs = performance.now() - tInstall;
  const growth = sessionBytes - SESSION_BASE_BYTES;
  const laneOwnBytes = growth - CALL_TABLE_BYTES;
  await single('environments.bundles.session', laneOwnBytes, {
    budget: { value: SESSION_CAP_BYTES / 1.25 },
    extra: {
      unit: 'bytes',
      sessionBytes,
      base: SESSION_BASE_BYTES,
      cap: SESSION_CAP_BYTES,
      sharedCallTableBytes: CALL_TABLE_BYTES,
      growth,
      laneOwnBytes,
    },
  });
  await single('environments.bundles.manager', managerBytes, {
    budget: { value: 80_000 / 1.25 },
    extra: {
      unit: 'bytes',
      what: 'makeBundle of resources/environments/durable.js',
    },
  });
  await single('environments.bundles.install', installMs, {
    budget: { value: 5000 },
    extra: { what: 'installNative of the environments resource, fresh name' },
  });

  // ---- environments.coldStart [real-runtime]
  emit({
    metric: 'environments.coldStart',
    run: false,
    reason: process.env.THIX_HARNESS_REAL_RUNTIME
      ? 'not built: the OCI cold start needs a pinned image present locally'
      : 'THIX_HARNESS_REAL_RUNTIME unset (podman or docker not configured)',
    realRuntime: true,
  });
  await main.live.stop();
});
