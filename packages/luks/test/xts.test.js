/* global Buffer */
/* eslint no-bitwise: ["off"] */
import test from '@endo/ses-ava/test.js';
import crypto from 'node:crypto';

import { makeXtsCodec } from '../src/xts.js';

// `aes-xts-plain64` tweaks each sector with the sector number encoded as a
// 128-bit little-endian integer. Node's `crypto` implements XTS over a
// single data unit, with the IV being exactly that tweak — so a single
// sector of our codec must match one Node XTS operation. This gives an
// independent known-answer cross-check that runs anywhere Node does, with
// no external tools or committed binary fixtures.

const plain64Iv = sector => {
  const iv = Buffer.alloc(16);
  let n = BigInt(sector);
  for (let i = 0; i < 16 && n > 0n; i += 1) {
    iv[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return iv;
};

/** @param {number} n @param {number} step */
const ramp = (n, step) => {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    bytes[i] = (i * step) & 0xff;
  }
  return bytes;
};

const nodeXts = (algo, key, sector, data, decrypt) => {
  const iv = plain64Iv(sector);
  const cipher = decrypt
    ? crypto.createDecipheriv(algo, key, iv)
    : crypto.createCipheriv(algo, key, iv);
  return new Uint8Array(
    Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]),
  );
};

/** @type {Array<[number, string, number]>} */
const cases = [
  [128, 'aes-128-xts', 32],
  [256, 'aes-256-xts', 64],
];
for (const [bits, algo, keyLen] of cases) {
  test(`XTS-AES-${bits} matches node:crypto across sectors`, t => {
    const key = ramp(keyLen, 1);
    const codec = makeXtsCodec(key);
    const plaintext = ramp(64, 7); // one 64-byte sector (4 AES blocks)
    for (const sector of [0, 1, 5, 42, 1000, 0x1_0000_0001]) {
      const expectedCt = nodeXts(
        algo,
        Buffer.from(key),
        sector,
        plaintext,
        false,
      );
      const actualCt = codec.encrypt(plaintext, sector, 64);
      t.deepEqual(actualCt, expectedCt, `encrypt sector ${sector}`);
      const actualPt = codec.decrypt(expectedCt, sector, 64);
      t.deepEqual(actualPt, plaintext, `decrypt sector ${sector}`);
    }
  });
}

test('XTS decrypts multi-sector buffers with per-sector tweaks', t => {
  const key = ramp(64, 3);
  const codec = makeXtsCodec(key);
  const sectorSize = 512;
  const firstSector = 7;
  const plaintext = ramp(sectorSize * 3, 5);

  // Build the expected ciphertext one sector at a time, the way dm-crypt
  // lays it out, then confirm our codec decrypts the whole run at once.
  const expected = new Uint8Array(plaintext.length);
  for (let i = 0; i < 3; i += 1) {
    const slice = plaintext.subarray(i * sectorSize, (i + 1) * sectorSize);
    const ct = nodeXts(
      'aes-256-xts',
      Buffer.from(key),
      firstSector + i,
      slice,
      false,
    );
    expected.set(ct, i * sectorSize);
  }

  t.deepEqual(codec.encrypt(plaintext, firstSector, sectorSize), expected);
  t.deepEqual(codec.decrypt(expected, firstSector, sectorSize), plaintext);
});

test('XTS rejects bad key and unaligned lengths', t => {
  t.throws(() => makeXtsCodec(new Uint8Array(16)), {
    message: /must be 32 or 64 bytes/,
  });
  const codec = makeXtsCodec(ramp(64, 1));
  t.throws(() => codec.decrypt(new Uint8Array(70), 0, 512), {
    message: /not a multiple of sector size/,
  });
});
