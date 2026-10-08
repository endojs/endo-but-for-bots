// @ts-check

// Replacement for the test deleted by endojs/endo#372 (commit 5cf2a20389).
// See https://github.com/endojs/endo/issues/390
//
// The point of erights's original test was to verify that the anonymous
// intrinsics the SES shim believes in actually exist on the host realm under
// the identity the shim expects. The shim recovers these intrinsics by
// navigating prototype chains from a small number of seed objects (for
// example, `new Set()[Symbol.iterator]()`). If a host realm reorganizes one
// of those chains, or if the shim's navigation drifts, downstream consumers
// (`permits-intrinsics.js` and friends) would silently install permits
// against the wrong object, and the rest of the SES test suite would not
// notice.
//
// Each assertion below compares an anonymous intrinsic (by identity) to a
// value the test obtains on its own: usually by re-deriving it from host
// objects, and for `%InertCompartment%` by importing the shim's export. The
// derivations are deliberately written without going through
// `commons.js`, so that a regression in `get-anonymous-intrinsics.js` cannot
// also corrupt the reference values.
//
// This test must run before lockdown so it samples the feral realm (the
// state in which `getAnonymousIntrinsics` is actually called from inside
// `repairIntrinsics`).

import test from 'ava';
import { getAnonymousIntrinsics } from '../src/get-anonymous-intrinsics.js';
import { InertCompartment } from '../src/compartment.js';

const { getPrototypeOf, getOwnPropertyDescriptor } = Object;

