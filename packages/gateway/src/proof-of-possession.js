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
 * Wire shape: byte-arrays cross the exo boundary as **immutable
 * `ArrayBuffer`**, per the `@endo/bytes` convention. Typed arrays
 * (`Uint8Array`) cannot be frozen, so `@endo/marshal` and
 * `@endo/patterns` reject them as non-passable. The bootstrap
 * accepts immutable `ArrayBuffer`s on the wire and converts to
 * `Uint8Array` views internally for byte-level work (hashing,
 * signature checks).
 *
 * The signature-verification primitive is supplied by the caller
 * (a Node-backed `crypto.verify` adapter for the daemon; a libsodium
 * adapter for Endor or other platforms). The bootstrap exo never
 * imports `node:crypto` directly so the same module composes under
 * SES, XS, and browser bundles.
 */

import { makeError, q, X } from '@endo/errors';
import { bytesToImmutable } from '@endo/bytes/to-immutable.js';
import { bytesFromImmutable } from '@endo/bytes/from-immutable.js';
import { encodeHex } from '@endo/hex';

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
 * @typedef {object} CryptoPowers
 * @property {(byteLength: number) => ArrayBuffer} randomBytes
 *   Returns a freshly-randomized immutable `ArrayBuffer` of the
 *   requested length. The byte source must be CSPRNG-quality
 *   (Node `crypto.randomBytes`, libsodium `randombytes_buf`); a
 *   non-cryptographic RNG breaks the security property.
 * @property {(input: ArrayBuffer | Uint8Array) => ArrayBuffer} sha256
 *   Returns the 32-byte SHA-256 hash of the input as an immutable
 *   `ArrayBuffer`. The bootstrap hashes the challenge nonce together
 *   with the domain-separation prefix before storing or verifying.
 * @property {(args: {
 *   publicKey: ArrayBuffer | Uint8Array,
 *   message: ArrayBuffer | Uint8Array,
 *   signature: ArrayBuffer | Uint8Array,
 * }) => boolean} verifyEd25519 Returns `true` iff `signature` is a
 *   valid Ed25519 signature of `message` under `publicKey`. Must
 *   not throw on malformed inputs; returns `false` instead so the
 *   verifier upgrades to a uniform reject path.
 */

/**
 * @typedef {object} ClockPowers
 * @property {() => number} now Returns the current time in
 *   milliseconds since the epoch. Injected so tests can simulate
 *   nonce expiry deterministically.
 */

/**
 * @typedef {object} ChallengeIssued
 * @property {ArrayBuffer} nonce The unhashed nonce the registrar
 *   returns to the caller. The caller will sign the *hashed* nonce
 *   (see {@link hashNonceForSigning}).
 * @property {ArrayBuffer} hashedNonce The hashed bytes the caller
 *   must sign and the bootstrap stores until the matching
 *   `register` call.
 * @property {number} issuedAt Epoch milliseconds.
 * @property {number} expiresAt `issuedAt + ttlMs`.
 */

/**
 * Convert any byte-shaped input (immutable `ArrayBuffer` or
 * `Uint8Array`) to a `Uint8Array` view for byte-level work. Copies
 * when the input is an immutable buffer (which cannot back a view
 * directly).
 *
 * @param {ArrayBuffer | Uint8Array} input
 * @returns {Uint8Array}
 */
const asUint8 = input => {
  if (input instanceof Uint8Array) {
    return input;
  }
  // Immutable ArrayBuffer or a plain ArrayBuffer: copy via
  // `bytesFromImmutable` (the helper works on any ArrayBufferLike).
  return bytesFromImmutable(input);
};

/**
 * Hash a nonce together with the domain-separation prefix. The
 * registrant signs *this* hash, not the raw nonce.
 *
 * Accepts either an immutable `ArrayBuffer` (wire shape) or a
 * `Uint8Array` (internal use), returns an immutable `ArrayBuffer`
 * so the hash can travel back across the wire.
 *
 * @param {ArrayBuffer | Uint8Array} nonce
 * @param {CryptoPowers} crypto
 * @returns {ArrayBuffer}
 */
