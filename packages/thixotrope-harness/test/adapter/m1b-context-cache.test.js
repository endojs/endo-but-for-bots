// @ts-check
// M1b W1b.2: the adapter-owned context projection
// (resources/agent-host/impl/{context-cache,projection,projection-hooks}.js,
// guest/session/context-source.js; designs/m1b-interfaces.md 6.5, 9).
// Node, the real record log and ContextSource under the guest prelude, a
// real blob store over a fake manager sink; a "restart" is a fresh blob
// store over the same directory and sink (its presence map is empty) and a
// fresh cache.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { interfaces, textOf, texts } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { messageBytes } from '../../guest/lib/bounded.js';
import { assertTranscriptRecord } from '../../guest/lib/transcript-records.js';
import { blobsOf } from '../../guest/session/staging.js';
/* eslint-enable import/no-relative-packages */
import { makeBlobStore } from '../../resources/agent-host/impl/blobs.js';
import {
  isAbandoned,
  makeContextCache,
} from '../../resources/agent-host/impl/context-cache.js';
import {
  NATIVE_CONTEXT_FORMAT,
  projectRecords,
} from '../../resources/agent-host/impl/projection.js';
import { projectionHooks } from '../../resources/agent-host/impl/projection-hooks.js';
import { makeEndpoint } from '../../resources/agent-host/impl/endpoint.js';
import { makeTimers } from '../../resources/agent-host/impl/timers.js';
import {
  contextDigests,
  makeScriptedProvider,
  scriptedUnexpectedFailure,
} from '../../resources/agent-host/impl/providers/scripted.js';
import { makeTestBlobs } from './_m1b-blobs.js';
import { makeRandom, makeSessionSim, USAGE } from './_m1b-context.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, makeExo } = /** @type {GuestGlobals} */ (globalThis);

const timers = makeTimers();

/**
 * A fresh adapter incarnation over the same blob directory and manager.
 * @param {ReturnType<typeof makeTestBlobs>} blobs
 */
const incarnation = blobs => {
  const store = makeBlobStore({ dir: blobs.blobDir, sink: blobs.sink });
  return { store, cache: makeContextCache({ store }) };
};

/**
 * The oracle: project the whole log as it stands.
 * @param {any} sim
 * @param {any} store
 */
const oracle = async (sim, store) => {
  const all = sim.records.since(0);
  const blobList = [...new Set(all.flatMap(blobsOf))];
  const loaded = new Map(
    await Promise.all(
      blobList.map(
        async blob =>
          /** @type {[any, string]} */ ([blob, await store.read(blob)]),
      ),
    ),
  );
  return projectRecords(all, { texts: loaded }).transcript;
};

test('ContextSource pages: from the boundary, bounded, cursors p<index>', async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const sim = makeSessionSim({ seed: 7, store: blobs.store, textUnits: 3000 });
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await sim.turn(async () => {});
  }
  const count = sim.records.count();
  const { source } = sim;
  /** @type {any[]} */
  const all = [];
  /** @type {string | undefined} */
  let cursor;
  let pages = 0;
  for (;;) {
    /** @type {any} */
    // eslint-disable-next-line no-await-in-loop
    const page = await E(source).page(
      ...(cursor === undefined ? [] : [cursor]),
    );
    t.is(page.from, all.length);
    /** @type {number} */
    const size = page.records.length;
    t.true(size >= 1);
    t.true(size <= limits.pageRecords);
    t.true(messageBytes(page) <= limits.contextPageBytes);
    all.push(...page.records);
    pages += 1;
    if (page.next === undefined) break;
    t.is(page.next, `p${all.length}`);
    cursor = page.next;
  }
  t.true(pages > 1, `${count} records in ${pages} pages`);
  t.is(all.length, count);
  t.deepEqual(all, sim.records.since(0));
  // Resume anywhere, including the end (an empty page).
  const tail = await E(source).page(`p${count - 2}`);
  t.is(tail.from, count - 2);
  t.is(tail.records.length, 2);
  t.is(tail.next, undefined);
  t.deepEqual((await E(source).page(`p${count}`)).records, []);
  for (const bad of [`p${count + 1}`, 'p01', 'x3', 'p-1', 'c1']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(source).page(bad), {
      message: texts.badCursor,
    });
  }
});

