// @ts-check
import { E } from '@endo/eventual-send';
import test from '@endo/ses-ava/test.js';
import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  listenerSource,
  producerSource,
} from '../../src/ironhorse/demo-promise-vats.js';
import { makeFixture, settled } from './_fixture.js';

// Every scenario owns a daemon and two Ironhorse processes. These are serial
// integration tests, not in-process substitutes or optional binary checks.
test.serial(
  'demo 1: a caller vat increments a counter in another vat',
  async t => {
    const f = await makeFixture(t);
    const caller = await f.guest();
    t.is(await E(caller).read(), 0n);
    t.is(await E(caller).incr(), 1n);
    t.is(await E(caller).read(), 1n);
    t.is(f.daemon.listWorkerIds().length, 2);
  },
);

test.serial(
  'demo 2: a persisted cross-vat promise listener settles after restart',
  async t => {
    t.timeout(120_000);
    const f = await makeFixture(t, {
      ownerSource: producerSource,
      guestSource: listenerSource,
      endowment: 'producer',
    });
    await E(await f.guest()).listen();
    await f.restart();
    const listener = await f.guest();
    t.deepEqual(await E(listener).read(), { settled: false });
    await E(listener).resolve('after restart');
    t.deepEqual(await settled(listener), {
      settled: true,
      value: 'after restart',
    });
  },
);

test.serial('counter wakes transparently after each worker sleeps', async t => {
  const f = await makeFixture(t);
  const caller = await f.guest();
  await E(caller).incr();
  await f.daemon.getWorker(f.ownerId).sleep();
  t.false(f.daemon.getWorker(f.ownerId).isAwake());
  t.is(await E(caller).incr(), 2n);
  await f.daemon.getWorker(f.guestId).sleep();
  t.false(f.daemon.getWorker(f.guestId).isAwake());
  t.is(await E(caller).incr(), 3n);
});

test.serial(
  'acknowledged mutations survive crash replay without duplication',
  async t => {
    t.timeout(120_000);
    const f = await makeFixture(t);
    let caller = await f.guest();
    await f.daemon.getWorker(f.ownerId).sleep();
    await f.daemon.getWorker(f.guestId).sleep();
    t.is(await E(caller).incr(), 1n);
    t.is(await E(caller).incr(), 2n);
    await f.restart(true);
    caller = await f.guest();
    t.is(await E(caller).read(), 2n);
    t.is(await E(caller).incr(), 3n);
  },
);

for (const phase of ['before delivery', 'after commit before outbound']) {
  test.serial(`a pending call recovers after failure ${phase}`, async t => {
    t.timeout(120_000);
    const f = await makeFixture(t);
    const caller = await f.guest();
    await f.daemon.getWorker(f.ownerId).sleep();
    const failed = f.armFault(
      /** @type {'before delivery' | 'after commit before outbound'} */ (phase),
    );
    const reply = E(caller).incr();
    await failed;
    t.deepEqual(f.injectedFaults, [phase]);
    await f.daemon.getWorker(f.ownerId).wake();
    t.is(await reply, 1n);
    t.is(await E(caller).read(), 1n);
  });
}

test.serial(
  'concurrent eventual sends preserve counter call order',
  async t => {
    const f = await makeFixture(t);
    const caller = await f.guest();
    const results = await Promise.all([
      E(caller).incr(),
      E(caller).incr(),
      E(caller).incr(),
    ]);
    t.deepEqual(results, [1n, 2n, 3n]);
  },
);

test.serial(
  'a guest-acquired capability remains callable after restart',
  async t => {
    const f = await makeFixture(t, {
      ownerSource: `Far('Factory', { make: () => { let n = 10n; return Far('Child', { incr: () => ++n }); } })`,
      guestSource: `(() => { let child; return Far('Holder', {
      acquire: async () => { child = await E(factory).make(); return 'acquired'; },
      incr: () => E(child).incr(),
    }); })()`,
      endowment: 'factory',
    });
    const holder = await f.guest();
    t.is(await E(holder).acquire(), 'acquired');
    t.is(await E(holder).incr(), 11n);
    await f.restart();
    t.is(await E(await f.guest()).incr(), 12n);
  },
);

