/* global globalThis */

import '../index.js';
import test from 'ava';

// On hosts without the WHATWG Encoding Standard codecs (e.g. XS), the
// sampling pass simply skips the absent permits and lockdown proceeds.
// Simulate that host by deleting the constructors before lockdown.
// See designs/hardened-text-codecs-shim.md § "degradation on hosts
// without the codecs".

Reflect.deleteProperty(globalThis, 'TextEncoder');
Reflect.deleteProperty(globalThis, 'TextDecoder');

lockdown();

test('lockdown tolerates a host missing the text codecs', t => {
  const c = new Compartment();
  t.is(c.evaluate('typeof TextEncoder'), 'undefined');
  t.is(c.evaluate('typeof TextDecoder'), 'undefined');
});
