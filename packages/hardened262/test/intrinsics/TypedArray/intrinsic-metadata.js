/*---
description: The %TypedArray% intrinsic superclass and %TypedArrayPrototype% expose coherent metadata across Hardened JavaScript hosts
includes: [testTypedArray.js, testBigIntTypedArray.js]
features: [TypedArray, BigInt, Symbol.iterator, Symbol.toStringTag, arraybuffer-transfer]
---*/

// `TypedArray` (the %TypedArray% intrinsic) and the constructor-family helpers
// come from the test262 harness includes above, where `TypedArray` is derived
// as `Object.getPrototypeOf(Int8Array)` independently of the assertions here.
var TypedArrayPrototype = TypedArray.prototype;

// %TypedArray% is an abstract superclass: it is not directly constructible,
// neither with `new` nor as a plain call.
assert.throws(
  TypeError,
  function () {
    new TypedArray();
  },
  '%TypedArray% throws a TypeError when constructed with new',
);
assert.throws(
  TypeError,
  function () {
    TypedArray();
  },
  '%TypedArray% throws a TypeError when called as a plain function',
);

// Every concrete typed-array constructor shares the single abstract %TypedArray%
// intrinsic as its prototype, and every concrete prototype chains up to the
// single %TypedArrayPrototype% intrinsic. Enumerate the family the vendored
// test262 harness knows (Number- and BigInt-backed alike) rather than
// spot-checking a subset. NOTE: the vendored `typedArrayConstructors` list
// (harness/testTypedArray.js) predates `Float16Array` (ES2025, Stage 4), so
// that one family member is not yet enumerated here; it will be covered
// automatically once the vendored harness is refreshed to match upstream
// test262.
function assertSharedSuperclass(TA) {
  assert.sameValue(
    Object.getPrototypeOf(TA),
    TypedArray,
    TA.name + ' chains to the single %TypedArray% intrinsic',
  );
  assert.sameValue(
    Object.getPrototypeOf(TA.prototype),
    TypedArrayPrototype,
    TA.name + '.prototype chains to the single %TypedArrayPrototype% intrinsic',
  );
}
testWithTypedArrayConstructors(assertSharedSuperclass);
testWithBigIntTypedArrayConstructors(assertSharedSuperclass);

// The remaining %TypedArray% / %TypedArrayPrototype% metadata (name, length,
// constructor identity, iterator/subarray shape) is single-valued across the
// family.
var metadata = [
  TypedArray.name,
  TypedArray.length,
  TypedArrayPrototype.constructor === TypedArray,
  TypedArrayPrototype.values.name,
  TypedArrayPrototype.values.length,
  TypedArrayPrototype[Symbol.iterator] === TypedArrayPrototype.values,
  TypedArrayPrototype.subarray.name,
  TypedArrayPrototype.subarray.length,
  Object.prototype.toString.call(new Int8Array(0)),
].join('|');

assert.sameValue(
  metadata,
  'TypedArray|0|true|values|0|true|subarray|2|[object Int8Array]',
  'the %TypedArray% superclass, %TypedArrayPrototype% chain, and iterator metadata agree',
);

// The %TypedArrayPrototype% @@toStringTag is an accessor whose getter yields the
// per-instance constructor name and undefined for any non-typed-array receiver.
var toStringTag = Object.getOwnPropertyDescriptor(
  TypedArrayPrototype,
  Symbol.toStringTag,
);

assert.sameValue(
  typeof toStringTag.get,
  'function',
  'the @@toStringTag is exposed through an accessor getter',
);
assert.sameValue(
  toStringTag.set,
  undefined,
  'the @@toStringTag accessor has no setter',
);
assert.sameValue(
  toStringTag.get.length,
  0,
  'the @@toStringTag getter takes no arguments',
);

// The getter yields the per-instance constructor name for every concrete
// typed-array constructor.
function assertToStringTagName(TA) {
  assert.sameValue(
    toStringTag.get.call(new TA(0)),
    TA.name,
    'the @@toStringTag getter yields ' + TA.name + ' for a ' + TA.name + ' instance',
  );
}
testWithTypedArrayConstructors(assertToStringTagName);
testWithBigIntTypedArrayConstructors(assertToStringTagName);

assert.sameValue(
  toStringTag.get.call([]),
  undefined,
  'the @@toStringTag getter yields undefined for a non-typed-array receiver',
);

// The getter keys off the [[TypedArrayName]] internal slot, which survives
// buffer detachment, so a typed array whose buffer has been detached must still
// report its constructor name rather than undefined.
var detached = new Int8Array(8);
detached.buffer.transfer();
assert.sameValue(
  toStringTag.get.call(detached),
  'Int8Array',
  'the @@toStringTag getter still yields the constructor name for a detached-buffer typed array',
);
assert.sameValue(
  Object.prototype.toString.call(detached),
  '[object Int8Array]',
  'Object.prototype.toString still reports the typed-array tag after buffer detachment',
);
