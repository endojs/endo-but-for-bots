// @ts-check

/**
 * A delivery that fails without a deterministic halt (the engine process
 * exits, is killed, or misses its request deadline) drops the incarnation,
 * and the next frame wakes a fresh one that replays the journal suffix. That
 * retry is right for a one-off crash. A frame that fails the same way on
 * every attempt made every later frame wake, replay up to it, and fail again,
 * with no end: a crash loop that runs for as long as frames keep arriving.
 * A bound on the attempts of one frame turns it into the same inspectable
 * failure a halt records.
 */
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { decodeBase64 } from '@endo/base64';

import { makeDurableWorkerTransport } from '../src/core/durable-worker-transport.js';
import { WorkerHaltError } from '../src/core/worker-engine.js';
import { makeMemoryStore } from '../src/store/store-memory.js';
import { makeNodePowers } from '../src/platform/node/powers.js';

const nodePowers = makeNodePowers();
const workerId = 'e'.repeat(32);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
/** @param {string} text */
const frame = text => textEncoder.encode(text);

/**
 * An engine whose incarnations fail the delivery of named frames, each a
 * given number of times (Infinity: on every attempt).
 *
 * @param {Record<string, number>} failures
 */
const makeFlakyEngine = failures => {
  const remaining = new Map(Object.entries(failures));
  const log = { starts: 0, failed: 0, delivered: /** @type {string[]} */ ([]) };
  const engine = harden({
    canSnapshot: false,
    start: async () => {
      log.starts += 1;
      return harden({
        /** @param {any} message */
        deliver: async message => {
          if (message.t !== 'f') return;
          const text = textDecoder.decode(decodeBase64(message.b64));
          const left = remaining.get(text) ?? 0;
          if (left > 0) {
            remaining.set(text, left - 1);
            log.failed += 1;
            throw Error('Ironhorse worker exited (signaled)');
          }
          log.delivered.push(text);
        },
        snapshot: async () => {
          throw Error('this engine does not snapshot');
        },
        terminate: async () => {},
      });
    },
  });
  return { engine, log };
};

/**
 * @param {any} engine
 * @param {number | undefined} maxDeliveryAttempts
 */
const makeKit = (engine, maxDeliveryAttempts) => {
  const store = makeMemoryStore().provideWorkerStore(workerId);
  const errors = /** @type {string[]} */ ([]);
  let fatal = 0;
  const transport = makeDurableWorkerTransport(
    {
      timers: nodePowers.timers,
      logging: {
        ...nodePowers.logging,
        error: (...args) => errors.push(args.map(String).join(' ')),
      },
    },
    {
      workerId,
      store,
      engine,
      maxDeliveryAttempts,
      onFrame: () => {},
      onFatal: () => {
        fatal += 1;
      },
    },
  );
  // Operations are serialized: a wake settles after those queued before it.
  const settle = () => transport.wake().catch(() => {});
  return { store, transport, settle, errors, fatal: () => fatal };
};

test('a frame that fails on every attempt quarantines the worker after a bounded number of attempts', async t => {
  const { engine, log } = makeFlakyEngine({ poison: Infinity });
  const { store, transport, settle, errors, fatal } = makeKit(engine, 3);
  t.true(transport.write(frame('a')));
  t.true(transport.write(frame('poison')));
  await settle();
  for (const text of ['b', 'c', 'd', 'e']) {
    transport.write(frame(text));
    // eslint-disable-next-line no-await-in-loop
    await settle();
  }
  t.is(log.failed, 3, 'the poisoned frame was attempted exactly three times');
  t.regex(
    String(store.getMeta().failure),
    /journal frame 1 failed 3 times without progress.*exited \(signaled\)/,
  );
  t.is(fatal(), 1, 'the logical session is retired once');
  t.true(errors.some(line => /quarantined/.test(line)));
  t.false(transport.write(frame('f')), 'a quarantined worker refuses frames');
  await t.throwsAsync(() => transport.wake(), { instanceOf: WorkerHaltError });
});

test('a crash that clears before the bound is replayed and forgotten', async t => {
  const { engine, log } = makeFlakyEngine({ poison: 2 });
  const { store, transport, settle, fatal } = makeKit(engine, 3);
  for (const text of ['a', 'poison']) transport.write(frame(text));
  await settle();
  t.is(log.failed, 2);
  for (const text of ['b', 'c']) transport.write(frame(text));
  await settle();
  t.is(store.getMeta().failure, undefined);
  t.is(fatal(), 0);
  t.deepEqual(log.delivered.slice(-3), ['poison', 'b', 'c']);
  t.true(transport.write(frame('d')), 'the worker still accepts frames');
});

test('attempts are counted per frame, and progress past a frame resets them', async t => {
  // Two failures of one frame, a replay past it, then two failures of a
  // later frame: four failures in all, but no frame reached the bound.
  const { engine, log } = makeFlakyEngine({ first: 2, second: 2 });
  const { store, transport, settle, fatal } = makeKit(engine, 3);
  transport.write(frame('first'));
  await settle();
  transport.write(frame('a'));
  await settle();
  transport.write(frame('second'));
  await settle();
  transport.write(frame('b'));
  await settle();
  t.is(log.failed, 4);
  t.is(store.getMeta().failure, undefined);
  t.is(fatal(), 0);
  t.deepEqual(log.delivered.slice(-4), ['first', 'a', 'second', 'b']);
});

test('without a bound, a frame that always fails is retried on every later frame', async t => {
  const { engine, log } = makeFlakyEngine({ poison: Infinity });
  const { store, transport, settle } = makeKit(engine, undefined);
  transport.write(frame('poison'));
  await settle();
  const before = log.failed;
  transport.write(frame('b'));
  await settle();
  t.true(log.failed > before, 'each later frame replays the poisoned one');
  t.is(store.getMeta().failure, undefined);
});
