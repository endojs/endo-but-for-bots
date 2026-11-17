// @ts-check
/* eslint-disable no-bitwise -- field and byte arithmetic for the Noise harness */

/**
 * A minimal, independent implementation of the initiator's half of
 * `Noise_IK_25519_ChaChaPoly_BLAKE2s` message 1, as `@endo/ocapn-noise`
 * frames it (see `rust/ocapn_noise/src/lib.rs`).
 *
 * Unlike the WASM initiator, which always derives its static key from
 * its Ed25519 seed, this builder lets a test choose the static X25519
 * public key, the `ss` Diffie-Hellman result, and the claimed Ed25519
 * verifying key independently, so a test can construct the SYNs a
 * malicious initiator could send.
 */

import harden from '@endo/harden';

import {
  createCipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
} from 'crypto';

const PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_BLAKE2s';
const PROLOGUE_PREFIX = new TextEncoder().encode('OCapN/np/1\0');

// DER prefixes wrapping a raw 32-byte X25519 key.
const X25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
]);
const X25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04,
  0x22, 0x04, 0x20,
]);

const P = 2n ** 255n - 19n;

/** @param {...Uint8Array} parts */
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** @param {Uint8Array} bytes */
const leToBigInt = bytes => {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    n = (n << 8n) | BigInt(bytes[i]);
  }
  return n;
};

/** @param {bigint} n */
const bigIntToLe32 = n => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  }
  return out;
};

/**
 * @param {bigint} base
 * @param {bigint} exponent
 */
const modPow = (base, exponent) => {
  let result = 1n;
  let b = ((base % P) + P) % P;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
};

/** @param {bigint} n */
const modInverse = n => modPow(n, P - 2n);

/**
 * The y coordinate of an encoded Ed25519 point.
 *
 * @param {Uint8Array} encoded
 */
const edwardsY = encoded => {
  const bytes = Uint8Array.from(encoded);
  bytes[31] &= 0x7f;
  return leToBigInt(bytes);
};

/**
 * The X25519 (Montgomery u) form of an encoded Ed25519 point:
 * u = (1 + y) / (1 - y).  Like curve25519-dalek, maps y = 1 to u = 0.
 *
 * @param {Uint8Array} encoded
 */
export const edwardsToMontgomery = encoded => {
  const y = edwardsY(encoded);
  return bigIntToLe32(((((1n + y) * modInverse(1n - y)) % P) + P) % P);
};
harden(edwardsToMontgomery);

/**
 * Encode A + T, where T = (0, -1) is the Ed25519 point of order 2.
 * On a twisted Edwards curve, (x, y) + (0, -1) = (-x, -y).
 *
 * @param {Uint8Array} encoded
 */
export const addOrderTwoPoint = encoded => {
  const y = edwardsY(encoded);
  const out = bigIntToLe32((P - y) % P);
  // Negating x flips its sign bit (x is non-zero for any point of
  // large order).
  out[31] |= (encoded[31] & 0x80) ^ 0x80;
  return out;
};
harden(addOrderTwoPoint);

/**
 * The clamped X25519 private scalar for an Ed25519 seed, matching
 * `SigningKey::to_scalar_bytes()`.
 *
 * @param {Uint8Array} seed
 */
export const scalarFromSeed = seed => {
  const scalar = Uint8Array.from(
    createHash('sha512').update(seed).digest().subarray(0, 32),
  );
  scalar[0] &= 248;
  scalar[31] &= 127;
  scalar[31] |= 64;
  return scalar;
};
harden(scalarFromSeed);

/**
 * @param {Uint8Array} privateKey - raw 32-byte X25519 scalar
 * @param {Uint8Array} publicKey - raw 32-byte X25519 u coordinate
 */
export const x25519 = (privateKey, publicKey) =>
  Uint8Array.from(
    diffieHellman({
      privateKey: createPrivateKey({
        key: concat(X25519_PKCS8_PREFIX, privateKey),
        format: 'der',
        type: 'pkcs8',
      }),
      publicKey: createPublicKey({
        key: concat(X25519_SPKI_PREFIX, publicKey),
        format: 'der',
        type: 'spki',
      }),
    }),
  );
