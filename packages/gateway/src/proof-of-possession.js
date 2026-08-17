// @ts-check

/**
 * @file Proof-of-possession nonce minting and verification for the
 *   gateway's bootstrap registrar.
 *
 * Per `designs/gateway-package.md` § Feature 4: any process that can
 * connect to the gateway's local bootstrap sock can call
 * `register({ publicKey, proofOfPossession, ... })`. The
 * filesystem permissions on the socket gate *who* may connect; the
 * proof-of-possession step gates *which public keys* the connector
 * may register. Without it, one local user could register another
 * user's public key (because the socket is local-only and the
 * caller could supply any public key it likes).
 *
 * The challenge-response flow:
 *
 *   1. Caller invokes `E(gatewayBootstrap).challenge()`. The
 *      registrar mints a fresh 32-byte random nonce, hashes it
 *      with the domain-separation prefix
 *      `endo-gateway:registrar:nonce`, and returns the *unhashed*
 *      nonce to the caller while remembering the hash.
 *   2. Caller signs the *same hashed bytes* with the Ed25519
 *      private key corresponding to the public key it wants to
 *      register, and submits the signature as `proofOfPossession`.
 *   3. Registrar verifies the signature against the registrant's
 *      claimed public key and consumes the nonce (single-use). A
 *      successful verification proves the registrant controls the
 *      private key.
 *
 * The domain-separation prefix is critical: without it, a
 * captured registration signature could be misused as a signature
 * in another OCapN protocol step that happens to produce a
 * compatible 32-byte challenge. Hashing the nonce together with a
 * literal that names the *purpose* of the signature ties the
 * signature's authority to this protocol step alone.
 *
 * Nonces expire after a short window (default 30 seconds) and are
 * single-use; a registrant who takes too long discovers the
 * expiration at `register` time and must call `challenge` again.
 *
 * Wire shape: byte fields are `Uint8Array` per the kriskowal
 * directive on PR #393. Internal helpers and the in-process API
 * accept `Uint8Array` exclusively; conversion to an immutable
 * `ArrayBuffer` (when a future cross-vat call eventually needs to
 * cross `@endo/marshal`) is the marshal layer's concern, not the
 * exo's.
 *
 * The signature-verification primitive is supplied by the caller
 * (a Node-backed `crypto.verify` adapter for the daemon; a libsodium
 * adapter for Endor or other platforms). The bootstrap exo never
 * imports `node:crypto` directly so the same module composes under
 * SES, XS, and browser bundles.
 */

import { makeError, q, X } from '@endo/errors';
import { encodeHex } from '@endo/hex';

/** @import { CryptoPowers, ClockPowers, ChallengeIssued, NonceRegistry } from './types.js' */

/**
 * The domain-separation literal hashed into every challenge nonce.
 * Changing this string invalidates every outstanding challenge and
 * every signature that was prepared against the old prefix; do not
 * change it without a corresponding upgrade story.
 */
export const NONCE_DOMAIN_SEPARATION_PREFIX = 'endo-gateway:registrar:nonce';
harden(NONCE_DOMAIN_SEPARATION_PREFIX);

/**
 * The size in bytes of each freshly-minted nonce. 32 bytes matches
 * the design's Feature 4 sketch and Ed25519's recommended challenge
 * length.
 */
export const NONCE_BYTE_LENGTH = 32;
harden(NONCE_BYTE_LENGTH);

/**
 * Default lifetime in milliseconds after which an unconsumed nonce
 * is rejected. 30 seconds matches the design's Feature 4 sketch:
 * long enough for a normal challenge-sign-respond round trip across
 * a local sock, short enough that captured-and-replayed nonces have
 * a tight window.
 */
export const DEFAULT_NONCE_TTL_MS = 30_000;
harden(DEFAULT_NONCE_TTL_MS);

/**
 * Hash a nonce together with the domain-separation prefix. The
 * registrant signs *this* hash, not the raw nonce.
 *
 * @param {Uint8Array} nonce
 * @param {CryptoPowers} crypto
 * @returns {Uint8Array}
 */
export const hashNonceForSigning = (nonce, crypto) => {
  if (!(nonce instanceof Uint8Array)) {
    throw makeError(X`nonce must be a Uint8Array`);
  }
  if (nonce.length !== NONCE_BYTE_LENGTH) {
    throw makeError(
      X`Nonce must be ${q(NONCE_BYTE_LENGTH)} bytes, got ${q(nonce.length)}`,
    );
  }
  const prefix = new TextEncoder().encode(NONCE_DOMAIN_SEPARATION_PREFIX);
  const combined = new Uint8Array(prefix.length + nonce.length);
  combined.set(prefix, 0);
  combined.set(nonce, prefix.length);
  return crypto.sha256(combined);
};
harden(hashNonceForSigning);

