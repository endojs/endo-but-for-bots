// @ts-check
import test from '@endo/ses-ava/test.js';
import { syrupCodec } from '@endo/ocapn/syrup';

import { E } from '@endo/far';
import { frozenBytes } from '@endo/immutable-arraybuffer';

import { makeOcapnHub } from '../src/net/hub.js';
import { makePipeNetwork } from '../src/net/pipe-network.js';
import { makeWorkerPeer } from '../src/core/worker-peer.js';
import { makeHubLogStore } from '../src/store/hub-log-store.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { makeMemorySyncFiles } from './_memory-sync-files.js';
import { makeTestOcapn } from './_util.js';

/** @param {any} [initial] */
const fixture = (initial = {}) => {
  let state = {
    version: 2,
    refs: {},
    publications: {},
    sessions: {
      worker: { durable: true, processedUpTo: '7' },
      'transient:observer': {
        queue: ['00', '01', '02', '03'],
        queueSequences: ['', '', '', ''],
      },
    },
    ...initial,
  };
  let commits = 0;
  let fail = false;
  const store = {
    getState: () => state,
    setState: next => {
      if (fail) {
        fail = false;
        throw Error('before wire');
      }
      state = JSON.parse(JSON.stringify(next));
      commits += 1;
    },
  };
  return {
    hub: makeOcapnHub({ codec: syrupCodec, store }),
    store,
    state: () => state,
    commits: () => commits,
    fail: () => {
      fail = true;
    },
  };
};

test('disposable progress stays in memory after committed output', t => {
  const f = fixture();
  const sent = [];
  const sink = f.hub.attachSession('transient:observer', {
    discardOnRestart: true,
    onAbort: () => t.fail('observer must remain live'),
    send: (bytes, sequence) => {
      t.is(f.commits(), 1, 'all output is committed before first wire');
      t.is(sequence, undefined, 'observer has no resumable delivery identity');
      sent.push(bytes[0]);
    },
  });
  t.deepEqual(sent, [0, 1, 2, 3]);
  t.is(f.commits(), 1, 'no commits just to advance or clear the outbox');
  // The restored frames were sent, and no commit ever holds observer frames.
  t.deepEqual(f.state().sessions['transient:observer'].queue, []);
  sink.flush();
  t.is(f.commits(), 2, 'an explicit flush persists progress');
  t.deepEqual(f.state().sessions['transient:observer'].queue, []);
});

for (const outcome of ['throw', 'closed']) {
  test(`ambiguous disposable delivery closes once (${outcome})`, t => {
    const f = fixture();
    const sent = [];
    let aborted = 0;
    f.hub.attachSession('transient:observer', {
      discardOnRestart: true,
      onAbort: () => {
        aborted += 1;
        f.hub.forgetSession('transient:observer');
      },
      send: bytes => {
        sent.push(bytes[0]);
        if (bytes[0] === 1) {
          if (outcome === 'throw') throw Error('after observation');
          return false;
        }
        return true;
      },
    });
    t.is(aborted, 1);
    t.deepEqual(sent, [0, 1], 'never retry an ambiguous prefix');
    t.false('transient:observer' in f.state().sessions);
    t.is(f.state().sessions.worker.processedUpTo, '7');
    const restored = makeOcapnHub({ codec: syrupCodec, store: f.store });
    restored.attachSession('transient:new', {
      discardOnRestart: true,
      onAbort: () => {},
      send: () => t.fail('new observer must not inherit old output'),
    });
  });
}

test('failed output commit exposes nothing to a disposable observer', t => {
  const f = fixture();
  f.fail();
  t.throws(
    () =>
      f.hub.attachSession('transient:observer', {
        discardOnRestart: true,
        onAbort: () => {},
        send: () => t.fail('no publication before commit'),
      }),
    { message: 'before wire' },
  );
  t.is(f.commits(), 0);
});

test('restart discards stale observer output without undoing durable work', t => {
  const f = fixture();
  f.hub.attachSession('transient:observer', {
    discardOnRestart: true,
    onAbort: () => {},
    send: () => {},
  });
  t.deepEqual(f.state().sessions['transient:observer'].queue, []);
  const restored = makeOcapnHub({ codec: syrupCodec, store: f.store });
  // The daemon sweeps old transient keys before resuming worker journals.
  restored.forgetSession('transient:observer');
  restored.attachSession('transient:new', {
    discardOnRestart: true,
    onAbort: () => {},
    send: () => t.fail('no replay into a new observer incarnation'),
  });
  t.is(f.state().sessions.worker.processedUpTo, '7');
  t.false('transient:observer' in f.state().sessions);
});

