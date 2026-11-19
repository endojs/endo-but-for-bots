// @ts-check
// The context cache after a compaction (resources/agent-host/impl/
// context-cache.js; designs/m8-interfaces.md 5.4, 5.5, D-M8-16; acceptance
// 11, K5 and K6): the rebase after `TurnSink.compacted` takes no vat page;
// the plan input is kept once per projection; a rebuild of a compacted
// session reconciles the archive manifest from the vat's base (K5: the
// adapter restarted before it rebased; K6: the manifest written, the context
// file not); and the M1b property with compaction markers: incremental
// equals rebuild equals the oracle (the projection of the records from the
// boundary, with the compaction hook) for random sessions that compact.
import '../unit/_m1a-prelude.js';

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import test from '@endo/ses-ava/test.js';

import {
  makeContextCache,
  planInputOf,
} from '../../resources/agent-host/impl/context-cache.js';
import { projectRecords } from '../../resources/agent-host/impl/projection.js';
import { compactionHook } from '../../resources/agent-host/impl/providers/compaction.js';
import { USAGE, makeRandom } from './_m1b-context.js';
import { makeCompactingSession } from './_compaction-session.js';
import {
  makeFakeSink,
  makeIncarnation,
  makeStateDir,
  oracleTranscript,
} from './_m2-archive.js';
import { makeFakeVat } from './_m2-archive-vat.js';

const { E, Far } = /** @type {any} */ (globalThis);

const AT = 1_700_000_000_000;
const noStore = harden({
  resolveMany: async () => {},
  read: async () => {
    throw Error('no staged text in these sessions');
  },
});

/**
 * The oracle: the records from the boundary, projected, with the hook.
 * @param {ReturnType<typeof makeCompactingSession>} s
 */
const oracleOf = s =>
  compactionHook([
    ...projectRecords(s.records.since(s.window.boundary()), {
      texts: new Map(),
    }).transcript,
  ]);

/**
 * A request for a fresh cache: everything from the boundary is paged.
 * @param {ReturnType<typeof makeCompactingSession>} s
 * @param {string} turnId
 */
const rebuildRequest = (s, turnId) =>
  harden({
    turnId,
    base: { count: s.records.count(), ...s.window.baseFields() },
    append: [],
    context: s.context,
  });

test('rebase: the request after compacted takes no vat page; the summary leads; the plan input is read once', async t => {
  const s = makeCompactingSession();
  const history = [];
  for (let i = 0; i < 6; i += 1) {
    history.push(s.historyTurn({ replies: [{ text: `r${i}`, calls: 1 }] }));
  }
  const cache = makeContextCache({ store: noStore });
  const { turnId, start } = s.startTurn();
  const ask = s.askFor(turnId, 0, start);
  const sink = Far('TurnSink', {});
  const turn = Far('Turn', {});
  const first = await cache.prepare(
    s.session,
    s.request({ turn, sink, turnId, round: 0, compaction: ask }),
    { planInput: true },
  );
  const input = planInputOf(first);
  t.truthy(input);
  t.is(input?.start, 0);
  t.is(input?.records.length, s.records.count());
  t.is(planInputOf(first), undefined, 'read once');
  s.append({ kind: 'dispatched', turnId, round: 0 });
  const b = history[4].start;
  const reply = s.compacted(turnId, {
    round: 0,
    at: AT,
    outcome: 'done',
    boundary: b,
    summary: 'SUMMARY',
  });
  const pages = cache.stats().pages;
  const next = await cache.prepare(
    s.session,
    harden({
      turnId,
      base: reply.base,
      append: reply.append,
      context: s.context,
    }),
  );
  t.is(cache.stats().pages, pages, 'no vat page');
  t.is(cache.stats().rebases, 1);
  t.is(planInputOf(next), undefined, 'kept only when asked');
  t.deepEqual(next.transcript[0], {
    kind: 'message',
    role: 'assistant',
    content: 'SUMMARY',
  });
  t.false(JSON.stringify(next.transcript).includes('input of t1'));
  t.deepEqual(next.transcript, oracleOf(s));
  // A fresh cache (a restart) pages from the boundary and agrees.
  const fresh = makeContextCache({ store: noStore });
  const rebuilt = await fresh.prepare(s.session, rebuildRequest(s, turnId));
  t.deepEqual(rebuilt.transcript, next.transcript);
});

