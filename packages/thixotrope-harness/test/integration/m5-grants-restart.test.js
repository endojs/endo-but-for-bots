// @ts-check
/**
 * M5 acceptance 11b, granted tools across a SIGKILL (W5.6;
 * designs/m5-interfaces.md 8.1 item 11, section 5 kill points K4 and K5),
 * in a real daemon on the m1b template with the M5 fixture objects:
 *
 * - K4: a grant whose schema read is in flight (a test tool whose
 *   `schema()` answers only when released) is pending at the SIGKILL; after
 *   the restart it is still pending, the next round start reads it again on
 *   the new ports, and once released it is offered and its call answers.
 * - K5: SIGKILL while the granted fixture `slowTool` runs (after crank D,
 *   the call in the exec vat waiting on the tool): after the restart the
 *   turn is outcome-unknown with "Tool outcome unknown"; the tool's log
 *   shows one run started and no rerun, even after it is released.
 * - K5, second kill point (XC): SIGKILL after the tool answered the exec
 *   vat, before the exec vat's answer reached the session. The session
 *   vat's worker (a spare's, found by journal growth in a plain turn) is
 *   woken and held with SIGSTOP (every incarnation as it appears) before
 *   the tool is released, so the exec vat's answer cannot run in it; the
 *   tool's log shows the run finished; then the daemon is SIGKILLed. The answer is then already in the session's journal
 *   (the hub appends a delivery before the worker runs it): after the
 *   restart the replay records the true result once, recovery settles the
 *   turn outcome-unknown, the tool ran once, the provider got the turn
 *   once; the next turn completes.
 *
 *   THIX_AGENT=W5.6 corepack yarn test:integration test/integration/m5-grants-restart.test.js
 */
import '../unit/_m1a-prelude.js';

import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { E } from '@endo/far';

// eslint-disable-next-line import/no-relative-packages
import { texts } from '../../guest/lib/interfaces.js';
import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
} from '../../perf/_harness.mjs';
import { makeM5Fixtures } from '../fixtures/m5-objects.js';
import {
  integrationEnabled,
  killStrays,
  processesUnder,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import {
  incarnationNeedle,
  makeSlice,
  requestId,
  round1,
  waitFor,
} from './_m1a-slice.js';
import { execTemplate } from './_m1b-exec.js';
import { runTurn, turnRecords } from './_m1b.js';

takeIntegrationLock(test, 'm5 grants restart test');

const run = integrationEnabled ? test.serial : test.skip;

/** How long the slow tool runs before the SIGKILL (K5). */
const KILL_DELAY_MS = 2000;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};
/**
 * @param {string} input
 * @param {string} name
 */
const callTurn = (input, name) => ({
  input,
  rounds: [
    {
      chunks: [{ text: input }],
      toolCalls: [{ name, args: JSON.stringify({ text: input }) }],
      usage,
    },
    { chunks: [{ text: 'done' }], usage },
  ],
});
const script = harden({
  turns: [
    callTurn('held', 'held'),
    callTurn('slow', 'slow'),
    callTurn('slow after', 'slow'),
    { input: 'hello', rounds: [{ chunks: [{ text: 'done' }], usage }] },
  ],
});

/** The workspace inventory name of this file's own fixture. */
const HELD_NAME = 'm5GrantsHeld';
/**
 * A granted tool named `held` whose `schema()` answers only when
 * `release()` is called (prelude names only: evaluated in the workspace
 * vat). `reads()` counts the schema reads.
 */
const heldSource = `(() => {
  const waiting = [];
  let reads = 0;
  const schema = harden({
    type: 'function',
    function: {
      name: 'held',
      description: 'A test tool whose schema read waits.',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    },
  });
  return Far('tool held', {
    schema: () => {
      reads += 1;
      return new Promise(resolve => waiting.push(() => resolve(schema)));
    },
    execute: args => \`held: \${args && args.text}\`,
    release: () => {
      for (const go of waiting.splice(0)) go();
    },
    reads: () => reads,
  });
})()`;

/**
 * @param {any} client
 */
