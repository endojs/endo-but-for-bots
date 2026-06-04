// @ts-nocheck

/**
 * Installs `ArrayBuffer.prototype[Symbol.for('transferToImmutable')]`.
 *
 * Optional: depends on platform support for `structuredClone` or
 * `ArrayBuffer.prototype.transfer`. On platforms lacking both, the
 * exported `installedTransferToImmutable` is `undefined`.
 *
 * The rendezvous symbol is the same name as the proposed
 * `ArrayBuffer.prototype.transferToImmutable` method
 * (proposal-immutable-arraybuffer).
 */

import { optTransferBufferToImmutable } from '@endo/immutable-arraybuffer';
import { CapturedArrayBuffer, installOrAdopt } from './install-helpers.js';

const symTransferToImmutable = Symbol.for('transferToImmutable');

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
    symTransferToImmutable,
    installedTransfer,
  );
}

export const installedTransferToImmutable = transferInstalled;
export { symTransferToImmutable };