test('a later compaction inside the running turn cuts it at a round: the turn still counts as dispatched; the directive follows the summary', async t => {
  const s = makeCompactingSession();
  for (let i = 0; i < 3; i += 1) s.historyTurn();
  const cache = makeContextCache({ store: noStore });
  const { turnId, start } = s.startTurn('keep this directive');
  const turn = Far('Turn', {});
  const sink = Far('TurnSink', {});
  await cache.prepare(s.session, s.request({ turn, sink, turnId, round: 0 }));
  s.append({ kind: 'dispatched', turnId, round: 0 });
  /** @type {number[]} */
  const settled = [];
  for (let round = 0; round < 2; round += 1) {
    settled.push(
      s.append({
        kind: 'round-settled',
        turnId,
        round,
        text: `round ${round}`,
        callCount: 0,
        usage: USAGE,
        at: AT,
      }),
    );
  }
  const ask = s.askFor(turnId, 2, start);
  await cache.prepare(
    s.session,
    s.request({ turn, sink, turnId, round: 2, compaction: ask }),
    { planInput: true },
  );
  const reply = s.compacted(turnId, {
    round: 2,
    at: AT,
    outcome: 'done',
    boundary: settled[1],
    summary: 'S2',
  });
  const next = await cache.prepare(
    s.session,
    harden({
      turnId,
      base: reply.base,
      append: reply.append,
      context: s.context,
    }),
  );
  t.deepEqual(next.transcript.slice(0, 3), [
    { kind: 'message', role: 'assistant', content: 'S2' },
    { kind: 'message', role: 'user', content: 'keep this directive' },
    { kind: 'message', role: 'assistant', content: 'round 1' },
  ]);
  // The turn settles; its cut group is still in the context.
  s.append({ kind: 'turn-settled', turnId, status: 'completed', at: AT });
  const after = s.startTurn();
  const later = await cache.prepare(
    s.session,
    s.request({ turn, sink, turnId: after.turnId, round: 0 }),
  );
  t.true(JSON.stringify(later.transcript).includes('round 1'));
  t.deepEqual(later.transcript, oracleOf(s));
});

/**
 * An archived session that seals, then compacts in its current turn at the
 * start of its last history turn.
 * @param {import('ava').ExecutionContext} t
 * @param {object} options
 * @param {'rebase' | 'restart-first' | 'context-torn'} options.order
 */
