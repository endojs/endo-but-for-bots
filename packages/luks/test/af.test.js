/* eslint no-bitwise: ["off"] */
import test from '@endo/ses-ava/test.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { afMerge } from '../src/af.js';

// An independent implementation of the LUKS AF *splitter* (the inverse of
// afMerge), written from the spec, so the round-trip exercises afMerge
// against a second implementation rather than itself. The diffuser here is
// re-derived from the format description (SHA-256, big-endian chunk index).

/** @param {Uint8Array} block @param {number} size */
const diffuse = (block, size) => {
  const ds = 32;
  const out = new Uint8Array(size);
  for (let i = 0; i * ds < size; i += 1) {
    const len = Math.min(ds, size - i * ds);
    const prefix = new Uint8Array(4);
    prefix[0] = (i >>> 24) & 0xff;
    prefix[1] = (i >>> 16) & 0xff;
    prefix[2] = (i >>> 8) & 0xff;
    prefix[3] = i & 0xff;
    const h = sha256.create();
    h.update(prefix);
    h.update(block.subarray(i * ds, i * ds + len));
    out.set(h.digest().subarray(0, len), i * ds);
  }
  return out;
};

// Deterministic "random" stripe filler so the test is reproducible.
/** @param {Uint8Array} buf @param {number} seed */
const fill = (buf, seed) => {
  let x = seed >>> 0;
  for (let i = 0; i < buf.length; i += 1) {
    x = (x * 1_664_525 + 1_013_904_223) >>> 0;
    buf[i] = (x >>> 24) & 0xff;
  }
  return buf;
};

/** @param {Uint8Array} key @param {number} stripes */
const afSplit = (key, stripes) => {
  const blockSize = key.length;
  const split = new Uint8Array(stripes * blockSize);
  let acc = new Uint8Array(blockSize);
  for (let s = 0; s < stripes - 1; s += 1) {
    const stripe = fill(new Uint8Array(blockSize), s + 1);
    split.set(stripe, s * blockSize);
    for (let j = 0; j < blockSize; j += 1) {
      acc[j] ^= stripe[j];
    }
    acc = diffuse(acc, blockSize);
  }
  const last = (stripes - 1) * blockSize;
  for (let j = 0; j < blockSize; j += 1) {
    split[last + j] = acc[j] ^ key[j];
  }
  return split;
};

test('afMerge inverts an independent afSplit', t => {
  const key = fill(new Uint8Array(64), 912_559);
  for (const stripes of [1, 2, 4, 4000]) {
    const split = afSplit(key, stripes);
    t.deepEqual(afMerge(split, stripes, 64), key, `stripes=${stripes}`);
  }
});

test('afMerge of a single stripe returns the stripe', t => {
  const key = fill(new Uint8Array(32), 7);
  t.deepEqual(afMerge(key, 1, 32), key);
});
