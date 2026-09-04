/*---
description: The %Promise.prototype% intrinsic exposes coherent then/catch/finally methods, toStringTag, and prototype chain across Hardened JavaScript hosts
features: [async-functions, Symbol.toStringTag]
---*/

function prototypeOf(value) {
  return Object.getPrototypeOf(value);
}

// Reach the %Promise.prototype% intrinsic without the %Promise% global: an
// async function's returned promise is an ordinary instance whose prototype is
// the single %Promise.prototype% intrinsic.
var PromisePrototype = prototypeOf((async () => {})());

var metadata = [
  typeof PromisePrototype.then,
  PromisePrototype.then.name,
  PromisePrototype.then.length,
  typeof PromisePrototype.catch,
  PromisePrototype.catch.length,
  typeof PromisePrototype.finally,
  PromisePrototype.finally.length,
  PromisePrototype[Symbol.toStringTag],
  prototypeOf(PromisePrototype) === Object.prototype,
].join('|');

assert.sameValue(
  metadata,
  'function|then|2|function|1|function|1|Promise|true',
  'the %Promise.prototype% then/catch/finally methods, toStringTag, and prototype chain agree',
);
