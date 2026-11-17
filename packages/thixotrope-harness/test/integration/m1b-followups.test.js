// @ts-check
/**
 * M1b follow-ups in a real daemon (JOURNAL J-9360..J-9379), on the m1b
 * template, through public objects:
 *
 * - Name table guard (J-9366): every public entry point of the session and
 *   the factory is first used once with constant data, then fed more than
 *   100,000 distinct keys as data (submissions inline and staged, model
 *   replies, tool calls with distinct names and argument keys, titles,
 *   request ids, cursors, session keys). The session vat's and the factory
 *   vat's interned property names are read from their snapshots after a
 *   clean stop each time (`small_sections` id 3, the `NAME` table: a u32
 *   count first). The status API does not expose the count.
 * - The exec scope in an Ironhorse vat (J-9367, J-9368): the names model
 *   code sees on `globalThis`, no host path in a stack string, and an
 *   abandoned call's one more step cannot send.
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m1b-followups -- \
 *     corepack yarn test test/integration/m1b-followups.test.js
 */
/* eslint-disable no-await-in-loop -- steps of one scenario run in order */
import '../unit/_m1a-prelude.js';

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
} from '../../perf/_harness.mjs';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, requestId, round1 } from './_m1a-slice.js';
import { execTemplate } from './_m1b-exec.js';
import { runTurn, turnRecords } from './_m1b.js';

takeIntegrationLock(test, 'm1b follow-ups test');

const run = integrationEnabled ? test.serial : test.skip;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

/**
 * Interned property names of a vat at its latest snapshot: the `NAME`
 * section (small_sections id 3) starts with a big-endian u32 count.
 * @param {string} root
 * @param {string} workerId
 */
const vatNames = (root, workerId) => {
  const metaPath = path.join(root, 'workers', workerId, 'meta.json');
  if (!existsSync(metaPath)) return undefined;
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (meta.snapshot?.ref === undefined) return undefined;
  const file = path.join(
    root,
    'heaps',
    'snapshots',
    `${meta.snapshot.ref}.sqlite`,
  );
  const hex = execFileSync('sqlite3', [
    file,
    'select hex(substr(bytes, 1, 4)) from small_sections where id = 3',
  ])
    .toString()
    .trim();
  return {
    label: meta.debugLabel,
    cut: meta.snapshot.cut,
    names: parseInt(hex, 16),
  };
};

/**
 * A JSON object text with `n` distinct keys starting at `from`.
 * @param {string} prefix
 * @param {number} from
 * @param {number} n
 */
const keysJson = (prefix, from, n) => {
  /** @type {string[]} */
  const parts = [];
  for (let i = from; i < from + n; i += 1) parts.push(`"${prefix}${i}":${i}`);
  return `{${parts.join(',')}}`;
};

/** Keys the flood carries, counted as it is built. */
let fedKeys = 0;
/**
 * @param {string} prefix
 * @param {number} n
 */
const fresh = (prefix, n) => {
  const text = keysJson(prefix, fedKeys, n);
  fedKeys += n;
  return text;
};

const UNKNOWN_TOOLS = limits.maxCallsPerMessage - limits.maxCallsPerRound;

/**
 * The scripted backend: `baseline` uses every shape once with constant
 * data; the default turn floods (a 100,000-key reply text, 64 echo calls
 * whose arguments carry distinct keys, 192 calls to distinct unknown
 * tools).
 */
const makeScript = () => {
  const floodCalls = [];
  for (let i = 0; i < limits.maxCallsPerRound; i += 1) {
    floodCalls.push({
      name: 'echo',
      args: JSON.stringify({ text: fresh('arg', 100) }),
    });
  }
  for (let i = 0; i < UNKNOWN_TOOLS; i += 1) {
    floodCalls.push({ name: `tool_${fedKeys + i}`, args: fresh('targ', 20) });
  }
  fedKeys += UNKNOWN_TOOLS;
  const baselineCalls = [
    { name: 'echo', args: JSON.stringify({ text: '{"a":1}' }) },
    { name: 'nosuchtool', args: '{"b":2}' },
  ];
  return harden({
    turns: [
      {
        input: 'baseline',
        rounds: [
          {
            chunks: [{ text: `{"c":3}${'x'.repeat(limits.inlineBytes)}` }],
            toolCalls: baselineCalls,
            usage,
          },
          { chunks: [{ text: 'base done' }], usage },
        ],
      },
      {
        rounds: [
          {
            chunks: [{ text: fresh('reply', 100_000) }],
            toolCalls: floodCalls,
            usage,
          },
          { chunks: [{ text: fresh('final', 300) }], usage },
        ],
      },
    ],
  });
};