test.serial(
  'a rejected promise reaches its persisted rejection listener',
  async t => {
    t.timeout(120_000);
    const f = await makeFixture(t, {
      ownerSource: `(() => { let reject; return Far('Producer', {
      makePromise: () => harden({ promise: new Promise((r, j) => { reject = j; }) }),
      reject: () => { reject(Error('expected rejection')); return 'rejected'; },
    }); })()`,
      guestSource: `(() => { let result = harden({ settled: false }); return Far('Listener', {
      listen: async () => { const { promise } = await E(producer).makePromise();
        promise.then(() => { result = harden({ settled: true, wrong: true }); },
          error => { result = harden({ settled: true, message: error.message }); }); return 'listening'; },
      reject: () => E(producer).reject(), read: () => result,
    }); })()`,
      endowment: 'producer',
    });
    await E(await f.guest()).listen();
    await f.restart();
    const listener = await f.guest();
    await E(listener).reject();
    t.deepEqual(await settled(listener), {
      settled: true,
      message: 'expected rejection',
    });
  },
);

test.serial(
  'two listeners on one promise both survive and run in registration order',
  async t => {
    t.timeout(120_000);
    const f = await makeFixture(t, {
      ownerSource: producerSource,
      endowment: 'producer',
      guestSource: `(() => { const seen = []; return Far('Listeners', {
      listen: async () => { const { promise } = await E(producer).makePromise();
        promise.then(v => seen.push('first:' + v)); promise.then(v => seen.push('second:' + v)); return 'listening'; },
      resolve: value => E(producer).resolve(value),
      read: () => harden({ settled: seen.length === 2, seen: [...seen] }),
    }); })()`,
    });
    await E(await f.guest()).listen();
    await f.restart();
    const listener = await f.guest();
    await E(listener).resolve('value');
    t.deepEqual(await settled(listener), {
      settled: true,
      seen: ['first:value', 'second:value'],
    });
  },
);

test.serial(
  'async locals and finally survive two separate await checkpoints',
  async t => {
    t.timeout(120_000);
    const f = await makeFixture(t, {
      ownerSource: `(() => { let first, second; return Far('Producer', {
      makePromises: () => harden({ a: new Promise(r => { first = r; }), b: new Promise(r => { second = r; }) }),
      first: () => { first(7n); return 'first'; }, second: () => { second(9n); return 'second'; },
    }); })()`,
      guestSource: `(() => { let stage = 0; let total = 0n; let final = false; return Far('Listener', {
      listen: async () => { const { a, b } = await E(producer).makePromises();
        (async () => { let sum = 5n; try { sum += await a; stage = 1; sum += await b; total = sum; }
          finally { final = true; stage = 2; } })(); return 'listening'; },
      first: () => E(producer).first(), second: () => E(producer).second(),
      read: () => harden({ stage, total, final, settled: stage === 2 }),
    }); })()`,
      endowment: 'producer',
    });
    await E(await f.guest()).listen();
    await f.restart();
    let listener = await f.guest();
    await E(listener).first();
    for (let i = 0; i < 100; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      if ((await E(listener).read()).stage === 1) break;
    }
    t.deepEqual(await E(listener).read(), {
      stage: 1,
      total: 0n,
      final: false,
      settled: false,
    });
    await f.restart();
    listener = await f.guest();
    await E(listener).second();
    t.deepEqual(await settled(listener), {
      stage: 2,
      total: 21n,
      final: true,
      settled: true,
    });
  },
);

test.serial('SES confinement remains intact across SQLite restore', async t => {
  const f = await makeFixture(t);
  const source = `[
    typeof process, typeof require, typeof thixotropeDispatch, typeof thixotropeTakeOutbound,
    Object.isFrozen(Object.prototype), Object.isFrozen(Function.prototype),
    Object.isFrozen(Array.prototype),
    (() => { const d = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
      return [typeof d.value, d.writable, d.configurable, typeof d.get]; })(),
    Array.from(new Uint8Array([1, 2, 3])),
    (() => { try { ({}).constructor.constructor('return globalThis')(); return false; } catch (_) { return true; } })()
  ]`;
  const expected = [
    'undefined',
    'undefined',
    'undefined',
    'undefined',
    true,
    true,
    true,
    ['function', false, false, 'undefined'],
    [1, 2, 3],
    true,
  ];
  t.deepEqual(await f.daemon.getWorker(f.guestId).evaluate(source), expected);
  await f.restart();
  t.deepEqual(await f.daemon.getWorker(f.guestId).evaluate(source), expected);
});