test('reentrant output commits its routing before publication', t => {
  const f = fixture({
    version: 2,
    publications: {},
    refs: {
      r1: {
        origin: 'transient:observer',
        position: '1',
        backing: 'answer',
        flavor: 'promise',
        mentionsIn: 0,
        refcounts: {},
        listeners: [],
      },
    },
    sessions: {
      worker: { durable: true, processedUpTo: '7' },
      source: { durable: true, answersOwed: { 1: { ref: 'r1' } } },
      'transient:observer': { queue: ['00', '01'], queueSequences: ['', ''] },
    },
  });
  const source = f.hub.attachSession('source', {
    durable: true,
    send: () => true,
  });
  const writer = syrupCodec.makeWriter();
  writer.enterRecord();
  writer.writeSelectorFromString('op:gc-answers');
  writer.enterList();
  writer.writeInteger(1n);
  writer.exitList();
  writer.exitRecord();
  let sends = 0;
  f.hub.attachSession('transient:observer', {
    discardOnRestart: true,
    onAbort: () => t.fail('unexpected abort'),
    send: () => {
      sends += 1;
      if (sends === 1) source.deliver(writer.getBytes(), 1n);
      if (sends === 3) {
        t.is(f.state().sessions.source.processedUpTo, '1');
        // The frame toward the observer is not part of that commit.
        t.deepEqual(f.state().sessions['transient:observer'].queue, []);
        t.deepEqual(Object.keys(f.state().refs), []);
      }
    },
  });
  t.is(sends, 3);
});

test('disposable policy cannot silently replace resumable delivery', t => {
  const f = fixture();
  const send = () => true;
  const onAbort = () => {};
  const expected = { message: /requires a unique transient session/ };
  t.throws(
    () =>
      f.hub.attachSession('peer:resumable', {
        send,
        onAbort,
        discardOnRestart: true,
      }),
    expected,
  );
  t.throws(
    () =>
      f.hub.attachSession('transient:durable', {
        send,
        onAbort,
        discardOnRestart: true,
        durable: true,
      }),
    expected,
  );
  t.throws(
    () =>
      f.hub.attachSession('transient:accepted', {
        send,
        onAbort,
        discardOnRestart: true,
        requireAcceptance: true,
      }),
    expected,
  );
  t.throws(
    () =>
      f.hub.attachSession('transient:unmanaged', {
        send,
        discardOnRestart: true,
      }),
    expected,
  );
  t.is(f.commits(), 0);
});

for (const failure of ['hook', 'cleanup-once', 'cleanup-persistent']) {
  test(`observer close failure isolates other outboxes (${failure})`, t => {
    /** @type {any} */
    let state = {
      version: 2,
      publications: {},
      refs: {
        r1: {
          origin: 'transient:observer',
          position: '1',
          backing: 'answer',
          flavor: 'promise',
          mentionsIn: 0,
          refcounts: {},
          listeners: [],
        },
        r2: {
          origin: 'receiver',
          position: '2',
          backing: 'answer',
          flavor: 'promise',
          mentionsIn: 0,
          refcounts: {},
          listeners: [],
        },
      },
      sessions: {
        'transient:observer': {},
        receiver: { durable: true },
        source: {
          durable: true,
          answersOwed: { 1: { ref: 'r1' }, 2: { ref: 'r2' } },
        },
      },
    };
    let failCleanup = false;
    const errors = [];
    const hub = makeOcapnHub({
      codec: syrupCodec,
      logError: (...args) => errors.push(args),
      store: {
        getState: () => state,
        setState: next => {
          if (failCleanup && next.sessions['transient:observer']?.retired) {
            if (failure === 'cleanup-once') failCleanup = false;
            throw Error('cleanup persistence refused');
          }
          state = JSON.parse(JSON.stringify(next));
        },
      },
    });
    hub.attachSession('transient:observer', {
      discardOnRestart: true,
      send: () => {
        throw Error('observer delivery failed');
      },
      onAbort: () => {
        if (failure === 'hook') throw Error('close hook failed');
        failCleanup = true;
        hub.forgetSession('transient:observer');
      },
    });
    let received = 0;
    hub.attachSession('receiver', {
      durable: true,
      requireAcceptance: true,
      send: (_bytes, sequence) => {
        t.is(
          state.sessions.source.processedUpTo,
          '1',
          'source effects precede onward delivery',
        );
        t.is(state.sessions.receiver.queueSequences[0], sequence);
        received += 1;
        return true;
      },
    });
    const source = hub.attachSession('source', {
      durable: true,
      send: () => true,
    });
    const writer = syrupCodec.makeWriter();
    writer.enterRecord();
    writer.writeSelectorFromString('op:gc-answers');
    writer.enterList();
    writer.writeInteger(1n);
    writer.writeInteger(2n);
    writer.exitList();
    writer.exitRecord();
    const bytes = writer.getBytes();
    if (failure === 'cleanup-persistent') {
      t.throws(() => source.deliver(bytes, 1n), {
        message: 'cleanup persistence refused',
      });
      t.is(received, 0, 'storage refusal still prevents publication');
      t.is(
        state.sessions.receiver.queue.length,
        1,
        'committed responsibility remains queued',
      );
      failCleanup = false;
      source.deliver(bytes, 1n);
    } else {
      t.notThrows(() => source.deliver(bytes, 1n));
      t.is(
        received,
        1,
        'unrelated durable receiver progresses without another operation',
      );
    }
    t.is(received, 1);
    t.is(state.sessions.source.processedUpTo, '1');
    t.true(
      errors.some(args =>
        String(args[0]).includes('onAbort for transient:observer threw:'),
      ),
    );
    source.deliver(bytes, 1n);
    t.is(received, 1, 'duplicate source input does not repeat the decrement');
  });
}