const archivedCompaction = async (t, { order }) => {
  const dirs = await makeStateDir('ccc');
  t.teardown(dirs.cleanup);
  const { sink, keyOf } = makeFakeSink();
  let tear = false;
  const trace = (/** @type {string} */ step) => {
    if (step === 'context' && tear) {
      tear = false;
      throw Error('killed while writing the context file');
    }
  };
  const first = makeIncarnation(dirs, sink, { trace });
  const vat = makeFakeVat({
    seed: 5,
    store: first.blobs,
    keepTurns: 4,
    segmentTurns: 2,
    interruptedChance: 0,
  });
  const key = keyOf(vat.session);
  const port = first.archive.portFor({ session: vat.session, key });
  for (let n = 0; n < 16; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    await vat.turn(async (/** @type {any} */ req) => {
      await first.cache.prepare(vat.session, req, { key });
    });
    // eslint-disable-next-line no-await-in-loop
    await vat.maybeSeal(port);
  }
  t.true(vat.entries.length > 0, 'sealed');
  const b = vat.turns[vat.turns.length - 1].start;
  t.true(b >= vat.sealedTo(), 'the boundary lies in the kept records');
  const push = (/** @type {any} */ record) => {
    vat.all.push(harden(record));
    return vat.all.length - 1;
  };
  push({ kind: 'turn-started', turnId: 'tc', input: 'current', at: AT });
  push({
    kind: 'compaction-started',
    turnId: 'tc',
    round: 0,
    epoch: 1,
    boundary: 0,
    usedTokens: 80,
    windowTokens: 100,
    at: AT,
  });
  // Round 0 (records did not fit: the cache pulls them).
  await first.cache.prepare(
    vat.session,
    harden({
      turnId: 'tc',
      base: { count: vat.all.length, epoch: 0, archive: vat.state() },
      append: [],
      context: vat.context,
    }),
    { key },
  );
  const sent = vat.all.length;
  push({ kind: 'dispatched', turnId: 'tc', round: 0 });
  push({
    kind: 'compaction',
    turnId: 'tc',
    round: 0,
    epoch: 1,
    boundary: b,
    summary: 'ARCHIVED SUMMARY',
    at: AT,
  });
  // The vat's ContextSource after the compaction pages from the boundary.
  const context = Far('ContextSource', {
    page: (/** @type {string | undefined} */ cursor) =>
      E(vat.context).page(cursor ?? `p${Math.max(b, vat.sealedTo())}`),
    segments: (/** @type {string | undefined} */ cursor) =>
      E(vat.context).segments(cursor),
  });
  const base = { epoch: 1, boundary: b, archive: vat.state() };
  const oracle = compactionHook([
    ...(await oracleTranscript(vat.all.slice(b), first.blobs)),
  ]);
  const manifest = async () =>
    JSON.parse(
      await readFile(join(dirs.archiveDir, key, 'manifest.json'), 'utf8'),
    );
  const contextHead = async () =>
    JSON.parse(
      (
        await readFile(join(dirs.archiveDir, key, 'context.jsonl'), 'utf8')
      ).split('\n')[0],
    );
  if (order !== 'restart-first') {
    const pages = vat.counts.pages;
    tear = order === 'context-torn';
    const next = await first.cache.prepare(
      vat.session,
      harden({
        turnId: 'tc',
        base: { count: sent, ...base },
        append: vat.all.slice(sent),
        context,
      }),
      { key },
    );
    t.is(vat.counts.pages, pages, 'the rebase takes no page');
    t.is(first.cache.stats().rebases, 1);
    t.deepEqual(next.transcript, oracle);
    await first.archive.drain();
    const written = await manifest();
    t.is(written.epoch, 1);
    t.is(written.boundary, b);
    if (order === 'context-torn') {
      t.not(
        (await contextHead()).epoch,
        1,
        'the context file was not rewritten',
      );
    }
  }
  // The adapter restarts: the rebuild reconciles and agrees.
  const again = makeIncarnation(dirs, sink);
  const rebuilt = await again.cache.prepare(
    vat.session,
    harden({
      turnId: 'tc',
      base: { count: vat.all.length, ...base },
      append: [],
      context,
    }),
    { key },
  );
  t.is(again.cache.stats().reconciles, 1);
  t.deepEqual(rebuilt.transcript, oracle);
  t.deepEqual(rebuilt.transcript[0], {
    kind: 'message',
    role: 'assistant',
    content: 'ARCHIVED SUMMARY',
  });
  await again.archive.drain();
  const reconciled = await manifest();
  t.is(reconciled.epoch, 1);
  t.is(reconciled.boundary, b);
  t.deepEqual(await contextHead(), {
    ...(await contextHead()),
    epoch: 1,
    boundary: b,
  });
  t.log({
    order,
    records: vat.all.length,
    sealedTo: vat.sealedTo(),
    b,
    archive: again.archive.stats(),
  });
};

test('archive: the rebase tells the archive; a rebuild after a restart reconciles at once', async t => {
  await archivedCompaction(t, { order: 'rebase' });
});

test('K5: crank Y journaled, the adapter restarted before it rebased: the rebuild rewrites the manifest and the context file', async t => {
  await archivedCompaction(t, { order: 'restart-first' });
});

test('K6: the manifest written, the context file not: the rebuild rewrites the context file', async t => {
  await archivedCompaction(t, { order: 'context-torn' });
});

/**
 * One random session that compacts now and then; after every prepare the
 * incremental projection equals a fresh cache's rebuild and the oracle.
 * @param {import('ava').ExecutionContext} t
 * @param {number} seed
 */