const heldTool = async client => {
  if ((await client.call('lookup', HELD_NAME)) === undefined) {
    await client.call(
      'evaluate',
      `(inventory.set(${JSON.stringify(HELD_NAME)}, ${heldSource}), true)`,
    );
  }
  return client.call('lookup', HELD_NAME);
};

const execAsync = promisify(execFile);

/**
 * SIGSTOP every process whose command line names `needle`, as soon as it
 * appears, until stopped (`startKiller`'s loop with SIGSTOP): holds a vat's
 * worker, and any new incarnation of it, so no delivery reaches that vat.
 * @param {string} needle
 * @param {number} [pollMs]
 */
const startStopper = (needle, pollMs = 20) => {
  /** @type {Set<number>} */
  const held = new Set();
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      // eslint-disable-next-line no-await-in-loop
      const { stdout } = await execAsync('ps', ['-axo', 'pid=,command='], {
        maxBuffer: 16 * 1024 * 1024,
      }).catch(() => ({ stdout: '' }));
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.includes(needle)) {
          const pid = Number(trimmed.slice(0, trimmed.indexOf(' ')));
          if (!held.has(pid)) {
            try {
              process.kill(pid, 'SIGSTOP');
              held.add(pid);
            } catch {
              // Gone already.
            }
          }
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(pollMs);
    }
  })();
  return {
    held,
    /** Stop polling and SIGKILL what it held. */
    stop: async () => {
      stopped = true;
      await done;
      for (const pid of held) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Gone already.
        }
      }
    },
  };
};

/** @param {any} turn */
const resultsOf = async turn =>
  (await turnRecords(turn))
    .filter(r => r.kind === 'tool-result')
    .map(r => [r.result, r.failed]);

/**
 * The session's grant whose name (or, while pending, position) matches.
 * @param {any} session
 * @param {number} index position in `list()`
 */
const grantAt = async (session, index) => {
  const list = await E(E(session).grants()).list();
  return list[index];
};

