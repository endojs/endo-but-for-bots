// @ts-check
/* global globalThis */
// Verifies the legacy back-compat path: when the registered-symbol
// slot is empty but `globalThis.HandledPromise` is set (the older
// `@endo/eventual-send/shim.js` convention), the ponyfill adopts the
// global rather than installing its own. This preserves the existing
// `@endo/init` workflow during the migration to the registered-symbol
// slot.

import 'ses';
import test from 'ava';

const symbolForDelegate = Symbol.for('delegate');

const legacyGlobal = function LegacyHandledPromise() {};
/** @type {any} */ (legacyGlobal).source = 'legacy-global';

// Plant the legacy global BEFORE importing the ponyfill, with the
// registered-symbol slot left empty.
/** @type {any} */ (globalThis).HandledPromise = legacyGlobal;

const { getHandledPromise } = await import('../handled-promise.js');

test.serial('ponyfill adopts globalThis.HandledPromise', t => {
  // Slot must be empty for this scenario.
  t.is(
    /** @type {any} */ (Promise)[symbolForDelegate],
    undefined,
    'precondition: slot is empty',
  );
  const hp = getHandledPromise();
  t.is(/** @type {any} */ (hp), legacyGlobal, 'returned the legacy global');
  t.is(/** @type {any} */ (hp).source, 'legacy-global');
});

test.serial('adopting the global does not install at the slot', t => {
  getHandledPromise();
  t.is(
    /** @type {any} */ (Promise)[symbolForDelegate],
    undefined,
    'slot stays empty after adoption',
  );
});
