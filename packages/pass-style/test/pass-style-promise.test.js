// @ts-check

import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import hardenIsNoop from '@endo/harden/is-noop.js';
import { isPromise } from '@endo/promise-kit';

import { passStyleOf } from '../src/passStyleOf.js';
import { isPassStylePromise, makePromise } from '../src/promise.js';
import { PASS_STYLE } from '../src/passStyle-helpers.js';

const { defineProperties, getPrototypeOf } = Object;
const { ownKeys } = Reflect;
const { toStringTag } = Symbol;

test('makePromise: passStyleOf is "promise"', t => {
  const p = makePromise();
  t.is(passStyleOf(p), 'promise');
});

test('makePromise: not a Promise instance and not thenable', t => {
  const p = makePromise();
  t.false(p instanceof Promise);
  t.false(isPromise(p));
  t.is(/** @type {any} */ (p).then, undefined);
  // Also no inherited then beyond Object.prototype.
  t.is(getPrototypeOf(p), Object.prototype);
});

test('makePromise: frozen with the expected own keys', t => {
  const p = makePromise();
  t.true(Object.isFrozen(p));
  // Exactly two symbol-keyed own properties: PASS_STYLE and toStringTag.
  t.deepEqual(
    ownKeys(p),
    [PASS_STYLE, toStringTag],
    'only PASS_STYLE and Symbol.toStringTag are own keys',
  );
  const passStyleDesc = Object.getOwnPropertyDescriptor(p, PASS_STYLE);
  const toStringTagDesc = Object.getOwnPropertyDescriptor(p, toStringTag);
  t.like(passStyleDesc, {
    value: 'promise',
    enumerable: false,
    configurable: false,
    writable: false,
  });
  t.like(toStringTagDesc, {
    value: 'Promise',
    enumerable: false,
    configurable: false,
    writable: false,
  });
});

test('makePromise: distinct identities, no shared state', t => {
  const a = makePromise();
  const b = makePromise();
  t.not(a, b);
  // Distinct passStyleOf entries (no shared identity in the memo).
  t.is(passStyleOf(a), 'promise');
  t.is(passStyleOf(b), 'promise');
});

test('makePromise: stringifies as Promise', t => {
  const p = makePromise();
  t.is(`${p}`, '[object Promise]');
});

test('isPassStylePromise: distinguishes pass-style carriers from native', t => {
  t.true(isPassStylePromise(makePromise()));
  t.false(isPassStylePromise(harden(Promise.resolve(null))));
  t.false(isPassStylePromise(harden({})));
  t.false(isPassStylePromise(undefined));
  t.false(isPassStylePromise(null));
  t.false(isPassStylePromise(42));
  t.false(isPassStylePromise('promise'));
});

test('await passStylePromise resolves to the carrier itself', async t => {
  // The non-thenable contract: `await x` walks `x.then`. Since the carrier
  // has no `then` (own or inherited beyond Object.prototype), `await x`
  // resolves to the carrier itself, not to any settlement target.
  const p = makePromise();
  const observed = await p;
  t.is(observed, p, 'await on a non-thenable carrier is identity');
});

test('Promise.resolve does not adopt a pass-style promise', async t => {
  // Promise.resolve(x) returns x only when x is a native Promise of the
  // same realm. Otherwise it wraps. For a pass-style promise carrier
  // (non-thenable, non-Promise), Promise.resolve wraps it as the
  // fulfillment value of a fresh native promise.
  const p = makePromise();
  const wrapped = Promise.resolve(p);
  t.not(wrapped, p);
  t.true(isPromise(wrapped));
  const observed = await wrapped;
  t.is(observed, p, 'wrapped fulfills to the carrier identity');
});

test('passStyleOf rejection: thenable on the carrier shape', t => {
  // A non-frozen object with [PASS_STYLE]: 'promise' AND a then method
  // must be rejected. The "then-pinhole" footgun is exactly what this
  // shape exists to close, so an own then must not pass.
  const bad = {};
  defineProperties(bad, {
    [PASS_STYLE]: { value: 'promise' },
    [toStringTag]: { value: 'Promise' },
    then: { value: () => 'sneaky', enumerable: true },
  });
  t.throws(() => passStyleOf(harden(bad)), {
    message: /Cannot pass non-promise thenables/,
  });
});

