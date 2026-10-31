// @ts-check
import test from '@endo/ses-ava/test.js';
import { syrupCodec } from '@endo/ocapn/syrup';

import { makeOcapnHub } from '../src/net/hub.js';

for (const kind of ['answers', 'exports']) {
  for (const failCommit of [false, true]) {
    test(`GC ${kind} stay batched through durable replay (commit failure: ${failCommit})`, t => {
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
              backing: kind === 'answers' ? 'answer' : 'export',
              flavor: kind === 'answers' ? 'promise' : 'object',
              mentionsIn: kind === 'exports' ? 5 : 0,
              refcounts: kind === 'exports' ? { source: 3 } : {},
              listeners: [],
            },
          ]),
        ),
        publications: {},
        sessions: {
          origin: { durable: true },
          source: {
            durable: true,
            answersOwed:
              kind === 'answers'
                ? Object.fromEntries(
                    positions.map(n => [String(n), { ref: `r${n}` }]),
                  )
                : {},
            ourExports:
              kind === 'exports'
                ? Object.fromEntries(positions.map(n => [String(n), `r${n}`]))
                : {},
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
      writer.writeSelectorFromString(`op:gc-${kind}`);
      writer.enterList();
      positions.forEach(n => writer.writeInteger(n));
      writer.exitList();
      if (kind === 'exports') {
        writer.enterList();
        positions.forEach(() => writer.writeInteger(3n));
        writer.exitList();
      }
      writer.exitRecord();
      const bytes = writer.getBytes();
      if (failCommit) {
        inject = true;
        t.throws(() => ingress.deliver(bytes, 1n), {
          message: 'before commit',
        });
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
          t.is(reader.readRecordLabel().value, `op:gc-${kind}`);
          reader.enterList();
          while (!reader.peekListEnd()) accepted.push(reader.readInteger());
          reader.exitList();
          if (kind === 'exports') {
            reader.enterList();
            while (!reader.peekListEnd())
              t.is(reader.readInteger(), 5n, 'exact original mention delta');
            reader.exitList();
          }
          reader.exitRecord();
          return true;
        },
      });
      t.deepEqual(accepted, positions);
      t.deepEqual(state.sessions.origin.queue, []);
    });
  }
}

for (const failCommit of [false, true]) {
  test(`completed crank commits once and replays partial prefix (failure: ${failCommit})`, t => {
    /** @type {any} */
    let state = {
      version: 2,
      publications: {},
      refs: Object.fromEntries(
        [1, 2, 3].map(n => [
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
      sessions: {
        origin: { durable: true },
        source: {
          durable: true,
          answersOwed: { 1: { ref: 'r1' }, 2: { ref: 'r2' }, 3: { ref: 'r3' } },
        },
      },
    };
    let commits = 0;
    let inject = false;
    const store = {
      getState: () => state,
      setState: next => {
        if (inject) {
          inject = false;
          throw Error('before crank commit');
        }
        state = JSON.parse(JSON.stringify(next));
        commits += 1;
      },
    };
    const hub = makeOcapnHub({ codec: syrupCodec, store });
    let source = hub.attachSession('source', {
      durable: true,
      send: () => true,
    });
    const frames = [1, 2, 3].map(n => {
      const writer = syrupCodec.makeWriter();
      writer.enterRecord();
      writer.writeSelectorFromString('op:gc-answers');
      writer.enterList();
      writer.writeInteger(BigInt(n));
      writer.exitList();
      writer.exitRecord();
      return { bytes: writer.getBytes(), sequenceNumber: n };
    });
    source.deliver(frames[0].bytes, 1);
    let before = commits;
    inject = failCommit;
    if (failCommit) {
      t.throws(() => source.deliverBatch(frames), {
        message: 'before crank commit',
      });
      t.is(state.sessions.source.processedUpTo, '1');
      t.is(state.sessions.origin.queue.length, 1);
      // Lose the failed attempt's RAM and regenerate only the missing suffix.
      source = makeOcapnHub({ codec: syrupCodec, store }).attachSession(
        'source',
        {
          durable: true,
          send: () => true,
        },
      );
      before = commits;
    }
    source.deliverBatch(frames);
    t.is(commits - before, 1);
    t.is(state.sessions.source.processedUpTo, '3');
    t.is(state.sessions.origin.queue.length, 3);
    t.deepEqual(Object.keys(state.refs), []);
    const restored = makeOcapnHub({ codec: syrupCodec, store });
    const replay = restored.attachSession('source', {
      durable: true,
      send: () => true,
    });
    replay.deliverBatch(frames);
    t.is(
      state.sessions.origin.queue.length,
      3,
      'no duplicate GC after restart',
    );
  });
}
