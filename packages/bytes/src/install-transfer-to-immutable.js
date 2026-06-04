// @ts-nocheck

/**
 * Installs `ArrayBuffer.prototype.transferToImmutable`.
 *
 * Optional: depends on platform support for `structuredClone` or
 * `ArrayBuffer.prototype.transfer`. On platforms lacking both, the
 * exported `installedTransferToImmutable` is `undefined`.
 *
 * The rendezvous key is the proposed standard name
 * `transferToImmutable` (proposal-immutable-arraybuffer), so a native
 * implementation or the `@endo/immutable-arraybuffer` shim that
 * places the standard method at the same name composes cleanly with
 * this install.
 */

import { optTransferBufferToImmutable } from '@endo/immutable-arraybuffer';
import { CapturedArrayBuffer, installOrAdopt } from './install-helpers.js';

/** @type {Function | undefined} */
let transferInstalled;
if (optTransferBufferToImmutable !== undefined) {
  /**
   * @this {ArrayBuffer}
   * @param {number} [newLength]
   */
  // eslint-disable-next-line no-inner-declarations
  function installedTransfer(newLength) {
    return optTransferBufferToImmutable(this, newLength);
  }
  transferInstalled = installOrAdopt(
    CapturedArrayBuffer.prototype,
    'transferToImmutable',
    installedTransfer,
  );
}

export const installedTransferToImmutable = transferInstalled;