test('passStyleOf rejection: extra own property', t => {
  const bad = {};
  defineProperties(bad, {
    [PASS_STYLE]: { value: 'promise' },
    [toStringTag]: { value: 'Promise' },
    extra: { value: 1, enumerable: true },
  });
  t.throws(() => passStyleOf(harden(bad)), {
    message: /unexpected own properties/,
  });
});

test('passStyleOf rejection: wrong [PASS_STYLE] value handled by other arm', t => {
  // [PASS_STYLE]: 'not-a-style' is rejected by the helper-table lookup.
  const bad = {};
  defineProperties(bad, {
    [PASS_STYLE]: { value: 'not-a-style' },
    [toStringTag]: { value: 'Promise' },
  });
  t.throws(() => passStyleOf(harden(bad)), {
    message: /Unrecognized PassStyle/,
  });
});

test('passStyleOf rejection: enumerable [PASS_STYLE] descriptor', t => {
  const bad = {};
  defineProperties(bad, {
    [PASS_STYLE]: { value: 'promise', enumerable: true },
    [toStringTag]: { value: 'Promise' },
  });
  t.throws(() => passStyleOf(harden(bad)), {
    message: /must not be an enumerable property/,
  });
});

test('passStyleOf rejection: accessor [PASS_STYLE] descriptor', t => {
  const bad = {};
  defineProperties(bad, {
    [PASS_STYLE]: { get: () => 'promise' },
    [toStringTag]: { value: 'Promise' },
  });
  t.throws(() => passStyleOf(harden(bad)), {
    message: /must not be an accessor property/,
  });
});

test('passStyleOf rejection: missing [Symbol.toStringTag]', t => {
  const bad = {};
  defineProperties(bad, {
    [PASS_STYLE]: { value: 'promise' },
  });
  t.throws(() => passStyleOf(harden(bad)), {
    message: /property expected/,
  });
});

test('passStyleOf rejection: [Symbol.toStringTag] not starting with Promise', t => {
  const bad = {};
  defineProperties(bad, {
    [PASS_STYLE]: { value: 'promise' },
    [toStringTag]: { value: 'NotAPromise' },
  });
  t.throws(() => passStyleOf(harden(bad)), {
    message: /\[Symbol\.toStringTag\] must be a string starting with "Promise"/,
  });
});

test('passStyleOf accepts Promise-prefixed [Symbol.toStringTag]', t => {
  // Like native promises, the carrier admits any string starting with
  // "Promise" as the toStringTag, not just exactly "Promise".
  const ok = {};
  defineProperties(ok, {
    [PASS_STYLE]: { value: 'promise' },
    [toStringTag]: { value: 'Promise: my-pet-name' },
  });
  t.is(passStyleOf(/** @type {any} */ (harden(ok))), 'promise');
});

test('native Promise still recognized as "promise" pass style', t => {
  // The new helper is additive; native promises continue to work.
  const native = harden(Promise.resolve(42));
  t.is(passStyleOf(native), 'promise');
  t.true(isPromise(native));
  t.false(isPassStylePromise(native));
});

test('passStyleOf rejection: not frozen', t => {
  const bad = {};
  defineProperties(bad, {
    [PASS_STYLE]: { value: 'promise' },
    [toStringTag]: { value: 'Promise' },
  });
  // Note: not hardened.
  if (hardenIsNoop(harden)) {
    // Under unsafe lockdown harden is a no-op, so passStyleOf cannot
    // observe a frozen-vs-not distinction. The carrier still validates.
    t.is(passStyleOf(/** @type {any} */ (bad)), 'promise');
  } else {
    t.throws(() => passStyleOf(/** @type {any} */ (bad)), {
      message: /Cannot pass non-frozen objects|A tagRecord must be frozen/,
    });
  }
});