test('ContextSource: one record over the page budget still makes a page', async t => {
  const sim = makeSessionSim({ seed: 3 });
  sim.records.append({
    kind: 'turn-started',
    turnId: 't1',
    input: 'x'.repeat(limits.submissionUnits),
    at: 1,
  });
  // A records list of 512 small records is capped by pageRecords.
  for (let i = 0; i < 600; i += 1) {
    sim.records.append({ kind: 'dispatched', turnId: 't1', round: i });
  }
  /** @type {any} */
  const first = await E(sim.source).page();
  /** @type {number} */
  const size = first.records.length;
  t.true(size <= limits.pageRecords);
  t.is(first.next, `p${first.records.length}`);
});

test('property: incremental equals rebuild equals the oracle, for random sessions', async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  let compared = 0;
  const totals = { appends: 0, duplicates: 0, gapPulls: 0, rebuilds: 0 };
  for (let seed = 1; seed <= 24; seed += 1) {
    const random = makeRandom(seed * 7919);
    const sim = makeSessionSim({ seed, store: blobs.store });
    let live = incarnation(blobs);
    const turnsInSession = 4 + random.int(14);
    for (let k = 0; k < turnsInSession; k += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sim.turn(async req => {
        if (random.chance(0.05)) {
          // A request never run here (parked and dropped): the cache falls
          // behind and pulls the gap next time.
          return;
        }
        if (random.chance(0.04)) {
          // The adapter restarted: a fresh incarnation and an empty cache.
          live = incarnation(blobs);
        }
        const incremental = await live.cache.prepare(sim.session, req);
        if (random.chance(0.05)) {
          // The same round 0 again, to the same incarnation.
          const again = await live.cache.prepare(sim.session, req);
          t.deepEqual(again.transcript, incremental.transcript);
        }
        const fresh = incarnation(blobs);
        const rebuilt = await fresh.cache.prepare(sim.session, req);
        t.deepEqual(rebuilt.transcript, incremental.transcript, `seed ${seed}`);
        t.deepEqual(
          incremental.transcript,
          await oracle(sim, blobs.store),
          `seed ${seed} oracle`,
        );
        t.is(incremental.count, sim.records.count());
        t.is(rebuilt.count, sim.records.count());
        compared += 1;
      });
    }
    const stats = live.cache.stats();
    for (const key of /** @type {const} */ ([
      'appends',
      'duplicates',
      'gapPulls',
      'rebuilds',
    ])) {
      totals[key] += stats[key];
    }
  }
  t.log({ compared, ...totals });
  t.true(compared > 200);
  // Every path was taken.
  t.true(totals.appends > 0 && totals.gapPulls > 0 && totals.rebuilds > 0);
});

test('projection: user, assistant with native context, calls then results in call order; interrupted turns left out', async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const native = await blobs.store.stage('opaque native state', {
    previewUnits: 0,
  });
  const bigArgs = await blobs.store.stage(
    JSON.stringify({ text: 'y'.repeat(9000) }),
    { previewUnits: 256 },
  );
  const at = 1;
  const records = [
    { kind: 'turn-started', turnId: 't1', input: 'never sent', at },
    { kind: 'turn-settled', turnId: 't1', status: 'interrupted', at },
    { kind: 'turn-started', turnId: 't2', input: 'hello', at },
    { kind: 'dispatched', turnId: 't2', round: 0 },
    {
      kind: 'round-settled',
      turnId: 't2',
      round: 0,
      text: 'calling',
      callCount: 2,
      usage: USAGE,
      at,
      nativeContext: native,
    },
    {
      kind: 'tool-intents',
      turnId: 't2',
      round: 0,
      intents: [
        { opId: 't2/0/0', callId: 'a', name: 'echo', args: '{"text":"1"}' },
        { opId: 't2/0/1', callId: 'b', name: 'echo', args: bigArgs },
      ],
    },
    // Completion order is the reverse of call order.
    {
      kind: 'tool-result',
      turnId: 't2',
      opId: 't2/0/1',
      name: 'echo',
      result: 'second',
      failed: true,
    },
    {
      kind: 'tool-result',
      turnId: 't2',
      opId: 't2/0/0',
      name: 'echo',
      result: 'first',
      failed: false,
    },
    {
      kind: 'round-settled',
      turnId: 't2',
      round: 1,
      text: 'done',
      callCount: 0,
      usage: USAGE,
      at,
    },
    { kind: 'turn-settled', turnId: 't2', status: 'completed', at },
    { kind: 'turn-started', turnId: 't3', input: 'stop', at },
    { kind: 'dispatched', turnId: 't3', round: 0 },
    { kind: 'partial', turnId: 't3', round: 0, text: 'half a' },
    { kind: 'turn-settled', turnId: 't3', status: 'cancelled', at },
    { kind: 'turn-resolved', turnId: 't3', note: 'ok', at },
  ];
  const textsMap = new Map([
    [native.blob, 'opaque native state'],
    [bigArgs.blob, JSON.stringify({ text: 'y'.repeat(9000) })],
  ]);
  const { transcript } = projectRecords(harden(records), { texts: textsMap });
  t.deepEqual(transcript, [
    { kind: 'message', role: 'user', content: 'hello' },
    {
      kind: 'message',
      role: 'assistant',
      content: 'calling',
      providerContext: {
        format: NATIVE_CONTEXT_FORMAT,
        payload: 'opaque native state',
      },
    },
    { kind: 'tool-call', id: 't2/0/0', name: 'echo', args: '{"text":"1"}' },
    {
      kind: 'tool-call',
      id: 't2/0/1',
      name: 'echo',
      args: JSON.stringify({ text: 'y'.repeat(9000) }),
    },
    { kind: 'tool-result', id: 't2/0/0', content: 'first' },
    { kind: 'tool-result', id: 't2/0/1', content: 'second', failed: true },
    { kind: 'message', role: 'assistant', content: 'done' },
    { kind: 'message', role: 'user', content: 'stop' },
    { kind: 'message', role: 'assistant', content: 'half a' },
  ]);
  // Every record is a valid transcript record (the providers' input format).
  for (const record of transcript) assertTranscriptRecord(record);
  // A staged text the caller did not load is a bug, not silence.
  t.throws(() => projectRecords(harden(records), { texts: new Map() }), {
    message: /not loaded/,
  });
  // The hook table is empty (M8 appends) and hooks run in order.
  t.deepEqual(projectionHooks, []);
  const hooked = projectRecords(harden(records), {
    texts: textsMap,
    hooks: [tr => tr.slice(0, 1), tr => [...tr, tr.length]],
  });
  t.deepEqual(hooked.transcript, [transcript[0], 1]);
});

