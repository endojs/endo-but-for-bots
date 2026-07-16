// @ts-check
/* eslint no-bitwise: ["off"] */
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * The LUKS anti-forensic (AF) splitter. A keyslot does not store the
 * volume key directly; it stores `stripes` (4000 by default) "AF blocks"
 * that must all be present to reconstruct the key, so that wiping any part
 * of the keyslot destroys the key beyond forensic recovery. `afMerge`
 * reverses the split, folding the stripes back into the volume key.
 *
 * This implements the `luks1`-type AF used by LUKS2: a hash-based diffuser
 * (here SHA-256) applied between each stripe XOR.
 *
 * @see https://gitlab.com/cryptsetup/cryptsetup
 */

/**
 * The AF diffuser: hash the buffer in digest-sized chunks, each prefixed
 * with its big-endian chunk index, producing a same-length buffer in which
 * every output byte depends on a full hash of its input chunk.
 *
 * @param {Uint8Array} block
 * @param {number} size
 * @returns {Uint8Array}
 */
const diffuse = (block, size) => {
  const digestSize = 32; // SHA-256
  const out = new Uint8Array(size);
  const fullChunks = Math.floor(size / digestSize);
  const remainder = size % digestSize;
  const chunkCount = fullChunks + (remainder > 0 ? 1 : 0);
  for (let i = 0; i < chunkCount; i += 1) {
    const length = i < fullChunks ? digestSize : remainder;
    const prefix = new Uint8Array(4);
    prefix[0] = (i >>> 24) & 0xff;
    prefix[1] = (i >>> 16) & 0xff;
    prefix[2] = (i >>> 8) & 0xff;
    prefix[3] = i & 0xff;
    const hash = sha256.create();
    hash.update(prefix);
    hash.update(block.subarray(i * digestSize, i * digestSize + length));
    out.set(hash.digest().subarray(0, length), i * digestSize);
  }
  return out;
};

/**
 * Merge `stripes` AF blocks of `blockSize` bytes back into a single
 * `blockSize`-byte secret (the volume key).
 *
 * @param {Uint8Array} split Concatenated stripes, length >= stripes * blockSize.
 * @param {number} stripes
 * @param {number} blockSize
 * @returns {Uint8Array}
 */
export const afMerge = (split, stripes, blockSize) => {
  /** @type {Uint8Array} */
  let acc = new Uint8Array(blockSize);
  for (let stripe = 0; stripe < stripes - 1; stripe += 1) {
    const base = stripe * blockSize;
    for (let j = 0; j < blockSize; j += 1) {
      acc[j] ^= split[base + j];
    }
    acc = diffuse(acc, blockSize);
  }
  const last = (stripes - 1) * blockSize;
  for (let j = 0; j < blockSize; j += 1) {
    acc[j] ^= split[last + j];
  }
  return acc;
};
harden(afMerge);
