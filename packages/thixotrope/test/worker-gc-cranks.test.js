// @ts-check

/**
 * OCapN GC frames toward a worker wait in its journal for the next ordinary
 * frame and enter the worker in the same crank (core candidate C-17 of the
 * harness journal): a GC frame never wakes a sleeping worker and never pays
 * a crank of its own. These tests hold the transport to the two promises
 * that change rests on:
 *
 * - no reference is released early: GC frames are only ever delayed, never
 *   moved past an ordinary frame, and a held frame still reaches the worker;
 * - replay is deterministic: where cranks begin follows from the journal
 *   alone, so a worker restarted from a snapshot (or killed and replayed)
 *   regenerates byte-identical outbound frames under the same sequence
 *   numbers, and every release reaches the host exactly once.
 */
import test from '@endo/ses-ava/test.js';

import { decodeBase64 } from '@endo/base64';
import harden from '@endo/harden';
import { syrupCodec } from '@endo/ocapn/syrup';
import { cborCodec } from '@endo/ocapn/cbor';

import { makeThixotropeDaemon } from '../src/core/daemon.js';
import {
  GC_FRAMES_PER_CRANK,
  journalCranks,
  makeDurableWorkerTransport,
} from '../src/core/durable-worker-transport.js';
import { makeGcFrameTest, makeOcapnHub } from '../src/net/hub.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { makeMemoryStore } from '../src/store/store-memory.js';

/** @import { WorkerEngine } from '../src/core/worker-engine.js' */

const nodePowers = makeNodePowers();
const workerId = 'f'.repeat(32);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
/** @param {string} text */
const frame = text => textEncoder.encode(text);
/** @param {any} message */
const textOf = message => textDecoder.decode(decodeBase64(message.b64));
/** The test's GC frames are the ones whose text says so. */
const isGcFrame = (/** @type {Uint8Array} */ bytes) =>
  textDecoder.decode(bytes).startsWith('gc ');
const settle = () => new Promise(resolve => setImmediate(resolve));

// ---- the classifier

/**
 * @param {any} codec
 * @param {string} label
 */
const gcFrameBytes = (codec, label) => {
  const writer = codec.makeWriter();
  writer.enterRecord(label === 'op:gc-exports' ? 3 : 2);
  writer.writeSelectorFromString(label);
  writer.enterList(2);
  writer.writeInteger(1n);
  writer.writeInteger(2n);
  writer.exitList();
  if (label === 'op:gc-exports') {
    writer.enterList(2);
    writer.writeInteger(1n);
    writer.writeInteger(1n);
    writer.exitList();
  }
  writer.exitRecord();
  return writer.getBytes();
};

for (const [name, codec] of /** @type {const} */ ([
  ['syrup', syrupCodec],
  ['cbor', cborCodec],
])) {
  test(`the GC frame test reads only the record label (${name})`, t => {
    const isGc = makeGcFrameTest(codec);
    t.true(isGc(gcFrameBytes(codec, 'op:gc-exports')));
    t.true(isGc(gcFrameBytes(codec, 'op:gc-answers')));
    t.false(isGc(gcFrameBytes(codec, 'op:abort')), 'another operation');
    t.false(isGc(new Uint8Array([0xff, 0x00, 0x13])), 'unreadable bytes');
    t.false(isGc(new Uint8Array()), 'no bytes');
  });
}

