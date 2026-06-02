// @ts-check
/* global Buffer */

/**
 * @file Node-backed adapter for the `CryptoPowers` shape that the
 *   gateway's proof-of-possession registry takes.
 *
 * The bootstrap registry consumes a platform-agnostic
 * `CryptoPowers` interface (`randomBytes`, `sha256`,
 * `verifyEd25519`) so the same module composes under SES, XS, and
 * browser bundles. This adapter is the Node-side implementation:
 * `node:crypto` provides each primitive directly.
 *
 * Kept in a separate file so the bootstrap module itself never
 * imports `node:crypto`; an Endor or browser embedder ships its
 * own powers adapter and the bootstrap remains portable.
 *
 * Byte shape: every output is an immutable `ArrayBuffer` per the
 * `@endo/bytes` convention. The adapter accepts either an immutable
 * `ArrayBuffer` (wire shape) or a mutable `Uint8Array` (internal
 * use) on input; it converts to whatever shape `node:crypto`
 * expects (a Node `Buffer` view).
 */

import crypto from 'node:crypto';

import { bytesToImmutable } from '@endo/bytes/to-immutable.js';
import { bytesFromImmutable } from '@endo/bytes/from-immutable.js';

/** @import { CryptoPowers } from './proof-of-possession.js' */

/**
 * The PKCS#8 DER prefix Node expects on a raw 32-byte Ed25519
 * seed. Mirrors `packages/daemon/src/daemon-node-powers.js` so
 * the bootstrap and the daemon agree on the conversion shape.
 */
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);

/**
 * The SPKI DER prefix Node expects on a raw 32-byte Ed25519
 * public key.
 */
const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/**
 * Coerce any byte-shaped input to a Node-friendly `Uint8Array`.
 *
 * @param {ArrayBuffer | Uint8Array} input
 * @returns {Uint8Array}
 */
const asNodeBytes = input => {
  if (input instanceof Uint8Array) {
    return input;
  }
  return bytesFromImmutable(input);
};

/**
 * Wrap a raw 32-byte Ed25519 public key as a Node `KeyObject` so
 * `crypto.verify(null, ...)` can use it.
 *
 * @param {Uint8Array} rawPublicKey
 * @returns {crypto.KeyObject}
 */
const publicKeyObjectFromRaw = rawPublicKey => {
  const der = new Uint8Array(ED25519_SPKI_PREFIX.length + rawPublicKey.length);
  der.set(ED25519_SPKI_PREFIX, 0);
  der.set(rawPublicKey, ED25519_SPKI_PREFIX.length);
  return crypto.createPublicKey({
    key: Buffer.from(der.buffer, der.byteOffset, der.byteLength),
    format: 'der',
    type: 'spki',
  });
};

/**
 * Wrap a raw 32-byte Ed25519 private key seed as a Node `KeyObject`
 * so `crypto.sign(null, ...)` can use it. Exported for tests; the
 * bootstrap itself never signs.
 *
 * @param {Uint8Array} rawPrivateKey
 * @returns {crypto.KeyObject}
 */
export const privateKeyObjectFromRaw = rawPrivateKey => {
  const der = new Uint8Array(
    ED25519_PKCS8_PREFIX.length + rawPrivateKey.length,
  );
  der.set(ED25519_PKCS8_PREFIX, 0);
  der.set(rawPrivateKey, ED25519_PKCS8_PREFIX.length);
  return crypto.createPrivateKey({
    key: Buffer.from(der.buffer, der.byteOffset, der.byteLength),
    format: 'der',
    type: 'pkcs8',
  });
};
harden(privateKeyObjectFromRaw);

/**
 * Make a `CryptoPowers` adapter backed by Node's `node:crypto`.
 * The adapter is plain (not an exo); callers pass it into
 * `makeNonceRegistry` or `makeGateway`.
 *
 * Outputs are immutable `ArrayBuffer` per the gateway's wire shape
 * (see `proof-of-possession.js` § Wire shape).
 *
 * @returns {CryptoPowers}
 */
export const makeNodeCryptoPowers = () => {
  return harden({
    /** @param {number} byteLength */
    randomBytes(byteLength) {
      const buf = crypto.randomBytes(byteLength);
      return bytesToImmutable(
        new Uint8Array(
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        ),
      );
    },
    /** @param {ArrayBuffer | Uint8Array} input */
    sha256(input) {
      const view = asNodeBytes(input);
      const hash = crypto.createHash('sha256').update(view).digest();
      return bytesToImmutable(
        new Uint8Array(
          hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength),
        ),
      );
    },
    /**
     * @param {object} args
     * @param {ArrayBuffer | Uint8Array} args.publicKey
     * @param {ArrayBuffer | Uint8Array} args.message
     * @param {ArrayBuffer | Uint8Array} args.signature
     */
    verifyEd25519({ publicKey, message, signature }) {
      try {
        const keyObject = publicKeyObjectFromRaw(asNodeBytes(publicKey));
        return crypto.verify(
          null,
          asNodeBytes(message),
          keyObject,
          asNodeBytes(signature),
        );
      } catch (err) {
        // The bare catch covers every emissible class, including
        // RangeError (which `crypto.verify` can raise at any time
        // on OOM): the contract says we return false rather than
        // throw, so callers see a uniform "did not verify"
        // rejection. The expected shape errors land here too: a
        // malformed public key (wrong length, non-DER) or a
        // signature of the wrong shape.
        return false;
      }
    },
  });
};
harden(makeNodeCryptoPowers);

/**
 * Generate an Ed25519 keypair for tests and turnkey-Node bootstrap.
 * Returned as immutable `ArrayBuffer`s for the wire-passable shape,
 * plus a `sign(message)` callback. `message` may be either an
 * immutable `ArrayBuffer` (wire shape) or a `Uint8Array`; the
 * returned signature is always an immutable `ArrayBuffer`.
 *
 * @returns {Promise<{
 *   publicKey: ArrayBuffer,
 *   privateKey: ArrayBuffer,
 *   sign: (message: ArrayBuffer | Uint8Array) => ArrayBuffer,
 * }>}
 */
export const generateNodeEd25519Keypair = () =>
  new Promise((resolve, reject) =>
    crypto.generateKeyPair(
      'ed25519',
      {},
      (err, publicKeyObject, privateKeyObject) => {
        if (err) {
          reject(err);
          return;
        }
        const publicDer = publicKeyObject.export({
          type: 'spki',
          format: 'der',
        });
        const privateDer = privateKeyObject.export({
          type: 'pkcs8',
          format: 'der',
        });
        // Raw 32-byte windows of each DER payload.
        const rawPublic = new Uint8Array(
          publicDer.subarray(publicDer.length - 32),
        );
        const rawPrivate = new Uint8Array(
          privateDer.subarray(privateDer.length - 32),
        );
        const publicKey = bytesToImmutable(rawPublic);
        const privateKey = bytesToImmutable(rawPrivate);
        const sign = message => {
          const messageBytes = asNodeBytes(message);
          const signature = crypto.sign(
            null,
            messageBytes,
            privateKeyObjectFromRaw(rawPrivate),
          );
          return bytesToImmutable(new Uint8Array(signature));
        };
        resolve(harden({ publicKey, privateKey, sign }));
      },
    ),
  );
harden(generateNodeEd25519Keypair);