test('a round 0 sent twice to two incarnations projects its TurnStarted once (contract 7.1 case 3)', async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const sim = makeSessionSim({ seed: 11, store: blobs.store });
  const first = incarnation(blobs);
  for (let k = 0; k < 6; k += 1) {
    // eslint-disable-next-line no-await-in-loop
    await sim.turn(async req => {
      await first.cache.prepare(sim.session, req);
    });
  }
  // The session was idle across a restart: its claim (TurnStarted appended,
  // round 0 sent) went to the dead incarnation, which may or may not have
  // run it; the same request is then sent to fresh ports.
  const staged = await blobs.store.stage(`resend ${'z'.repeat(9000)}`, {
    previewUnits: 1024,
  });
  sim.records.append({
    kind: 'turn-started',
    turnId: 'tx',
    input: staged,
    at: 9,
  });
  const round0 = sim.request('tx', 0);
  t.is(round0.append.at(-1).kind, 'turn-started');
  const dead = await first.cache.prepare(sim.session, round0);
  const fresh = incarnation(blobs);
  const again = await fresh.cache.prepare(sim.session, round0);
  const users = again.transcript.filter(
    (/** @type {any} */ r) =>
      r.role === 'user' && r.content.startsWith('resend'),
  );
  t.is(users.length, 1);
  t.deepEqual(again.transcript, dead.transcript);
  t.is(again.input, `resend ${'z'.repeat(9000)}`);
  t.is(fresh.cache.stats().rebuilds, 1);
  // The page held the TurnStarted at base.count; it was not taken from it.
  t.is(fresh.cache.stats().pagedRecords, round0.base.count);
  // The same request twice to one incarnation: a duplicate, applied once.
  const third = await fresh.cache.prepare(sim.session, round0);
  t.deepEqual(third.transcript, again.transcript);
  t.is(fresh.cache.stats().duplicates, 1);
});

