// @ts-check

import test from '@endo/ses-ava/test.js';
import {
  parseSturdyRefUri,
  formatSturdyRefUri,
  swissnumFromBytes,
  swissnumToBytes,
} from '../index.js';

/**
 * @import { OcapnLocation } from '../src/codecs/components.js'
 */

/** @type {OcapnLocation} */
const baseLocation = {
  type: 'ocapn-peer',
  designator: 'a2ef69ddd5f84840970612ff660f5058',
  transport: 'tcp-testing-only',
  hints: false,
};

test('format then parse round-trips a swiss-num verbatim', t => {
  const swissBytes = Uint8Array.from({ length: 24 }, (_, i) => i);
  const uri = formatSturdyRefUri({
    location: baseLocation,
    swissNum: swissBytes,
  });
  const parsed = parseSturdyRefUri(uri);
  t.is(parsed.kind, 'sturdyref');
  t.deepEqual(parsed.location, baseLocation);
  t.truthy(parsed.swissNum);
  t.deepEqual(
    swissnumToBytes(/** @type {any} */ (parsed.swissNum)),
    swissBytes,
    'swiss-num bytes survive the round-trip unchanged',
  );
});

test('base64url(no-padding) vectors match Goblins ids.scm encoding', t => {
  // The `/s/<…>` segment is base64url (RFC 4648 §5) of the raw swiss-num
  // bytes, no padding, per the OCapN Locators draft URI Serialization
  // section and Spritely Goblins' `goblins/ocapn/ids.scm`
  // (`string->ocapn-id`, `#:alphabet base64-url-alphabet #:padding? #f`).
  /** @type {Array<{ bytes: number[], segment: string }>} */
  const vectors = [
    // 24-byte Goblins-style random (here 0x00..0x17), no padding.
    {
      bytes: [...Array(24).keys()],
      segment: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYX',
    },
    // Exercises both URL-alphabet substitutions (`-` for `+`, `_` for `/`).
    { bytes: [0xfb, 0xff, 0xbf, 0xd0, 0x0f], segment: '-_-_0A8' },
    { bytes: [0xfb, 0xef, 0xff], segment: '--__' },
  ];
  for (const { bytes, segment } of vectors) {
    const swissBytes = Uint8Array.from(bytes);
    const uri = formatSturdyRefUri({
      location: baseLocation,
      swissNum: swissBytes,
    });
    t.is(
      uri,
      `ocapn://${baseLocation.designator}.${baseLocation.transport}/s/${segment}`,
      `formats ${segment} without padding`,
    );
    const parsed = parseSturdyRefUri(uri);
    t.deepEqual(
      swissnumToBytes(/** @type {any} */ (parsed.swissNum)),
      swissBytes,
      `parses ${segment} back to the raw bytes`,
    );
  }
});

test('a SwissNum (branded immutable) is accepted by format', t => {
  const swissBytes = Uint8Array.from([1, 2, 3, 4, 5]);
  const swissNum = swissnumFromBytes(swissBytes);
  const fromBranded = formatSturdyRefUri({
    location: baseLocation,
    swissNum,
  });
  const fromRaw = formatSturdyRefUri({
    location: baseLocation,
    swissNum: swissBytes,
  });
  t.is(fromBranded, fromRaw, 'SwissNum and Uint8Array format identically');
});

test('hints round-trip through the URI query string', t => {
  /** @type {OcapnLocation} */
  const location = {
    type: 'ocapn-peer',
    designator: 'peer1',
    transport: 'tcp-testing-only',
    hints: { host: '127.0.0.1', port: '22046', url: 'ws://127.0.0.1:8080' },
  };
  const swissBytes = Uint8Array.from([9, 8, 7]);
  const uri = formatSturdyRefUri({ location, swissNum: swissBytes });
  const parsed = parseSturdyRefUri(uri);
  t.deepEqual(parsed.location.hints, location.hints, 'hints survive verbatim');
  t.deepEqual(swissnumToBytes(/** @type {any} */ (parsed.swissNum)), swissBytes);
});

test('hint keys are sorted for byte-stable output', t => {
  /** @type {OcapnLocation} */
  const location = {
    type: 'ocapn-peer',
    designator: 'peer1',
    transport: 'tcp-testing-only',
    hints: { zeta: '1', alpha: '2', mu: '3' },
  };
  const uri = formatSturdyRefUri({ location, swissNum: Uint8Array.from([0]) });
  t.true(
    uri.endsWith('?alpha=2&mu=3&zeta=1'),
    `keys sorted regardless of insertion order: ${uri}`,
  );
});

test('a plain peer URI carries no swiss-num', t => {
  const uri = formatSturdyRefUri({ location: baseLocation });
  t.is(
    uri,
    `ocapn://${baseLocation.designator}.${baseLocation.transport}`,
    'no /s/ segment when swissNum is omitted',
  );
  const parsed = parseSturdyRefUri(uri);
  t.is(parsed.kind, 'peer');
  t.is(parsed.swissNum, undefined);
  t.deepEqual(parsed.location, baseLocation);
});

test('parse rejects malformed URIs', t => {
  t.throws(() => parseSturdyRefUri('https://example.com/'), {
    message: /Not a valid ocapn/,
  });
  t.throws(() => parseSturdyRefUri('ocapn://nohostdot/s/AAAA'), {
    message: /<designator>\.<transport>/,
  });
  t.throws(() => parseSturdyRefUri('ocapn://p.tcp/wrong/path'), {
    message: /Unsupported OCapN URI path/,
  });
  t.throws(() => parseSturdyRefUri('ocapn://p.tcp/s/not*base64url'), {
    message: /base64url/,
  });
  t.throws(() => parseSturdyRefUri('ocapn://user:pw@p.tcp/s/AAAA'), {
    message: /userinfo or port/,
  });
});
