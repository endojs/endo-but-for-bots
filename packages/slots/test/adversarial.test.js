// @ts-nocheck

// Adversarial inputs.  These complement the happy-path tests by
// exercising the decoder paths that defend the trust boundary
// between the JS client and an untrusted peer (or a corrupt frame
// from a transport bug).

import test from '@endo/ses-ava/prepare-endo.js';

import {
  makeReader,
  readUint,
  readByteString,
  readArrayHeader,
  assertConsumed,
} from '../src/cbor.js';
import { decodeDescriptor } from '../src/descriptor.js';
import {
  decodeDeliverPayload,
  decodeResolvePayload,
  decodeDropPayload,
  decodeAbortPayload,
} from '../src/payload.js';

test('cbor — truncated multi-byte head', t => {
  // 0x18 announces a one-byte uint follow-up but supplies none.
  const r = makeReader(new Uint8Array([0x18]));
  t.throws(() => readUint(r), { message: /EOF/ });
});

test('cbor — byte string body shorter than declared length', t => {
  // 0x44 = byte-string of length 4, but only one body byte follows.
  const r = makeReader(new Uint8Array([0x44, 0xff]));
  t.throws(() => readByteString(r), { message: /truncated/ });
});

test('cbor — additional info 28 (unsupported indefinite)', t => {
  const r = makeReader(new Uint8Array([0x1c]));
  t.throws(() => readUint(r), { message: /unsupported additional info/ });
});

test('cbor — additional info 31 (break)', t => {
  const r = makeReader(new Uint8Array([0x1f]));
  t.throws(() => readUint(r), { message: /unsupported additional info/ });
});

test('cbor — array header with valid length and assertConsumed catches trailing', t => {
  const r = makeReader(new Uint8Array([0x80, 0x00]));
  t.is(readArrayHeader(r), 0);
  t.throws(() => assertConsumed(r), { message: /trailing/ });
});

test('descriptor — every reserved bit pattern is rejected', t => {
  // Bits 3..7 of the kind byte are reserved.  Build the descriptor
  // CBOR explicitly: array(2), uint(kindByte), uint(0).  Values
  // ≤ 23 fit inline (`0x00 + n`); values 24..255 take the head
  // form `0x18 nn`.
  const cborUint = (/** @type {number} */ n) => (n <= 23 ? [n] : [0x18, n]);
  for (const reserved of [0x08, 0x10, 0x20, 0x40, 0x80, 0xf8, 0xff]) {
    const bytes = new Uint8Array([0x82, ...cborUint(reserved), 0x00]);
    t.throws(() => decodeDescriptor(bytes), { message: /reserved bits/ });
  }
});

test('descriptor — array of length 4 is rejected', t => {
  t.throws(
    () => decodeDescriptor(new Uint8Array([0x84, 0x00, 0x00, 0x00, 0x00])),
    { message: /2-element/ },
  );
});

test('descriptor — non-array head is rejected', t => {
  // 0x00 is uint(0), not an array.
  t.throws(() => decodeDescriptor(new Uint8Array([0x00])), {
    message: /expected array/,
  });
});

test('deliver payload — 4-element array is rejected', t => {
  // array(4): would parse target/body/targets/promises and miss reply.
  const bad = new Uint8Array([
    0x84,
    0x82,
    0x00,
    0x00, // descriptor [Local,Object,0]
    0x40, // body: empty bytes
    0x80, // targets: empty array
    0x80, // promises: empty array
  ]);
  t.throws(() => decodeDeliverPayload(bad), { message: /5-element array/ });
});

test('deliver payload — extra element after array(5) caught by trailing-byte guard', t => {
  // array(5) full deliver, then an extra trailing 0x00 outside.
  const valid = new Uint8Array([
    0x85, 0x82, 0x00, 0x00, 0x40, 0x80, 0x80, 0xf6,
  ]);
  const padded = new Uint8Array([...valid, 0x00]);
  t.throws(() => decodeDeliverPayload(padded), { message: /trailing/ });
});

test('resolve payload — is_reject = 5 is rejected', t => {
  const bad = new Uint8Array([
    0x85,
    0x82,
    0x02,
    0x00, // [Local,Promise,0]
    0x05, // is_reject = 5 (only 0 or 1 allowed)
    0x40,
    0x80,
    0x80,
  ]);
  t.throws(() => decodeResolvePayload(bad), { message: /0 or 1/ });
});

test('drop payload — entry of arity 3 is rejected', t => {
  // array(1) of array(3) [target, ram, clist] — missing export.
  const bad = new Uint8Array([
    0x81,
    0x83,
    0x82,
    0x00,
    0x00, // descriptor
    0x01, // ram
    0x00, // clist
  ]);
  t.throws(() => decodeDropPayload(bad), { message: /4-element/ });
});

test('abort payload — invalid UTF-8 in reason is rejected', t => {
  // Byte string of length 2 with bytes 0xff 0xfe — invalid UTF-8.
  const bad = new Uint8Array([0x42, 0xff, 0xfe]);
  t.throws(() => decodeAbortPayload(bad), { message: /utf-8/ });
});

test('abort payload — wrong major (uint) is rejected', t => {
  const bad = new Uint8Array([0x05]);
  t.throws(() => decodeAbortPayload(bad), {
    message: /expected byte string/,
  });
});

test('abort payload — trailing bytes after byte string are rejected', t => {
  const bad = new Uint8Array([0x40, 0x00]); // empty bytes + trailing 0x00
  t.throws(() => decodeAbortPayload(bad), { message: /trailing/ });
});
