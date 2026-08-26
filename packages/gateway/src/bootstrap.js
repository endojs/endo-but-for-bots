// @ts-check

/**
 * @file `GatewayBootstrap` and `Registration` exos for the gateway's
 *   local sock bootstrap channel (design Feature 4).
 *
 * This module implements the *semantic* core of the bootstrap: the
 * exo objects, the nonce registry, the registration table, and the
 * proof-of-possession check that gates which-public-keys-may-register.
 *
 * It does **not** open a sock listener; that is a Node (or other
 * platform-bound) concern that follows in a separate PR alongside
 * CapTP-over-netstring framing reuse from
 * `packages/daemon/src/connection.js`. Once the listener exists, it
 * accepts incoming CapTP connections and serves *this* bootstrap exo
 * as the connection's bootstrap object. Until then, embedders that
 * already speak CapTP (a Familiar bundle holding a process-local
 * handle, a test that connects in-realm) hold the exo directly via
 * `makeGateway(...).getBootstrap()`.
 *
 * The exos use `makeExo` + `M.interface` per `project/CLAUDE.md` §
 * Exo and Interface Authoring, so CapTP introspection
 * (`__getMethodNames__`) works out of the box.
 *
 * Identifiers carried on the bootstrap wire (`publicKey`,
 * `proofOfPossession`, `nonce`, etc.) are immutable `ArrayBuffer`
 * per the `@endo/bytes` convention. Typed arrays cannot be frozen,
 * so `@endo/marshal` and `@endo/patterns` reject them as
 * non-passable; immutable `ArrayBuffer` is the canonical
 * cross-realm byte shape. The bootstrap also accepts `Uint8Array`
 * on its internal in-realm API (where the pattern checker is not
 * in the picture) so embedders that hand the bootstrap to direct
 * callers do not have to convert.
 */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeError, q, X } from '@endo/errors';
import { bytesFromImmutable } from '@endo/bytes/from-immutable.js';
import { encodeHex } from '@endo/hex';

import { makeNonceRegistry, NONCE_BYTE_LENGTH } from './proof-of-possession.js';

/** @import { AppsNameHub, BootstrapDeps, ChallengeIssued, GatewayBootstrap, PublicKeyAddition, Registration, RegistrationArgs, RegistrationEntry, RelayRegistrationArgs, WebletDescriptor } from './types.js' */

/**
 * Expected raw Ed25519 public key length in bytes. The bootstrap
 * accepts only this length; SPKI-encoded keys (12-byte prefix plus
 * 32 raw bytes) and PKCS#8 keys are converted to raw at the boundary
 * by the caller (the daemon's `daemonNodePowers` already does this
 * conversion for its own keypair generation; downstream code follows
 * suit).
 */
export const ED25519_PUBLIC_KEY_LENGTH = 32;
harden(ED25519_PUBLIC_KEY_LENGTH);

/** Expected raw Ed25519 signature length in bytes. */
export const ED25519_SIGNATURE_LENGTH = 64;
harden(ED25519_SIGNATURE_LENGTH);

const RegistrationInterface = M.interface('GatewayRegistration', {
  publishWeblet: M.call(M.any()).returns(M.promise()),
  unpublishWeblet: M.call(M.string()).returns(M.promise()),
  addPublicKey: M.call(M.any()).returns(M.promise()),
  deregister: M.call().returns(M.promise()),
  listWeblets: M.call().returns(M.promise()),
  listPublicKeys: M.call().returns(M.promise()),
});

const GatewayBootstrapInterface = M.interface('GatewayBootstrap', {
  challenge: M.call().returns(M.promise()),
  register: M.call(M.any()).returns(M.promise()),
  registerRelay: M.call(M.any()).returns(M.promise()),
  getBindAddress: M.call().returns(M.promise()),
  getApps: M.call().returns(M.promise()),
});

/**
 * Validate that a byte-shaped input is an immutable `ArrayBuffer`
 * (wire shape) or a `Uint8Array` (internal use) with the expected
 * length. Returns the input unchanged for chaining.
 *
 * @param {unknown} candidate
 * @param {string} fieldName For diagnostics.
 * @param {number} expectedLength In bytes.
 * @returns {ArrayBuffer | Uint8Array}
 */
