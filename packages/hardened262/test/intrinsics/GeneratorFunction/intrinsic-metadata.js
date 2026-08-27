/*---
description: GeneratorFunction intrinsic metadata is coherent across Hardened JavaScript hosts
features: [generators, Symbol.toStringTag]
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
// link.
var metadata = [
  GeneratorFunction.prototype === Generator,
  Generator.constructor === GeneratorFunction,
  Generator[Symbol.toStringTag],
  Object.getPrototypeOf(Generator) === Function.prototype,
].join('|');

assert.sameValue(
  metadata,
  'true|true|GeneratorFunction|true',
  'the GeneratorFunction intrinsic and its prototype metadata agree',
);