/**
 * Every public entry point of a session and the factory, with `data` as
 * the source of names (constant for the baseline, fresh for the flood).
 * @param {any} slice
 * @param {any} session
 * @param {any} live
 * @param {(prefix: string, n: number) => string} data
 * @param {'baseline' | 'flood'} phase
 */
const touchEveryEntryPoint = async (slice, session, live, data, phase) => {
  const rounds = phase === 'baseline' ? 1 : 3;
  for (let i = 0; i < rounds; i += 1) {
    // Composer -> enqueueOnce (inline, about 7 KB of keys), then a staged
    // submission (100,000 keys) that runs the flood turn.
    const inline = phase === 'baseline' ? 'baseline' : data('sub', 600);
    const r = await runTurn(slice, session, live, inline, 180_000);
    if (phase === 'flood') {
      const records = await turnRecords(r.turn);
      if (!records.some(x => x.kind === 'tool-result'))
        throw Error('the flood turn ran no tools');
    }
  }
  if (phase === 'flood') {
    await runTurn(slice, session, live, data('big', 100_000), 180_000);
  }
  const variants = phase === 'baseline' ? 1 : 40;
  for (let i = 0; i < variants; i += 1) {
    const tag = phase === 'baseline' ? 'k0' : data('id', 1).slice(2, 12);
    await E(session).rename(`${phase} ${tag}`);
    await E(session).getSubmissionReceipt(requestId());
    await E(session)
      .getHistoryPage(`c${tag}`)
      .catch(() => undefined);
    await E(session).getInfo();
    await E(session).listPending();
    await E(session).getUsage();
    await E(session).getCurrentTurn();
    await E(session).watch();
    // Factory: unknown keys and cursors are refused or empty.
    await E(slice.factory)
      .findSession(`s${tag}`)
      .catch(() => undefined);
    await E(slice.factory)
      .listSessions(harden({ after: `s${tag}`, limit: 5 }))
      .catch(() => undefined);
    await E(slice.factory).listPresets();
    await E(slice.factory).sessionListFeed();
  }
  // A direct start refused while a turn is current is still an entry point;
  // idle here, so it starts a turn: wait for it.
  const direct = await E(session).startTurn(
    harden({ text: phase === 'baseline' ? 'baseline' : data('direct', 600) }),
    Date.now(),
  );
  await E(direct).whenFinished();
  // createSession with a fresh title (the factory's main entry point).
  const made = await slice.createSession(
    slice.backend,
    phase === 'baseline' ? 'baseline title' : data('title', 5).slice(0, 64),
  );
  void made;
};

