/*---
description: The %TypedArray% intrinsic superclass and %TypedArrayPrototype% expose coherent metadata across Hardened JavaScript hosts
features: [TypedArray, Symbol.iterator, Symbol.toStringTag]
---*/

function prototypeOf(value) {
  return Object.getPrototypeOf(value);
}

// Every concrete typed-array constructor (Int8Array, Float64Array, ...) shares
// the single abstract %TypedArray% intrinsic as its prototype, and every
// concrete prototype chains up to the single %TypedArrayPrototype% intrinsic.
var TypedArray = prototypeOf(Int8Array);
var TypedArrayPrototype = TypedArray.prototype;

var metadata = [
  TypedArray.name,
  TypedArray.length,
  prototypeOf(Int8Array) === TypedArray,
  prototypeOf(Float64Array) === TypedArray,
  prototypeOf(Int8Array.prototype) === TypedArrayPrototype,
  prototypeOf(Uint32Array.prototype) === TypedArrayPrototype,
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
  'TypedArray|0|true|true|true|true|true|values|0|true|subarray|2|[object Int8Array]',
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
assert.sameValue(
  toStringTag.get.call(new Float64Array(0)),
  'Float64Array',
  'the @@toStringTag getter yields the per-instance constructor name',
);
assert.sameValue(
  toStringTag.get.call([]),
  undefined,
  'the @@toStringTag getter yields undefined for a non-typed-array receiver',
);