const checkBytesLength = (candidate, fieldName, expectedLength) => {
  if (
    !(candidate instanceof ArrayBuffer) &&
    !(candidate instanceof Uint8Array)
  ) {
    throw makeError(
      X`${q(fieldName)} must be an immutable ArrayBuffer or Uint8Array`,
    );
  }
  const length =
    candidate instanceof Uint8Array ? candidate.length : candidate.byteLength;
  if (length !== expectedLength) {
    throw makeError(
      X`${q(fieldName)} must be ${q(expectedLength)} bytes, got ${q(length)}`,
    );
  }
  return candidate;
};

/**
 * @param {unknown} candidate
 * @returns {ArrayBuffer | Uint8Array}
 */
const checkPublicKey = candidate =>
  checkBytesLength(candidate, 'publicKey', ED25519_PUBLIC_KEY_LENGTH);

/**
 * @param {unknown} candidate
 * @returns {ArrayBuffer | Uint8Array}
 */
const checkSignature = candidate =>
  checkBytesLength(candidate, 'signature', ED25519_SIGNATURE_LENGTH);

/**
 * @param {unknown} candidate
 * @returns {ArrayBuffer | Uint8Array}
 */
const checkNonce = candidate =>
  checkBytesLength(candidate, 'nonce', NONCE_BYTE_LENGTH);

/**
 * Validate a webletId shape: a non-empty string with no whitespace
 * or control characters. Matches the design's gateway-assigned
 * identifier convention.
 *
 * @param {unknown} candidate
 * @returns {string}
 */
const checkWebletId = candidate => {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw makeError(
      X`webletId must be a non-empty string, got ${q(candidate)}`,
    );
  }
  if (candidate.length > 253) {
    throw makeError(X`webletId exceeds 253 octets: ${q(candidate.length)}`);
  }
  if (!/^[A-Za-z0-9.\-_]+$/.test(candidate)) {
    throw makeError(X`webletId contains invalid characters: ${q(candidate)}`);
  }
  return candidate;
};

/**
 * Validate a content-tree root: 64 hex characters (SHA-256).
 *
 * @param {unknown} candidate
 * @returns {string}
 */
const checkContentTreeRoot = candidate => {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw makeError(X`contentTreeRoot must be a non-empty string`);
  }
  if (!/^[0-9a-f]{64}$/.test(candidate)) {
    throw makeError(
      X`contentTreeRoot must be 64 lowercase hex characters, got ${q(candidate)}`,
    );
  }
  return candidate;
};

/**
 * Render a public key as lowercase hex; used as a registration key.
 * Accepts either an immutable `ArrayBuffer` (wire shape) or a
 * `Uint8Array` (internal use); copies the immutable case via
 * `bytesFromImmutable` so byte indexing works either way.
 *
 * @param {ArrayBuffer | Uint8Array} bytes
 * @returns {string}
 */
const publicKeyToHex = bytes => {
  const view = bytes instanceof Uint8Array ? bytes : bytesFromImmutable(bytes);
  return encodeHex(view);
};

/**
 * Create the bootstrap exo, the registration registry, and the
 * nonce registry. The exo is the CapTP-reachable entry point a sock
 * listener serves as its bootstrap object.
 *
 * @param {BootstrapDeps} deps
 * @returns {{
 *   bootstrap: GatewayBootstrap,
 *   listRegisteredPeers: () => ReadonlyArray<{
 *     publicKeys: ReadonlyArray<ArrayBuffer | Uint8Array>,
 *     weblets: ReadonlyArray<WebletDescriptor>,
 *     relayTarget?: unknown,
 *     daemon?: unknown,
 *   }>,
 *   pendingNonces: () => number,
 * }}
 */