test('the hub’s own GC frames are GC frames to the test', t => {
  /** @type {any} */
  let state = {
    version: 2,
    refs: {
      r1: {
        origin: 'origin',
        position: '1',
        backing: 'export',
        flavor: 'object',
        mentionsIn: 2,
        refcounts: { source: 2 },
        listeners: [],
      },
      r2: {
        origin: 'origin',
        position: '2',
        backing: 'answer',
        flavor: 'promise',
        mentionsIn: 0,
        refcounts: {},
        listeners: [],
      },
    },
    publications: {},
    sessions: {
      origin: { durable: true },
      source: {
        durable: true,
        answersOwed: { 7: { ref: 'r2' } },
        ourExports: { 1: 'r1' },
      },
    },
  };
  const hub = makeOcapnHub({
    codec: syrupCodec,
    store: {
      getState: () => state,
      setState: next => {
        state = JSON.parse(JSON.stringify(next));
      },
    },
  });
  const ingress = hub.attachSession('source', {
    durable: true,
    send: () => true,
  });
  /** @type {Uint8Array[]} */
  const toOrigin = [];
  hub.attachSession('origin', {
    durable: true,
    send: (/** @type {Uint8Array} */ bytes) => {
      toOrigin.push(bytes);
      return true;
    },
  });
  const writer = syrupCodec.makeWriter();
  writer.enterRecord();
  writer.writeSelectorFromString('op:gc-exports');
  writer.enterList();
  writer.writeInteger(1n);
  writer.exitList();
  writer.enterList();
  writer.writeInteger(2n);
  writer.exitList();
  writer.exitRecord();
  ingress.deliver(writer.getBytes(), 1n);
  const answers = syrupCodec.makeWriter();
  answers.enterRecord();
  answers.writeSelectorFromString('op:gc-answers');
  answers.enterList();
  answers.writeInteger(7n);
  answers.exitList();
  answers.exitRecord();
  ingress.deliver(answers.getBytes(), 2n);
  t.is(toOrigin.length, 2, 'one release of each kind toward the origin');
  const isGc = makeGcFrameTest(syrupCodec);
  t.true(toOrigin.every(isGc));
  t.deepEqual(
    hub.gcCounts().map(({ direction, kind, frames, positions }) => ({
      direction,
      kind,
      frames,
      positions,
    })),
    [
      { direction: 'in', kind: 'op:gc-exports', frames: 1, positions: 1 },
      { direction: 'out', kind: 'op:gc-exports', frames: 1, positions: 1 },
      { direction: 'in', kind: 'op:gc-answers', frames: 1, positions: 1 },
      { direction: 'out', kind: 'op:gc-answers', frames: 1, positions: 1 },
    ],
  );
  t.true(
    hub
      .gcCounts()
      .filter(row => row.direction === 'out')
      .every(row => row.cause === 'source' && row.to === 'origin'),
    'each release names the session that let go, and its destination',
  );
});

// ---- where cranks begin

test('journal cranks: a GC run goes with the next ordinary frame, or alone when full', t => {
  const gc = { b64: 'g', gc: /** @type {const} */ (true) };
  const plain = { b64: 'p' };
  const shape = (/** @type {any[]} */ entries, base = 10) => {
    const { cranks, heldStart, held } = journalCranks(entries, base);
    return {
      cranks: cranks.map(c => [c.start, c.entries.length]),
      heldStart,
      held: held.length,
    };
  };
  t.deepEqual(shape([]), { cranks: [], heldStart: 10, held: 0 });
  t.deepEqual(shape([plain, plain]), {
    cranks: [
      [10, 1],
      [11, 1],
    ],
    heldStart: 12,
    held: 0,
  });
  t.deepEqual(shape([gc, gc, plain, gc]), {
    cranks: [[10, 3]],
    heldStart: 13,
    held: 1,
  });
  const full = Array.from({ length: GC_FRAMES_PER_CRANK + 2 }, () => gc);
  t.deepEqual(shape([...full, plain], 0), {
    cranks: [
      [0, GC_FRAMES_PER_CRANK],
      [GC_FRAMES_PER_CRANK, 3],
    ],
    heldStart: GC_FRAMES_PER_CRANK + 3,
    held: 0,
  });
});

// ---- the transport, against a model vat

/**
 * A worker engine whose guest is a model vat: `export N` adds a reference to
 * object N the host holds, `use N` calls it (and records an early release if
 * the vat no longer has it), `gc N` (a GC frame) drops one. At the end of
 * each crank the model collects, as the real worker does, and reports every
 * object released in that crank in one outbound frame, so outbound depends
 * on where cranks begin. Snapshots are copies of the model's state.
 */