test('rebuild after a restart: native context replayed from its blob; handles resolved in batches of 64', async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const sim = makeSessionSim({
    seed: 5,
    store: blobs.store,
    stagedChance: 1,
    nativeChance: 1,
    toolChance: 0,
    cancelChance: 0,
    interruptedChance: 0,
  });
  const first = incarnation(blobs);
  /** @type {any} */
  let before;
  for (let k = 0; k < 60; k += 1) {
    // eslint-disable-next-line no-await-in-loop
    await sim.turn(async req => {
      before = await first.cache.prepare(sim.session, req);
    });
  }
  const resolvesBefore = blobs.counts?.resolves ?? 0;
  const fresh = incarnation(blobs);
  // The next turn after the restart.
  /** @type {any} */
  let after;
  let handles = 0;
  await sim.turn(async req => {
    after = await fresh.cache.prepare(sim.session, req);
    handles = new Set(
      sim.records.since(0).flatMap((/** @type {any} */ r) => blobsOf(r)),
    ).size;
  });
  // The context before the restart is a prefix of the one after it,
  // native contexts included.
  t.deepEqual(
    after.transcript.slice(0, before.transcript.length),
    before.transcript,
  );
  const natives = after.transcript.filter(
    (/** @type {any} */ r) => r.providerContext !== undefined,
  );
  t.is(natives.length, 60);
  t.true(
    natives.every(
      (/** @type {any} */ r, /** @type {number} */ i) =>
        r.providerContext.format === NATIVE_CONTEXT_FORMAT &&
        r.providerContext.payload.startsWith(`native t${i + 1}/0`),
    ),
  );
  // Every handle in the log (60 turns of input, reply unless empty, native
  // context, and this turn's input), resolved by the fresh incarnation in
  // batches of at most 64 per manager call.
  t.true(handles > 128);
  const resolves = (blobs.counts?.resolves ?? 0) - resolvesBefore;
  t.log({ handles, resolves, pages: fresh.cache.stats().pages });
  t.true(
    resolves >= Math.ceil(handles / 64) &&
      resolves <= Math.ceil(handles / 64) + fresh.cache.stats().pages,
    `${resolves} resolve calls`,
  );
  t.is(fresh.cache.stats().blobsRead, handles);
});

test('gap pull: an append that did not fit (append: []) pulls from p<count> only', async t => {
  const sim = makeSessionSim({ seed: 2 });
  const cache = makeContextCache({
    store: /** @type {any} */ ({
      resolveMany: async () => {},
      read: async () => '',
    }),
  });
  for (let k = 0; k < 10; k += 1) {
    // eslint-disable-next-line no-await-in-loop
    await sim.turn(
      async req => {
        await cache.prepare(sim.session, req);
      },
      { fallbackChance: 0 },
    );
  }
  const before = cache.stats();
  const had = sim.sent();
  sim.records.append({
    kind: 'turn-started',
    turnId: 'tg',
    input: 'gap',
    at: 1,
  });
  const req = sim.request('tg', 0, true);
  t.deepEqual(req.append, []);
  const projection = await cache.prepare(sim.session, req);
  const after = cache.stats();
  t.is(after.gapPulls - before.gapPulls, 1);
  t.is(after.pages - before.pages, 1);
  t.is(after.pagedRecords - before.pagedRecords, req.base.count - had);
  t.true(
    req.base.count - had >= 2,
    'the previous turn settled after its last request',
  );
  t.is(projection.input, 'gap');
  t.is(projection.count, sim.records.count());
});

test('failures: a page that breaks abandons the round (nothing sent); a blob that cannot load fails it with stagingFailed', async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  // The session vat is lost: its ContextSource breaks.
  const lost = Far('ContextSource', {
    page: () => {
      throw Error('ocapn hub: retired');
    },
  });
  const cache = makeContextCache({ store: blobs.store });
  const session = Far('Session', {});
  const req = harden({
    turnId: 't1',
    round: 0,
    base: { count: 3, epoch: 0 },
    append: [],
    context: lost,
  });
  const error = await t.throwsAsync(() => cache.prepare(session, req));
  t.true(isAbandoned(error));
  t.is(cache.stats().abandons, 1);
  t.false(cache.has(session));

  // A handle the manager does not know (resolveBlobs answers null).
  const stranger = Far('Blob', {});
  const sim = makeSessionSim({ seed: 1 });
  sim.records.append({
    kind: 'turn-started',
    turnId: 't1',
    input: harden({ blob: stranger, preview: 'p', bytes: 9000 }),
    at: 1,
  });
  const bad = sim.request('t1', 0);
  const failure = await t.throwsAsync(() => cache.prepare(sim.session, bad));
  t.false(isAbandoned(failure));
  t.is(failure?.message, texts.blobUnknown);
  t.is(cache.stats().failures, 1);

  // Through the scripted provider: abandon sends nothing; a load failure
  // sends roundFailed with textOf.stagingFailed, before dispatching(0).
  /** @type {any[]} */
  const sent = [];
  const sink = makeExo('TurnSink', interfaces.TurnSink, {
    dispatching: () => {
      sent.push('dispatching');
      return true;
    },
    roundFinal: () => {
      sent.push('roundFinal');
    },
    roundFailed: (/** @type {any} */ f) => {
      sent.push(f.reason);
    },
    deadline: () => undefined,
    progress: () => true,
    // WX.1: the context window's method; nothing here asks to compact.
    compacted: () => harden({ go: false }),
  });
  const turn = Far('Turn', {});
  /** @type {any[]} */
  const log = [];
  const provider = makeScriptedProvider({
    label: 'scripted',
    script: harden({ turns: [{ rounds: [{ chunks: [{ text: 'hi' }] }] }] }),
    timers,
    log: (kind, fields = {}) => log.push({ kind, ...fields }),
    blobs: blobs.store,
  });
  await provider.startRound(
    harden({ ...req, turn, sink, options: { modelId: 'm' }, tools: [] }),
    harden({ publishDelta: () => {} }),
    () => cache.prepare(session, req),
  );
  t.deepEqual(sent, []);
  t.is(log.at(-1).kind, 'context-abandoned');
  await provider.startRound(
    harden({ ...bad, turn, sink, options: { modelId: 'm' }, tools: [] }),
    harden({ publishDelta: () => {} }),
    () => cache.prepare(sim.session, bad),
  );
  t.deepEqual(sent, [textOf.stagingFailed(texts.blobUnknown)]);
  t.is(log.at(-1).kind, 'context-failed');
});

