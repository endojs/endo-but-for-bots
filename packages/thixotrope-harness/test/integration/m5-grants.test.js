// @ts-check
/**
 * M5 acceptance 6, granted tools (W5.6; designs/m5-interfaces.md 8.1 item
 * 6, 2.5, R3-6, P-65), in a real daemon on the m1b template with the M5
 * fixture objects (`test/fixtures/m5-objects.js`) in the workspace vat:
 *
 * - a granted `echo2` is offered at the next round and its call returns
 *   its result (through the exec vat's inspector, D-M5-2);
 * - a grant named `exec` is `refused-builtin` and not offered;
 * - two grants named `t` are both `refused-duplicate` (a call answers the
 *   unknown-tool text); withdrawing one offers the other at the next round;
 * - a withdrawn tool is gone from the next request;
 * - schema refusals (a non-function schema, parameters nested 40 deep,
 *   parameters of about 3,000 units: probe e) are `refused-schema` with
 *   the reason, and the session keeps working.
 *
 *   THIX_AGENT=W5.6 corepack yarn test:integration test/integration/m5-grants.test.js
 */
/* eslint-disable no-await-in-loop -- steps of one scenario run in order */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { textOf } from '../../guest/lib/interfaces.js';
import { textOf as textOfM5 } from '../../guest/lib/interfaces-m5.js';
/* eslint-enable import/no-relative-packages */
import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
} from '../../perf/_harness.mjs';
import { makeM5Fixtures } from '../fixtures/m5-objects.js';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, round1, waitFor } from './_m1a-slice.js';
import { execTemplate } from './_m1b-exec.js';
import { runTurn, turnRecords } from './_m1b.js';

takeIntegrationLock(test, 'm5 grants test');

const run = integrationEnabled ? test.serial : test.skip;

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
 * @param {string} text
 */
const callTurn = (input, name, text) => ({
  input,
  rounds: [
    {
      chunks: [{ text: input }],
      toolCalls: [{ name, args: JSON.stringify({ text }) }],
      usage,
    },
    { chunks: [{ text: 'done' }], usage },
  ],
});

const script = harden({
  turns: [
    callTurn('echo2', 'echo2', 'hi'),
    callTurn('t', 't', 'x'),
    { input: 'hello', rounds: [{ chunks: [{ text: 'done' }], usage }] },
  ],
});

/**
 * The tool results of a turn, in call order, as `[result, failed]`.
 * @param {any} turn
 */
const resultsOf = async turn =>
  (await turnRecords(turn))
    .filter(r => r.kind === 'tool-result')
    .map(r => [r.result, r.failed]);

/**
 * Wait until a grant's schema read has settled; answer its info.
 * @param {any} grant
 */
const settled = grant =>
  waitFor(
    async () => {
      const info = await E(grant).describe();
      return info.state === 'pending' ? undefined : info;
    },
    20_000,
    'the grant to leave pending',
    20,
  );

run('acceptance 6: granted tools offered, refused and withdrawn', async t => {
  t.timeout(4 * 60_000);
  const t0 = performance.now();
  const template = await execTemplate();
  const state = await startFromTemplate(template, { t });
  const slice = await makeSlice(state);
  const fixtures = await makeM5Fixtures(state.client);
  const identity = {
    ...(await runIdentity()),
    crankBudget,
    loadAvg: loadAvg(),
  };
  const made = await slice.makeBackend(script);
  const session = await slice.createSession(made.backend, 'm5 grants');
  const live = await slice.subscribe(session);
  const grants = await E(session).grants();

  // ---- echo2: granted, offered at the next round, its call answers
  const tGrant = performance.now();
  const echo = await E(grants).grantTool(fixtures.echoTool);
  const echoInfo = await settled(echo);
  const grantMs = round1(performance.now() - tGrant);
  t.is(echoInfo.state, 'offered');
  t.is(echoInfo.name, 'echo2');
  t.is(echoInfo.source, 'operator');
  const first = await runTurn(slice, session, live, 'echo2');
  t.is(first.end.status, 'completed');
  t.deepEqual(await resultsOf(first.turn), [['echo2: hi', false]]);

  // ---- exec: refused-builtin
  const execGrant = await E(grants).grantTool(
    await E(fixtures.tools).make('exec'),
  );
  const execInfo = await settled(execGrant);
  t.is(execInfo.state, 'refused-builtin');
  t.is(execInfo.reason, textOfM5.toolNameBuiltIn('exec'));

  // ---- two t: both refused-duplicate; the call is an unknown tool
  const t1 = await E(grants).grantTool(await E(fixtures.tools).make('t'));
  const t2 = await E(grants).grantTool(await E(fixtures.tools).make('t'));
  await settled(t1);
  await settled(t2);
  const dup = await runTurn(slice, session, live, 't');
  t.is(dup.end.status, 'completed');
  const [[dupResult, dupFailed]] = await resultsOf(dup.turn);
  t.true(dupFailed);
  t.true(String(dupResult).startsWith(textOf.errorResult('Unknown tool: "t"')));
  for (const g of [t1, t2]) {
    const info = await E(g).describe();
    t.is(info.state, 'refused-duplicate');
    t.is(info.reason, textOfM5.toolNameDuplicate('t'));
  }

  // ---- withdraw one t: the other is offered at the next round
  await E(t1).withdraw();
  t.is((await E(t1).describe()).state, 'withdrawn');
  const single = await runTurn(slice, session, live, 't');
  t.deepEqual(await resultsOf(single.turn), [['t: x', false]]);
  t.is((await E(t2).describe()).state, 'offered');

  // ---- a withdrawn tool is gone from the next request
  await E(echo).withdraw();
  const gone = await runTurn(slice, session, live, 'echo2');
  const [[goneResult, goneFailed]] = await resultsOf(gone.turn);
  t.true(goneFailed);
  t.true(
    String(goneResult).startsWith(textOf.errorResult('Unknown tool: "echo2"')),
  );

  // ---- schema refusals (probe e: 3,000-unit parameters), session works
  const tProbe = performance.now();
  /** @type {Record<string, any>} */
  const refusals = {};
  for (const name of ['badSchemaTool', 'deepSchemaTool', 'bigSchemaTool']) {
    const g = await E(grants).grantTool(fixtures[name]);
    const info = await settled(g);
    refusals[name] = info;
    t.is(info.state, 'refused-schema', name);
    t.true(
      String(info.reason).startsWith(textOfM5.toolSchemaInvalid('')),
      name,
    );
  }
  t.regex(refusals.deepSchemaTool.reason, /nest deeper than 32/);
  t.regex(refusals.bigSchemaTool.reason, /characters of JSON; the limit is/);
  const probeMs = round1(performance.now() - tProbe);
  const after = await runTurn(slice, session, live, 'hello');
  t.is(after.end.status, 'completed');
  const halted = (await slice.workers()).filter(w => w.failure);
  t.deepEqual(
    halted.map(w => w.debugLabel),
    [],
    'no vat halted',
  );
  const list = await E(grants).list();
  t.deepEqual(
    list.map((/** @type {any} */ i) => i.state),
    [
      'refused-builtin',
      'offered',
      'refused-schema',
      'refused-schema',
      'refused-schema',
    ],
  );
  emit({
    metric: 'm5.grants.acceptance6',
    grantToOfferedMs: grantMs,
    schemaProbesMs: probeMs,
    totalMs: round1(performance.now() - t0),
    ...identity,
  });
  await live.stop();
});
