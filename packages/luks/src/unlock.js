// @ts-check
import { argon2id, argon2i, argon2d } from '@noble/hashes/argon2.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { makeError, q, X } from '@endo/errors';

import { decodeBase64 } from './base64.js';
import { makeXtsCodec } from './xts.js';
import { afMerge } from './af.js';

/** @import { BlockDevice } from '@endo/block-device' */
/** @import { LuksHeader, LuksKeyslot, LuksDigest } from './header.js' */

// The LUKS2 keyslot AF area is always encrypted with 512-byte sectors,
// independent of the data segment's sector size.
const KEYSLOT_SECTOR_SIZE = 512;

const argon2Variants = harden({
  argon2id,
  argon2i,
  argon2d,
});

const pbkdf2Hashes = harden({
  sha256,
  sha512,
});

/**
 * Run a keyslot's key-derivation function over a passphrase, producing the
 * key-encryption key that decrypts that keyslot's AF area.
 *
 * @param {import('./header.js').LuksKdf} kdf
 * @param {Uint8Array} passphrase
 * @param {number} dkLen
 * @returns {Uint8Array}
 */
const deriveKeyslotKey = (kdf, passphrase, dkLen) => {
  const salt = decodeBase64(kdf.salt);
  if (kdf.type.startsWith('argon2')) {
    const argon2 =
      argon2Variants[/** @type {keyof typeof argon2Variants} */ (kdf.type)];
    if (argon2 === undefined) {
      throw makeError(X`Unsupported argon2 variant ${q(kdf.type)}`);
    }
    return argon2(passphrase, salt, {
      t: kdf.time ?? 1,
      m: kdf.memory ?? 1024,
      p: kdf.cpus ?? 1,
      dkLen,
    });
  }
  if (kdf.type === 'pbkdf2') {
    const hash =
      pbkdf2Hashes[/** @type {keyof typeof pbkdf2Hashes} */ (kdf.hash ?? '')];
    if (hash === undefined) {
      throw makeError(X`Unsupported pbkdf2 hash ${q(kdf.hash)}`);
    }
    return pbkdf2(hash, passphrase, salt, {
      c: kdf.iterations ?? kdf.time ?? 1,
      dkLen,
    });
  }
  throw makeError(X`Unsupported keyslot KDF type ${q(kdf.type)}`);
};

/**
 * Verify a candidate volume key against a LUKS2 `pbkdf2` digest, returning
 * `true` on a constant-shaped comparison match.
 *
 * @param {LuksDigest} digest
 * @param {Uint8Array} volumeKey
 * @returns {boolean}
 */
const digestMatches = (digest, volumeKey) => {
  if (digest.type !== 'pbkdf2') {
    throw makeError(X`Unsupported digest type ${q(digest.type)}`);
  }
  const hash =
    pbkdf2Hashes[/** @type {keyof typeof pbkdf2Hashes} */ (digest.hash)];
  if (hash === undefined) {
    throw makeError(X`Unsupported digest hash ${q(digest.hash)}`);
  }
  const expected = decodeBase64(digest.digest);
  const actual = pbkdf2(hash, volumeKey, decodeBase64(digest.salt), {
    c: digest.iterations,
    dkLen: expected.length,
  });
  if (actual.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    // eslint-disable-next-line no-bitwise
    diff |= actual[i] ^ expected[i];
  }
  return diff === 0;
};

/**
 * Attempt to recover the volume (master) key from a single keyslot.
 *
 * @param {BlockDevice} device
 * @param {LuksKeyslot} keyslot
 * @param {Uint8Array} passphrase
 * @returns {Promise<Uint8Array>}
 */
const unlockKeyslot = async (device, keyslot, passphrase) => {
  const volumeKeySize = keyslot.key_size;
  const derivedKey = deriveKeyslotKey(
    keyslot.kdf,
    passphrase,
    keyslot.area.key_size,
  );
  const stripes = keyslot.af.stripes;
  const areaOffset = Number(keyslot.area.offset);
  const splitLength = volumeKeySize * stripes;
  const areaCiphertext = await device.read(areaOffset, splitLength);
  const codec = makeXtsCodec(derivedKey);
  const split = codec.decrypt(areaCiphertext, 0, KEYSLOT_SECTOR_SIZE);
  return afMerge(split, stripes, volumeKeySize);
};

/**
 * @typedef {object} LuksVolume
 * @property {Uint8Array} masterKey The recovered volume key.
 * @property {string} keyslotId Which keyslot the passphrase unlocked.
 * @property {import('./header.js').LuksSegment} segment The crypt data segment.
 */

/**
 * Unlock a LUKS2 volume with a passphrase, recovering the master key and
 * the data-segment description. Tries the requested keyslot, or every
 * keyslot in turn, accepting the first whose derived volume key satisfies
 * the keyslot's digest.
 *
 * @param {BlockDevice} device
 * @param {LuksHeader} header
 * @param {Uint8Array | string} passphrase
 * @param {object} [options]
 * @param {string} [options.keyslotId] Restrict to a single keyslot.
 * @returns {Promise<LuksVolume>}
 */
export const unlockVolume = async (
  device,
  header,
  passphrase,
  { keyslotId = undefined } = {},
) => {
  const passBytes =
    typeof passphrase === 'string'
      ? new TextEncoder().encode(passphrase)
      : passphrase;
  const { keyslots, digests, segments } = header.metadata;
  const candidateIds =
    keyslotId !== undefined ? [keyslotId] : Object.keys(keyslots);

  for (const id of candidateIds) {
    const keyslot = keyslots[id];
    if (keyslot === undefined) {
      throw makeError(X`No such keyslot ${q(id)}`);
    }
    // eslint-disable-next-line no-await-in-loop
    const candidate = await unlockKeyslot(device, keyslot, passBytes);
    const digest = Object.values(digests).find(d => d.keyslots.includes(id));
    if (digest === undefined) {
      throw makeError(X`Keyslot ${q(id)} has no associated digest`);
    }
    if (digestMatches(digest, candidate)) {
      const segmentId = digest.segments[0] ?? Object.keys(segments)[0];
      const segment = segments[segmentId];
      if (segment === undefined) {
        throw makeError(X`No data segment for keyslot ${q(id)}`);
      }
      return harden({ masterKey: candidate, keyslotId: id, segment });
    }
  }
  throw makeError(X`No keyslot could be unlocked with the supplied passphrase`);
};
harden(unlockVolume);