run('acceptance 11b: K4 and K5 (both kill points)', async t => {
  t.timeout(5 * 60_000);
  const template = await execTemplate();
  const state = await startFromTemplate(template, { t });
  const slice = await makeSlice(state);
  const identity = {
    ...(await runIdentity()),
    crankBudget,
    loadAvg: loadAvg(),
  };
  const made = await slice.makeBackend(script);
  let session = await slice.createSession(made.backend, 'm5 grants restart');
  const { key } = await E(session).getInfo();
  let live = await slice.subscribe(session);

  /** SIGKILL, serve again, find the session again. */
  const killAndServe = async () => {
    await live.stop();
    await state.kill();
    await killStrays(state.root);
    const restarted = await state.restart();
    await slice.refresh();
    session = await E(slice.factory).findSession(key);
    live = await slice.subscribe(session);
    return restarted;
  };

  // ---- K4: the schema read is in flight at the SIGKILL
  let held = await heldTool(state.client);
  await E(E(session).grants()).grantTool(held);
  await waitFor(
    async () => Number(await E(held).reads()) >= 1,
    20_000,
    'the schema read to reach the tool',
    20,
  );
  t.is((await grantAt(session, 0)).state, 'pending');
  const k4 = await killAndServe();
  held = await heldTool(state.client);
  const afterKill = await grantAt(session, 0);
  t.is(afterKill.state, 'pending', 'still pending after the restart');
  const readsBefore = await E(held).reads();
  // The next round start reads it again on the new ports; the turn itself
  // is the `hello` turn (no call), then `held` is offered.
  const hello = await runTurn(slice, session, live, 'hello');
  t.is(hello.end.status, 'completed');
  await waitFor(
    async () => Number(await E(held).reads()) > Number(readsBefore),
    20_000,
    'the schema to be read again',
    20,
  );
  await E(held).release();
  const offered = await waitFor(
    async () => {
      const info = await grantAt(session, 0);
      return info.state === 'pending' ? undefined : info;
    },
    20_000,
    'the grant to leave pending',
    20,
  );
  t.is(offered.state, 'offered');
  t.is(offered.name, 'held');
  const used = await runTurn(slice, session, live, 'held');
  t.deepEqual(await resultsOf(used.turn), [['held: held', false]]);
  emit({
    metric: 'm5.grants.restart.k4',
    servedMs: k4.servedMs,
    readsBefore,
    readsAfter: await E(held).reads(),
    ...identity,
  });

  // ---- K5: SIGKILL while the granted slow tool runs
  let fixtures = await makeM5Fixtures(state.client);
  const slowGrant = await E(E(session).grants()).grantTool(fixtures.slowTool);
  await waitFor(
    async () => (await E(slowGrant).describe()).state === 'offered',
    20_000,
    'slow to be offered',
    20,
  );
  const runsBefore = await E(fixtures.slowTool).runs();
  const receipt = await E(slice.composer).submit(session, 'slow', requestId());
  const { turnId } = await E(receipt.turn).getStatus();
  await waitFor(
    async () =>
      Number((await E(fixtures.slowTool).runs()).started) >
      Number(runsBefore.started),
    20_000,
    'the slow tool to start',
    20,
  );
  await delay(KILL_DELAY_MS);
  const tKill = performance.now();
  const k5 = await killAndServe();
  fixtures = await makeM5Fixtures(state.client);
  const page = await E(session).getHistoryPage();
  const killed = page.turns.find(
    (/** @type {any} */ tp) => tp.turnId === turnId,
  );
  t.is(killed?.state, 'outcome-unknown');
  t.deepEqual(
    (killed?.records ?? [])
      .filter((/** @type {any} */ r) => r.kind === 'tool-result')
      .map((/** @type {any} */ r) => r.result),
    [texts.toolOutcomeUnknown],
  );
  // Release the run that was waiting: its late answer is ignored, and the
  // tool is not run again.
  await E(fixtures.slowTool).release();
  // The session's worker label: a pooled session runs in a spare vat, so
  // its label is not `session <key>`. It is the one vat whose journal grows
  // during a turn with no tool call (K5's second kill point holds it).
  /** @returns {Promise<Map<string, number>>} */
  const journals = async () =>
    new Map(
      (await slice.workers()).map((/** @type {any} */ w) => [
        w.debugLabel,
        Number(w.journalLength ?? 0),
      ]),
    );
  const journalsBefore = await journals();
  const next = await runTurn(slice, session, live, 'hello');
  const grewInHello = [...(await journals())]
    .filter(([label, n]) => n > (journalsBefore.get(label) ?? n))
    .map(([label]) => label);
  t.is(next.end.status, 'completed');
  await delay(1000);
  const runsAfter = await E(fixtures.slowTool).runs();
  t.is(
    runsAfter.started - runsBefore.started,
    1,
    'the granted tool ran at most once',
  );
  const killedRequests = made
    .log()
    .filter(
      (/** @type {any} */ l) => l.kind === 'request' && l.turnId === turnId,
    ).length;
  t.is(killedRequests, 1, 'the provider got the killed turn once');
  emit({
    metric: 'm5.grants.restart.k5',
    servedMs: k5.servedMs,
    recoveredReadMs: round1(performance.now() - tKill),
    runs: runsAfter,
    ...identity,
  });

  // ---- K5, second kill point: the tool answered the exec vat; the exec
  // vat's answer has not reached the session (its worker is held stopped).
  const runsB = await E(fixtures.slowTool).runs();
  const receiptB = await E(slice.composer).submit(
    session,
    'slow after',
    requestId(),
  );
  const turnB = (await E(receiptB.turn).getStatus()).turnId;
  await waitFor(
    async () =>
      Number((await E(fixtures.slowTool).runs()).started) >
      Number(runsB.started),
    20_000,
    'the slow tool to start again',
    20,
  );
  t.log('K5b: vats whose journal grew in a plain turn', grewInHello);
  const sessionLabels = grewInHello.filter(
    label => !/^(native|registry|workspace|app)/.test(label),
  );
  t.is(sessionLabels.length, 1, JSON.stringify(grewInHello));
  const needle = incarnationNeedle(state.root, sessionLabels[0]);
  const stopper = startStopper(needle);
  /** @type {number} */
  let heldAtKill;
  /** @type {number} */
  let tKillB;
  let journalGrewBeforeKill = -1;
  try {
    // Vats sleep while they wait (the worker exits), so the session is woken
    // first by a call that needs nothing (`getInfo`, not awaited) and its
    // worker held as soon as it appears; only then is the tool released, so
    // the exec vat's answer can only queue for the held session.
    const sessionJournal = async () =>
      Number(
        (await slice.workers()).find(
          (/** @type {any} */ w) => w.debugLabel === sessionLabels[0],
        )?.journalLength ?? 0,
      );
    E(session)
      .getInfo()
      .catch(() => {});
    await waitFor(
      async () => stopper.held.size > 0,
      20_000,
      'the session worker to be held',
      20,
    ).catch(error => {
      const workers = processesUnder(state.root).map(p =>
        p.command.slice(0, 300),
      );
      t.log('needle', needle, 'workers', JSON.stringify(workers));
      throw error;
    });
    t.log('K5b: session worker held', [...stopper.held]);
    await delay(500);
    const journalAtHold = await sessionJournal();
    await E(fixtures.slowTool).release();
    await waitFor(
      async () =>
        Number((await E(fixtures.slowTool).runs()).finished) >
        Number(runsB.finished),
      20_000,
      'the slow tool to answer the exec vat',
      20,
    );
    t.log('K5b: the tool answered');
    // The exec vat renders and answers in a crank or two; its answer waits
    // for the held session.
    await delay(1500);
    heldAtKill = stopper.held.size;
    // The exec vat's answer is in the session's journal (the hub appends a
    // delivery before the worker runs it) while the worker is held: sent,
    // not yet run (the status call does not wake a vat).
    journalGrewBeforeKill = (await sessionJournal()) - journalAtHold;
    t.true(journalGrewBeforeKill >= 1, `${journalGrewBeforeKill}`);
    tKillB = performance.now();
    live.stop().catch(() => {});
    await state.kill();
  } finally {
    // SIGKILL what it held (also when a step above failed).
    await stopper.stop();
  }
  t.log('K5b: killed');
  await killStrays(state.root);
  const k5b = await state.restart();
  await slice.refresh();
  session = await E(slice.factory).findSession(key);
  live = await slice.subscribe(session);
  fixtures = await makeM5Fixtures(state.client);
  // Recovery runs when the session meets its new ports; the next turn
  // opens them.
  const after = await runTurn(slice, session, live, 'hello');
  t.is(after.end.status, 'completed');
  const pageB = await E(session).getHistoryPage();
  const killedB = pageB.turns.find(
    (/** @type {any} */ tp) => tp.turnId === turnB,
  );
  t.log(
    'K5b: the killed turn',
    killedB?.state,
    JSON.stringify(
      (killedB?.records ?? []).map((/** @type {any} */ r) => [
        r.kind,
        r.result ?? r.status ?? r.round ?? '',
      ]),
    ),
    'provider requests',
    made
      .log()
      .filter(
        (/** @type {any} */ l) => l.kind === 'request' && l.turnId === turnB,
      ).length,
  );
  t.is(killedB?.state, 'outcome-unknown', JSON.stringify(killedB?.state));
  // The answer was journaled for the session before the SIGKILL, so the
  // replay runs it: the true result is recorded once (not "Tool outcome
  // unknown", which is for an answer that never reached the hub, K5's first
  // point), and recovery then settles the turn outcome-unknown when the
  // next round meets the new ports; no round is sent again.
  t.deepEqual(
    (killedB?.records ?? [])
      .filter((/** @type {any} */ r) => r.kind === 'tool-result')
      .map((/** @type {any} */ r) => r.result),
    ['slow: slow after'],
    'the journaled answer is recorded once, by the replay',
  );
  await delay(1000);
  const runsAfterB = await E(fixtures.slowTool).runs();
  t.is(runsAfterB.started - runsB.started, 1, 'ran once');
  t.is(runsAfterB.finished - runsB.finished, 1, 'answered once');
  t.is(
    made
      .log()
      .filter(
        (/** @type {any} */ l) => l.kind === 'request' && l.turnId === turnB,
      ).length,
    1,
    'the provider got the killed turn once',
  );
  emit({
    metric: 'm5.grants.restart.k5b',
    servedMs: k5b.servedMs,
    heldAtKill,
    journalGrewBeforeKill,
    recoveredReadMs: round1(performance.now() - tKillB),
    runs: runsAfterB,
    ...identity,
  });
  await live.stop();
});