test.serial(
  'a metered-out vat stays quarantined while its sibling serves calls',
  async t => {
    t.timeout(120_000);
    const f = await makeFixture(t);
    const burner = /** @type {any} */ (
      await f.daemon
        .getWorker(f.guestId)
        .evaluate(`Far('Burner', { spin: () => { while (true) {} } })`)
    );
    await f.daemon.getWorker(f.guestId).sleep();
    const snapshot = f.store.provideWorkerStore(f.guestId).getMeta().snapshot;
    await t.throwsAsync(() => E(burner).spin(), { message: /retired/ });
    t.deepEqual(
      f.store.provideWorkerStore(f.guestId).getMeta().snapshot,
      snapshot,
    );
    t.regex(
      f.store.provideWorkerStore(f.guestId).getMeta().failure ?? '',
      /MeterAbort/,
    );
    t.is(await f.daemon.getWorker(f.ownerId).evaluate('6 * 7'), 42);
    await f.restart(true);
    await t.throwsAsync(() => f.daemon.getWorker(f.guestId).wake(), {
      message: /MeterAbort/,
    });
    t.is(await f.daemon.getWorker(f.ownerId).evaluate('40 + 2'), 42);
  },
);

test.serial(
  'completed-crank garbage is reclaimed across snapshot recovery',
  async t => {
    t.timeout(120_000);
    const f = await makeFixture(t, {
      ownerSource: `(() => {
        const retained = { count: 0 };
        const aliases = [retained, retained];
        return Far('AllocationChurn', {
          churn: () => {
            const temporary = [];
            for (let i = 0; i < 20000; i += 1) {
              temporary.push({ index: i, owner: retained, label: 'temporary' });
            }
            if (temporary[19999].owner !== retained) throw Error('lost owner');
            retained.count += 1;
            return retained.count;
          },
          read: () => harden({
            count: retained.count,
            same: aliases[0] === retained && aliases[1] === retained,
          }),
        });
      })()`,
      guestSource: `Far('ChurnCaller', {
        churn: () => E(counter).churn(),
        read: () => E(counter).read(),
      })`,
    });
    // Each crank fits comfortably in the heap, but their discarded objects
    // together exceed the default slot ceiling without between-crank GC.
    // Retained identity and state must survive both collection and restore.
    for (let phase = 0; phase < 2; phase += 1) {
      // eslint-disable-next-line no-await-in-loop
      const caller = await f.guest();
      for (let round = 0; round < 6; round += 1) {
        // eslint-disable-next-line no-await-in-loop
        t.is(await E(caller).churn(), phase * 6 + round + 1);
      }
      // eslint-disable-next-line no-await-in-loop
      await f.restart();
      // eslint-disable-next-line no-await-in-loop
      t.deepEqual(await E(await f.guest()).read(), {
        count: (phase + 1) * 6,
        same: true,
      });
    }
  },
);

test.serial(
  'a corrupted sleep image is refused without leaking an incarnation',
  async t => {
    t.timeout(120_000);
    const f = await makeFixture(t);
    let imagePath = '';
    /** @type {Uint8Array} */
    let original = new Uint8Array();
    await t.throwsAsync(
      async () => {
        await f.restart(false, async () => {
          const ref = f.store.provideWorkerStore(f.ownerId).getMeta()
            .snapshot?.ref;
          t.is(typeof ref, 'string');
          imagePath = join(f.statePath, 'heaps', 'snapshots', `${ref}.sqlite`);
          original = await readFile(imagePath);
          await appendFile(imagePath, 'corrupt');
        });
        // Startup wakes workers with a journal suffix. A fully checkpointed
        // owner stays asleep, so explicitly request its image in that case.
        await f.daemon.getWorker(f.ownerId).wake();
      },
      { message: /digest mismatch/ },
    );
    // Stop any healthy workers that startup resumed. A failed image load
    // must not leave an untracked incarnation behind after daemon cleanup.
    await f.daemon.crash();
    t.deepEqual(await readdir(join(f.statePath, 'heaps', 'incarnations')), []);
    // Loading refuses an unusable recovery image and cleanup releases ownership.
    // Restoring the immutable image permits a fresh startup to recover work.
    await writeFile(imagePath, original);
    await f.restart(true);
    t.is(await f.daemon.getWorker(f.ownerId).evaluate('40 + 2'), 42);
    t.is(await f.daemon.getWorker(f.guestId).evaluate('6 * 7'), 42);
  },
);
