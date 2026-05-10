// @ts-check

import '@endo/lockdown/commit-debug.js';

import test from 'ava';

import { HandledPromise, E } from './_get-hp.js';
import {
  makeSubscribableKit,
  resolveExternalPassStylePromise,
} from '../src/pass-style-promise.js';

test('makeSubscribableKit: returns a non-thenable promise carrier', t => {
  const { promise } = makeSubscribableKit();
  t.is(typeof promise, 'object');
  t.true(Object.isFrozen(promise));
  t.is(/** @type {any} */ (promise).then, undefined);
  t.false(promise instanceof Promise);
});

test('HandledPromise.subscribe fires once on settle (single subscriber)', async t => {
  const { promise, settle } = makeSubscribableKit();
  let called = 0;
  /** @type {any} */
  let observed;
  HandledPromise.subscribe(promise, target => {
    called += 1;
    observed = target;
  });
  settle('hello');
  // The subscriber fires on a future turn.
  await Promise.resolve();
  await Promise.resolve();
  t.is(called, 1);
  t.is(observed, 'hello');
  // A second settle is silently ignored (fire-once invariant).
  settle('again');
  await Promise.resolve();
  await Promise.resolve();
  t.is(called, 1, 'subscriber not re-fired');
});

test('HandledPromise.subscribe with multiple subscribers', async t => {
  const { promise, settle } = makeSubscribableKit();
  /** @type {string[]} */
  const log = [];
  HandledPromise.subscribe(promise, t1 => log.push(`a:${t1}`));
  HandledPromise.subscribe(promise, t2 => log.push(`b:${t2}`));
  HandledPromise.subscribe(promise, t3 => log.push(`c:${t3}`));
  settle(7);
  await Promise.resolve();
  await Promise.resolve();
  t.deepEqual(log, ['a:7', 'b:7', 'c:7']);
});

test('HandledPromise.subscribe after settle still fires', async t => {
  const { promise, settle } = makeSubscribableKit();
  settle('after');
  // Subscriber added AFTER the producer settled.
  /** @type {any} */
  let observed;
  HandledPromise.subscribe(promise, target => {
    observed = target;
  });
  await Promise.resolve();
  await Promise.resolve();
  t.is(observed, 'after');
});

test('HandledPromise.subscribe rejection path', async t => {
  const { promise, reject } = makeSubscribableKit();
  /** @type {any} */
  let rejection;
  HandledPromise.subscribe(
    promise,
    () => t.fail('onFulfilled must not fire'),
    reason => {
      rejection = reason;
    },
  );
  reject(new Error('nope'));
  await Promise.resolve();
  await Promise.resolve();
  t.true(rejection instanceof Error);
  t.is(/** @type {Error} */ (rejection).message, 'nope');
});

test('HandledPromise.subscribe on a native Promise delegates to .then', async t => {
  /** @type {any} */
  let observed;
  HandledPromise.subscribe(Promise.resolve('native'), target => {
    observed = target;
  });
  await Promise.resolve();
  await Promise.resolve();
  t.is(observed, 'native');
});

test('HandledPromise.subscribe on a non-promise delivers verbatim', async t => {
  /** @type {any} */
  let observed;
  HandledPromise.subscribe(42, target => {
    observed = target;
  });
  await Promise.resolve();
  await Promise.resolve();
  t.is(observed, 42);
});

test('HandledPromise.settle: pass-style carrier resolves to ground value', async t => {
  const { promise, settle } = makeSubscribableKit();
  settle('ground');
  const observed = await HandledPromise.settle(promise);
  t.is(observed, 'ground');
});

test('HandledPromise.settle: native Promise pass-through', async t => {
  const observed = await HandledPromise.settle(Promise.resolve('native'));
  t.is(observed, 'native');
});

test('HandledPromise.settle: non-promise pass-through', async t => {
  t.is(await HandledPromise.settle(99), 99);
  t.is(await HandledPromise.settle('hello'), 'hello');
  t.is(await HandledPromise.settle(undefined), undefined);
});

test('HandledPromise.settle walks chain: pass-style → pass-style → ground', async t => {
  const a = makeSubscribableKit();
  const b = makeSubscribableKit();
  // a settles to b.promise; b.promise then settles to 'ground'.
  a.settle(b.promise);
  b.settle('ground');
  const observed = await HandledPromise.settle(a.promise);
  t.is(observed, 'ground');
});

