// @ts-check

import { encodeUtf8 } from '@endo/utf8/encode.js';

/** @import { CryptoPowers, FilePowers } from './types.js' */

/**
 * Local envelope-encrypted backend for development and conformance testing.
 * It protects values from casual inspection and state-file mixups, but the
 * wrapping key lives in the same daemon state directory. Deployments that
 * require separation from filesystem compromise should inject a KMS-backed
 * implementation of the same interface.
 *
 * @param {object} powers
 * @param {string} powers.storagePath
 * @param {FilePowers} powers.filePowers
 * @param {CryptoPowers} powers.cryptoPowers
 * @param {Uint8Array} powers.key
 */
export const makeEncryptedFileSecretBackend = ({
  storagePath,
  filePowers,
  cryptoPowers,
  key,
}) => {
  /** @param {string} backendRef */
  const pathFor = backendRef => filePowers.joinPath(storagePath, backendRef);

  /**
   * @param {string} backendRef
   * @param {Uint8Array} bytes
   * @param {string} operationId
   */
  const write = async (backendRef, bytes, operationId) => {
    const associatedData = encodeUtf8(backendRef);
    const sealed = cryptoPowers.sealSecret(key, bytes, associatedData);
    const temporaryPath = filePowers.joinPath(
      storagePath,
      `.${backendRef}.${operationId}.tmp`,
    );
    await null;
    try {
      // Acquisition happens inside the try so that a failure to create the
      // directory or the writer still reaches the zeroing `finally`.
      await filePowers.makePath(storagePath);
      const writer = filePowers.makeFileWriter(temporaryPath);
      await writer.next(sealed);
      await writer.return(undefined);
      await filePowers.renamePath(temporaryPath, pathFor(backendRef));
    } catch (error) {
      await filePowers.removePath(temporaryPath).catch(() => {});
      throw error;
    } finally {
      sealed.fill(0);
    }
  };

  return harden({
    /**
     * @param {string} operationId
     * @param {string} secretId
     * @param {Uint8Array} bytes
     */
    create: async (operationId, secretId, bytes) => {
      const backendRef = `${secretId}.secret`;
      await write(backendRef, bytes, operationId);
      return backendRef;
    },
    /** @param {string} backendRef */
    read: async backendRef => {
      const sealed = await filePowers.readFileBytes(pathFor(backendRef));
      try {
        return cryptoPowers.openSecret(key, sealed, encodeUtf8(backendRef));
      } finally {
        sealed.fill(0);
      }
    },
    /**
     * @param {string} operationId
     * @param {string} backendRef
     * @param {Uint8Array} bytes
     */
    replace: async (operationId, backendRef, bytes) => {
      await write(backendRef, bytes, operationId);
    },
    /**
     * Idempotent, as `SecretBackend.revoke` requires: `SecretAdmin.delete`
     * retries revocation so an earlier cleanup failure cannot strand backend
     * material. Node's `removePath` already tolerates a missing file; the XS
     * host's does not, and its error carries no portable `code`, so recheck
     * existence rather than matching an errno. A genuine permission or IO
     * failure on a still-present file still propagates.
     *
     * @param {string} _operationId
     * @param {string} backendRef
     */
    revoke: async (_operationId, backendRef) => {
      const secretPath = pathFor(backendRef);
      await null;
      try {
        await filePowers.removePath(secretPath);
      } catch (error) {
        if (await filePowers.exists(secretPath)) {
          throw error;
        }
      }
    },
  });
};
harden(makeEncryptedFileSecretBackend);