/**
 * Compare two `Uint8Array` values in constant time. Returns `true`
 * iff they have the same length and the same bytes.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export const constantTimeEqual = (a, b) => {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    // Constant-time byte comparison: bitwise OR over byte XORs.
    // The constant-time property is the whole point of this
    // helper; the `no-bitwise` rule is appropriately suppressed.
    // eslint-disable-next-line no-bitwise
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
};
harden(constantTimeEqual);

/**
 * Create a registry that issues challenge nonces and verifies
 * proof-of-possession signatures against them. The registry is
 * in-memory; a gateway restart drops every outstanding challenge
 * (caller retries with a fresh `challenge()`, which is acceptable
 * because the only outstanding challenges are those mid-handshake).
 *
 * @param {object} args
 * @param {CryptoPowers} args.crypto
 * @param {ClockPowers} args.clock
 * @param {number} [args.ttlMs] Lifetime of an unconsumed nonce in
 *   milliseconds. Defaults to {@link DEFAULT_NONCE_TTL_MS}.
 * @returns {NonceRegistry}
 */
export const makeNonceRegistry = ({
  crypto,
  clock,
  ttlMs = DEFAULT_NONCE_TTL_MS,
}) => {
  if (crypto === undefined) {
    throw makeError(X`makeNonceRegistry requires a crypto power`);
  }
  if (clock === undefined) {
    throw makeError(X`makeNonceRegistry requires a clock power`);
  }
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw makeError(X`ttlMs must be a positive finite number, got ${q(ttlMs)}`);
  }

  /**
   * Map from hashedNonce hex to its expiration timestamp. The hex
   * key lets us match two byte arrays that are byte-equal but
   * reference-unequal (the caller hands back a fresh buffer from
   * the wire; we held the original).
   *
   * @type {Map<string, number>}
   */
  const pending = new Map();

  /**
   * Drop entries whose TTL has elapsed. Called opportunistically
   * on every issue and verify. The data structure stays small in
   * the absence of adversarial concurrent issue calls; this is a
   * single-host registry, not a public service.
   */
  const sweep = () => {
    const now = clock.now();
    // Entries are inserted with monotonically increasing
    // `expiresAt` (a constant ttlMs added to a monotonically
    // increasing `clock.now()`), and `Map` preserves insertion
    // order, so the first entry whose `expiresAt > now` proves
    // every later entry is also unexpired; break to skip the
    // tail.
    for (const [key, expiresAt] of pending) {
      if (expiresAt > now) {
        break;
      }
      pending.delete(key);
    }
  };

  return harden({
    issue() {
      sweep();
      const nonce = crypto.randomBytes(NONCE_BYTE_LENGTH);
      if (!(nonce instanceof Uint8Array)) {
        throw makeError(X`CryptoPowers.randomBytes must return a Uint8Array`);
      }
      if (nonce.length !== NONCE_BYTE_LENGTH) {
        throw makeError(
          X`CryptoPowers.randomBytes must return ${q(NONCE_BYTE_LENGTH)} bytes`,
        );
      }
      const hashedNonce = hashNonceForSigning(nonce, crypto);
      const issuedAt = clock.now();
      const expiresAt = issuedAt + ttlMs;
      pending.set(encodeHex(hashedNonce), expiresAt);
      return harden({
        nonce,
        hashedNonce,
        issuedAt,
        expiresAt,
      });
    },
    /**
     * @param {object} args
     * @param {Uint8Array} args.publicKey
     * @param {Uint8Array} args.nonce
     * @param {Uint8Array} args.signature
     */
    verifyAndConsume({ publicKey, nonce, signature }) {
      if (!(publicKey instanceof Uint8Array)) {
        throw makeError(X`publicKey must be a Uint8Array`);
      }
      if (!(nonce instanceof Uint8Array)) {
        throw makeError(X`nonce must be a Uint8Array`);
      }
      if (!(signature instanceof Uint8Array)) {
        throw makeError(X`signature must be a Uint8Array`);
      }
      // Re-derive the hashed nonce the caller would have signed and
      // look it up in the pending table. If the caller submitted
      // a wrong-length nonce, this throws before we reach the
      // expiration check, which is the right precedence.
      const hashedNonce = hashNonceForSigning(nonce, crypto);
      const key = encodeHex(hashedNonce);
      const expiresAt = pending.get(key);
      if (expiresAt === undefined) {
        // Either never-issued or already-consumed; both are
        // indistinguishable to the caller (and should be: an
        // attacker who can distinguish "expired" from "never
        // issued" learns less but still learns a partial oracle).
        throw makeError(X`Unknown or already-consumed nonce`);
      }
      const now = clock.now();
      if (expiresAt <= now) {
        // Expired: prune and reject.
        pending.delete(key);
        throw makeError(X`Nonce has expired`);
      }
      // Verify the signature *before* consuming the nonce, so a
      // bad signature on a valid nonce does not turn into a denial
      // of service against the legitimate registrant who races
      // with an attacker.
      const ok = crypto.verifyEd25519({
        publicKey,
        message: hashedNonce,
        signature,
      });
      if (!ok) {
        throw makeError(X`Proof-of-possession signature does not verify`);
      }
      // Consume.
      pending.delete(key);
    },
    size() {
      return pending.size;
    },
  });
};
harden(makeNonceRegistry);