run(
  'J-9366: feeding 100,000 distinct keys through the session and factory entry points does not grow their name tables',
  async t => {
    t.timeout(20 * 60_000);
    const template = await execTemplate();
    const state = await startFromTemplate(template, { t });
    let slice = await makeSlice(state);
    const script = makeScript();
    const made = await slice.makeBackend(script);
    /** @type {any} */ (slice).backend = made.backend;
    let session = await slice.createSession(made.backend, 'names');
    const { key } = await E(session).getInfo();
    let live = await slice.subscribe(session);
    const identity = {
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    };
    // The session vat came from the pool ("spare session N"): after the
    // baseline it is the session vat with the longest journal.
    /** @type {{ session?: string, factory?: string }} */
    const ids = {};
    const findIds = async () => {
      const rows = await slice.workers();
      const sessions = rows
        .filter(w => /^(spare )?session /.test(w.debugLabel ?? ''))
        .sort(
          (a, b) => Number(b.journalLength ?? 0) - Number(a.journalLength ?? 0),
        );
      ids.session = sessions[0]?.workerId;
      ids.factory = rows.find(w => w.debugLabel === 'app:harness')?.workerId;
    };
    const measure = () => ({
      session:
        ids.session === undefined
          ? undefined
          : vatNames(state.root, ids.session),
      factory:
        ids.factory === undefined
          ? undefined
          : vatNames(state.root, ids.factory),
    });

    const cleanCycle = async () => {
      await live.stop();
      await state.restart();
      slice = await makeSlice(state);
      // Presences the client held die with its connection: a backend for
      // createSession is made again (the session keeps its own).
      /** @type {any} */ (slice).backend = (
        await slice.makeBackend(script)
      ).backend;
      session = await E(slice.factory).findSession(key);
      live = await slice.subscribe(session);
    };

    await touchEveryEntryPoint(
      slice,
      session,
      live,
      (p, n) => keysJson(p, 0, n),
      'baseline',
    );
    await findIds();
    await cleanCycle();
    const before = measure();
    const fedBefore = fedKeys;
    const t0 = performance.now();
    await touchEveryEntryPoint(slice, session, live, fresh, 'flood');
    const floodMs = round1(performance.now() - t0);
    await cleanCycle();
    const after = measure();
    const row = {
      metric: 'names.flood',
      fedKeys,
      fedInFlood: fedKeys - fedBefore,
      before,
      after,
      sessionGrowth:
        Number(after.session?.names ?? NaN) -
        Number(before.session?.names ?? NaN),
      factoryGrowth:
        Number(after.factory?.names ?? NaN) -
        Number(before.factory?.names ?? NaN),
      ids,
      floodMs,
      ...identity,
    };
    emit(row);
    t.log(JSON.stringify(row));
    t.true(fedKeys >= 100_000, `${fedKeys} distinct keys fed`);
    t.truthy(before.session && after.session, 'session vat snapshots found');
    t.truthy(before.factory && after.factory, 'factory vat snapshots found');
    t.true(
      row.sessionGrowth <= 32,
      `session vat names grew ${row.sessionGrowth}`,
    );
    t.true(
      row.factoryGrowth <= 32,
      `factory vat names grew ${row.factoryGrowth}`,
    );
    const last = await runTurn(slice, session, live, 'baseline');
    t.is(last.end.status, 'completed');
    await live.stop();
  },
);

/** @param {string} code */
const execRound = code => ({
  chunks: [{ text: 'exec' }],
  toolCalls: [{ name: 'exec', args: JSON.stringify({ code }) }],
  usage,
});

const GLOBALS_CODE =
  'return Object.getOwnPropertyNames(globalThis).filter(n => globalThis[n] !== undefined).sort();';
const STACK_CODE = [
  "const deep = n => (n === 0 ? new Error('deep') : deep(n - 1));",
  'let caught = "";',
  'try { null.x; } catch (e) { caught = String(e.stack); }',
  'return [String(deep(3).stack), caught, String(new Error("x").stack)];',
].join('\n');
const FENCE_CODE = [
  'globalThis.hits = [];',
  "const target = harden({ hit: () => { globalThis.hits.push('sent'); } });",
  'await sleep(4000);',
  "globalThis.hits.push('stepped');",
  'E(target).hit();',
  'E.sendOnly(target).hit();',
  "return 'late';",
].join('\n');

const execScript = harden({
  turns: [
    {
      input: 'globals',
      rounds: [execRound(GLOBALS_CODE), { chunks: [{ text: 'g' }], usage }],
    },
    {
      input: 'stack',
      rounds: [execRound(STACK_CODE), { chunks: [{ text: 's' }], usage }],
    },
    {
      input: 'fence',
      rounds: [execRound(FENCE_CODE), { chunks: [{ text: 'f' }], usage }],
    },
    {
      input: 'hits',
      rounds: [
        execRound(
          'await sleep(10); return typeof hits === "undefined" ? [] : hits;',
        ),
        { chunks: [{ text: 'h' }], usage },
      ],
    },
  ],
});

/** @param {any} turn */
const resultOf = async turn => {
  const records = await turnRecords(turn);
  return records.find(r => r.kind === 'tool-result')?.result;
};