harden(x25519);

/** @param {...Uint8Array} parts */
const blake2s = (...parts) => {
  const hash = createHash('blake2s256');
  for (const part of parts) hash.update(part);
  return Uint8Array.from(hash.digest());
};

/**
 * @param {Uint8Array} key
 * @param {...Uint8Array} parts
 */
const hmacBlake2s = (key, ...parts) => {
  const hmac = createHmac('blake2s256', key);
  for (const part of parts) hmac.update(part);
  return Uint8Array.from(hmac.digest());
};

/**
 * Build a prefixed SYN (intended responder key || Noise IK message 1).
 *
 * @param {object} options
 * @param {Uint8Array} options.responderVerifyingKey - responder's Ed25519
 *   key; also the cleartext routing prefix and part of the prologue
 * @param {Uint8Array} options.initiatorStatic - X25519 public key sent as
 *   the initiator's static `s`
 * @param {Uint8Array} options.staticSharedSecret - the `ss` DH result the
 *   responder will compute from its static and `initiatorStatic`
 * @param {Uint8Array} options.claimedVerifyingKey - the Ed25519 key claimed
 *   in the encrypted payload
 */
export const makePrefixedSyn = ({
  responderVerifyingKey,
  initiatorStatic,
  staticSharedSecret,
  claimedVerifyingKey,
}) => {
  const responderStatic = edwardsToMontgomery(responderVerifyingKey);

  // InitializeSymmetric: the protocol name exceeds HASHLEN, so hash it.
  let h = blake2s(new TextEncoder().encode(PROTOCOL_NAME));
  let ck = h;
  /** @type {Uint8Array | undefined} */
  let k;
  let n = 0n;

  /** @param {Uint8Array} data */
  const mixHash = data => {
    h = blake2s(h, data);
  };
  /** @param {Uint8Array} inputKeyMaterial */
  const mixKey = inputKeyMaterial => {
    const temp = hmacBlake2s(ck, inputKeyMaterial);
    ck = hmacBlake2s(temp, Uint8Array.of(1));
    k = hmacBlake2s(temp, ck, Uint8Array.of(2));
    n = 0n;
  };
  /** @param {Uint8Array} plaintext */
  const encryptAndHash = plaintext => {
    if (!k) throw Error('no cipher key yet');
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setBigUint64(4, n, true);
    const cipher = createCipheriv('chacha20-poly1305', k, nonce, {
      authTagLength: 16,
    });
    cipher.setAAD(h);
    const ciphertext = concat(
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    );
    n += 1n;
    mixHash(ciphertext);
    return ciphertext;
  };

  mixHash(concat(PROLOGUE_PREFIX, responderVerifyingKey));
  // Pre-message pattern `<- s`.
  mixHash(responderStatic);

  // e
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPublic = Uint8Array.from(
    ephemeral.publicKey
      .export({ type: 'spki', format: 'der' })
      .subarray(X25519_SPKI_PREFIX.length),
  );
  mixHash(ephemeralPublic);
  // es
  mixKey(
    Uint8Array.from(
      diffieHellman({
        privateKey: ephemeral.privateKey,
        publicKey: createPublicKey({
          key: concat(X25519_SPKI_PREFIX, responderStatic),
          format: 'der',
          type: 'spki',
        }),
      }),
    ),
  );
  // s
  const encryptedStatic = encryptAndHash(initiatorStatic);
  // ss
  mixKey(staticSharedSecret);
  // Payload: claimed verifying key || encodings (first 0, no others).
  const encryptedPayload = encryptAndHash(
    concat(claimedVerifyingKey, new Uint8Array(4)),
  );

  return concat(
    responderVerifyingKey,
    ephemeralPublic,
    encryptedStatic,
    encryptedPayload,
  );
};
harden(makePrefixedSyn);
