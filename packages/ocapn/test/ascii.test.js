// @ts-check

import { bytesFromImmutable } from '@endo/bytes/from-immutable.js';
import { bytesToImmutable } from '@endo/bytes/to-immutable.js';
import test from '@endo/ses-ava/test.js';

import {
  decodeSwissnum,
  encodeSwissnum,
  swissnumFromBytes,
} from '../src/client/util.js';
import { makeOcapnHub } from '../src/hub/hub.js';
import { syrupCodec } from '../src/syrup/index.js';

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
  t.notThrows(() => hub.unpublish(Uint8Array.of(0x80)));
  t.notThrows(() => hub.unpublish(bytesToImmutable(Uint8Array.of(0x80))));
});
