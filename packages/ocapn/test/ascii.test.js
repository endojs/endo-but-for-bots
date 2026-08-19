// @ts-check

import { bytesFromImmutable } from '@endo/bytes/from-immutable.js';
import { bytesToImmutable } from '@endo/bytes/to-immutable.js';
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';

import {
  decodeSwissnum,
  encodeSwissnum,
  swissnumFromBytes,
} from '../src/client/util.js';
import { makeSturdyRefTracker } from '../src/client/sturdyrefs.js';
import { makeHandoffSessionKey, makeOcapnHub } from '../src/hub/hub.js';
import { syrupCodec } from '../src/syrup/index.js';

/** @import { OcapnLocation } from '../src/codecs/components.js' */

test('encodeSwissnum preserves every ASCII byte', t => {
  let asciiText = '';
  const expectedBytes = new Uint8Array(0x80);
  for (let codeUnit = 0; codeUnit < 0x80; codeUnit += 1) {
    asciiText += String.fromCharCode(codeUnit);
    expectedBytes[codeUnit] = codeUnit;
  }

  const swissnum = encodeSwissnum(asciiText);
  t.true(Object.isFrozen(swissnum));
  t.deepEqual(bytesFromImmutable(swissnum), expectedBytes);
});

test('encodeSwissnum rejects U+0080', t => {
  t.throws(() => encodeSwissnum('\x80'), {
    instanceOf: RangeError,
    message: /Non-ASCII code unit 0x80 at offset 0 of string swissnum/,
  });
});

test('decodeSwissnum round-trips every ASCII byte', t => {
  let asciiText = '';
  for (let codeUnit = 0; codeUnit < 0x80; codeUnit += 1) {
    asciiText += String.fromCharCode(codeUnit);
  }

  t.is(decodeSwissnum(encodeSwissnum(asciiText)), asciiText);
});

test('swissnum wrappers round-trip beyond the ASCII decoder chunk size', t => {
  let asciiText = '';
  for (let index = 0; index < 4096 * 2 + 1; index += 1) {
    asciiText += String.fromCharCode(index % 0x80);
  }

  t.is(decodeSwissnum(encodeSwissnum(asciiText)), asciiText);
});

test('decodeSwissnum rejects a non-ASCII wire byte', t => {
  // A raw-bytes swissnum carrying 0x80 must not silently decode to a
  // windows-1252 character (the trap `TextDecoder('ascii')` falls into);
  // the string form of a swissnum is 7-bit ASCII by construction.
  t.throws(() => decodeSwissnum(swissnumFromBytes(Uint8Array.of(0x80))), {
    instanceOf: RangeError,
    message: /Non-ASCII byte 0x80 at offset 0 of bytes swissnum/,
  });
});

test('hub string swissnums reject U+0080 without restricting bytes', t => {
  const hub = makeOcapnHub({ codec: syrupCodec });

  t.throws(() => hub.unpublish('\x80'), {
    instanceOf: RangeError,
    message: /Non-ASCII code unit 0x80 at offset 0 of string swissnum/,
  });
  hub.publish(Uint8Array.of(0x80), {
    session: 'byte-swissnum-origin',
    position: 0n,
  });
  t.deepEqual(hub.inspect().publishedOrigins, ['byte-swissnum-origin']);
  hub.unpublish(bytesToImmutable(Uint8Array.of(0x80)));
  t.deepEqual(hub.inspect().publishedOrigins, []);
});

test('sturdyref lookup falls back to raw non-ASCII bytes', async t => {
  /** @type {unknown} */
  let lookedUp;
  const tracker = makeSturdyRefTracker({
    get: secret => {
      lookedUp = secret;
      return undefined;
    },
  });

  await tracker.lookup(Uint8Array.of(0x80).buffer);
  t.deepEqual(lookedUp, Uint8Array.of(0x80));
});

test('handoff session keys admit Unicode exporter locations', t => {
  /** @type {OcapnLocation} */
  const unicodeLocation = harden({
    type: 'ocapn-peer',
    transport: 'tcp-test-only',
    designator: 'caf\u00e9',
    hints: false,
  });
  const key = makeHandoffSessionKey(unicodeLocation);
  t.is(
    key,
    'handoff:7b2274797065223a226f6361706e2d70656572222c227472616e73706f7274223a227463702d746573742d6f6e6c79222c2264657369676e61746f72223a22636166c3a9222c2268696e7473223a66616c73657d',
  );
  t.not(key, makeHandoffSessionKey({ ...unicodeLocation, designator: 'cafe' }));
});
