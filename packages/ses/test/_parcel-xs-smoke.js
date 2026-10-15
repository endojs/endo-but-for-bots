// Run on XS after ./_parcel-shim-first.js and the SES bundle, as a script
// with no test framework: each failed check throws.
const check = (condition, message) => {
  if (!condition) {
    throw Error(`Parcel XS smoke: ${message}`);
  }
};

const fixtureGlobal = /** @type {any} */ (globalThis);
const shimmed = fixtureGlobal.Parcel;
lockdown();

const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Parcel');
check(descriptor?.value === shimmed, 'start binding keeps the shim value');
check(descriptor?.writable === false, 'start binding stays non-writable');
check(descriptor?.configurable === false, 'start binding stays locked');
check(Object.isFrozen(shimmed), 'constructor is hardened');
check(Object.isFrozen(shimmed.prototype), 'prototype is hardened');

const compartment = new Compartment();
const shared = /** @type {any} */ (compartment.globalThis.Parcel);
check(shared !== shimmed, 'child receives the shared constructor');
check(
  compartment.evaluate('Parcel') === shared,
  'child code resolves shared Parcel',
);
check(typeof shimmed.locate === 'function', 'initial constructor has locate');
check(!Object.hasOwn(shared, 'locate'), 'shared constructor omits locate');
check(shared.prototype === shimmed.prototype, 'constructors share a prototype');
check(shared.prototype.constructor === shared, 'prototype points to shared');
const grandchild = compartment.evaluate('new Compartment()');
check(grandchild.globalThis.Parcel === shared, 'grandchild shares it');