const makeModelEngine = () => {
  /** @type {Map<string, string>} */
  const images = new Map();
  let imageCount = 0;
  const log = {
    starts: 0,
    /** @type {string[][]} every crank's frames, live and replayed */
    cranks: /** @type {string[][]} */ ([]),
    /** @type {string[]} uses of an object the vat had released */
    early: /** @type {string[]} */ ([]),
    batches: 0,
  };
  /** @type {WorkerEngine} */
  const engine = harden({
    canSnapshot: true,
    start: async ({ snapshot, onOutbound }) => {
      log.starts += 1;
      /** @type {{ held: Record<string, number>, released: string[] }} */
      const model =
        snapshot === null
          ? { held: {}, released: [] }
          : JSON.parse(/** @type {string} */ (images.get(String(snapshot))));
      /** @type {string[]} */
      let releasedThisCrank = [];
      /** @param {string} text */
      const apply = text => {
        const [op, id] = text.split(' ');
        if (op === 'export') model.held[id] = (model.held[id] ?? 0) + 1;
        else if (op === 'use') {
          if (!(model.held[id] > 0)) log.early.push(id);
        } else if (op === 'gc') {
          model.held[id] -= 1;
          if (model.held[id] === 0) {
            delete model.held[id];
            releasedThisCrank.push(id);
          }
        }
      };
      /** @param {any[]} messages */
      const crank = async messages => {
        const texts = messages.filter(message => message.t === 'f').map(textOf);
        if (texts.length === 0) return;
        log.cranks.push(texts);
        texts.forEach(apply);
        if (releasedThisCrank.length > 0) {
          model.released.push(...releasedThisCrank);
          onOutbound(
            harden({
              t: 'f',
              b64: Buffer.from(
                `released ${releasedThisCrank.join(',')}`,
              ).toString('base64'),
            }),
          );
        }
        releasedThisCrank = [];
      };
      return harden({
        deliver: async message => crank([message]),
        deliverBatch: async messages => {
          log.batches += 1;
          await crank(messages);
        },
        snapshot: async () => {
          imageCount += 1;
          const ref = `image ${imageCount}`;
          images.set(ref, JSON.stringify(model));
          return ref;
        },
        terminate: async () => {},
      });
    },
  });
  return { engine, log };
};

/**
 * @param {any} engine
 * @param {any} store
 * @param {Map<number, string>} outbound by sequence number, as the hub's
 *   watermark keeps them: a number seen again must carry the same bytes
 * @param {string[]} problems
 */
const makeTransport = (engine, store, outbound, problems) =>
  makeDurableWorkerTransport(
    { timers: nodePowers.timers, logging: nodePowers.logging },
    {
      workerId,
      store,
      engine,
      isGcFrame,
      onFrame: (bytes, sequenceNumber) => {
        const text = textDecoder.decode(bytes);
        const seen = outbound.get(sequenceNumber);
        if (seen !== undefined && seen !== text) {
          problems.push(`frame ${sequenceNumber}: ${seen} then ${text}`);
        }
        outbound.set(sequenceNumber, text);
      },
    },
  );

test('a GC frame waits for the next ordinary frame and does not wake the worker', async t => {
  const { engine, log } = makeModelEngine();
  const store = makeMemoryStore().provideWorkerStore(workerId);
  /** @type {Map<number, string>} */
  const outbound = new Map();
  /** @type {string[]} */
  const problems = [];
  const transport = makeTransport(engine, store, outbound, problems);
  for (const text of ['export 1', 'export 2', 'export 2']) {
    transport.write(frame(text));
  }
  await settle();
  await transport.sleep();
  t.is(log.starts, 1);
  t.false(transport.isAwake());

  for (const text of ['gc 1', 'gc 2']) {
    t.true(transport.write(frame(text)), 'the GC frame is accepted');
  }
  await settle();
  t.is(log.starts, 1, 'GC frames do not wake a sleeping worker');
  t.false(transport.isAwake());
  t.is(store.journalLength(), 5, 'they are journaled');
  t.false(transport.owesDelivery(), 'and no crank is owed for them');
  t.like(transport.stats(), { heldFrames: 2, wakes: 1 });

  transport.write(frame('use 2'));
  await settle();
  t.is(log.starts, 2, 'the ordinary frame wakes the worker');
  t.deepEqual(
    log.cranks.at(-1),
    ['gc 1', 'gc 2', 'use 2'],
    'one crank, in journal order, the GC frames first',
  );
  t.is(log.batches, 1);
  t.deepEqual(log.early, [], 'object 2 was still held: one of two dropped');
  t.deepEqual([...outbound.values()], ['released 1']);
  t.like(transport.stats(), { heldFrames: 0 });
  t.deepEqual(problems, []);
});