test('HandledPromise.settle walks chain: pass-style → native Promise → ground', async t => {
  const { promise, settle } = makeSubscribableKit();
  settle(Promise.resolve('via-native'));
  const observed = await HandledPromise.settle(promise);
  t.is(observed, 'via-native');
});

test('HandledPromise.settle walks chain: native → pass-style → ground', async t => {
  const { promise, settle } = makeSubscribableKit();
  settle('via-passStyle');
  const observed = await HandledPromise.settle(Promise.resolve(promise));
  t.is(observed, 'via-passStyle');
});

test('HandledPromise.settle propagates rejection from the chain', async t => {
  const a = makeSubscribableKit();
  const b = makeSubscribableKit();
  a.settle(b.promise);
  b.reject(new Error('bottom'));
  await t.throwsAsync(() => HandledPromise.settle(a.promise), {
    message: 'bottom',
  });
});

test('E.when re-implemented in terms of settle: pass-style carrier', async t => {
  const { promise, settle } = makeSubscribableKit();
  /** @type {any} */
  let observed;
  const whenP = E.when(promise, target => {
    observed = target;
    return target;
  });
  settle('through-when');
  const result = await whenP;
  t.is(observed, 'through-when');
  t.is(result, 'through-when');
});

test('E.when on a non-promise', async t => {
  t.is(await E.when(123, x => x * 2), 246);
});

test('E.when on a native Promise', async t => {
  t.is(await E.when(Promise.resolve('hi'), x => `${x}!`), 'hi!');
});

test('await passStylePromise resolves to the carrier (no thenable)', async t => {
  const { promise } = makeSubscribableKit();
  const observed = await promise;
  t.is(observed, promise);
});

test('resolveExternalPassStylePromise: bridges external producers', async t => {
  // Simulates a host (CapTP, liveSlots) that mints a carrier outside
  // makeSubscribableKit and drives settlement through the external
  // resolution channel.
  const { promise } = makeSubscribableKit();
  /** @type {any} */
  let observed;
  HandledPromise.subscribe(promise, target => {
    observed = target;
  });
  resolveExternalPassStylePromise(promise, 'external');
  await Promise.resolve();
  await Promise.resolve();
  // The kit's settle was never called, but the external resolver
  // notified subscribers. (Note: the kit's settle still works
  // independently because both look up the same producer record.)
  t.is(observed, 'external');
});

test('Promise.all on pass-style promise treats it as a value', async t => {
  // Documents the design's Open Question 6 behavior: Promise.all uses
  // the host's promise-resolution algorithm, which only synchronizes
  // on thenables. A pass-style carrier is non-thenable, so it appears
  // verbatim in the result array.
  const { promise } = makeSubscribableKit();
  const result = await Promise.all([promise, 1, 2]);
  t.is(result[0], promise, 'carrier is its own value, not its target');
  t.is(result[1], 1);
  t.is(result[2], 2);
});

test('E(passStylePromise).method() dispatches after settle', async t => {
  // E(x).method() goes through HandledPromise.applyMethod, which calls
  // staticMethods.resolve(x). Resolve recognizes pass-style carriers and
  // routes through HandledPromise.settle to walk to the eventual target.
  // The returned promise then dispatches the method against the target.
  const target = harden({
    greet: name => `hello, ${name}`,
  });
  const { promise, settle } = makeSubscribableKit();
  const callP = E(promise).greet('world');
  // Settle the carrier to the actual target.
  settle(target);
  t.is(await callP, 'hello, world');
});

test('E(passStylePromise) dispatch on chained pass-style carrier', async t => {
  const target = harden({
    add: (a, b) => a + b,
  });
  const a = makeSubscribableKit();
  const b = makeSubscribableKit();
  const callP = E(a.promise).add(2, 3);
  a.settle(b.promise);
  b.settle(target);
  t.is(await callP, 5);
});

test('subscribe error inside callback does not corrupt other subscribers', async t => {
  const { promise, settle } = makeSubscribableKit();
  /** @type {any} */
  let observedB;
  HandledPromise.subscribe(promise, () => {
    throw new Error('boom from a');
  });
  HandledPromise.subscribe(promise, target => {
    observedB = target;
  });
  settle('ok');
  // Both subscribers run; subscriber a's exception is reported via the
  // host's unhandled-rejection path (we cannot directly observe it from
  // the test, but the second subscriber must still fire).
  await Promise.resolve();
  await Promise.resolve();
  t.is(observedB, 'ok');
});
