// @ts-check
/**
 * M5 creation perf (W5.9; designs/m5-interfaces.md 8.2, open decision O-1),
 * on the m5o template (m1b provisioning, the default pool, the M5 fixture
 * objects in the workspace vat):
 *
 * - `session.program`, `exec.program`: bytes of the bundled programs
 *   against `limits.sessionProgramBytes` (270,336 since WX.1's G-1 default;
 *   240,000 as raised by O-1) and `execProgramBytes` (120,000, O-1). Bytes are compared strictly (no slack).
 * - `prompt.compose.node`: `composeSystemPrompt` in Node over a fixed
 *   window (PROMPT_WINDOW_MS, default 10 s), the largest preset's
 *   instructions (4,096 units of three-byte text) and none alternating;
 *   budget <= 5 ms each.
 * - `prompt.compose`: `createSession` with the largest preset (4,096-unit
 *   instructions, so the prompt is staged by the factory, and 32
 *   endowments from the inventory) and with `chat-only`, alternating over a
 *   fixed window (CREATION_WINDOW_MS, default 120 s) with a pool of 4 spare
 *   session vats; each creation starts once the pool has settled (the wait
 *   is not counted). Budget: the largest <= `chat-only` + 150 ms and
 *   <= 750 ms (medians; the harness's 1.25 x slack applies to both).
 * - `session.createCold`: `createSession` (`chat-only`) with no spare
 *   session vat, over a fixed window (CREATION_WINDOW_MS); budget median
 *   6 s (D-4: about 10 us per program byte).
 *
 *   node scripts/run-lock.mjs --exclusive --label creation-m5 -- node perf/creation-m5.perf.mjs
 */
import { performance } from 'node:perf_hooks';

import {
  BUDGET_SLACK,
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
  runPerf,
  stats,
  summarize,
} from './_harness.mjs';
import { windowMs } from './_window.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { bundleGuest } = await import('../scripts/bundle-guest.mjs');
const { execEntry, guestRoot, programPieceBytes, sessionEntry } =
  await import('../scripts/provision-steps.js');
/* eslint-disable import/no-relative-packages */
const { limits } = await import('../guest/lib/limits.js');
const { composeSystemPrompt } =
  await import('../guest/lib/system-prompt-base.js');
/* eslint-enable import/no-relative-packages */
const { makeSlice } = await import('../test/integration/_m1a-slice.js');
const { fixturesOf, objectsTemplate, operatorOf } =
  await import('../test/integration/_m5-objects.js');

const PROMPT_WINDOW_MS = windowMs('PROMPT_WINDOW_MS', 10_000);
const CREATION_WINDOW_MS = windowMs('CREATION_WINDOW_MS', 120_000);
const POOL = 4;

/**
 * A row whose budget is compared strictly (bytes: no slack).
 * @param {Record<string, any>} row
 * @param {number} limit
 */
const strictRow = async (row, limit) => {
  const pass = row.value <= limit;
  if (!pass) process.exitCode = 1;
  return emit({
    ...row,
    budget: { value: limit, slack: 'none' },
    pass,
    ...(await runIdentity()),
    crankBudget,
    loadAvg: loadAvg(),
  });
};

// The largest preset's instructions: 4,096 units of three-byte text.
const bigInstructions = '漢'.repeat(limits.presetInstructionsUnits);