export const hashNonceForSigning = (nonce, crypto) => {
  const view = asUint8(nonce);
  if (view.length !== NONCE_BYTE_LENGTH) {
    throw makeError(
      X`Nonce must be ${q(NONCE_BYTE_LENGTH)} bytes, got ${q(view.length)}`,
    );
  }
  const prefix = new TextEncoder().encode(NONCE_DOMAIN_SEPARATION_PREFIX);
  const combined = new Uint8Array(prefix.length + view.length);
  combined.set(prefix, 0);
  combined.set(view, prefix.length);
  const hashed = crypto.sha256(combined);
  // The crypto adapter is expected to return an immutable buffer.
  // If a caller wires up a non-immutable adapter we coerce here
  // so the rest of the code does not have to special-case.
  if (hashed instanceof Uint8Array) {
    return bytesToImmutable(hashed);
  }
  return hashed;
};
harden(hashNonceForSigning);

/**
 * Compare two byte-shaped inputs in constant time. Returns `true`
 * iff they have the same length and the same bytes. Accepts
 * immutable `ArrayBuffer` or `Uint8Array`.
 *
 * @param {ArrayBuffer | Uint8Array} a
 * @param {ArrayBuffer | Uint8Array} b
 * @returns {boolean}
 */
export const constantTimeEqual = (a, b) => {
  if (
    !(a instanceof Uint8Array || a instanceof ArrayBuffer) ||
    !(b instanceof Uint8Array || b instanceof ArrayBuffer)
  ) {
    return false;
  }
  const av = asUint8(a);
  const bv = asUint8(b);
  if (av.length !== bv.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < av.length; i += 1) {
    // Constant-time byte comparison: bitwise OR over byte XORs.
    // The constant-time property is the whole point of this
    // helper; the `no-bitwise` rule is appropriately suppressed.
    // eslint-disable-next-line no-bitwise
    diff |= av[i] ^ bv[i];
  }
  return diff === 0;
};
harden(constantTimeEqual);

/**
 * @typedef {object} NonceRegistry
 * @property {() => ChallengeIssued} issue Mints a fresh nonce and
 *   stores its hash under the registry's TTL policy.
 * @property {(args: {
 *   publicKey: ArrayBuffer | Uint8Array,
 *   nonce: ArrayBuffer | Uint8Array,
 *   signature: ArrayBuffer | Uint8Array,
 * }) => void} verifyAndConsume Verifies the proof-of-possession
 *   signature and consumes the nonce. Throws on a malformed input,
 *   an unknown nonce, an expired nonce, or a bad signature.
 * @property {() => number} size For tests and diagnostics: the
 *   number of issued-but-unconsumed nonces currently held.
 */

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
      const rawNonce = crypto.randomBytes(NONCE_BYTE_LENGTH);
      const nonceView = asUint8(rawNonce);
      if (nonceView.length !== NONCE_BYTE_LENGTH) {
        throw makeError(
          X`CryptoPowers.randomBytes must return ${q(NONCE_BYTE_LENGTH)} bytes`,
        );
      }
      const hashedNonce = hashNonceForSigning(nonceView, crypto);
      const issuedAt = clock.now();
      const expiresAt = issuedAt + ttlMs;
      pending.set(encodeHex(asUint8(hashedNonce)), expiresAt);
      // Return immutable buffers so the caller can pass the result
      // straight back across the wire.
      const nonceOut =
        rawNonce instanceof ArrayBuffer
          ? rawNonce
          : bytesToImmutable(nonceView);
      return harden({
        nonce: nonceOut,
        hashedNonce,
        issuedAt,
        expiresAt,
      });
    },
    /**
     * @param {object} args
     * @param {ArrayBuffer | Uint8Array} args.publicKey
     * @param {ArrayBuffer | Uint8Array} args.nonce
     * @param {ArrayBuffer | Uint8Array} args.signature
     */
    verifyAndConsume({ publicKey, nonce, signature }) {
      if (
        !(publicKey instanceof ArrayBuffer || publicKey instanceof Uint8Array)
      ) {
        throw makeError(
          X`publicKey must be an immutable ArrayBuffer or Uint8Array`,
        );
      }
      if (!(nonce instanceof ArrayBuffer || nonce instanceof Uint8Array)) {
        throw makeError(
          X`nonce must be an immutable ArrayBuffer or Uint8Array`,
        );
      }
      if (
        !(signature instanceof ArrayBuffer || signature instanceof Uint8Array)
      ) {
        throw makeError(
          X`signature must be an immutable ArrayBuffer or Uint8Array`,
        );
      }
      // Re-derive the hashed nonce the caller would have signed and
      // look it up in the pending table. If the caller submitted
      // a wrong-length nonce, this throws before we reach the
      // expiration check, which is the right precedence.
      const hashedNonce = hashNonceForSigning(nonce, crypto);
      const key = encodeHex(asUint8(hashedNonce));
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
