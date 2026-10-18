// @ts-check
import test from '@endo/ses-ava/test.js';
import { syrupCodec } from '@endo/ocapn/syrup';

import { makeOcapnHub } from '../src/net/hub.js';

for (const failCommit of [false, true]) {
  test(`GC lists stay batched through durable replay (commit failure: ${failCommit})`, t => {
    const positions = Array.from({ length: 130 }, (_, i) => BigInt(i + 1));
    /** @type {any} */
    let state = {
      version: 2,
      refs: Object.fromEntries(
        positions.map(n => [
          `r${n}`,
          {
            origin: 'origin',
            position: String(n),
            backing: 'answer',
            flavor: 'promise',
            mentionsIn: 0,
            refcounts: {},
            listeners: [],
          },
        ]),
      ),
      publications: {},
      sessions: {
        origin: { durable: true },
        source: {
          durable: true,
          answersOwed: Object.fromEntries(
            positions.map(n => [String(n), { ref: `r${n}` }]),
          ),
        },
      },
    };
    let inject = false;
    const store = {
      getState: () => state,
      setState: next => {
        if (inject) {
          inject = false;
          throw Error('before commit');
        }
        state = JSON.parse(JSON.stringify(next));
      },
    };
    const hub = makeOcapnHub({ codec: syrupCodec, store });
    const ingress = hub.attachSession('source', {
      durable: true,
      send: () => true,
    });
    const writer = syrupCodec.makeWriter();
    writer.enterRecord();
    writer.writeSelectorFromString('op:gc-answers');
    writer.enterList();
    positions.forEach(n => writer.writeInteger(n));
    writer.exitList();
    writer.exitRecord();
    const bytes = writer.getBytes();
    if (failCommit) {
      inject = true;
      t.throws(() => ingress.deliver(bytes, 1n), { message: 'before commit' });
      t.is(Object.keys(state.refs).length, 130);
      t.deepEqual(state.sessions.origin.queue, []);
    }
    ingress.deliver(bytes, 1n);
    t.is(state.sessions.source.processedUpTo, '1');
    t.is(Object.keys(state.refs).length, 0);
    t.is(
      state.sessions.origin.queue.length,
      3,
      '64 + 64 + 2, not 130 singleton frames',
    );
    const committed = state.sessions.origin.queue.slice();
    ingress.deliver(bytes, 1n);
    t.deepEqual(
      state.sessions.origin.queue,
      committed,
      'source replay does not duplicate decrements',
    );
    const accepted = [];
    makeOcapnHub({ codec: syrupCodec, store }).attachSession('origin', {
      durable: true,
      requireAcceptance: true,
      send: (frame, sequence) => {
        t.is(
          state.sessions.source.processedUpTo,
          '1',
          'source identity precedes wire',
        );
        t.is(state.sessions.origin.queueSequences[0], sequence);
        const reader = syrupCodec.makeReader(frame);
        reader.enterRecord();
        t.is(reader.readRecordLabel().value, 'op:gc-answers');
        reader.enterList();
        while (!reader.peekListEnd()) accepted.push(reader.readInteger());
        reader.exitList();
        reader.exitRecord();
        return true;
      },
    });
    t.deepEqual(accepted, positions);
    t.deepEqual(state.sessions.origin.queue, []);
  });
}
