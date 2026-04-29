// @ts-check

import test from '@endo/ses-ava/test.js';

import {
  chacha20Block,
  chacha20State,
  makeChaCha20Source,
} from '../src/chacha20.js';

/** @param {string} hex */
const hexToBytes = hex => {
  const clean = hex.replace(/[\s:]/g, '');
  if (clean.length % 2 !== 0) throw Error('odd hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

/** @param {Uint8Array} bytes */
const bytesToHex = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    s += b < 16 ? `0${b.toString(16)}` : b.toString(16);
  }
  return s;
};

// RFC 8439 §2.3.2 — Test Vector for the ChaCha20 Block Function.
// https://datatracker.ietf.org/doc/html/rfc8439#section-2.3.2
test('RFC 8439 §2.3.2 block function test vector', t => {
  const key = hexToBytes(
    '00:01:02:03:04:05:06:07:08:09:0a:0b:0c:0d:0e:0f:10:11:12:13:14:15:16:17:18:19:1a:1b:1c:1d:1e:1f',
  );
  const nonce = hexToBytes('00:00:00:09:00:00:00:4a:00:00:00:00');
  const counter = 1;
  const expected = hexToBytes(
    '10 f1 e7 e4 d1 3b 59 15 50 0f dd 1f a3 20 71 c4' +
      ' c7 d1 f4 c7 33 c0 68 03 04 22 aa 9a c3 d4 6c 4e' +
      ' d2 82 64 46 07 9f aa 09 14 c2 d7 05 d9 8b 02 a2' +
      ' b5 12 9c d1 de 16 4e b9 cb d0 83 e8 a2 50 3c 4e',
  );

  const state = chacha20State(key, nonce, counter);
  const out = new Uint8Array(64);
  chacha20Block(state, out);
  t.is(bytesToHex(out), bytesToHex(expected));
});

// RFC 8439 §2.4.2 — Encryption Test Vector.
// We treat the cipher as keystream by XORing the plaintext with the
// keystream and comparing against the ciphertext.  The keystream
// here spans two blocks, starting at counter = 1 per the test
// vector (RFC encrypts with counter starting at 1; counter 0 is
// the Poly1305 key block).
test('RFC 8439 §2.4.2 encryption test vector', t => {
  const key = hexToBytes(
    '00:01:02:03:04:05:06:07:08:09:0a:0b:0c:0d:0e:0f:10:11:12:13:14:15:16:17:18:19:1a:1b:1c:1d:1e:1f',
  );
  const nonce = hexToBytes('00:00:00:00:00:00:00:4a:00:00:00:00');
  const plaintext =
    "Ladies and Gentlemen of the class of '99: " +
    'If I could offer you only one tip for the future, sunscreen would be it.';
  // ASCII; portable across realms.
  const pt = new Uint8Array(plaintext.length);
  for (let i = 0; i < plaintext.length; i += 1) pt[i] = plaintext.charCodeAt(i);
  const expectedCiphertext = hexToBytes(
    '6e 2e 35 9a 25 68 f9 80 41 ba 07 28 dd 0d 69 81' +
      ' e9 7e 7a ec 1d 43 60 c2 0a 27 af cc fd 9f ae 0b' +
      ' f9 1b 65 c5 52 47 33 ab 8f 59 3d ab cd 62 b3 57' +
      ' 16 39 d6 24 e6 51 52 ab 8f 53 0c 35 9f 08 61 d8' +
      ' 07 ca 0d bf 50 0d 6a 61 56 a3 8e 08 8a 22 b6 5e' +
      ' 52 bc 51 4d 16 cc f8 06 81 8c e9 1a b7 79 37 36' +
      ' 5a f9 0b bf 74 a3 5b e6 b4 0b 8e ed f2 78 5e 42' +
      ' 87 4d',
  );

  // Two keystream blocks at counters 1 and 2.
  const ks = new Uint8Array(128);
  const block = new Uint8Array(64);
  let state = chacha20State(key, nonce, 1);
  chacha20Block(state, block);
  for (let i = 0; i < 64; i += 1) ks[i] = block[i];
  state = chacha20State(key, nonce, 2);
  chacha20Block(state, block);
  for (let i = 0; i < 64; i += 1) ks[64 + i] = block[i];

  const ct = new Uint8Array(pt.length);
  for (let i = 0; i < pt.length; i += 1) {
    // eslint-disable-next-line no-bitwise
    ct[i] = pt[i] ^ ks[i];
  }
  t.is(bytesToHex(ct), bytesToHex(expectedCiphertext));
});

test('makeChaCha20Source rejects bad keys', t => {
  t.throws(() => makeChaCha20Source(/** @type {any} */ (null)), {
    instanceOf: TypeError,
  });
  t.throws(() => makeChaCha20Source(new Uint8Array(31)), {
    instanceOf: TypeError,
  });
  t.throws(() => makeChaCha20Source(new Uint8Array(33)), {
    instanceOf: TypeError,
  });
});

test('makeChaCha20Source pullBlock validates output', t => {
  const src = makeChaCha20Source(new Uint8Array(32));
  t.throws(() => src.pullBlock(new Uint8Array(63)), { instanceOf: TypeError });
  t.throws(() => src.pullBlock(new Uint8Array(65)), { instanceOf: TypeError });
});

test('makeChaCha20Source first block: counter=0 nonce=0, all-zero key', t => {
  // Pinned reference: ChaCha20 keystream first 64 bytes for
  // key=all zeros, nonce=all zeros, counter=0.  Computed once via
  // a separate reference implementation; matches Node-crypto.
  const src = makeChaCha20Source(new Uint8Array(32));
  const out = new Uint8Array(64);
  src.pullBlock(out);
  // RFC 8439 §2.3.2 has a vector for "key=all zero, nonce=all zero,
  // counter=0":
  //  76 b8 e0 ad a0 f1 3d 90 40 5d 6a e5 53 86 bd 28
  //  bd d2 19 b8 a0 8d ed 1a a8 36 ef cc 8b 770d c7
  //  da 41 59 7c 51 57 48 8d 77 24 e0 3f b8 d8 4a 37
  //  6a 43 b8 f4 15 18 a1 1c c3 87 b6 69 b2 ee 65 86
  // (Test Vectors for the ChaCha20 Block Function, vector #1.)
  const expected = hexToBytes(
    '76 b8 e0 ad a0 f1 3d 90 40 5d 6a e5 53 86 bd 28' +
      ' bd d2 19 b8 a0 8d ed 1a a8 36 ef cc 8b 77 0d c7' +
      ' da 41 59 7c 51 57 48 8d 77 24 e0 3f b8 d8 4a 37' +
      ' 6a 43 b8 f4 15 18 a1 1c c3 87 b6 69 b2 ee 65 86',
  );
  t.is(bytesToHex(out), bytesToHex(expected));
});

test('makeChaCha20Source advances counter monotonically', t => {
  // Two consecutive blocks must differ; the state machine must
  // advance.
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) key[i] = i;
  const src = makeChaCha20Source(key);
  const a = new Uint8Array(64);
  const b = new Uint8Array(64);
  src.pullBlock(a);
  src.pullBlock(b);
  t.not(bytesToHex(a), bytesToHex(b));
});