await runPerf('creation-m5', async ({ provision }) => {
  // ---- session.program, exec.program
  for (const [name, entry, limit] of /** @type {const} */ ([
    ['session.program', sessionEntry, limits.sessionProgramBytes],
    ['exec.program', execEntry, limits.execProgramBytes],
  ])) {
    const bundle = await bundleGuest(entry, { guestRoot });
    await strictRow(
      {
        metric: name,
        unit: 'bytes',
        value: bundle.bytes,
        modules: bundle.modules.length,
        stagingPieces: Math.ceil(bundle.bytes / programPieceBytes),
        digest: bundle.digest.slice(0, 12),
      },
      limit,
    );
  }

  // ---- prompt.compose.node
  {
    /** @type {number[]} */
    const largest = [];
    /** @type {number[]} */
    const plain = [];
    const end = performance.now() + PROMPT_WINDOW_MS;
    let bytes = 0;
    while (performance.now() < end) {
      let t0 = performance.now();
      const text = composeSystemPrompt({
        spoken: false,
        snapshot: { instructions: bigInstructions },
      });
      largest.push(performance.now() - t0);
      bytes = text.length;
      t0 = performance.now();
      composeSystemPrompt({ spoken: false });
      plain.push(performance.now() - t0);
    }
    await stats('prompt.compose.node', largest, {
      budget: { median: 5, p99: 5 },
      extra: {
        windowMs: PROMPT_WINDOW_MS,
        promptUnits: bytes,
        chatOnlyMedianMs: summarize(plain).median,
      },
    });
  }

  const template = await objectsTemplate();
  const state = await provision({ template, idleSleepMs: 2000 });
  const slice = await makeSlice(state);
  const { harness } = slice;
  const fixtures = await fixturesOf(state);
  const { catalog, inventory } = await operatorOf(slice);
  const made = await slice.makeBackend(
    harden({
      turns: [{ input: 'hello', rounds: [{ chunks: [{ text: 'hi' }] }] }],
    }),
  );
  const { backend } = made;

  // ---- the largest preset: 4,096-unit instructions, 32 endowments
  const labels = Array.from(
    { length: limits.maxEndowments },
    (_, i) => `e${String(i).padStart(2, '0')}`,
  );
  const held = new Set(
    (await E(inventory).list()).rows.map((/** @type {any} */ r) => r.label),
  );
  const missing = labels.filter(label => !held.has(label));
  if (missing.length > 0)
    await E(inventory).addAll(
      harden(missing.map(label => ({ label, value: fixtures.notes }))),
    );
  /** @type {any[]} */
  const rows = [];
  /** @type {string | undefined} */
  let cursor;
  do {
    const page = await (cursor === undefined
      ? E(inventory).list()
      : E(inventory).list(cursor));
    rows.push(...page.rows);
    cursor = page.next;
  } while (cursor !== undefined);
  const endowments = rows
    .filter(r => labels.includes(r.label))
    .map(r => harden({ label: r.label, value: r.value }));
  const { preset: largest } = await E(catalog).create(
    harden({
      label: 'Largest',
      template: 'general',
      backend,
      instructions: bigInstructions,
      endowments,
    }),
    (await E(catalog).configuration()).revision,
  );

  // ---- prompt.compose (creations with a pool of 4)
  await E(harness).configure(harden({ spareSessions: POOL }));
  await E(harness).whenSettled();
  /** @type {number[]} */
  const largestMs = [];
  /** @type {number[]} */
  const chatOnlyMs = [];
  let n = 0;
  const poolEnd = performance.now() + CREATION_WINDOW_MS;
  while (performance.now() < poolEnd) {
    for (const [preset, into] of /** @type {const} */ ([
      [largest, largestMs],
      [slice.chatOnly, chatOnlyMs],
    ])) {
      await E(harness).whenSettled();
      n += 1;
      const t0 = performance.now();
      await E(slice.factory).createSession(
        harden({ title: `c${n}`, preset, backend, at: Date.now() }),
      );
      into.push(performance.now() - t0);
    }
  }
  await stats('prompt.compose.largest', largestMs, {
    budget: { median: 750 },
    extra: { windowMs: CREATION_WINDOW_MS, pool: POOL, endowments: 32 },
  });
  await stats('prompt.compose.chatOnly', chatOnlyMs, {
    extra: { windowMs: CREATION_WINDOW_MS, pool: POOL },
  });
  {
    const big = summarize(largestMs).median;
    const plain = summarize(chatOnlyMs).median;
    const added = +(big - plain).toFixed(3);
    const pass = added <= 150 * BUDGET_SLACK && big <= 750 * BUDGET_SLACK;
    if (!pass) process.exitCode = 1;
    emit({
      metric: 'prompt.compose',
      unit: 'ms',
      largestMedian: big,
      chatOnlyMedian: plain,
      addedMedian: added,
      n: [largestMs.length, chatOnlyMs.length],
      windowMs: CREATION_WINDOW_MS,
      budget: { added: 150, median: 750, slack: BUDGET_SLACK },
      pass,
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
  }

  // ---- session.createCold (no spare session vat)
  await E(harness).configure(harden({ spareSessions: 0 }));
  await E(harness).whenSettled();
  const program = await bundleGuest(sessionEntry, { guestRoot });
  /** @type {number[]} */
  const coldMs = [];
  const before = await state.counters();
  const coldEnd = performance.now() + CREATION_WINDOW_MS;
  while (performance.now() < coldEnd) {
    n += 1;
    const t0 = performance.now();
    await E(slice.factory).createSession(
      harden({
        title: `cold ${n}`,
        preset: slice.chatOnly,
        backend,
        at: Date.now(),
      }),
    );
    coldMs.push(performance.now() - t0);
  }
  const after = await state.counters();
  await stats('session.createCold', coldMs, {
    budget: { median: 6000 },
    before,
    after,
    extra: {
      windowMs: CREATION_WINDOW_MS,
      programBytes: program.bytes,
      depends: 'C-5 (staging cost)',
    },
  });
});