run(
  'J-9367, J-9368: the exec scope in a vat: hidden globals, no host paths, no send after the call',
  async t => {
    t.timeout(6 * 60_000);
    const template = await execTemplate();
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);
    const made = await slice.makeBackend(execScript);
    const session = await slice.createSession(made.backend, 'exec scope');
    const live = await slice.subscribe(session);
    t.teardown(() => live.stop());
    const identity = {
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    };

    const globals = await runTurn(slice, session, live, 'globals', 120_000);
    const names = JSON.parse(await resultOf(globals.turn));
    for (const hidden of [
      'Compartment',
      'lockdown',
      'repairIntrinsics',
      'HandledPromise',
    ])
      t.false(names.includes(hidden), `${hidden} is not in the scope`);
    const stack = await runTurn(slice, session, live, 'stack', 120_000);
    const stackText = await resultOf(stack.turn);
    t.notRegex(stackText, /\/(?:Users|home|private|tmp|var|nix|opt)\//);
    t.notRegex(stackText, /file:\/\//);

    // The fence: cancel during the 4 s sleep; the sleep answers later and
    // the abandoned code takes its one more step, which cannot send.
    const receipt = await slice.submit(session, 'fence');
    const { turnId } = await E(receipt.turn).getStatus();
    await live.until(
      event => event.type === 'tool_call' && event.turnId === turnId,
      60_000,
    );
    await delay(1500);
    await E(receipt.turn).cancel();
    await E(receipt.turn).whenFinished();
    await delay(4000);
    const hits = await runTurn(slice, session, live, 'hits', 60_000);
    const hitsText = await resultOf(hits.turn);
    t.deepEqual(
      JSON.parse(hitsText),
      ['stepped'],
      'the step ran; nothing was sent',
    );
    emit({
      metric: 'exec.scope.globals',
      names,
      stackSample: stackText.slice(0, 600),
      hits: JSON.parse(hitsText),
      ...identity,
    });
    t.log(JSON.stringify({ names }));
    t.log(stackText.slice(0, 600));
    t.is(texts.execAbandoned.length > 0, true);
  },
);

const SENDS_CODE = [
  'const all = [];',
  'for (let i = 0; i < 100; i += 1) all.push(sleep(0));',
  'await Promise.all(all);',
  'return all.length;',
].join('\n');

run(
  'J-9368: 100 answered sleeps from one body with per-call endowments (exec.sends.answered)',
  async t => {
    t.timeout(6 * 60_000);
    const template = await execTemplate();
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);
    const turns = [];
    for (let i = 0; i < 6; i += 1) {
      turns.push({
        input: `sends ${i}`,
        rounds: [execRound(SENDS_CODE), { chunks: [{ text: 'd' }], usage }],
      });
    }
    const made = await slice.makeBackend(harden({ turns }));
    const session = await slice.createSession(made.backend, 'exec sends');
    const live = await slice.subscribe(session);
    t.teardown(() => live.stop());
    const identity = {
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    };
    /** @type {number[]} */
    const ms = [];
    for (let i = 0; i < 6; i += 1) {
      const from = live.deliveries.length;
      const r = await runTurn(slice, session, live, `sends ${i}`, 120_000);
      t.is(await resultOf(r.turn), '100');
      const call = live.deliveries.find(
        (d, k) => k >= from && d.event.type === 'tool_call',
      );
      const result = live.deliveries.find(
        (d, k) => k >= from && d.event.type === 'tool_result',
      );
      // The first call wakes a spare exec vat (exec.first); not counted.
      if (i > 0 && call && result)
        ms.push(round1(result.arrivedAt - call.arrivedAt));
    }
    const sorted = [...ms].sort((a, b) => a - b);
    const row = {
      metric: 'exec.sends.answered',
      unit: 'ms',
      n: sorted.length,
      median: sorted[Math.floor(sorted.length / 2)],
      min: sorted[0],
      max: sorted[sorted.length - 1],
      all: ms,
      what: 'per-call E and powers (J-9368); 100 answered sleeps from one body, tool_call to tool_result',
      budget: { median: 8000 },
      ...identity,
    };
    emit(row);
    t.log(JSON.stringify(row));
    t.true(row.median <= 1.25 * 8000, `median ${row.median} ms`);
  },
);