test('frames toward a disposable observer never reach the hub log', async t => {
  const { syncFiles, files } = makeMemorySyncFiles();
  const logPaths = {
    imagePath: '/s/hub-image.json',
    logPath: '/s/hub-log.jsonl',
    legacyPath: '/s/hub.json',
  };
  const store = makeHubLogStore(syncFiles, logPaths);
  const hub = makeOcapnHub({ codec: syrupCodec, store });
  const workerId = 'a'.repeat(32);
  /** @type {any} */
  let workerSink;
  /** @type {Array<Uint8Array>} */
  const early = [];
  const worker = await makeWorkerPeer(makeNodePowers(), {
    workerId,
    debugLabel: 'teller',
    send: frame =>
      workerSink === undefined ? early.push(frame) : workerSink.deliver(frame),
  });
  t.teardown(() => worker.shutdown());
  workerSink = hub.attachSession(workerId, {
    send: (/** @type {Uint8Array} */ bytes) => worker.deliver(bytes),
    durable: true,
  });
  for (const frame of early.splice(0)) workerSink.deliver(frame);
  hub.publish('teller', { session: workerId, position: 0n });

  const key = 'transient:observer';
  /** @type {any} */
  let observerSink;
  const pipe = makePipeNetwork({
    codec: syrupCodec,
    workerId: key,
    role: 'worker',
    send: frame =>
      observerSink === undefined
        ? early.push(frame)
        : observerSink.deliver(frame),
  });
  const client = await makeTestOcapn({
    codec: syrupCodec,
    network: pipe.network,
    debugLabel: 'observer',
  });
  t.teardown(() => client.shutdown());
  const session = await client.provideSession(pipe.peerLocation);
  observerSink = hub.attachSession(key, {
    discardOnRestart: true,
    onAbort: () => t.fail('the observer must stay live'),
    send: (/** @type {Uint8Array} */ bytes) => pipe.deliver(bytes),
  });
  for (const frame of early.splice(0)) observerSink.deliver(frame);

  const bytesOf = (/** @type {string} */ text) =>
    frozenBytes(new TextEncoder().encode(text));
  const boot = await E(session.getBootstrap()).fetch(bytesOf('teller'));
  const shell = await E(boot).fetch(bytesOf('shell'));
  // Made in the vat, so only the answer toward the observer carries it.
  const secret = await E(shell).evaluate(
    "'observer-' + 'secret-'.repeat(8) + 'end'",
  );
  const marker = `observer-${'secret-'.repeat(8)}end`;
  t.is(secret, marker);

  const markerHex = Buffer.from(marker).toString('hex');
  t.true(files.size > 0);
  for (const [path, text] of files) {
    t.false(text.includes(markerHex), `${path} holds no observer frame`);
    t.false(text.includes(marker), `${path} holds no observer text`);
  }

  // A restart restores the observer with nothing queued; the daemon then
  // forgets it, and the worker's tables are as they were.
  const before = store.getState().sessions;
  t.deepEqual(before[key].queue, []);
  const restored = makeOcapnHub({
    codec: syrupCodec,
    store: makeHubLogStore(syncFiles, logPaths),
  });
  restored.forgetSession(key);
  const after = makeHubLogStore(syncFiles, logPaths).getState().sessions;
  t.false(key in after);
  // Forgetting the observer releases what it held (a GC frame queues toward
  // the worker); the worker's own progress is untouched.
  t.is(after[workerId].processedUpTo, before[workerId].processedUpTo);
  t.is(after[workerId].epoch, before[workerId].epoch);
});
