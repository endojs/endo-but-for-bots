// @ts-check

import '@endo/lockdown/commit-debug.js';

import test from 'ava';

import { HandledPromise, E } from './_get-hp.js';
import {
  makeSubscribableKit,
  registerExternalPassStylePromise,
  resolveExternalPassStylePromise,
  rejectExternalPassStylePromise,
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

test('subscribe delivers each of the four target shapes verbatim', async t => {
  // Test Plan item 8 from designs/pass-style-promise.md: the four target
  // cases (final Passable, native Promise, HandledPromise, another
  // pass-style promise) must each be delivered verbatim to the
  // subscriber, distinguishable by passStyleOf + isPromise checks. We
  // exercise `HandledPromise.subscribe` directly (NOT `settle`, which
  // walks the chain) so each carrier's recorded target identity is
  // observable.
  // Case 1: final Passable.
  {
    const { promise, settle } = makeSubscribableKit();
    const target = harden({ kind: 'passable' });
    /** @type {any} */
    let observed;
    HandledPromise.subscribe(promise, t1 => {
      observed = t1;
    });
    settle(target);
    await Promise.resolve();
    await Promise.resolve();
    t.is(observed, target, 'final passable delivered verbatim');
  }
  // Case 2: native Promise.
  {
    const { promise, settle } = makeSubscribableKit();
    const nativeP = Promise.resolve('inside-native');
    /** @type {any} */
    let observed;
    HandledPromise.subscribe(promise, t1 => {
      observed = t1;
    });
    settle(nativeP);
    await Promise.resolve();
    await Promise.resolve();
    t.is(observed, nativeP, 'native Promise delivered verbatim (not unwrapped)');
  }
  // Case 3: HandledPromise.
  {
    const { promise, settle } = makeSubscribableKit();
    const hp = HandledPromise.resolve('inside-handled');
    /** @type {any} */
    let observed;
    HandledPromise.subscribe(promise, t1 => {
      observed = t1;
    });
    settle(hp);
    await Promise.resolve();
    await Promise.resolve();
    t.is(observed, hp, 'HandledPromise delivered verbatim (not unwrapped)');
  }
  // Case 4: another pass-style promise carrier.
  {
    const { promise: outer, settle: settleOuter } = makeSubscribableKit();
    const { promise: inner } = makeSubscribableKit();
    /** @type {any} */
    let observed;
    HandledPromise.subscribe(outer, t1 => {
      observed = t1;
    });
    settleOuter(inner);
    await Promise.resolve();
    await Promise.resolve();
    t.is(observed, inner, 'pass-style carrier delivered verbatim');
  }
});

test('reject without subscribers retains the rejection (intentional)', async t => {
  // Producer rejects with NO subscriber attached and NO downstream
  // promise-returning facade. The rejection MUST NOT trip an unhandled
  // rejection on the host (we cannot easily observe absence in-process,
  // but we DO assert the recorded rejection is delivered verbatim to a
  // subscriber attached after the fact).
  const { promise, reject } = makeSubscribableKit();
  reject(new Error('produced-but-unobserved'));
  // No microtask flush in between: late subscriber should still see it.
  await Promise.resolve();
  await Promise.resolve();
  /** @type {any} */
  let rejection;
  HandledPromise.subscribe(
    promise,
    () => t.fail('onFulfilled must not fire'),
    reason => {
      rejection = reason;
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  t.true(rejection instanceof Error);
  t.is(/** @type {Error} */ (rejection).message, 'produced-but-unobserved');
});

test('settle as facade: reject before settle still rejects the facade', async t => {
  // Demonstrates the intentional retention contract: the rejection is
  // delivered to the synchronous-handler facade attached after the fact.
  const { promise, reject } = makeSubscribableKit();
  reject(new Error('producer-side'));
  await t.throwsAsync(() => HandledPromise.settle(promise), {
    message: 'producer-side',
  });
});

test('isPassStylePromiseShape rejects extra own properties (strict shape)', t => {
  // Hostile shape: looks like a carrier but has a poisoned extra
  // property. Should NOT be classified as a pass-style carrier; must
  // not slip into the subscribe path. Without the strict-shape check,
  // this would auto-install a producer record (or now, fail with the
  // unregistered-carrier diagnostic). Either is wrong: this is not a
  // carrier at all, so HandledPromise.subscribe must treat it as an
  // unknown value and deliver it verbatim on the next turn.
  const hostile = harden(
    Object.defineProperties(
      {},
      {
        [Symbol.for('passStyle')]: { value: 'promise' },
        [Symbol.toStringTag]: { value: 'Promise' },
        poisoned: { value: 42, enumerable: true },
      },
    ),
  );
  /** @type {any} */
  let observed;
  HandledPromise.subscribe(hostile, target => {
    observed = target;
  });
  // No throw, no hang: delivered verbatim.
  return Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => {
      t.is(observed, hostile);
    });
});

test('subscribe to unregistered carrier fails with a diagnostic', t => {
  // Hostile / typo case: a carrier-shaped object that no one registered.
  // The prior auto-install behavior would silently install a producer
  // record and the subscriber would wait forever; now we fail loudly.
  const orphan = harden(
    Object.defineProperties(
      {},
      {
        [Symbol.for('passStyle')]: { value: 'promise' },
        [Symbol.toStringTag]: { value: 'Promise' },
      },
    ),
  );
  t.throws(
    () =>
      HandledPromise.subscribe(orphan, () => {
        t.fail('onFulfilled must not fire');
      }),
    { message: /unregistered pass-style promise carrier/ },
  );
});

test('resolveExternalPassStylePromise on unregistered carrier fails with a diagnostic', t => {
  const orphan = harden(
    Object.defineProperties(
      {},
      {
        [Symbol.for('passStyle')]: { value: 'promise' },
        [Symbol.toStringTag]: { value: 'Promise' },
      },
    ),
  );
  t.throws(() => resolveExternalPassStylePromise(orphan, 'value'), {
    message: /unregistered pass-style promise carrier/,
  });
});

test('rejectExternalPassStylePromise on unregistered carrier fails with a diagnostic', t => {
  const orphan = harden(
    Object.defineProperties(
      {},
      {
        [Symbol.for('passStyle')]: { value: 'promise' },
        [Symbol.toStringTag]: { value: 'Promise' },
      },
    ),
  );
  t.throws(() => rejectExternalPassStylePromise(orphan, new Error('x')), {
    message: /unregistered pass-style promise carrier/,
  });
});

test('registerExternalPassStylePromise enables subscribe + external settle', async t => {
  // Externally-minted carrier (mimics CapTP's `makePromise()` flow).
  const carrier = harden(
    Object.defineProperties(
      {},
      {
        [Symbol.for('passStyle')]: { value: 'promise' },
        [Symbol.toStringTag]: { value: 'Promise' },
      },
    ),
  );
  registerExternalPassStylePromise(carrier);
  // Idempotent: a second call is a no-op.
  registerExternalPassStylePromise(carrier);
  /** @type {any} */
  let observed;
  HandledPromise.subscribe(carrier, target => {
    observed = target;
  });
  resolveExternalPassStylePromise(carrier, 'driven-from-host');
  await Promise.resolve();
  await Promise.resolve();
  t.is(observed, 'driven-from-host');
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
