// @ts-check
/* global globalThis */

// Replacement for the test deleted by PR #372 (commit 5cf2a20389).
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
// Each assertion below independently re-derives an anonymous intrinsic and
// compares it (by identity) to what `getAnonymousIntrinsics()` returns. The
// independent derivations are deliberately written without going through
// `commons.js`, so that a regression in `get-anonymous-intrinsics.js` cannot
// also corrupt the reference values.
//
// This test must run before lockdown so it samples the feral realm (the
// state in which `getAnonymousIntrinsics` is actually called from inside
// `repairIntrinsics`).

import test from 'ava';
// `getAnonymousIntrinsics` looks up `ArrayBuffer.prototype.sliceToImmutable`,
// which the SES shim ordinarily polyfills via the immutable-arraybuffer
// shim that `lockdown.js` imports for its side effect. We need to load the
// same side-effect shim here because we want to call
// `getAnonymousIntrinsics` directly, before lockdown.
import '@endo/immutable-arraybuffer/shim.js';
import { getAnonymousIntrinsics } from '../src/get-anonymous-intrinsics.js';

const { getPrototypeOf, getOwnPropertyDescriptor } = Object;

test('getAnonymousIntrinsics returns the expected anonymous intrinsics', t => {
  const intrinsics = getAnonymousIntrinsics();

  // Using `===` and `t.true` instead of `t.is` avoids the AVA-side
  // diff-formatter trying to enumerate iterator prototypes when an
  // assertion fails — the iterator's `next()` would throw on the
  // `[object Foo Iterator]` placeholder concordance constructs. This way
  // failures still pinpoint the offending line via the stack trace, and
  // the message field tells the reader which intrinsic mismatched.
  const isSame = (name, actual, expected) => {
    t.true(
      actual === expected,
      `${name} should equal the independently derived value`,
    );
  };
  const isAbsent = (name, reason) => {
    t.true(!(name in intrinsics), `${name} ${reason}`);
  };

  // %ThrowTypeError% — the shared getter of `arguments.callee` on a
  // strict-mode arguments object.
  const expectedThrowTypeError = (function makeArgs() {
    // eslint-disable-next-line prefer-rest-params
    const desc = getOwnPropertyDescriptor(arguments, 'callee');
    return desc && desc.get;
  })();
  isSame(
    '%ThrowTypeError%',
    intrinsics['%ThrowTypeError%'],
    expectedThrowTypeError,
  );

  // %StringIteratorPrototype%
  const expectedStringIteratorPrototype = getPrototypeOf(
    // eslint-disable-next-line no-new-wrappers
    new String()[Symbol.iterator](),
  );
  isSame(
    '%StringIteratorPrototype%',
    intrinsics['%StringIteratorPrototype%'],
    expectedStringIteratorPrototype,
  );

  // %RegExpStringIteratorPrototype%
  if (typeof RegExp.prototype[Symbol.matchAll] === 'function') {
    const expectedRegExpStringIteratorPrototype = getPrototypeOf(
      /./[Symbol.matchAll](''),
    );
    isSame(
      '%RegExpStringIteratorPrototype%',
      intrinsics['%RegExpStringIteratorPrototype%'],
      expectedRegExpStringIteratorPrototype,
    );
  }

  // %ArrayIteratorPrototype%
  const expectedArrayIteratorPrototype = getPrototypeOf([][Symbol.iterator]());
  isSame(
    '%ArrayIteratorPrototype%',
    intrinsics['%ArrayIteratorPrototype%'],
    expectedArrayIteratorPrototype,
  );

  // %MapIteratorPrototype%
  const expectedMapIteratorPrototype = getPrototypeOf(
    new Map()[Symbol.iterator](),
  );
  isSame(
    '%MapIteratorPrototype%',
    intrinsics['%MapIteratorPrototype%'],
    expectedMapIteratorPrototype,
  );

  // %SetIteratorPrototype%
  const expectedSetIteratorPrototype = getPrototypeOf(
    new Set()[Symbol.iterator](),
  );
  isSame(
    '%SetIteratorPrototype%',
    intrinsics['%SetIteratorPrototype%'],
    expectedSetIteratorPrototype,
  );

  // %IteratorPrototype% — the common ancestor of array/map/set iterators.
  const expectedIteratorPrototype = getPrototypeOf(
    expectedArrayIteratorPrototype,
  );
  isSame(
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

  // %TypedArray% — the shared abstract supertype of Int8Array etc.
  const expectedTypedArray = getPrototypeOf(Int8Array);
  isSame('%TypedArray%', intrinsics['%TypedArray%'], expectedTypedArray);
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
  const generatorFn = function* () {};
  const expectedGeneratorFunction = getPrototypeOf(generatorFn).constructor;
  const expectedGenerator = expectedGeneratorFunction.prototype;
  isSame(
    '%InertGeneratorFunction%',
    intrinsics['%InertGeneratorFunction%'],
    expectedGeneratorFunction,
  );
  isSame('%Generator%', intrinsics['%Generator%'], expectedGenerator);

  // %InertAsyncFunction%.
  // eslint-disable-next-line no-empty-function, func-names
  const asyncFn = async function () {};
  const expectedAsyncFunction = getPrototypeOf(asyncFn).constructor;
  isSame(
    '%InertAsyncFunction%',
    intrinsics['%InertAsyncFunction%'],
    expectedAsyncFunction,
  );

  // %InertAsyncGeneratorFunction% / %AsyncGenerator% / %AsyncGeneratorPrototype% /
  // %AsyncIteratorPrototype% — only present when the host supports async
  // generators. Mirrors the conditional inside `getAnonymousIntrinsics`.
  let expectedAsyncGeneratorFunction;
  try {
    // Use indirection because some platforms (notably Hermes) cannot parse
    // async-generator syntax even at module load time.
    // eslint-disable-next-line no-new-func
    const ag = new Function('return (async function* () {})')();
    expectedAsyncGeneratorFunction = getPrototypeOf(ag).constructor;
  } catch (_e) {
    expectedAsyncGeneratorFunction = undefined;
  }
  if (expectedAsyncGeneratorFunction !== undefined) {
    const expectedAsyncGenerator = expectedAsyncGeneratorFunction.prototype;
    const expectedAsyncGeneratorPrototype = expectedAsyncGenerator.prototype;
    const expectedAsyncIteratorPrototype = getPrototypeOf(
      expectedAsyncGeneratorPrototype,
    );
    isSame(
      '%InertAsyncGeneratorFunction%',
      intrinsics['%InertAsyncGeneratorFunction%'],
      expectedAsyncGeneratorFunction,
    );
    isSame(
      '%AsyncGenerator%',
      intrinsics['%AsyncGenerator%'],
      expectedAsyncGenerator,
    );
    isSame(
      '%AsyncGeneratorPrototype%',
      intrinsics['%AsyncGeneratorPrototype%'],
      expectedAsyncGeneratorPrototype,
    );
    isSame(
      '%AsyncIteratorPrototype%',
      intrinsics['%AsyncIteratorPrototype%'],
      expectedAsyncIteratorPrototype,
    );
  } else {
    isAbsent(
      '%InertAsyncGeneratorFunction%',
      'should be absent when host lacks async generators',
    );
  }

  // %InertFunction% — the (inert post-lockdown) Function constructor.
  // Before lockdown it is just Function; the shim only renders it inert
  // later via tameFunctionConstructors.
  isSame('%InertFunction%', intrinsics['%InertFunction%'], Function);

  // %InertCompartment% is provided by the shim itself, not derived from a
  // host intrinsic. Just check it is present and a function.
  t.is(
    typeof intrinsics['%InertCompartment%'],
    'function',
    '%InertCompartment%',
  );

  // Iterator-helpers proposal intrinsics — only when host implements them.
  if (globalThis.Iterator) {
    const expectedIteratorHelperPrototype = getPrototypeOf(
      // eslint-disable-next-line @endo/no-polymorphic-call
      globalThis.Iterator.from([]).take(0),
    );
    isSame(
      '%IteratorHelperPrototype%',
      intrinsics['%IteratorHelperPrototype%'],
      expectedIteratorHelperPrototype,
    );
    const expectedWrapForValidIteratorPrototype = getPrototypeOf(
      // eslint-disable-next-line @endo/no-polymorphic-call
      globalThis.Iterator.from({
        next() {
          return { value: undefined };
        },
      }),
    );
    isSame(
      '%WrapForValidIteratorPrototype%',
      intrinsics['%WrapForValidIteratorPrototype%'],
      expectedWrapForValidIteratorPrototype,
    );
  } else {
    isAbsent(
      '%IteratorHelperPrototype%',
      'should be absent when host lacks globalThis.Iterator',
    );
  }

  if (globalThis.AsyncIterator) {
    const expectedAsyncIteratorHelperPrototype = getPrototypeOf(
      // eslint-disable-next-line @endo/no-polymorphic-call
      globalThis.AsyncIterator.from([]).take(0),
    );
    isSame(
      '%AsyncIteratorHelperPrototype%',
      intrinsics['%AsyncIteratorHelperPrototype%'],
      expectedAsyncIteratorHelperPrototype,
    );
    const expectedWrapForValidAsyncIteratorPrototype = getPrototypeOf(
      // eslint-disable-next-line @endo/no-polymorphic-call
      globalThis.AsyncIterator.from({ next() {} }),
    );
    isSame(
      '%WrapForValidAsyncIteratorPrototype%',
      intrinsics['%WrapForValidAsyncIteratorPrototype%'],
      expectedWrapForValidAsyncIteratorPrototype,
    );
  } else {
    isAbsent(
      '%AsyncIteratorHelperPrototype%',
      'should be absent when host lacks globalThis.AsyncIterator',
    );
  }

  // %ImmutableArrayBufferPrototype% — the shim provides
  // `ArrayBuffer.prototype.sliceToImmutable` itself when the host lacks it,
  // so this entry is only included when the immutable slice has its own
  // prototype distinct from `ArrayBuffer.prototype`.
  const ab = new ArrayBuffer(0);
  // eslint-disable-next-line @endo/no-polymorphic-call
  const iab = ab.sliceToImmutable();
  const iabProto = getPrototypeOf(iab);
  if (iabProto !== ArrayBuffer.prototype) {
    isSame(
      '%ImmutableArrayBufferPrototype%',
      intrinsics['%ImmutableArrayBufferPrototype%'],
      iabProto,
    );
  } else {
    isAbsent(
      '%ImmutableArrayBufferPrototype%',
      'should be absent when host immutable slice shares ArrayBuffer.prototype',
    );
  }

  // Sanity check: every key in the intrinsics record begins and ends with
  // `%`, matching the conventional spec name. This is what
  // `permits-intrinsics.js` expects to look up.
  for (const name of Object.keys(intrinsics)) {
    t.true(
      name.startsWith('%') && name.endsWith('%'),
      `intrinsic name ${name} should be wrapped in %…%`,
    );
    t.not(intrinsics[name], undefined, `${name} should be defined`);
  }
});
