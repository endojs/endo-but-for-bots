/*---
description: Lockdown tames %AsyncFunction% into a frozen inert stand-in that throws on call and construct
features: [async-functions]
flags: [onlyLockdown]
---*/

async function asyncFunction() {}
var AsyncFunction = Object.getPrototypeOf(asyncFunction).constructor;

// This file runs only under lockdown (`flags: [onlyLockdown]`), the one scenario
// in which the behavioral claim holds: `hardenIntrinsics()`
// (packages/ses/src/lockdown.js) freezes %AsyncFunction% and
// tame-function-constructors.js replaces it with an inert stand-in that throws
// on call and construct. The sibling intrinsic-metadata.js pins the identity
// relationships that survive on every host; this pins the freeze/throw contract
// that only lockdown establishes.
//
// The freeze is asserted UNCONDITIONALLY rather than used as a runtime gate. An
// earlier draft wrapped the throw assertions in `if (Object.isFrozen(AsyncFunction))`,
// but that made the freeze a precondition that vanishes with the very bug it
// should catch: a regression dropping %InertAsyncFunction% from the set
// `hardenIntrinsics()` freezes — with taming otherwise intact — would leave
// `Object.isFrozen(AsyncFunction)` false and silently no-op the block instead of
// failing. Because this file is scoped to lockdown, the freeze is a claim, not a
// guard: it goes red under exactly that regression.
assert(
  Object.isFrozen(AsyncFunction),
  'lockdown freezes the inert %AsyncFunction% stand-in',
);

assert.throws(
  TypeError,
  function () {
    AsyncFunction('return 1');
  },
  'lockdown tames %AsyncFunction% into an inert stand-in that throws when called',
);

assert.throws(
  TypeError,
  function () {
    new AsyncFunction('return 1');
  },
  'the tamed %AsyncFunction% stand-in throws under construct as well as call',
);