export const makeGatewayBootstrap = ({
  crypto,
  clock,
  apps,
  getBindAddress,
  ttlMs,
}) => {
  if (crypto === undefined) {
    throw makeError(X`makeGatewayBootstrap requires crypto powers`);
  }
  if (clock === undefined) {
    throw makeError(X`makeGatewayBootstrap requires clock powers`);
  }
  if (apps === undefined) {
    throw makeError(X`makeGatewayBootstrap requires an AppsNameHub`);
  }
  if (typeof getBindAddress !== 'function') {
    throw makeError(X`makeGatewayBootstrap requires a getBindAddress function`);
  }

  const nonces = makeNonceRegistry({ crypto, clock, ttlMs });

  /**
   * Map from public-key hex to the registration entry that owns it.
   * Multiple keys can map to the same entry (via `addPublicKey`); a
   * deregister clears every key.
   *
   * @type {Map<string, RegistrationEntry>}
   */
  const registrationsByKey = new Map();
  /** @type {Set<RegistrationEntry>} */
  const allRegistrations = new Set();

  /** @param {RegistrationEntry} entry */
  const deregisterEntry = entry => {
    if (entry.deregistered) {
      return;
    }
    entry.deregistered = true;
    for (const key of entry.publicKeys) {
      registrationsByKey.delete(publicKeyToHex(key));
    }
    entry.weblets.clear();
    allRegistrations.delete(entry);
  };

  /**
   * @param {RegistrationEntry} entry
   */
  const makeRegistrationExo = entry => {
    const exo = makeExo(
      'GatewayRegistration',
      RegistrationInterface,
      /** @type {any} */ ({
        /** @param {WebletDescriptor} descriptor */
        async publishWeblet(descriptor) {
          if (entry.deregistered) {
            throw makeError(X`Registration has been deregistered`);
          }
          if (descriptor === null || typeof descriptor !== 'object') {
            throw makeError(X`publishWeblet expects a descriptor object`);
          }
          const webletId = checkWebletId(descriptor.webletId);
          const contentTreeRoot = checkContentTreeRoot(
            descriptor.contentTreeRoot,
          );
          if (typeof descriptor.hasWebSocket !== 'boolean') {
            throw makeError(X`hasWebSocket must be a boolean`);
          }
          const normalized = harden({
            webletId,
            contentTreeRoot,
            hasWebSocket: descriptor.hasWebSocket,
          });
          entry.weblets.set(webletId, normalized);
        },
        /** @param {string} webletId */
        async unpublishWeblet(webletId) {
          if (entry.deregistered) {
            throw makeError(X`Registration has been deregistered`);
          }
          const normalized = checkWebletId(webletId);
          entry.weblets.delete(normalized);
        },
        /** @param {PublicKeyAddition} addition */
        async addPublicKey(addition) {
          if (entry.deregistered) {
            throw makeError(X`Registration has been deregistered`);
          }
          if (addition === null || typeof addition !== 'object') {
            throw makeError(X`addPublicKey expects an addition object`);
          }
          const publicKey = checkPublicKey(addition.publicKey);
          const nonce = checkNonce(addition.nonce);
          const signature = checkSignature(addition.signature);
          nonces.verifyAndConsume({ publicKey, nonce, signature });
          const hex = publicKeyToHex(publicKey);
          if (registrationsByKey.has(hex)) {
            throw makeError(X`Public key ${q(hex)} is already registered`);
          }
          entry.publicKeys = harden([...entry.publicKeys, publicKey]);
          registrationsByKey.set(hex, entry);
        },
        async deregister() {
          deregisterEntry(entry);
        },
        async listWeblets() {
          if (entry.deregistered) {
            throw makeError(X`Registration has been deregistered`);
          }
          return harden([...entry.weblets.values()]);
        },
        async listPublicKeys() {
          if (entry.deregistered) {
            throw makeError(X`Registration has been deregistered`);
          }
          return entry.publicKeys;
        },
      }),
    );
    return /** @type {Registration} */ (/** @type {unknown} */ (exo));
  };

  /**
   * @param {ArrayBuffer | Uint8Array} publicKey
   * @param {ArrayBuffer | Uint8Array} nonce
   * @param {ArrayBuffer | Uint8Array} signature
   * @param {{ daemon?: unknown, cancelled?: Promise<unknown>, relayTarget?: unknown }} extras
   */
  const registerInternal = (publicKey, nonce, signature, extras) => {
    nonces.verifyAndConsume({ publicKey, nonce, signature });
    const hex = publicKeyToHex(publicKey);
    if (registrationsByKey.has(hex)) {
      throw makeError(X`Public key ${q(hex)} is already registered`);
    }
    /** @type {RegistrationEntry} */
    const entry = {
      publicKeys: harden([publicKey]),
      daemon: extras.daemon,
      // RegistrationEntry intentionally holds the relayTarget as a
      // mutable property even though publicKeys is frozen; the
      // weblet map is also mutable.
      weblets: new Map(),
      deregistered: false,
    };
    if (extras.relayTarget !== undefined) {
      // Stash on the entry under a non-enumerable property so the
      // shape of `listRegisteredPeers` stays predictable. The relay
      // target is for Feature 6.
      Object.defineProperty(entry, 'relayTarget', {
        value: extras.relayTarget,
        enumerable: true,
      });
    }
    registrationsByKey.set(hex, entry);
    allRegistrations.add(entry);
    if (extras.cancelled !== undefined) {
      void Promise.resolve(extras.cancelled).then(
        () => deregisterEntry(entry),
        () => deregisterEntry(entry),
      );
    }
    return makeRegistrationExo(entry);
  };

  const bootstrap = makeExo(
    'GatewayBootstrap',
    GatewayBootstrapInterface,
    /** @type {any} */ ({
      async challenge() {
        const issued = nonces.issue();
        // ChallengeIssued is already hardened; return shape-mapped
        // to ChallengePayload.
        return harden({
          nonce: issued.nonce,
          hashedNonce: issued.hashedNonce,
          issuedAt: issued.issuedAt,
          expiresAt: issued.expiresAt,
        });
      },
      /** @param {RegistrationArgs} args */
      async register(args) {
        if (args === null || typeof args !== 'object') {
          throw makeError(X`register expects an args object`);
        }
        const publicKey = checkPublicKey(args.publicKey);
        const nonce = checkNonce(args.nonce);
        const signature = checkSignature(args.signature);
        if (args.daemon !== undefined && args.cancelled === undefined) {
          throw makeError(X`register requires cancelled when daemon is present`);
        }
        return registerInternal(publicKey, nonce, signature, {
          daemon: args.daemon,
          cancelled: args.cancelled,
        });
      },
      /** @param {RelayRegistrationArgs} args */
      async registerRelay(args) {
        if (args === null || typeof args !== 'object') {
          throw makeError(X`registerRelay expects an args object`);
        }
        const publicKey = checkPublicKey(args.publicKey);
        const nonce = checkNonce(args.nonce);
        const signature = checkSignature(args.signature);
        if (args.relayTarget === undefined) {
          throw makeError(X`registerRelay requires a relayTarget`);
        }
        return registerInternal(publicKey, nonce, signature, {
          relayTarget: args.relayTarget,
        });
      },
      async getBindAddress() {
        return getBindAddress();
      },
      async getApps() {
        return apps;
      },
    }),
  );

  /**
   * Diagnostic accessor used by `makeGateway` for admin / test
   * inspection. Not part of the CapTP exo surface; intentionally
   * exposed only on the in-process return shape.
   */
  const listRegisteredPeers = () => {
    const entries = [];
    for (const entry of allRegistrations) {
      if (!entry.deregistered) {
        entries.push(
          harden({
            publicKeys: entry.publicKeys,
            weblets: harden([...entry.weblets.values()]),
            relayTarget: /** @type {any} */ (entry).relayTarget,
            daemon: entry.daemon,
          }),
        );
      }
    }
    return harden(entries);
  };

  const bootstrapAsType = /** @type {GatewayBootstrap} */ (
    /** @type {unknown} */ (bootstrap)
  );

  return harden({
    bootstrap: bootstrapAsType,
    listRegisteredPeers,
    pendingNonces: () => nonces.size(),
  });
};
harden(makeGatewayBootstrap);
