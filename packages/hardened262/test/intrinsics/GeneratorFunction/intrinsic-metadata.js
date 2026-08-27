/*---
description: GeneratorFunction intrinsic metadata is coherent across Hardened JavaScript hosts
features: [generators, async-iteration, Symbol.toStringTag]
---*/

function* generator() {}

var Generator = Object.getPrototypeOf(generator);
var GeneratorFunction = Generator.constructor;

// Lockdown tames the generator-function constructor into an inert stand-in, and
// the taming is not uniform across hosts: the SES shim keeps its name and
// length while XS's native lockdown blanks the name, and every lockdown drops
// its `length` and reparents it off the tamed `Function`. So this pins only the
// identity relationships that survive hardening on every host: the `.prototype`
// back-link to %Generator%, the reciprocal `.constructor` edge, the
// %Generator% Symbol.toStringTag, and the %Generator% -> %Function.prototype%
// link. The tag is cross-checked through the generic `Object.prototype.toString`
// algorithm as well as the direct symbol read, so a host whose two paths
// diverge is caught.
var metadata = [
  GeneratorFunction.prototype === Generator,
  Generator.constructor === GeneratorFunction,
  Generator[Symbol.toStringTag],
  Object.getPrototypeOf(Generator) === Function.prototype,
  Object.prototype.toString.call(Generator),
].join('|');

assert.sameValue(
  metadata,
  'true|true|GeneratorFunction|true|[object GeneratorFunction]',
  'the GeneratorFunction intrinsic and its prototype metadata agree',
);

// A user-defined generator function retains an assignable `.prototype` own
// property even after hardening — lockdown freezes the intrinsics, not the
// generator functions a program later declares — mirroring the mutability
// corner the sibling %GeneratorPrototype% test pins.
var replacementPrototype = {};
generator.prototype = replacementPrototype;
assert.sameValue(
  generator.prototype,
  replacementPrototype,
  'a generator function retains an assignable prototype',
);

// %Generator% is a single shared intrinsic: every syntactic form of generator
// function — declaration, expression, and object-method shorthand — resolves to
// the same %GeneratorFunction.prototype%, so a taming that minted a fresh
// stand-in per producer would be caught here.
var generatorExpression = function* () {};
var generatorMethod = { *method() {} }.method;
assert.sameValue(
  Object.getPrototypeOf(generatorExpression),
  Generator,
  'a generator function expression shares the %Generator% intrinsic',
);
assert.sameValue(
  Object.getPrototypeOf(generatorMethod),
  Generator,
  'a generator method shares the %Generator% intrinsic',
);

// The sync and async generator-function intrinsics are distinct objects built
// by parallel taming paths; a bug that shared one stand-in across the two would
// pass the sync and async files individually but is caught by this cross-check.
async function* asyncGenerator() {}
var AsyncGenerator = Object.getPrototypeOf(asyncGenerator);
var AsyncGeneratorFunction = AsyncGenerator.constructor;
assert.notSameValue(
  Generator,
  AsyncGenerator,
  '%Generator% and %AsyncGenerator% are distinct intrinsics',
);
assert.notSameValue(
  GeneratorFunction,
  AsyncGeneratorFunction,
  '%GeneratorFunction% and %AsyncGeneratorFunction% are distinct intrinsics',
);