test('scripted provider through the endpoint: chooses its turn from the projected input, logs the context it received', async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const sim = makeSessionSim({ seed: 9, store: blobs.store });
  const cache = makeContextCache({ store: blobs.store });
  /** @type {any[]} */
  const log = [];
  const provider = makeScriptedProvider({
    label: 'scripted',
    script: harden({
      turns: [
        {
          input: 'x'.repeat(9000),
          rounds: [{ chunks: [{ text: 'long one' }] }],
        },
        { rounds: [{ chunks: [{ text: 'default' }] }] },
      ],
    }),
    timers,
    log: (kind, fields = {}) => log.push({ kind, ...fields }),
    blobs: blobs.store,
    logContext: true,
  });
  const endpoint = makeEndpoint({
    provider,
    channel: harden({ publishDelta: () => {} }),
    timers,
    prepare: req => cache.prepare(sim.session, req),
    unexpectedFailure: scriptedUnexpectedFailure,
  });
  /** @type {any[]} */
  const finals = [];
  const sink = makeExo('TurnSink', interfaces.TurnSink, {
    dispatching: () => true,
    roundFinal: (/** @type {any} */ r) => {
      finals.push(r);
    },
    roundFailed: (/** @type {any} */ f) => {
      finals.push(f);
    },
    deadline: () => undefined,
    progress: () => true,
    // WX.1: the context window's method; nothing here asks to compact.
    compacted: () => harden({ go: false }),
  });
  await sim.turn(async () => {}); // history
  // A staged input, sent as `append: []` (it did not fit): the provider
  // finds the full text only through the projection.
  const staged = await blobs.store.stage('x'.repeat(9000), {
    previewUnits: 1024,
  });
  sim.records.append({
    kind: 'turn-started',
    turnId: 'ts',
    input: staged,
    at: 5,
  });
  const req = sim.request('ts', 0, true);
  const turn = Far('Turn', {});
  void E(endpoint).holdTurn(turn);
  E.sendOnly(endpoint).startRound(
    harden({ ...req, turn, sink, tools: [], options: { modelId: 'm' } }),
  );
  const t0 = Date.now();
  while (finals.length === 0 && Date.now() - t0 < 5000) {
    // eslint-disable-next-line no-await-in-loop
    await timers.delay(5);
  }
  t.is(finals[0]?.text, 'long one');
  await timers.delay(20);
  const line = log.find(entry => entry.kind === 'context');
  const projection = await cache.prepare(sim.session, req);
  t.like(line, {
    turnId: 'ts',
    round: 0,
    ...contextDigests(projection.transcript),
  });
  t.is(line.turnDigests.split(' ').length, 2);
});

test('retained state: at most maxSessions entries, least recently prepared out', async t => {
  const cache = makeContextCache({
    store: /** @type {any} */ ({
      resolveMany: async () => {},
      read: async () => '',
    }),
    maxSessions: 2,
  });
  const sims = [1, 2, 3].map(seed => makeSessionSim({ seed }));
  for (const sim of sims) {
    // eslint-disable-next-line no-await-in-loop
    await sim.turn(async req => {
      await cache.prepare(sim.session, req);
    });
  }
  t.false(cache.has(sims[0].session));
  t.true(cache.has(sims[1].session));
  t.true(cache.has(sims[2].session));
  t.true(cache.stats().evictions >= 1);
  cache.evict(sims[2].session);
  t.false(cache.has(sims[2].session));
});
