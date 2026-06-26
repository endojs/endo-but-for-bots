// @ts-check
/* eslint no-bitwise: ["off"] */
import { unsafe } from '@noble/ciphers/aes.js';
import { makeError, q, X } from '@endo/errors';

const { expandKeyLE, expandKeyDecLE, encryptBlock, decryptBlock } = unsafe;

const BLOCK = 16;

/**
 * Multiply a 128-bit XTS tweak by the primitive element x = 0x02 in
 * GF(2^128), in place. The field is represented little-endian per the
 * IEEE 1619 / dm-crypt convention, with reduction polynomial
 * x^128 + x^7 + x^2 + x + 1 (the trailing XOR by 0x87 on overflow).
 *
 * @param {Uint8Array} tweak 16 bytes, mutated in place.
 */
const gfMultiplyByX = tweak => {
  let carry = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    const byte = tweak[i];
    tweak[i] = ((byte << 1) | carry) & 0xff;
    carry = (byte >> 7) & 1;
  }
  if (carry) {
    tweak[0] ^= 0x87;
  }
};

/**
 * Encode a sector number as a 128-bit little-endian "plain64" tweak, the
 * initialization vector scheme dm-crypt and LUKS use for `aes-xts-plain64`.
 *
 * @param {number} sectorNumber
 * @returns {Uint8Array}
 */
const plain64Tweak = sectorNumber => {
  const tweak = new Uint8Array(BLOCK);
  let n = BigInt(sectorNumber);
  for (let i = 0; i < BLOCK && n > 0n; i += 1) {
    tweak[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return tweak;
};

/**
 * Build an AES-XTS codec for a given key, with `plain64` sector tweaking.
 *
 * The key is the concatenation of the two AES keys XTS requires: a
 * 64-byte key selects AES-256 (`aes-xts-plain64` with a 512-bit volume
 * key), a 32-byte key selects AES-128. The first half is the data-unit
 * key; the second half is the tweak key.
 *
 * Both directions operate on whole sectors: the data length must be a
 * multiple of `sectorSize`, and each sector is (en/de)crypted
 * independently with tweak `firstSector + i`. LUKS sectors (512 or 4096
 * bytes) are always multiples of the 16-byte cipher block, so no
 * ciphertext stealing is required.
 *
 * @param {Uint8Array} key 32 or 64 bytes.
 * @returns {{
 *   keyBits: number,
 *   decrypt: (data: Uint8Array, firstSector: number, sectorSize: number) => Uint8Array,
 *   encrypt: (data: Uint8Array, firstSector: number, sectorSize: number) => Uint8Array,
 * }}
 */
export const makeXtsCodec = key => {
  if (key.length !== 32 && key.length !== 64) {
    throw makeError(X`XTS key must be 32 or 64 bytes, got ${q(key.length)}`);
  }
  const half = key.length / 2;
  const dataEnc = expandKeyLE(key.subarray(0, half));
  const dataDec = expandKeyDecLE(key.subarray(0, half));
  const tweakEnc = expandKeyLE(key.subarray(half));

  /**
   * @param {Uint8Array} data
   * @param {number} firstSector
   * @param {number} sectorSize
   * @param {boolean} encrypting
   */
  const transform = (data, firstSector, sectorSize, encrypting) => {
    if (data.length % sectorSize !== 0) {
      throw makeError(
        X`XTS data length ${q(data.length)} is not a multiple of sector size ${q(sectorSize)}`,
      );
    }
    if (sectorSize % BLOCK !== 0) {
      throw makeError(
        X`XTS sector size ${q(sectorSize)} is not a multiple of 16`,
      );
    }
    const out = new Uint8Array(data.length);
    const sectorCount = data.length / sectorSize;
    const dataKey = encrypting ? dataEnc : dataDec;
    const cipherBlock = encrypting ? encryptBlock : decryptBlock;
    for (let s = 0; s < sectorCount; s += 1) {
      const tweak = encryptBlock(tweakEnc, plain64Tweak(firstSector + s));
      const base = s * sectorSize;
      for (let b = 0; b < sectorSize; b += BLOCK) {
        const off = base + b;
        const xored = new Uint8Array(BLOCK);
        for (let i = 0; i < BLOCK; i += 1) {
          xored[i] = data[off + i] ^ tweak[i];
        }
        const ciphered = cipherBlock(dataKey, xored);
        for (let i = 0; i < BLOCK; i += 1) {
          out[off + i] = ciphered[i] ^ tweak[i];
        }
        gfMultiplyByX(tweak);
      }
    }
    return out;
  };

  return harden({
    keyBits: key.length * 8,
    decrypt: (data, firstSector, sectorSize) =>
      transform(data, firstSector, sectorSize, false),
    encrypt: (data, firstSector, sectorSize) =>
      transform(data, firstSector, sectorSize, true),
  });
};
harden(makeXtsCodec);
