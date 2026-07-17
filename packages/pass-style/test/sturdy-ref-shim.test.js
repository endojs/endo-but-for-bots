/* global globalThis */
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';

import { passStyleOf } from '../src/passStyleOf.js';
import { isSturdyRef } from '../src/sturdy-ref.js';
import { installSturdyRefShim } from '../src/sturdy-ref-shim.js';

const { isFrozen } = Object;

test('installSturdyRefShim installs a hardened global SturdyRef namespace', t => {
  const SturdyRef = installSturdyRefShim();
  t.is(SturdyRef, installSturdyRefShim(), 'installed once, returned each time');
  t.is(globalThis.SturdyRef, SturdyRef, 'installed on globalThis');
  t.true(isFrozen(SturdyRef), 'namespace is hardened');
  t.is(typeof SturdyRef.fromLocation, 'function');
  t.is(typeof SturdyRef.toLocation, 'function');
  // No SES permit and non-configurable/non-writable: closely held and
  // impossible for a twin to replace.
  const desc = /** @type {PropertyDescriptor} */ (
    Object.getOwnPropertyDescriptor(globalThis, 'SturdyRef')
  );
  t.false(desc.configurable, 'non-configurable');
  t.false(desc.writable, 'non-writable');
  t.false(desc.enumerable, 'non-enumerable');
});

test('the shim is first-wins and idempotent (twins converge)', t => {
  // A second install — as an eval twin of ocapn/captp would do — returns the
  // already-installed namespace rather than replacing it.
  const first = installSturdyRefShim();
  const second = installSturdyRefShim();
  t.is(first, second, 'both twins converge on one namespace');
});

test('fromLocation mints an opaque SturdyRef that toLocation reveals', t => {
  const SturdyRef = installSturdyRefShim();
  const locator = harden({ designator: 'peerB', secret: 's3cr3t' });
  const sturdyRef = SturdyRef.fromLocation(locator);

  t.is(passStyleOf(sturdyRef), 'sturdyRef', 'fromLocation yields a SturdyRef');
  t.true(isSturdyRef(sturdyRef));
  // The locator is reachable only through the closely-held namespace, never
  // through the opaque SturdyRef object.
  t.is(
    SturdyRef.toLocation(sturdyRef),
    locator,
    'toLocation reveals the locator',
  );
  t.deepEqual(Reflect.ownKeys(sturdyRef), [], 'SturdyRef exposes no locator');
  t.false('secret' in sturdyRef, 'secret is not on the SturdyRef');
});

test('the mapping converges across twin namespaces in one realm', t => {
  // Two references to the same realm-global namespace (what distinct eval
  // twins observe) share one mapping.
  const twinA = installSturdyRefShim();
  const twinB = installSturdyRefShim();
  const locator = harden({ designator: 'peerC' });
  const sturdyRef = twinA.fromLocation(locator);
  t.is(twinB.toLocation(sturdyRef), locator, 'twin B reveals twin A locator');
});

test('toLocation returns undefined for an unregistered SturdyRef', t => {
  const SturdyRef = installSturdyRefShim();
  const foreign = harden({ not: 'a sturdyref' });
  t.is(SturdyRef.toLocation(/** @type {any} */ (foreign)), undefined);
});

test('fromLocation refuses a non-object locator (no URL/URN coupling)', t => {
  const SturdyRef = installSturdyRefShim();
  t.throws(
    () => SturdyRef.fromLocation(/** @type {any} */ ('ocapn://peerB/s')),
    {
      message: /object locator/,
    },
  );
  t.throws(() => SturdyRef.fromLocation(/** @type {any} */ (null)), {
    message: /object locator/,
  });
});