test('a full run of GC frames is one crank of its own', async t => {
  const { engine, log } = makeModelEngine();
  const store = makeMemoryStore().provideWorkerStore(workerId);
  const transport = makeTransport(engine, store, new Map(), []);
  for (let i = 0; i < GC_FRAMES_PER_CRANK; i += 1) {
    transport.write(frame(`export ${i}`));
  }
  await settle();
  const before = log.cranks.length;
  for (let i = 0; i < GC_FRAMES_PER_CRANK + 1; i += 1) {
    transport.write(frame(`gc ${i % GC_FRAMES_PER_CRANK}`));
  }
  await settle();
  t.is(log.cranks.length, before + 1, 'one crank for the full run');
  t.is(log.cranks.at(-1)?.length, GC_FRAMES_PER_CRANK);
  t.is(transport.stats().heldFrames, 1, 'the next run has begun');
});

/**
 * A script of frames to a model vat: objects exported, used, and released by
 * GC frames in bursts, with every use of an object made while the host still
 * holds it. Returns the frames and, per object, how many references the
 * host gave back.
 */
const script = () => {
  /** @type {string[]} */
  const frames = [];
  for (let round = 0; round < 6; round += 1) {
    for (let i = 0; i < 10; i += 1) frames.push(`export ${round}.${i}`);
    frames.push(`use ${round}.0`);
    // A burst releasing most of the round's objects, then an ordinary frame
    // that uses one still held.
    for (let i = 1; i < 10; i += 1) frames.push(`gc ${round}.${i}`);
    frames.push(`use ${round}.0`);
    frames.push(`gc ${round}.0`);
  }
  // The last release is held until something else reaches the vat.
  frames.push('ping');
  return frames;
};

const expectedReleases = () =>
  Array.from({ length: 6 }, (_, round) =>
    Array.from({ length: 10 }, (__, i) => `${round}.${i}`),
  )
    .flat()
    .sort();

/**
 * @param {Map<number, string>} outbound
 */
const releasesOf = outbound =>
  [...outbound.values()]
    .flatMap(text => text.slice('released '.length).split(','))
    .sort();

test('replay after a kill delivers the same cranks: same outbound, each release once', async t => {
  const frames = script();
  // The live run, never interrupted.
  const live = makeModelEngine();
  /** @type {Map<number, string>} */
  const liveOut = new Map();
  /** @type {string[]} */
  const problems = [];
  const liveTransport = makeTransport(
    live.engine,
    makeMemoryStore().provideWorkerStore(workerId),
    liveOut,
    problems,
  );
  for (const text of frames) liveTransport.write(frame(text));
  await settle();
  await liveTransport.sleep();

  // The same frames to a worker that is put to sleep with GC frames held,
  // killed without a snapshot (SIGKILL), and served again by a fresh
  // transport object over the same store (a restarted host), twice.
  const { engine, log } = makeModelEngine();
  const store = makeMemoryStore().provideWorkerStore(workerId);
  /** @type {Map<number, string>} */
  const out = new Map();
  let transport = makeTransport(engine, store, out, problems);
  const cut1 = 36; // inside round 1's GC burst
  const cut2 = 70; // inside round 3's exports
  frames.slice(0, cut1).forEach(text => transport.write(frame(text)));
  await settle();
  await transport.sleep();
  t.true(transport.stats().heldFrames > 0, 'asleep with GC frames held');
  transport = makeTransport(engine, store, out, problems);
  t.false(transport.owesDelivery(), 'a restart need not wake it');
  frames.slice(cut1, cut2).forEach(text => transport.write(frame(text)));
  await settle();
  await transport.crash(); // killed: no snapshot
  transport = makeTransport(engine, store, out, problems);
  t.true(transport.owesDelivery(), 'the unsnapshotted cranks are owed');
  await transport.wake(); // the replay
  frames.slice(cut2).forEach(text => transport.write(frame(text)));
  await settle();
  await transport.sleep();

  t.deepEqual(problems, [], 'a regenerated frame always repeats its bytes');
  t.deepEqual(
    [...out.entries()].sort((a, b) => a[0] - b[0]),
    [...liveOut.entries()].sort((a, b) => a[0] - b[0]),
    'the interrupted worker emitted what the uninterrupted one did',
  );
  t.deepEqual(releasesOf(out), expectedReleases(), 'every release, once');
  t.deepEqual(log.early, [], 'no object was used after its release');
  t.deepEqual(live.log.early, []);
  t.true(
    log.cranks.length < frames.length,
    'GC frames shared cranks with ordinary ones',
  );
});

