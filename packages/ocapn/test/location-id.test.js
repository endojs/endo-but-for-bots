// @ts-check

import test from '@endo/ses-ava/test.js';

import { locationNetworkId, locationToLocationId } from '../src/client/util.js';

/**
 * @import { OcapnLocation } from '../src/codecs/components.js'
 */

const designator = 'ab'.repeat(32);

/**
 * @param {Partial<OcapnLocation>} fields
 * @returns {OcapnLocation}
 */
const makeLocation = fields => ({
  type: 'ocapn-peer',
  transport: 'np',
  designator,
  hints: false,
  ...fields,
});

/**
 * @param {OcapnLocation} location
 * @returns {string}
 */
const idOf = location => String(locationToLocationId(location));

test('locationNetworkId prefers network over the legacy transport', t => {
  t.is(locationNetworkId({ network: 'np', transport: 'legacy' }), 'np');
  t.is(locationNetworkId({ transport: 'websocket' }), 'websocket');
});

test('np location ID is (network, designator) and ignores hints', t => {
  const bare = makeLocation({});
  const tcp = makeLocation({ hints: { 'tcp+cbor': '127.0.0.1:3469' } });
  const dual = makeLocation({
    network: 'np',
    hints: {
      'tcp+cbor': '[::1]:3469',
      'wss+cbor': 'minion.town:443/.well-known/ocapn-cbor-np',
    },
  });
  const expected = `ocapn://${designator}.np`;
  t.is(idOf(bare), expected);
  t.is(idOf(tcp), expected);
  t.is(idOf(dual), expected);
});

test('np location ID distinguishes designators', t => {
  const other = 'cd'.repeat(32);
  t.not(idOf(makeLocation({})), idOf(makeLocation({ designator: other })));
});

test('legacy netlayer location ID keeps sorted hints', t => {
  const location = makeLocation({
    transport: 'tcp-testing-only',
    network: 'tcp-testing-only',
    hints: { port: '22046', host: '127.0.0.1' },
  });
  t.is(
    idOf(location),
    `ocapn://${designator}.tcp-testing-only?host=127.0.0.1&port=22046`,
  );
});

test('location ID keys on network, not the legacy transport field', t => {
  const location = makeLocation({ transport: 'legacy', network: 'np' });
  t.is(idOf(location), `ocapn://${designator}.np`);
});
