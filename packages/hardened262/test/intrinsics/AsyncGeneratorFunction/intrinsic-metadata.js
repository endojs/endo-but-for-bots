/*---
description: AsyncGeneratorFunction intrinsic metadata is coherent across Hardened JavaScript hosts
features: [async-iteration, generators, Symbol.toStringTag]
---*/

async function* generator() {}

var AsyncGenerator = Object.getPrototypeOf(generator);
var AsyncGeneratorFunction = AsyncGenerator.constructor;

// Lockdown tames the async-generator-function constructor into an inert
// stand-in, and the taming is not uniform across hosts: the SES shim keeps its
// name and length while XS's native lockdown blanks the name, and every
// lockdown drops its `length` and reparents it off the tamed `Function`. So
// this pins only the identity relationships that survive hardening on every
// host: the `.prototype` back-link to %AsyncGenerator%, the reciprocal
// `.constructor` edge, the %AsyncGenerator% Symbol.toStringTag, and the
// %AsyncGenerator% -> %Function.prototype% link. The tag is cross-checked
// through the generic `Object.prototype.toString` algorithm as well as the
// direct symbol read, so a host whose two paths diverge is caught.
var metadata = [
  AsyncGeneratorFunction.prototype === AsyncGenerator,
  AsyncGenerator.constructor === AsyncGeneratorFunction,
  AsyncGenerator[Symbol.toStringTag],
  Object.getPrototypeOf(AsyncGenerator) === Function.prototype,
  Object.prototype.toString.call(AsyncGenerator),
].join('|');

assert.sameValue(
  metadata,
  'true|true|AsyncGeneratorFunction|true|[object AsyncGeneratorFunction]',
  'the AsyncGeneratorFunction intrinsic and its prototype metadata agree',
);

// A user-defined async generator function retains an assignable `.prototype`
// own property even after hardening — lockdown freezes the intrinsics, not the
// generator functions a program later declares — mirroring the mutability
// corner the sibling %AsyncGeneratorPrototype% test pins.
var replacementPrototype = {};
generator.prototype = replacementPrototype;
assert.sameValue(
  generator.prototype,
  replacementPrototype,
  'an async generator function retains an assignable prototype',
);

// %AsyncGenerator% is a single shared intrinsic: every syntactic form of async
// generator function — declaration, expression, and object-method shorthand —
// resolves to the same %AsyncGeneratorFunction.prototype%, so a taming that
// minted a fresh stand-in per producer would be caught here.
var generatorExpression = async function* () {};
var generatorMethod = { async *method() {} }.method;
assert.sameValue(
  Object.getPrototypeOf(generatorExpression),
  AsyncGenerator,
  'an async generator function expression shares the %AsyncGenerator% intrinsic',
);
assert.sameValue(
  Object.getPrototypeOf(generatorMethod),
  AsyncGenerator,
  'an async generator method shares the %AsyncGenerator% intrinsic',
);

// The async and sync generator-function intrinsics are distinct objects built
// by parallel taming paths; a bug that shared one stand-in across the two would
// pass the async and sync files individually but is caught by this cross-check.
function* syncGenerator() {}
var Generator = Object.getPrototypeOf(syncGenerator);
var GeneratorFunction = Generator.constructor;
assert.notSameValue(
  AsyncGenerator,
  Generator,
  '%AsyncGenerator% and %Generator% are distinct intrinsics',
);
assert.notSameValue(
  AsyncGeneratorFunction,
  GeneratorFunction,
  '%AsyncGeneratorFunction% and %GeneratorFunction% are distinct intrinsics',
);
