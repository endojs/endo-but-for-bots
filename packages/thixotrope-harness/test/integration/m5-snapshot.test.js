// @ts-check
/**
 * M5 acceptance 1 (snapshot isolation; R3-7, R4-4, R4-28) and the part-7
 * check of acceptance 9 (preset instructions in the composed prompt; W5.9;
 * designs/m5-interfaces.md 8.1), in a real daemon on the m5o template (the
 * fixture objects live in the workspace vat):
 *
 * - a user preset with instructions X and the endowment `notes`; session A
 *   from it: its requests carry the composition with X as part 7 and `list`
 *   shows `notes`;
 * - the preset is saved with instructions Y and no endowment;
 * - A's next turn carries the same prompt digest as before and `list` still
 *   shows `notes`;
 * - session B from the saved preset carries Y (part 7) and lists nothing.
 *
 * Prompts are compared by the scripted provider's `context` lines
 * (`systemDigest`, `systemBytes`) against `composeSystemPrompt` in Node.
 *
 *   THIX_AGENT=W5.9 corepack yarn test:integration test/integration/m5-snapshot.test.js
 */
import '../unit/_m1a-prelude.js';

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

// eslint-disable-next-line import/no-relative-packages
import { composeSystemPrompt } from '../../guest/lib/system-prompt-base.js';
import { emit, loadAvg, runIdentity } from '../../perf/_harness.mjs';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice } from './_m1a-slice.js';
import { runTurn, turnRecords } from './_m1b.js';
import {
  call,
  fixturesOf,
  objectsTemplate,
  operatorOf,
  presetSession,
  turnOf,
} from './_m5-objects.js';

takeIntegrationLock(test, 'm5 snapshot test');

const run = integrationEnabled ? test.serial : test.skip;

const script = harden({
  turns: [
    turnOf('first', [call('list', {})]),
    turnOf('second', [call('list', {})]),
  ],
});

/** @param {string} text */
const sha16 = text =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

/** @param {unknown} value */
const rendered = value => JSON.stringify(value, null, 2);

/**
 * The tool results of a turn, in call order: `[result, failed]`.
 * @param {any} turn
 */
const resultsOf = async turn => {
  const records = await turnRecords(turn);
  return records
    .filter(r => r.kind === 'tool-result')
    .map(r => [r.result, r.failed]);
};

// Instructions with three-byte text, so the composed prompt is over
// inlineBytes and the factory stages it (M2 10, R4-28) for X; Y stays inline.
const X = `Instructions X: answer in haiku. ${'漢'.repeat(1500)}`;
const Y = 'Instructions Y: answer in one short line.';

run('acceptance 1: a session keeps its preset snapshot; 9: part 7', async t => {
  t.timeout(4 * 60_000);
  const t0 = performance.now();
  const template = await objectsTemplate();
  const state = await startFromTemplate(template, { t });
  const slice = await makeSlice(state);
  const fixtures = await fixturesOf(state);
  const { catalog, inventory } = await operatorOf(slice);
  const ready = performance.now();

  const a = await slice.makeBackend(script);
  const b = await slice.makeBackend(script);

  // The inventory row `notes` (the m5o template may already hold it).
  const rows = (await E(inventory).list()).rows;
  if (!rows.some((/** @type {any} */ r) => r.label === 'notes'))
    await E(inventory).add('notes', fixtures.notes);
  const notes = (await E(inventory).list()).rows.find(
    (/** @type {any} */ r) => r.label === 'notes',
  );

  const recordX = harden({
    label: 'Snapshot',
    template: 'general',
    backend: a.backend,
    instructions: X,
    endowments: [{ label: 'notes', value: notes.value }],
  });
  const { preset } = await E(catalog).create(
    recordX,
    (await E(catalog).configuration()).revision,
  );

  const promptX = composeSystemPrompt({
    spoken: false,
    snapshot: { instructions: X },
  });
  const promptY = composeSystemPrompt({
    spoken: false,
    snapshot: { instructions: Y },
  });
  // Part 7 is the last part: the instructions end the composition.
  t.true(promptX.endsWith(`\n\n${X}`));
  t.true(promptY.endsWith(`\n\n${Y}`));
  t.true(Buffer.byteLength(promptX) > 8192, 'X is staged by the factory');

  /**
   * The `context` lines of a log from `from` on.
   * @param {() => any[]} log
   * @param {number} [from]
   */
  const contexts = (log, from = 0) =>
    log()
      .slice(from)
      .filter(l => l.kind === 'context');

  // ---- session A from the preset at X
  const sessionA = await presetSession(slice, preset, a.backend, 'A');
  const liveA = await slice.subscribe(sessionA);
  const first = await runTurn(slice, sessionA, liveA, 'first');
  t.is(first.end.status, 'completed');
  t.deepEqual(await resultsOf(first.turn), [[rendered(['notes']), false]]);
  const firstContexts = contexts(a.log);
  t.is(firstContexts.length, 2, 'two rounds');
  for (const line of firstContexts) {
    t.is(line.systemDigest, sha16(promptX), 'A carries X (part 7)');
    t.is(line.systemBytes, Buffer.byteLength(promptX));
  }

  // ---- the preset saved with Y and no endowment
  const { endowments: _e, instructions: _i, ...rest } = recordX;
  await E(preset).save(
    harden({ ...rest, instructions: Y, endowments: [] }),
    (await E(catalog).configuration()).revision,
  );
  const view = await E(preset).describe();
  t.is(view.instructions, Y);
  t.deepEqual(view.endowments, []);

  // ---- A keeps its snapshot
  const mark = a.log().length;
  const second = await runTurn(slice, sessionA, liveA, 'second');
  t.is(second.end.status, 'completed');
  t.deepEqual(await resultsOf(second.turn), [[rendered(['notes']), false]]);
  const secondContexts = contexts(a.log, mark);
  t.is(secondContexts.length, 2);
  for (const line of secondContexts) {
    t.is(line.systemDigest, firstContexts[0].systemDigest, 'same prompt');
    t.is(line.systemBytes, firstContexts[0].systemBytes);
  }

  // ---- B from the saved preset: Y and no `notes`
  const sessionB = await presetSession(slice, preset, b.backend, 'B');
  const liveB = await slice.subscribe(sessionB);
  const third = await runTurn(slice, sessionB, liveB, 'first');
  t.is(third.end.status, 'completed');
  t.deepEqual(await resultsOf(third.turn), [[rendered([]), false]]);
  for (const line of contexts(b.log)) {
    t.is(line.systemDigest, sha16(promptY), 'B carries Y (part 7)');
    t.is(line.systemBytes, Buffer.byteLength(promptY));
  }

  emit({
    metric: 'm5.snapshot',
    readyMs: +(ready - t0).toFixed(1),
    totalMs: +(performance.now() - t0).toFixed(1),
    promptBytes: {
      x: Buffer.byteLength(promptX),
      y: Buffer.byteLength(promptY),
    },
    ...(await runIdentity()),
    loadAvg: loadAvg(),
  });
});
