/*---
description: AsyncGeneratorFunction intrinsic metadata is coherent across Hardened JavaScript hosts
features: [async-iteration, Symbol.toStringTag]
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
// %AsyncGenerator% -> %Function.prototype% link.
var metadata = [
  AsyncGeneratorFunction.prototype === AsyncGenerator,
  AsyncGenerator.constructor === AsyncGeneratorFunction,
  AsyncGenerator[Symbol.toStringTag],
  Object.getPrototypeOf(AsyncGenerator) === Function.prototype,
].join('|');

assert.sameValue(
  metadata,
  'true|true|AsyncGeneratorFunction|true',
  'the AsyncGeneratorFunction intrinsic and its prototype metadata agree',
);
