// @ts-check
import { makeError, q, X } from '@endo/errors';

/** @import { BlockDevice } from '@endo/block-device' */

// LUKS2 binary header layout (big-endian), per the on-disk format:
//   offset 0:  magic, 6 bytes — "LUKS\xba\xbe"
//   offset 6:  version, uint16
//   offset 8:  hdr_size, uint64 — bytes from the start of this header to the
//              end of its JSON metadata area (the primary metadata region).
// The JSON metadata area immediately follows the 4096-byte binary header and
// runs to `hdr_size`. It is NUL-padded UTF-8 JSON.
const LUKS_MAGIC_1ST = '\x4c\x55\x4b\x53\xba\xbe'; // "LUKS\xba\xbe"
const BINARY_HEADER_SIZE = 4096;

/**
 * @typedef {object} LuksKdf
 * @property {string} type e.g. 'argon2id', 'argon2i', 'pbkdf2'
 * @property {string} salt base64
 * @property {number} [time] argon2 iterations / pbkdf2 cost
 * @property {number} [memory] argon2 memory in KiB
 * @property {number} [cpus] argon2 parallelism
 * @property {number} [iterations] pbkdf2 iterations
 * @property {string} [hash] pbkdf2 hash
 */

/**
 * @typedef {object} LuksKeyslot
 * @property {string} type
 * @property {number} key_size Volume-key size this slot unlocks, in bytes.
 * @property {{ type: string, stripes: number, hash: string }} af
 * @property {{ type: string, offset: string, size: string, encryption: string, key_size: number }} area
 * @property {LuksKdf} kdf
 */

/**
 * @typedef {object} LuksDigest
 * @property {string} type
 * @property {string[]} keyslots
 * @property {string[]} segments
 * @property {string} hash
 * @property {number} iterations
 * @property {string} salt base64
 * @property {string} digest base64
 */

/**
 * @typedef {object} LuksSegment
 * @property {string} type
 * @property {string} offset Byte offset of the data area, as a decimal string.
 * @property {string} size 'dynamic' or a decimal byte count.
 * @property {string} encryption e.g. 'aes-xts-plain64'
 * @property {number} sector_size
 * @property {string} [iv_tweak]
 */

/**
 * @typedef {object} LuksMetadata
 * @property {Record<string, LuksKeyslot>} keyslots
 * @property {Record<string, LuksDigest>} digests
 * @property {Record<string, LuksSegment>} segments
 * @property {Record<string, unknown>} [config]
 * @property {Record<string, unknown>} [tokens]
 */

/**
 * @typedef {object} LuksHeader
 * @property {number} version LUKS format version (this package supports 2).
 * @property {number} headerSize Bytes of the primary metadata region.
 * @property {LuksMetadata} metadata Parsed JSON metadata.
 */

/**
 * Parse the LUKS2 binary header and JSON metadata from the front of a
 * block device.
 *
 * @param {BlockDevice} device
 * @returns {Promise<LuksHeader>}
 */
export const parseLuksHeader = async device => {
  const binary = await device.read(0, BINARY_HEADER_SIZE);
  const magic = String.fromCharCode(...binary.subarray(0, 6));
  if (magic !== LUKS_MAGIC_1ST) {
    throw makeError(X`Not a LUKS device: bad magic ${q(magic)}`);
  }
  const view = new DataView(
    binary.buffer,
    binary.byteOffset,
    binary.byteLength,
  );
  const version = view.getUint16(6, false);
  if (version !== 2) {
    throw makeError(
      X`Unsupported LUKS version ${q(version)}; this package reads LUKS2`,
    );
  }
  const headerSize = Number(view.getBigUint64(8, false));
  const jsonBytes = await device.read(
    BINARY_HEADER_SIZE,
    headerSize - BINARY_HEADER_SIZE,
  );
  let end = jsonBytes.indexOf(0);
  if (end < 0) {
    end = jsonBytes.length;
  }
  const jsonText = new TextDecoder().decode(jsonBytes.subarray(0, end));
  /** @type {LuksMetadata} */
  const metadata = JSON.parse(jsonText);
  return harden({ version, headerSize, metadata });
};
harden(parseLuksHeader);
