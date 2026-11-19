// @ts-check
// The scripted double's compaction step (resources/agent-host/impl/
// providers/scripted.js; designs/m8-interfaces.md 5.1, seam S-16, D-M8-13):
// an ask is answered with `scriptedSummary` and no usage, consuming no
// script round; the round's `context` line records the compacted context
// (what a later rebuild projects); a plan that cannot help is recorded
// `compaction-skipped` and the round runs from the script as before.
import '../unit/_m1a-prelude.js';

import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

import test from '@endo/ses-ava/test.js';

import {
  contextDigests,
  makeScriptedProvider,
  scriptedUnexpectedFailure,
} from '../../resources/agent-host/impl/providers/scripted.js';
import {
  compactionSkipTexts,
  scriptedSummary,
} from '../../resources/agent-host/impl/providers/compaction-texts.js';
import { makeContextCache } from '../../resources/agent-host/impl/context-cache.js';
import { makeEndpoint } from '../../resources/agent-host/impl/endpoint.js';
import { makeChannelRegistry } from '../../resources/agent-host/impl/channels.js';
import { makeTestBlobs } from './_m1b-blobs.js';
import { timers, until } from './_m2-w21b-round.js';
import { makeCompactingSession, makeTurnSink } from './_compaction-session.js';

const { E } = /** @type {any} */ (globalThis);

const harnessTmp = new URL('../../tmp/', import.meta.url).pathname;

/**
 * @param {import('ava').ExecutionContext} t
 * @param {{ history: number }} options
 */
const run = async (t, { history }) => {
  mkdirSync(harnessTmp, { recursive: true });
  const blobs = makeTestBlobs({
    dir: mkdtempSync(join(harnessTmp, 'compaction-scripted-')),
  });
  t.teardown(blobs.cleanup);
  const s = makeCompactingSession();
  for (let i = 0; i < history; i += 1) {
    s.historyTurn({
      replies: [{ text: `reply ${i} ${'r'.repeat(2000)}` }],
    });
  }
  /** @type {any[]} */
  const log = [];
  const provider = makeScriptedProvider({
    label: 'scripted',
    script: harden({
      turns: [{ rounds: [{ chunks: [{ text: 'the scripted answer' }] }] }],
    }),
    timers,
    log: (/** @type {string} */ kind, fields = {}) =>
      log.push({ kind, ...fields }),
    blobs: blobs.store,
    logContext: true,
  });
  const cache = makeContextCache({ store: blobs.store });
  const endpoint = makeEndpoint({
    provider,
    channel: makeChannelRegistry().channelFor(s.session),
    timers,
    prepare: (req, options) => cache.prepare(s.session, req, options),
    owner: s.session,
    unexpectedFailure: scriptedUnexpectedFailure,
  });
  const current = s.startTurn();
  const fake = makeTurnSink(s, current.turnId);
  const ask = s.askFor(current.turnId, 0, current.start);
  void E(endpoint).holdTurn(fake.turn);
  E.sendOnly(endpoint).startRound(
    s.request({
      turn: fake.turn,
      sink: fake.sink,
      turnId: current.turnId,
      round: 0,
      compaction: ask,
    }),
  );
  await until(() => fake.finals.length + fake.failures.length > 0);
  // The context line is written off the round's path.
  await until(() => log.some(e => e.kind === 'context'));
  return { s, fake, log, cache, current };
};

test('an ask is answered with the scripted summary and no usage, consuming no script round', async t => {
  const { s, fake, log, current } = await run(t, { history: 8 });
  t.deepEqual(fake.failures, []);
  t.is(fake.finals[0].text, 'the scripted answer', 'script round 0 ran');
  t.is(fake.compactions.length, 1);
  const [result] = fake.compactions;
  t.is(result.outcome, 'done');
  t.is(result.summary, scriptedSummary);
  t.false('usage' in result, 'no usage');
  t.false('servedBy' in result);
  t.is(s.window.epoch(), 1);
  // One context line for the round: the compacted context, as a fresh
  // cache rebuilds it from the boundary.
  const lines = log.filter(e => e.kind === 'context');
  t.is(lines.length, 1);
  const fresh = makeContextCache({
    store: harden({
      resolveMany: async () => {},
      read: async () => '',
    }),
  });
  const rebuilt = await fresh.prepare(
    s.session,
    harden({
      turnId: current.turnId,
      base: { count: s.records.count(), ...s.window.baseFields() },
      append: [],
      context: s.context,
    }),
  );
  t.deepEqual(rebuilt.transcript[0], {
    kind: 'message',
    role: 'assistant',
    content: scriptedSummary,
  });
  t.is(lines[0].digest, contextDigests(rebuilt.transcript).digest);
});

test('a plan that cannot help: compaction-skipped recorded, the round runs from the script', async t => {
  const { s, fake, log } = await run(t, { history: 0 });
  t.is(fake.finals[0].text, 'the scripted answer');
  t.is(fake.compactions[0].outcome, 'skipped');
  t.is(fake.compactions[0].reason, compactionSkipTexts.nothingToSummarize);
  t.is(s.window.epoch(), 0);
  t.is(s.records.since(0).at(-1).kind, 'compaction-skipped');
  t.is(log.filter(e => e.kind === 'context').length, 1);
});
