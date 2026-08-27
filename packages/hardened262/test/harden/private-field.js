/*---
description:
features: [harden]
flags: [onlyStrict]
---*/

class Class {
  #value;
  constructor(it) {
    this.#value = it;
  }
  get value() {
    return this.#value;
  }
  set value(it) {
    this.#value = it;
  }
}

const object = new Class('wow');
// `harden` is ambient on native XS and the SES-on-XS shim but installed only at
// `lockdown()` on the pure-JS Node shim, so guard on its availability to run in
// every scenario (module + lockdownModule) rather than only the lockdown column.
// Hardening must not seal a private field: the mutation below succeeds whether or
// not `harden` ran, so this pins that harden leaves private state writable.
if (typeof harden === 'function') {
  harden(object);
}
object.value = 'oops';
assert.sameValue(
  object.value,
  'oops',
  'hardened object: mutable private field',
);