test('the hub sequence advances with the crank that delivered it', async t => {
  const { engine } = makeModelEngine();
  const store = makeMemoryStore().provideWorkerStore(workerId);
  const transport = makeTransport(engine, store, new Map(), []);
  transport.write(frame('export 1'), '1');
  transport.write(frame('gc 1'), '2');
  await settle();
  await transport.sleep();
  t.is(store.getMeta().hubDelivery, '1', 'the held frame is not delivered');
  t.true(transport.write(frame('gc 1'), '2'), 'a resend of it is accepted');
  t.is(store.journalLength(), 2, 'and dropped as a duplicate');
  transport.write(frame('use 9'), '3');
  await settle();
  await transport.sleep();
  t.is(store.getMeta().hubDelivery, '3');
});

// ---- the daemon's startup sweep

const makeNetlayer = () => ({
  location: {
    type: 'ocapn-peer',
    transport: 'test',
    designator: 'gc-cranks',
    hints: false,
  },
  shutdown() {},
});

test.serial(
  'startup does not wake a worker for held GC frames alone',
  async t => {
    t.timeout(10_000);
    const store = makeMemoryStore();
    const gcOnly = 'a'.repeat(32);
    const gcThenFrame = 'b'.repeat(32);
    const gc = gcFrameBytes(syrupCodec, 'op:gc-exports');
    const gcB64 = Buffer.from(gc).toString('base64');
    for (const id of [gcOnly, gcThenFrame]) {
      const worker = store.provideWorkerStore(id);
      worker.setMeta({ snapshot: { ref: id, cut: 0 } });
      worker.appendJournal({ b64: gcB64, hubSequence: '1', gc: true });
      worker.appendJournal({ b64: gcB64, hubSequence: '2', gc: true });
    }
    store
      .provideWorkerStore(gcThenFrame)
      .appendJournal({ b64: 'AQID', hubSequence: '3' });
    /** @type {unknown[]} */
    const started = [];
    /** @type {unknown[]} */
    const batches = [];
    /** @type {WorkerEngine} */
    const engine = {
      canSnapshot: true,
      start: async ({ snapshot }) => {
        started.push(snapshot);
        return {
          deliver: async () => {},
          deliverBatch: async messages => {
            batches.push(messages.length);
          },
          snapshot: async () => snapshot,
          terminate: async () => {},
        };
      },
    };
    const daemon = await makeThixotropeDaemon(nodePowers, {
      store,
      codec: syrupCodec,
      engine,
      makeNetlayer,
    });
    t.teardown(() => daemon.shutdown());
    t.deepEqual(started, [gcThenFrame], 'only the worker owed a crank');
    t.deepEqual(batches, [3], 'its GC frames went with the frame after them');
    t.false(daemon.getWorker(gcOnly).isAwake());
    t.like(daemon.getWorker(gcOnly).transportStats(), {
      heldFrames: 2,
      wakes: 0,
    });
    const row = /** @type {any} */ (daemon)
      .inspectWorkers()
      .find((/** @type {any} */ w) => w.workerId === gcOnly);
    t.like(
      row,
      { journalLength: 0, heldFrames: 2, snapshot: { cut: 0 } },
      'its delivery frontier is its snapshot: it reads as checkpointed',
    );
    t.like(daemon.getWorker(gcThenFrame).transportStats(), {
      heldFrames: 0,
      wakes: 1,
      cranks: 1,
    });
  },
);