const property = async (t, seed) => {
  const random = makeRandom(seed);
  const s = makeCompactingSession();
  const cache = makeContextCache({ store: noStore });
  const turn = Far('Turn', {});
  const sink = Far('TurnSink', {});
  let compared = 0;
  let compactions = 0;
  /** @param {any} projection @param {string} turnId @param {string} where */
  const check = async (projection, turnId, where) => {
    const fresh = makeContextCache({ store: noStore });
    const rebuilt = await fresh.prepare(s.session, rebuildRequest(s, turnId));
    t.deepEqual(projection.transcript, rebuilt.transcript, `rebuild ${where}`);
    t.deepEqual(projection.transcript, oracleOf(s), `oracle ${where}`);
    compared += 1;
  };
  /**
   * Prepare round `round`, compacting first when the dice say so.
   * @param {string} turnId
   * @param {number} round
   * @param {number} start
   */
  const prepareRound = async (turnId, round, start) => {
    const where = `${turnId} round ${round}`;
    if (!random.chance(0.3)) {
      await check(
        await cache.prepare(
          s.session,
          s.request({ turn, sink, turnId, round }),
        ),
        turnId,
        where,
      );
      return;
    }
    const ask = s.askFor(turnId, round, start);
    await cache.prepare(
      s.session,
      s.request({ turn, sink, turnId, round, compaction: ask }),
      { planInput: true },
    );
    if (round === 0) s.append({ kind: 'dispatched', turnId, round: 0 });
    const cuts = [];
    for (
      let i = Math.max(ask.floor, ask.boundary + 1);
      i <= Number(ask.askedAt);
      i += 1
    ) {
      if (s.window.isCut(i)) cuts.push(i);
    }
    const done = cuts.length > 0 && random.chance(0.8);
    const reply = s.compacted(
      turnId,
      done
        ? {
            round,
            at: AT,
            outcome: 'done',
            boundary: cuts[random.int(cuts.length)],
            summary: `summary ${compactions + 1}`,
          }
        : {
            round,
            at: AT,
            outcome: 'skipped',
            reason: 'Compaction skipped: test',
          },
    );
    if (done) compactions += 1;
    await check(
      await cache.prepare(
        s.session,
        harden({
          turnId,
          base: reply.base,
          append: reply.append,
          context: s.context,
        }),
      ),
      turnId,
      `${where} after compacted`,
    );
  };
  for (let n = 0; n < 40; n += 1) {
    const { turnId, start } = s.startTurn(`input ${n}`);
    // eslint-disable-next-line no-await-in-loop
    await prepareRound(turnId, 0, start);
    if (s.records.since(0).at(-1)?.kind !== 'dispatched') {
      s.append({ kind: 'dispatched', turnId, round: 0 });
    }
    const rounds = 1 + random.int(3);
    for (let round = 0; round < rounds; round += 1) {
      const calls = round < rounds - 1 ? 1 + random.int(2) : 0;
      s.append({
        kind: 'round-settled',
        turnId,
        round,
        text: `reply ${n}/${round}`,
        callCount: calls,
        usage: USAGE,
        at: AT,
      });
      if (calls > 0) {
        const intents = [];
        for (let i = 0; i < calls; i += 1) {
          intents.push(
            harden({
              opId: `${turnId}/${round}/${i}`,
              callId: '',
              name: 'echo',
              args: '{}',
            }),
          );
        }
        s.append({ kind: 'tool-intents', turnId, round, intents });
        for (const intent of intents) {
          s.append({
            kind: 'tool-result',
            turnId,
            opId: intent.opId,
            name: 'echo',
            result: `result ${intent.opId}`,
            failed: false,
          });
        }
        // eslint-disable-next-line no-await-in-loop
        await prepareRound(turnId, round + 1, start);
      }
    }
    s.append({
      kind: 'turn-settled',
      turnId,
      status: random.chance(0.2) ? 'failed' : 'completed',
      at: AT,
    });
  }
  t.true(compactions >= 3, `compactions: ${compactions}`);
  t.log({
    seed,
    compared,
    compactions,
    epoch: s.window.epoch(),
    cache: cache.stats(),
  });
};

test('property: with compactions, incremental equals rebuild equals the oracle, for random sessions', async t => {
  for (const seed of [1, 2, 3]) {
    // eslint-disable-next-line no-await-in-loop
    await property(t, seed);
  }
});
