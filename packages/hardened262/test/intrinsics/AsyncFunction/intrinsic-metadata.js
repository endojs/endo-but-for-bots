/*---
description: AsyncFunction intrinsic metadata is coherent across Hardened JavaScript hosts
features: [async-functions, generators, async-iteration, Symbol.toStringTag]
---*/

async function asyncFunction() {}

// The async-function constructor is not exposed as a global binding; it is
// reached only through an async function's prototype. `%AsyncFunction.prototype%`
// (here %AsyncFunctionPrototype%) is the object every async function inherits
// from, and its `.constructor` is the %AsyncFunction% intrinsic itself.
var AsyncFunctionPrototype = Object.getPrototypeOf(asyncFunction);
var AsyncFunction = AsyncFunctionPrototype.constructor;

// Lockdown tames the async-function constructor into an inert stand-in, and the
// taming is not uniform across hosts: the SES shim keeps its name and length
// while XS's native lockdown blanks the name, and every lockdown drops its
// `length` and reparents it off the tamed `Function`. So this pins only the
// identity relationships that survive hardening on every host: the `.prototype`
// back-link to %AsyncFunctionPrototype%, the reciprocal `.constructor` edge, the
// %AsyncFunctionPrototype% Symbol.toStringTag, and the
// %AsyncFunctionPrototype% -> %Function.prototype% link. The tag is
// cross-checked through the generic `Object.prototype.toString` algorithm as
// well as the direct symbol read, so a host whose two paths diverge is caught.
var metadata = [
  AsyncFunction.prototype === AsyncFunctionPrototype,
  AsyncFunctionPrototype.constructor === AsyncFunction,
  AsyncFunctionPrototype[Symbol.toStringTag],
  Object.getPrototypeOf(AsyncFunctionPrototype) === Function.prototype,
  Object.prototype.toString.call(AsyncFunctionPrototype),
].join('|');

assert.sameValue(
  metadata,
  'true|true|AsyncFunction|true|[object AsyncFunction]',
  'the AsyncFunction intrinsic and its prototype metadata agree',
);

// Unlike a generator function, an async function is not a constructor and so
// carries no own `.prototype` property at all — the corner the sibling
// %GeneratorFunction% test pins as an *assignable* prototype has no analog here,
// and a taming that mistakenly grafted a generator-shaped `.prototype` onto
// async functions would be caught by its absence.
assert.sameValue(
  Object.prototype.hasOwnProperty.call(asyncFunction, 'prototype'),
  false,
  'an async function has no own prototype property',
);

// %AsyncFunctionPrototype% is a single shared intrinsic: every syntactic form of
// async function — declaration, expression, object-method shorthand, and arrow
// — resolves to the same %AsyncFunction.prototype%, so a taming that minted a
// fresh stand-in per producer would be caught here.
var asyncExpression = async function () {};
var asyncMethod = { async method() {} }.method;
var asyncArrow = async () => {};
assert.sameValue(
  Object.getPrototypeOf(asyncExpression),
  AsyncFunctionPrototype,
  'an async function expression shares the %AsyncFunction.prototype% intrinsic',
);
assert.sameValue(
  Object.getPrototypeOf(asyncMethod),
  AsyncFunctionPrototype,
  'an async method shares the %AsyncFunction.prototype% intrinsic',
);
assert.sameValue(
  Object.getPrototypeOf(asyncArrow),
  AsyncFunctionPrototype,
  'an async arrow function shares the %AsyncFunction.prototype% intrinsic',
);

// The async-function intrinsic is a distinct object from the sibling generator
// intrinsics built by parallel taming paths; a bug that shared one stand-in
// across the three would pass each file individually but is caught by these
// cross-checks. (Async generators combine both traits, so the async-function
// and async-generator constructors must still be distinct.)
async function* asyncGenerator() {}
var AsyncGeneratorFunction = Object.getPrototypeOf(asyncGenerator).constructor;
function* syncGenerator() {}
var GeneratorFunction = Object.getPrototypeOf(syncGenerator).constructor;
assert.notSameValue(
  AsyncFunction,
  AsyncGeneratorFunction,
  '%AsyncFunction% and %AsyncGeneratorFunction% are distinct intrinsics',
);
assert.notSameValue(
  AsyncFunction,
  GeneratorFunction,
  '%AsyncFunction% and %GeneratorFunction% are distinct intrinsics',
);
