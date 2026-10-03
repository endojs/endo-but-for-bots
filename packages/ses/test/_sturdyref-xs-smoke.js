// Run on XS after ./_sturdyref-shim-first.js and the SES bundle, as a script
// with no test framework: each failed check throws.
/* global SturdyRef */

const check = (condition, message) => {
  if (!condition) {
    throw Error(`SturdyRef XS smoke: ${message}`);
  }
};

const shimmed = SturdyRef;
lockdown();

const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'SturdyRef');
check(descriptor?.value === shimmed, 'start binding keeps the shim value');
check(descriptor?.writable === false, 'start binding stays non-writable');
check(descriptor?.configurable === false, 'start binding stays locked');
check(Object.isFrozen(shimmed), 'constructor is hardened');
check(Object.isFrozen(shimmed.prototype), 'prototype is hardened');

const c = new Compartment();
check(c.globalThis.SturdyRef === shimmed, 'child shares the constructor');
check(c.evaluate('SturdyRef') === shimmed, 'child code resolves SturdyRef');
const grandchild = c.evaluate('new Compartment()');
check(grandchild.globalThis.SturdyRef === shimmed, 'grandchild shares it');
