// @ts-nocheck
/* global globalThis */
import test from 'ava';
import '../index.js';

// Delete before lockdown so the intrinsics-collection pass sees a host without
// URL, as on XS. AVA runs each test file in its own worker.
delete globalThis.URL;
delete globalThis.URLSearchParams;

lockdown();

test('lockdown succeeds on a host without URL', t => {
  t.is(globalThis.URL, undefined);
  t.is(globalThis.URLSearchParams, undefined);
});

test('compartments observe the absence of URL', t => {
  const c = new Compartment();
  t.is(c.evaluate('typeof URL'), 'undefined');
  t.is(c.evaluate('typeof URLSearchParams'), 'undefined');
});
