// @ts-check
/**
 * The hub's batched commits (core candidate C-20 of the harness journal): a
 * disposable observer's frames delivered in one turn are handled as one
 * batch with one commit, a batching durable receiver gets a whole flush in
 * one call, and the cost counters see both. Crash consistency is in
 * `hub-crash-consistency.test.js`.
 */
import test from '@endo/ses-ava/test.js';

import { syrupCodec } from '@endo/ocapn/syrup';

import { makeOcapnHub } from '../src/net/hub.js';

const ORIGIN = 'origin';
const OBSERVER = 'transient:observer';
const N = 12;

/** @param {number} position */
const release = position => {
  const w = syrupCodec.makeWriter();
  w.enterRecord();
  w.writeSelectorFromString('op:gc-exports');
  w.enterList();
  w.writeInteger(BigInt(position));
  w.exitList();
  w.enterList();
  w.writeInteger(1n);
  w.exitList();
  w.exitRecord();
  return w.getBytes();
};

const setup = ({
  sendBatchResult = /** @type {number | undefined} */ (undefined),
} = {}) => {
  /** @type {Record<string, any>} */
  const refs = {};
  /** @type {Record<string, string>} */
  const held = {};
  for (let i = 1; i <= N; i += 1) {
    refs[`r${i}`] = {
      origin: ORIGIN,
      position: String(i),
      backing: 'export',
      flavor: 'object',
      mentionsIn: 1,
      refcounts: { [OBSERVER]: 1 },
      listeners: [],
    };
    held[String(i)] = `r${i}`;
  }
  /** @type {any} */
  let state = {
    version: 2,
    refs,
    publications: {},
    sessions: {
      [ORIGIN]: { durable: true },
      [OBSERVER]: { ourExports: held },
    },
  };
  let commits = 0;
  let tick = 0;
  const hub = makeOcapnHub({
    codec: syrupCodec,
    now: () => (tick += 1),
    store: {
      getState: () => state,
      setState: next => {
        commits += 1;
        state = JSON.parse(JSON.stringify(next));
      },
    },
  });
  /** @type {Array<Array<{ bytes: Uint8Array, sequence: string }>>} */
  const batches = [];
  hub.attachSession(ORIGIN, {
    send: () => {
      throw Error('a batching receiver gets every flush as a batch');
    },
    sendBatch: frames => {
      batches.push(frames);
      return sendBatchResult ?? frames.length;
    },
    durable: true,
    requireAcceptance: true,
    deferCleanup: true,
  });
  const sink = hub.attachSession(OBSERVER, {
    send: () => true,
    discardOnRestart: true,
    coalesceInbound: true,
    onAbort: () => {},
  });
  return {
    hub,
    sink,
    batches,
    commits: () => commits,
    state: () => state,
  };
};

const turn = () => new Promise(resolve => setImmediate(resolve));

test('frames an observer delivers in one turn commit once and flush as one batch', async t => {
  const { hub, sink, batches, commits, state } = setup();
  const before = commits();
  for (let i = 1; i <= N; i += 1) sink.deliver(release(i));
  t.is(commits(), before, 'nothing is handled before the turn ends');
  t.is(Object.keys(state().refs).length, N);
  await turn();
  t.is(commits(), before + 1, 'one commit for the whole burst');
  t.deepEqual(Object.keys(state().refs), [], 'every row released');
  t.is(batches.length, 1, 'one send call toward the origin');
  t.is(batches[0].length, N, 'with one release per frame');
  t.deepEqual(
    batches[0].map(f => f.sequence),
    Array.from({ length: N }, (_, i) => String(i + 1)),
    'each with its own stable sequence',
  );
  const { gcOnly } = hub.stats();
  t.like(gcOnly, { deliveries: 1, frames: N, persists: 1, sends: 1 });
  t.true(gcOnly.ms > 0, 'timed with the injected clock');
});

test('forgetting an observer handles what it delivered first', t => {
  const { hub, sink, batches, state } = setup();
  sink.deliver(release(1));
  sink.deliver(release(2));
  hub.forgetSession(OBSERVER);
  // Released by its frames (each position once) and by its retirement (the
  // rest), all before the session is gone.
  const released = batches.flat().length;
  t.true(released >= 1);
  t.deepEqual(Object.keys(state().refs), []);
  t.false(OBSERVER in state().sessions);
});

test('a batching receiver that owns only a prefix keeps the rest queued', async t => {
  const { sink, batches, state } = setup({ sendBatchResult: 0 });
  for (let i = 1; i <= 3; i += 1) sink.deliver(release(i));
  await turn();
  t.is(batches.length, 1);
  t.is(state().sessions[ORIGIN].queue.length, 3, 'nothing owned, all kept');
  t.deepEqual(
    state().sessions[ORIGIN].queueSequences,
    ['1', '2', '3'],
    'with the sequences committed before the send',
  );
});

test('coalescing is only for disposable observers, batching only with deferred cleanup', t => {
  const hub = makeOcapnHub({ codec: syrupCodec });
  t.throws(() =>
    hub.attachSession('s', { send: () => true, coalesceInbound: true }),
  );
  t.throws(() =>
    hub.attachSession('d', {
      send: () => true,
      sendBatch: () => 0,
      durable: true,
    }),
  );
});
