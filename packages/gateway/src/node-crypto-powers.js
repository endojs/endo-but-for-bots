// @ts-check

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
 * Byte shape: every input and output is a `Uint8Array` per the
 * kriskowal directive on PR #393. The adapter converts between
 * Node's `Buffer` view and `Uint8Array` at the `node:crypto`
 * boundary.
 */

import crypto from 'node:crypto';

/** @import { CryptoPowers } from './types.js' */

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
    // `node:crypto` accepts any `TypedArray` for a DER `key` at
    // runtime, but `@types/node` still types the object-form field
    // as `string | Buffer`; the cast passes our own `Uint8Array`
    // through without an intermediate `Buffer` view.
    key: /** @type {Buffer} */ (der),
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
    // See `publicKeyObjectFromRaw`: `@types/node` types the DER
    // `key` field as `string | Buffer`, so cast our `Uint8Array`.
    key: /** @type {Buffer} */ (der),
    format: 'der',
    type: 'pkcs8',
  });
};
harden(privateKeyObjectFromRaw);

/**
 * Copy a Node `Buffer` view into a fresh standalone `Uint8Array`.
 * `Buffer` is a subclass of `Uint8Array`, but views can share
 * underlying allocator pools, so callers that hold the returned
 * value past the immediate call need an independent copy.
 *
 * @param {Buffer} buf
 * @returns {Uint8Array}
 */
const bufferToUint8Array = buf =>
  new Uint8Array(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );

/**
 * Make a `CryptoPowers` adapter backed by Node's `node:crypto`.
 * The adapter is plain (not an exo); callers pass it into
 * `makeNonceRegistry` or `makeGateway`.
 *
 * @returns {CryptoPowers}
 */
export const makeNodeCryptoPowers = () => {
  return harden({
    /** @param {number} byteLength */
    randomBytes(byteLength) {
      return bufferToUint8Array(crypto.randomBytes(byteLength));
    },
    /** @param {Uint8Array} input */
    sha256(input) {
      const hash = crypto.createHash('sha256').update(input).digest();
      return bufferToUint8Array(hash);
    },
    /**
     * @param {object} args
     * @param {Uint8Array} args.publicKey
     * @param {Uint8Array} args.message
     * @param {Uint8Array} args.signature
     */
    verifyEd25519({ publicKey, message, signature }) {
      try {
        const keyObject = publicKeyObjectFromRaw(publicKey);
        return crypto.verify(null, message, keyObject, signature);
      } catch (_err) {
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
 * Returned as `Uint8Array`s for the wire-passable shape, plus a
 * `sign(message)` callback. The returned signature is always a
 * `Uint8Array`.
 *
 * @returns {Promise<{
 *   publicKey: Uint8Array,
 *   privateKey: Uint8Array,
 *   sign: (message: Uint8Array) => Uint8Array,
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
        const publicKey = new Uint8Array(
          publicDer.subarray(publicDer.length - 32),
        );
        const privateKey = new Uint8Array(
          privateDer.subarray(privateDer.length - 32),
        );
        const sign = message => {
          if (!(message instanceof Uint8Array)) {
            throw new Error('sign: message must be a Uint8Array');
          }
          const signature = crypto.sign(
            null,
            message,
            privateKeyObjectFromRaw(privateKey),
          );
          return bufferToUint8Array(signature);
        };
        resolve(harden({ publicKey, privateKey, sign }));
      },
    ),
  );
harden(generateNodeEd25519Keypair);
