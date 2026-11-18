// @ts-check
/**
 * Sealed boxes for the CLI path (M2 W2.3; D-6; `designs/m2-interfaces.md`
 * section 9.2): a value travels from the CLI to the adapter's
 * `SecretWriter` through the hub, and the hub may keep the message in its
 * state, so the CLI seals it to the adapter's X25519 public key first and
 * the hub only ever carries ciphertext.
 *
 * Format `x25519-aes-256-gcm-1` (`shapes.SealedBox`): the sender makes an
 * ephemeral X25519 key pair; the AES-256-GCM key is HKDF-SHA256 of the
 * shared secret with salt `ephemeral public | recipient public`; `box` is
 * base64 of `nonce (12) | ciphertext | tag (16)`, with the format as
 * additional data; `publicKey` is the ephemeral public key in 64 hex.
 *
 * The adapter's X25519 private key is not stored anywhere: it is derived by
 * HKDF from the secrets wrapping key (the 32-byte key file outside the
 * state directory), so whoever holds the state directory alone can open
 * neither `secrets.enc` nor a box the hub kept.
 *
 * Node only (adapter, CLI).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { Buffer } from 'node:buffer';
import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
} from 'node:crypto';

import { limits } from '../../../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import { decrypt, encrypt, secretError } from './store.js';

/** @import { WrappingKey } from './wrapping-key.js' */

export const SEALED_BOX_FORMAT = 'x25519-aes-256-gcm-1';
/** DER prefix of a PKCS#8 X25519 private key (RFC 8410) before its 32 bytes. */
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
/** DER prefix of an SPKI X25519 public key before its 32 bytes. */
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const fatalUtf8 = new TextDecoder('utf-8', { fatal: true });

/** @param {Buffer} raw */
const privateKeyOf = raw =>
  createPrivateKey({
    key: Buffer.concat([PKCS8_X25519, raw]),
    format: 'der',
    type: 'pkcs8',
  });

/** @param {Buffer} raw */
const publicKeyOf = raw =>
  createPublicKey({
    key: Buffer.concat([SPKI_X25519, raw]),
    format: 'der',
    type: 'spki',
  });

/** @param {import('node:crypto').KeyObject} key */
const rawPublic = key =>
  Buffer.from(key.export({ type: 'spki', format: 'der' })).subarray(-32);

/**
 * @param {Buffer} shared
 * @param {Buffer} senderPublic
 * @param {Buffer} recipientPublic
 */
const boxKey = (shared, senderPublic, recipientPublic) =>
  Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      Buffer.concat([senderPublic, recipientPublic]),
      'thix-harness sealed box 1',
      32,
    ),
  );

/** @param {unknown} hex */
const isPublicHex = hex =>
  typeof hex === 'string' && /^[0-9a-f]{64}$/.test(hex);

/**
 * Seal `value` to the adapter's public key (the CLI's half).
 * @param {string} publicKeyHex `SecretWriter.publicKey()`
 * @param {string} value
 */
export const sealTo = (publicKeyHex, value) => {
  if (!isPublicHex(publicKeyHex)) throw Error('not an X25519 public key');
  const recipientPublic = Buffer.from(publicKeyHex, 'hex');
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const senderPublic = rawPublic(publicKey);
  const shared = diffieHellman({
    privateKey,
    publicKey: publicKeyOf(recipientPublic),
  });
  const key = boxKey(shared, senderPublic, recipientPublic);
  shared.fill(0);
  const plain = Buffer.from(value, 'utf8');
  const box = encrypt(key, plain, SEALED_BOX_FORMAT).toString('base64');
  plain.fill(0);
  key.fill(0);
  return harden({
    format: SEALED_BOX_FORMAT,
    publicKey: senderPublic.toString('hex'),
    box,
  });
};
harden(sealTo);

/**
 * The adapter's sealing keys.
 *
 * @param {object} options
 * @param {WrappingKey} [options.wrappingKey] the incarnation's wrapping key
 *   (`makeWrappingKey`, the store's)
 * @param {Buffer} [options.key] the wrapping key itself (tests)
 */
export const makeSealKeys = ({ wrappingKey, key: givenKey }) => {
  /** @type {import('node:crypto').KeyObject | undefined} */
  let privateKey;
  /** @type {Buffer | undefined} */
  let publicRaw;
  /** @type {Promise<void> | undefined} */
  let loading;

  /** @param {Buffer} wrapKey */
  const derive = wrapKey => {
    const raw = Buffer.from(
      hkdfSync(
        'sha256',
        wrapKey,
        Buffer.from('thix-harness', 'utf8'),
        'sealed-box x25519 1',
        32,
      ),
    );
    privateKey = privateKeyOf(raw);
    raw.fill(0);
    publicRaw = rawPublic(createPublicKey(privateKey));
  };
  if (givenKey !== undefined) derive(givenKey);

  /** Derives once; a failed load is not kept, the next call tries again. */
  const ready = () => {
    if (privateKey !== undefined) return Promise.resolve();
    if (loading === undefined) {
      const attempt = (async () => {
        if (wrappingKey === undefined) throw Error('no secrets key file');
        derive(await wrappingKey.get());
      })();
      loading = attempt;
      attempt.catch(() => {
        if (loading === attempt) loading = undefined;
      });
    }
    return loading;
  };

  const publicKey = () => {
    if (publicRaw === undefined) throw Error('the sealing keys are not ready');
    return publicRaw.toString('hex');
  };

  /**
   * Open a box sealed to this adapter; any defect is `INVALID_SECRET_BYTES`
   * and never says more.
   * @param {any} box a `shapes.SealedBox`
   * @returns {string}
   */
  const open = box => {
    if (privateKey === undefined || publicRaw === undefined)
      throw secretError('READ_FAILED');
    try {
      if (
        box === null ||
        typeof box !== 'object' ||
        box.format !== SEALED_BOX_FORMAT ||
        !isPublicHex(box.publicKey) ||
        typeof box.box !== 'string' ||
        Number(box.box.length) > limits.sealedBoxUnits
      )
        throw Error('bad box');
      const senderPublic = Buffer.from(box.publicKey, 'hex');
      const shared = diffieHellman({
        privateKey,
        publicKey: publicKeyOf(senderPublic),
      });
      const key = boxKey(shared, senderPublic, publicRaw);
      shared.fill(0);
      const plain = decrypt(
        key,
        Buffer.from(box.box, 'base64'),
        SEALED_BOX_FORMAT,
      );
      key.fill(0);
      const value = fatalUtf8.decode(plain);
      plain.fill(0);
      return value;
    } catch {
      throw secretError('INVALID_SECRET_BYTES');
    }
  };

  return harden({ ready, publicKey, open });
};
harden(makeSealKeys);