test('getAnonymousIntrinsics returns the expected anonymous intrinsics', t => {
  const intrinsics = getAnonymousIntrinsics();

  // Tracks the names the test expects to find in `intrinsics`, so we can
  // fail closed if `getAnonymousIntrinsics` ever adds a new entry without
  // a matching test branch. Each `assertSame` call records its name; each
  // `assertAbsent` call deliberately does not.
  const expectedKeys = new Set();
  // Names whose value may legitimately be `undefined` on this host, because
  // the source writes the key unconditionally with an `undefined` value.
  const undefinedKeys = new Set();

  // Using `===` and `t.true` instead of `t.is` avoids the AVA-side
  // diff-formatter trying to enumerate iterator prototypes when an
  // assertion fails. The iterator's `next()` would throw on the
  // `[object Foo Iterator]` placeholder concordance constructs. This way
  // failures still pinpoint the offending line via the stack trace, and
  // the message field tells the reader which intrinsic mismatched.
  const assertSame = (name, actual, expected) => {
    expectedKeys.add(name);
    t.true(
      actual === expected,
      `${name} should equal the independently derived value`,
    );
  };
  const assertAbsent = (name, reason) => {
    t.true(!(name in intrinsics), `${name} ${reason}`);
  };

  // %ThrowTypeError% is the shared getter of `arguments.callee` on a
  // strict-mode arguments object.
  const expectedThrowTypeError = (function makeArgs() {
    // eslint-disable-next-line prefer-rest-params
    const descriptor = getOwnPropertyDescriptor(arguments, 'callee');
    return descriptor && descriptor.get;
  })();
  assertSame(
    '%ThrowTypeError%',
    intrinsics['%ThrowTypeError%'],
    expectedThrowTypeError,
  );

  // %StringIteratorPrototype%
  const expectedStringIteratorPrototype = getPrototypeOf(
    // eslint-disable-next-line no-new-wrappers
    new String()[Symbol.iterator](),
  );
  assertSame(
    '%StringIteratorPrototype%',
    intrinsics['%StringIteratorPrototype%'],
    expectedStringIteratorPrototype,
  );

  // %RegExpStringIteratorPrototype%
  if (typeof RegExp.prototype[Symbol.matchAll] === 'function') {
    const expectedRegExpStringIteratorPrototype = getPrototypeOf(
      /./[Symbol.matchAll](''),
    );
    assertSame(
      '%RegExpStringIteratorPrototype%',
      intrinsics['%RegExpStringIteratorPrototype%'],
      expectedRegExpStringIteratorPrototype,
    );
  } else {
    // The source always writes this key; without `matchAll` its value is
    // `undefined`.
    expectedKeys.add('%RegExpStringIteratorPrototype%');
    undefinedKeys.add('%RegExpStringIteratorPrototype%');
    t.true(
      intrinsics['%RegExpStringIteratorPrototype%'] === undefined,
      '%RegExpStringIteratorPrototype% should be undefined when host lacks RegExp.prototype[Symbol.matchAll]',
    );
  }

  // %ArrayIteratorPrototype%
  const expectedArrayIteratorPrototype = getPrototypeOf([][Symbol.iterator]());
  assertSame(
    '%ArrayIteratorPrototype%',
    intrinsics['%ArrayIteratorPrototype%'],
    expectedArrayIteratorPrototype,
  );

  // %MapIteratorPrototype%
  const expectedMapIteratorPrototype = getPrototypeOf(
    new Map()[Symbol.iterator](),
  );
  assertSame(
    '%MapIteratorPrototype%',
    intrinsics['%MapIteratorPrototype%'],
    expectedMapIteratorPrototype,
  );

  // %SetIteratorPrototype%
  const expectedSetIteratorPrototype = getPrototypeOf(
    new Set()[Symbol.iterator](),
  );
  assertSame(
    '%SetIteratorPrototype%',
    intrinsics['%SetIteratorPrototype%'],
    expectedSetIteratorPrototype,
  );

  // %IteratorPrototype% is the common ancestor of array/map/set iterators.
  const expectedIteratorPrototype = getPrototypeOf(
    expectedArrayIteratorPrototype,
  );
  assertSame(
    '%IteratorPrototype%',
    intrinsics['%IteratorPrototype%'],
    expectedIteratorPrototype,
  );
  // Cross-check the invariant the shim relies on: every native iterator
  // prototype shares this common ancestor.
  t.true(
    getPrototypeOf(expectedMapIteratorPrototype) === expectedIteratorPrototype,
    'MapIteratorPrototype should inherit from IteratorPrototype',
  );
  t.true(
    getPrototypeOf(expectedSetIteratorPrototype) === expectedIteratorPrototype,
    'SetIteratorPrototype should inherit from IteratorPrototype',
  );

  // %TypedArray% is the shared abstract supertype of Int8Array etc.
  const expectedTypedArray = getPrototypeOf(Int8Array);
  assertSame('%TypedArray%', intrinsics['%TypedArray%'], expectedTypedArray);
  // The shim derives this from Float64Array; cross-check that all typed
  // array constructors agree.
  t.true(
    getPrototypeOf(Float64Array) === expectedTypedArray,
    'Float64Array should inherit from %TypedArray%',
  );
  t.true(
    getPrototypeOf(Uint8Array) === expectedTypedArray,
    'Uint8Array should inherit from %TypedArray%',
  );

  // %InertGeneratorFunction% and %Generator%.
  // eslint-disable-next-line no-empty-function, func-names
  const generatorFunction = function* () {};
  const expectedGeneratorFunction =
    getPrototypeOf(generatorFunction).constructor;
  const expectedGenerator = expectedGeneratorFunction.prototype;
  assertSame(
    '%InertGeneratorFunction%',
    intrinsics['%InertGeneratorFunction%'],
    expectedGeneratorFunction,
  );
  assertSame('%Generator%', intrinsics['%Generator%'], expectedGenerator);

  // %InertAsyncFunction%.
  // eslint-disable-next-line no-empty-function, func-names
  const asyncFunction = async function () {};
  const expectedAsyncFunction = getPrototypeOf(asyncFunction).constructor;
  assertSame(
    '%InertAsyncFunction%',
    intrinsics['%InertAsyncFunction%'],
    expectedAsyncFunction,
  );

  // %InertAsyncGeneratorFunction% / %AsyncGenerator% / %AsyncGeneratorPrototype% /
  // %AsyncIteratorPrototype% are only present when the host supports
  // async generators. Mirrors the conditional inside
  // `getAnonymousIntrinsics`.
  let asyncGeneratorFunction;
  try {
    // Use indirection because some platforms (notably Hermes) cannot parse
    // async-generator syntax even at module load time. Like `commons.js`,
    // treat only a `SyntaxError` as "host lacks async generators".
    // eslint-disable-next-line no-new-func
    asyncGeneratorFunction = new Function('return (async function* () {})')();
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }
  if (asyncGeneratorFunction !== undefined) {
    const expectedAsyncGeneratorFunction = getPrototypeOf(
      asyncGeneratorFunction,
    ).constructor;
    const expectedAsyncGenerator = expectedAsyncGeneratorFunction.prototype;
    const expectedAsyncGeneratorPrototype = expectedAsyncGenerator.prototype;
    const expectedAsyncIteratorPrototype = getPrototypeOf(
      expectedAsyncGeneratorPrototype,
    );
    assertSame(
      '%InertAsyncGeneratorFunction%',
      intrinsics['%InertAsyncGeneratorFunction%'],
      expectedAsyncGeneratorFunction,
    );
    assertSame(
      '%AsyncGenerator%',
      intrinsics['%AsyncGenerator%'],
      expectedAsyncGenerator,
    );
    assertSame(
      '%AsyncGeneratorPrototype%',
      intrinsics['%AsyncGeneratorPrototype%'],
      expectedAsyncGeneratorPrototype,
    );
    assertSame(
      '%AsyncIteratorPrototype%',
      intrinsics['%AsyncIteratorPrototype%'],
      expectedAsyncIteratorPrototype,
    );
  } else {
    for (const name of [
      '%InertAsyncGeneratorFunction%',
      '%AsyncGenerator%',
      '%AsyncGeneratorPrototype%',
      '%AsyncIteratorPrototype%',
    ]) {
      assertAbsent(name, 'should be absent when host lacks async generators');
    }
  }

  // %InertFunction% is the (inert post-lockdown) Function constructor.
  // Before lockdown it is just Function; the shim only renders it inert
  // later via tameFunctionConstructors.
  assertSame('%InertFunction%', intrinsics['%InertFunction%'], Function);

  // %InertCompartment% is provided by the shim itself, not derived from a
  // host intrinsic, so compare it to the shim's own export.
  assertSame(
    '%InertCompartment%',
    intrinsics['%InertCompartment%'],
    InertCompartment,
  );

  // Iterator helpers (ES2025), only when the host implements them.
  if (globalThis.Iterator) {
    // Since ES2025, %Iterator.prototype% is reachable by name; it must be the
    // same object as the ancestor derived from the array iterator above.
    t.true(
      globalThis.Iterator.prototype === expectedIteratorPrototype,
      'Iterator.prototype should be %IteratorPrototype%',
    );
    // Derived via `map` on an array iterator rather than the source's
    // `Iterator.from([]).take(0)` path (ECMA-262 §27.1.2.1).
    const expectedIteratorHelperPrototype = getPrototypeOf(
      [].values().map(x => x),
    );
    t.true(
      getPrototypeOf(expectedIteratorHelperPrototype) ===
        expectedIteratorPrototype,
      '%IteratorHelperPrototype% should inherit from %IteratorPrototype%',
    );
    assertSame(
      '%IteratorHelperPrototype%',
      intrinsics['%IteratorHelperPrototype%'],
      expectedIteratorHelperPrototype,
    );
    const expectedWrapForValidIteratorPrototype = getPrototypeOf(
      globalThis.Iterator.from({
        next() {
          return { value: undefined };
        },
      }),
    );
    t.true(
      getPrototypeOf(expectedWrapForValidIteratorPrototype) ===
        expectedIteratorPrototype,
      '%WrapForValidIteratorPrototype% should inherit from %IteratorPrototype%',
    );
    assertSame(
      '%WrapForValidIteratorPrototype%',
      intrinsics['%WrapForValidIteratorPrototype%'],
      expectedWrapForValidIteratorPrototype,
    );
  } else {
    for (const name of [
      '%IteratorHelperPrototype%',
      '%WrapForValidIteratorPrototype%',
    ]) {
      assertAbsent(
        name,
        'should be absent when host lacks globalThis.Iterator',
      );
    }
  }

  // Async iterator helpers (TC39 stage 2 proposal; names may change), only
  // when the host implements them.
  if (globalThis.AsyncIterator) {
    const expectedAsyncIteratorHelperPrototype = getPrototypeOf(
      globalThis.AsyncIterator.from([]).take(0),
    );
    assertSame(
      '%AsyncIteratorHelperPrototype%',
      intrinsics['%AsyncIteratorHelperPrototype%'],
      expectedAsyncIteratorHelperPrototype,
    );
    const expectedWrapForValidAsyncIteratorPrototype = getPrototypeOf(
      globalThis.AsyncIterator.from({ next() {} }),
    );
    assertSame(
      '%WrapForValidAsyncIteratorPrototype%',
      intrinsics['%WrapForValidAsyncIteratorPrototype%'],
      expectedWrapForValidAsyncIteratorPrototype,
    );
  } else {
    for (const name of [
      '%AsyncIteratorHelperPrototype%',
      '%WrapForValidAsyncIteratorPrototype%',
    ]) {
      assertAbsent(
        name,
        'should be absent when host lacks globalThis.AsyncIterator',
      );
    }
  }

  // Sanity check: every key in the intrinsics record begins and ends with
  // `%`, matching the conventional spec name. This is what
  // `permits-intrinsics.js` expects to look up. Also reject `null` and
  // `undefined` as values (defense in depth alongside the identity
  // checks above).
  for (const name of Object.keys(intrinsics)) {
    t.true(
      name.startsWith('%') && name.endsWith('%'),
      `intrinsic name ${name} should be wrapped in %...%`,
    );
    if (!undefinedKeys.has(name)) {
      t.not(intrinsics[name], undefined, `${name} should not be undefined`);
    }
    t.not(intrinsics[name], null, `${name} should not be null`);
  }

  // Fail closed when a future patch adds a new intrinsic without a
  // matching test branch. This catches drift that the per-name identity
  // checks alone cannot: a new key with no corresponding `assertSame` call
  // would slip through silently.
  t.deepEqual(
    Object.keys(intrinsics).slice().sort(),
    [...expectedKeys].sort(),
    'intrinsics keys should match the set the test branches assert against',
  );
});
