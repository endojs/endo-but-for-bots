// @ts-check
import test from '@endo/ses-ava/test.js';
import { syrupCodec } from '@endo/ocapn/syrup';

import { makeOcapnHub } from '../src/net/hub.js';

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
  t.is(f.state().sessions['transient:observer'].queue.length, 4);
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
  t.is(f.state().sessions['transient:observer'].queue.length, 4);
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
        t.is(f.state().sessions['transient:observer'].queue.length, 1);
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
