// @ts-nocheck
// Exercises the shim as used in a real HardenedJS realm: lockdown FIRST, then
// the shim installs and hardens after lockdown. Each test pins one distributed
// confinement property from the shim's spec.

import '@endo/init';
import test from 'ava';
import { passStyleOf } from '@endo/pass-style';
import harden from '@endo/harden';
import {
  fromLocation,
  toLocation,
  provideSturdyRef,
  selectSturdyRef,
  makeSturdyRefNamespace,
} from '../src/sturdyref-pony.js';

const { isFrozen } = Object;

// Property (d): the shim initialized after lockdown yields hardened, functioning
// surfaces.
test('installed after lockdown: hardened and functioning', t => {
  const SturdyRef = provideSturdyRef();
  t.is(globalThis.SturdyRef, SturdyRef, 'installed at globalThis.SturdyRef');
  t.true(isFrozen(SturdyRef), 'namespace is hardened');
  t.true(isFrozen(SturdyRef.fromLocation), 'fromLocation is hardened');
  t.true(isFrozen(SturdyRef.toLocation), 'toLocation is hardened');

  const locator = harden({ kind: 'test-locator', endpoint: 'wormhole:abc' });
  const sturdyRef = fromLocation(locator);
  t.true(isFrozen(sturdyRef), 'minted sturdyref is hardened');
  t.is(
    toLocation(sturdyRef),
    locator,
    'round-trips to the same locator record',
  );
});

// Locators are OBJECTS, not strings.
test('locators are objects, not strings', t => {
  t.throws(() => fromLocation('wormhole:abc'), {
    message: /locator record/,
  });
  t.throws(() => fromLocation(42), { message: /locator record/ });
  t.throws(() => fromLocation(null), { message: /locator record/ });
});

// Property (b) — NO LOCATION: a guest holding a sturdyref cannot read a locator
// from it. It is passStyleOf-opaque with no own property leaking locator data;
// only the closely-held namespace can recover the locator.
test('no location: sturdyref is passStyleOf-opaque and leaks no locator', t => {
  const locator = harden({ kind: 'secret-locator', endpoint: 'wormhole:xyz' });
  const sturdyRef = fromLocation(locator);

  t.is(passStyleOf(sturdyRef), 'sturdyRef', 'opaque passable, not a record');

  // No own property (string or symbol) exposes the locator.
  for (const key of Reflect.ownKeys(sturdyRef)) {
    t.not(
      Reflect.get(sturdyRef, key),
      locator,
      `own key ${String(key)} leaks locator`,
    );
  }
  t.deepEqual(Object.keys(sturdyRef), [], 'no enumerable own keys');

  // The locator is recoverable ONLY through the closely-held namespace.
  t.is(toLocation(sturdyRef), locator);
});

// Property — NO IDENTIFICATION: two sturdyrefs minted for the same locator are
// distinct objects, so a guest cannot correlate or recover stable identity.
test('no identification: same locator mints distinct sturdyrefs', t => {
  const locator = harden({ kind: 'shared-locator' });
  const a = fromLocation(locator);
  const b = fromLocation(locator);
  t.not(a, b, 'distinct sturdyref objects');
  t.is(toLocation(a), locator);
  t.is(toLocation(b), locator);
});

// Property (a) — WITHHELD FROM CHILD COMPARTMENTS: the SturdyRef global has no
// SES permit, so a child compartment does not see it.
test('withheld: a child compartment does not see the SturdyRef global', t => {
  provideSturdyRef(); // ensure installed on the start-compartment global
  t.not(globalThis.SturdyRef, undefined, 'present on the start compartment');

  const child = new Compartment();
  t.is(
    child.evaluate('typeof SturdyRef'),
    'undefined',
    'absent from the child compartment global',
  );
});

// Property (c) — FIRST-WINS CONVERGENCE: independent selections in one realm
// converge on the same namespace and therefore the same mapping.
test('first-wins: selections converge on one shared mapping', t => {
  const first = selectSturdyRef();
  const second = selectSturdyRef();
  t.is(first, second, 'both selections yield the one installed namespace');
  t.is(globalThis.SturdyRef, first);

  const locator = harden({ kind: 'converged-locator' });
  const sturdyRef = first.fromLocation(locator);
  t.is(second.toLocation(sturdyRef), locator, 'resolves through either handle');

  // Control: an un-installed namespace has its OWN private mapping, proving the
  // convergence above is real and not an artifact of a single shared closure.
  const isolated = makeSturdyRefNamespace();
  t.not(isolated, first);
  t.throws(() => isolated.toLocation(sturdyRef), {
    message: /Not a SturdyRef known to this realm/,
  });
});
