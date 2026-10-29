// @ts-nocheck
// XS smoke check for a host without TextEncoder and TextDecoder: lockdown must
// proceed without them and compartments must observe their absence.
// Lockdown happens once per realm, so ../scripts/generate-test-xs.js bundles
// this as its own xst script.

/* global globalThis, print */

import './_xs-delete-text-codecs.js';
// eslint-disable-next-line import/no-extraneous-dependencies
import 'ses';

assert.equal(typeof globalThis.TextEncoder, 'undefined', 'TextEncoder deleted');
assert.equal(typeof globalThis.TextDecoder, 'undefined', 'TextDecoder deleted');

lockdown();

print('# compartments observe the absence of the host text codecs');
{
  const compartment = new Compartment();
  assert.equal(
    compartment.evaluate('typeof TextEncoder'),
    'undefined',
    'compartment lacks TextEncoder',
  );
  assert.equal(
    compartment.evaluate('typeof TextDecoder'),
    'undefined',
    'compartment lacks TextDecoder',
  );
}

print('ok');
