// @ts-check
import { assertReadRange } from '@endo/block-device';
import { makeError, q, X } from '@endo/errors';

import { parseLuksHeader } from './header.js';
import { unlockVolume } from './unlock.js';
import { makeXtsCodec } from './xts.js';

/** @import { BlockDevice } from '@endo/block-device' */

/**
 * Open a LUKS2 volume as a decrypting `BlockDevice`. The returned device
 * presents the *plaintext* data segment: a read at plaintext offset `o`
 * faults in exactly the ciphertext sectors covering `o`, decrypts them with
 * the recovered master key, and returns the requested slice. Nothing but
 * the touched sectors is ever read or decrypted, so the whole stack stays
 * lazy from filesystem read down to raw device.
 *
 * Only `aes-xts-plain64` (the modern LUKS default) is supported.
 *
 * @param {BlockDevice} base The underlying device holding the LUKS container.
 * @param {Uint8Array | string} passphrase
 * @param {object} [options]
 * @param {string} [options.keyslotId] Restrict unlocking to one keyslot.
 * @returns {Promise<BlockDevice>}
 */
export const openLuksDevice = async (base, passphrase, options = {}) => {
  const header = await parseLuksHeader(base);
  const { masterKey, segment } = await unlockVolume(
    base,
    header,
    passphrase,
    options,
  );

  if (segment.encryption !== 'aes-xts-plain64') {
    throw makeError(
      X`Unsupported data segment encryption ${q(segment.encryption)}; only aes-xts-plain64 is supported`,
    );
  }

  const codec = makeXtsCodec(masterKey);
  const segmentOffset = Number(segment.offset);
  const sectorSize = segment.sector_size;
  const ivTweak = Number(segment.iv_tweak ?? '0');

  const baseSize = await base.getSize();
  const rawDataSize =
    segment.size === 'dynamic'
      ? baseSize - segmentOffset
      : Number(segment.size);
  // Expose only whole sectors; a LUKS data area is always sector-aligned.
  const size = Math.floor(rawDataSize / sectorSize) * sectorSize;

  return harden({
    sectorSize,
    getSize: async () => size,
    read: async (offset, length) => {
      assertReadRange(offset, length, size);
      if (length === 0) {
        return new Uint8Array(0);
      }
      const firstSector = Math.floor(offset / sectorSize);
      const lastSector = Math.floor((offset + length - 1) / sectorSize);
      const spanSectors = lastSector - firstSector + 1;
      const ciphertext = await base.read(
        segmentOffset + firstSector * sectorSize,
        spanSectors * sectorSize,
      );
      const plaintext = codec.decrypt(
        ciphertext,
        ivTweak + firstSector,
        sectorSize,
      );
      const start = offset - firstSector * sectorSize;
      return plaintext.slice(start, start + length);
    },
  });
};
harden(openLuksDevice);
