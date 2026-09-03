// @ts-check

import { decodeBase64, encodeBase64 } from '@endo/base64';
import { makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';

import {
  SecretAdminInterface,
  SecretAuditReaderInterface,
  SecretBlobInterface,
  SecretCatalogInterface,
  SecretImporterInterface,
  SecretManagerDirectoryInterface,
} from './interfaces.js';
import { assertPetName } from './pet-name.js';

/** @import { SecretAuditEvent, SecretSummary } from './types.js' */

const MAX_SECRET_BYTES = 1024 * 1024;
const MAX_PURPOSE_LENGTH = 200;

export const secretBlobHelp =
  'This capability grants access to secret bytes. Prefer proposing a formula that receives it as an endowment. Do not call readBase64() unless the task specifically requires learning the secret value.';
harden(secretBlobHelp);

const fixedError = code => makeError(X`Secret operation failed: ${q(code)}`);

/**
 * @param {string} purpose
 */
const assertPurpose = purpose => {
  if (
    typeof purpose !== 'string' ||
    purpose.length === 0 ||
    purpose.length > MAX_PURPOSE_LENGTH ||
    purpose.includes('\n') ||
    purpose.includes('\r')
  ) {
    throw fixedError('INVALID_PURPOSE');
  }
};

/**
 * Decode and canonicalize the passable wire representation without ever
 * including it in an error.
 *
 * @param {string} bytesBase64
 * @returns {Uint8Array}
 */
const decodeSecret = bytesBase64 => {
  try {
    if (typeof bytesBase64 !== 'string') {
      throw new TypeError('not a string');
    }
    const bytes = decodeBase64(bytesBase64);
    if (
      encodeBase64(bytes) !== bytesBase64 ||
      bytes.length > MAX_SECRET_BYTES
    ) {
      throw new TypeError('invalid encoding or size');
    }
    return bytes;
  } catch {
    throw fixedError('INVALID_SECRET_BYTES');
  }
};

/**
 * @typedef {object} SecretRecord
 * @property {string} secretId
 * @property {string} backendRef
 * @property {string} purpose
 * @property {'active' | 'revoked' | 'unavailable'} state
 * @property {bigint} generation
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {object} SecretPersistence
 * @property {(secretId: string) => SecretRecord | undefined} getSecretRecord
 * @property {(record: SecretRecord) => void} writeSecretRecord
 * @property {() => SecretRecord[]} listSecretRecords
 * @property {(grantId: string) => string | undefined} getSecretIdForGrant
 * @property {(grantId: string, secretId: string) => void} writeSecretGrant
 * @property {(event: SecretAuditEvent) => void} writeSecretAuditEvent
 * @property {(limit: number) => SecretAuditEvent[]} listSecretAuditEvents
 */

/**
 * @typedef {object} SecretBackend
 * @property {(operationId: string, secretId: string, bytes: Uint8Array) => Promise<string>} create
 * @property {(backendRef: string) => Promise<Uint8Array>} read
 * @property {(operationId: string, backendRef: string, bytes: Uint8Array) => Promise<void>} replace
 * @property {(operationId: string, backendRef: string) => Promise<void>} revoke
 */

/**
 * @param {object} powers
 * @param {SecretPersistence} powers.persistence
 * @param {SecretBackend} powers.backend
 * @param {() => Promise<string>} powers.randomHex256
 * @param {() => string} [powers.now]
 */
export const makeSecretManager = ({
  persistence,
  backend,
  randomHex256,
  now = () => new Date().toISOString(),
}) => {
  /** @param {SecretRecord} record */
  const summaryFor = record =>
    harden(
      /** @type {SecretSummary} */ ({
        secretId: record.secretId,
        purpose: record.purpose,
        state: record.state,
        generation: record.generation,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }),
    );

  /**
   * @param {string} secretId
   * @returns {SecretRecord}
   */
  const requireRecord = secretId => {
    const record = persistence.getSecretRecord(secretId);
    if (record === undefined) {
      throw fixedError('UNKNOWN_SECRET');
    }
    return record;
  };

  /**
   * @param {string} secretId
   * @param {SecretAuditEvent['operation']} operation
   * @param {SecretAuditEvent['outcome']} outcome
   * @param {bigint} generation
   * @param {string} operationId
   * @param {object} [extra]
   * @param {string} [extra.grantId]
   * @param {string} [extra.reasonCode]
   */
  const audit = async (
    secretId,
    operation,
    outcome,
    generation,
    operationId,
    extra = {},
  ) => {
    const eventId = await randomHex256();
    persistence.writeSecretAuditEvent(
      harden({
        eventId,
        secretId,
        operation,
        outcome,
        generation,
        occurredAt: now(),
        operationId,
        ...extra,
      }),
    );
  };

  /** @type {Map<string, import('./types.js').SecretBlob>} */
  const blobs = new Map();
  /** @type {Map<string, import('./types.js').SecretAdmin>} */
  const admins = new Map();
  /** @type {Map<string, Promise<unknown>>} */
  const mutationTails = new Map();

  /**
   * Serialize lifecycle mutations per secret so a replace cannot resurrect a
   * concurrently revoked record and generation increments cannot be lost.
   *
   * @template T
   * @param {string} secretId
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const serializeMutation = async (secretId, operation) => {
    const prior = mutationTails.get(secretId) || Promise.resolve();
    const current = prior.catch(() => {}).then(operation);
    mutationTails.set(secretId, current);
    /** @type {T} */
    let result;
    await null;
    try {
      result = await current;
    } finally {
      if (mutationTails.get(secretId) === current) {
        mutationTails.delete(secretId);
      }
    }
    return result;
  };

  /** @param {string} grantId */
  const provideBlob = grantId => {
    const existing = blobs.get(grantId);
    if (existing !== undefined) return existing;
    const secretId = persistence.getSecretIdForGrant(grantId);
    if (secretId === undefined) throw fixedError('UNKNOWN_GRANT');
    const blob = makeExo(`SecretBlob ${grantId}`, SecretBlobInterface, {
      help: () => secretBlobHelp,
      getPurpose: async () => requireRecord(secretId).purpose,
      readBase64: async () => {
        const before = requireRecord(secretId);
        if (before.state !== 'active') throw fixedError('REVOKED');
        const operationId = await randomHex256();
        await audit(
          secretId,
          'release',
          'attempted',
          before.generation,
          operationId,
          { grantId },
        );
        let bytes;
        try {
          // This state check is intentionally adjacent to the backend call.
          if (requireRecord(secretId).state !== 'active') {
            throw fixedError('REVOKED');
          }
          bytes = await backend.read(before.backendRef);
          const after = requireRecord(secretId);
          if (
            after.state !== 'active' ||
            after.generation !== before.generation
          ) {
            bytes.fill(0);
            throw fixedError('STALE_RELEASE');
          }
          await audit(
            secretId,
            'release',
            'succeeded',
            after.generation,
            operationId,
            { grantId },
          );
          const bytesBase64 = encodeBase64(bytes);
          bytes.fill(0);
          return bytesBase64;
        } catch {
          if (bytes !== undefined) bytes.fill(0);
          await audit(
            secretId,
            'release',
            'failed',
            before.generation,
            operationId,
            { grantId, reasonCode: 'RELEASE_FAILED' },
          );
          throw fixedError('RELEASE_FAILED');
        }
      },
    });
    blobs.set(grantId, blob);
    return blob;
  };

  /** @param {string} secretId */
  const provideAdmin = secretId => {
    const existing = admins.get(secretId);
    if (existing !== undefined) return existing;
    requireRecord(secretId);
    const admin = makeExo(`SecretAdmin ${secretId}`, SecretAdminInterface, {
      getSummary: async () => summaryFor(requireRecord(secretId)),
      replaceBase64: bytesBase64 =>
        serializeMutation(secretId, async () => {
          const bytes = decodeSecret(bytesBase64);
          const before = requireRecord(secretId);
          if (before.state !== 'active') throw fixedError('REVOKED');
          const operationId = await randomHex256();
          await audit(
            secretId,
            'replace',
            'attempted',
            before.generation,
            operationId,
          );
          try {
            await backend.replace(operationId, before.backendRef, bytes);
            const updated = harden({
              ...before,
              generation: before.generation + 1n,
              updatedAt: now(),
            });
            persistence.writeSecretRecord(updated);
            await audit(
              secretId,
              'replace',
              'succeeded',
              updated.generation,
              operationId,
            );
          } catch {
            await audit(
              secretId,
              'replace',
              'failed',
              before.generation,
              operationId,
              { reasonCode: 'REPLACE_FAILED' },
            );
            throw fixedError('REPLACE_FAILED');
          } finally {
            bytes.fill(0);
          }
        }),
      setPurpose: purpose =>
        serializeMutation(secretId, async () => {
          assertPurpose(purpose);
          const before = requireRecord(secretId);
          if (before.state === 'revoked') throw fixedError('REVOKED');
          const operationId = await randomHex256();
          persistence.writeSecretRecord(
            harden({ ...before, purpose, updatedAt: now() }),
          );
          await audit(
            secretId,
            'rename',
            'succeeded',
            before.generation,
            operationId,
          );
        }),
      revoke: () =>
        serializeMutation(secretId, async () => {
          const before = requireRecord(secretId);
          const operationId = await randomHex256();
          await audit(
            secretId,
            'revoke',
            'attempted',
            before.generation,
            operationId,
          );
          const revoked = harden({
            ...before,
            state: /** @type {'revoked'} */ ('revoked'),
            updatedAt: now(),
          });
          // Persist the denial before attempting backend cleanup: fail closed.
          persistence.writeSecretRecord(revoked);
          try {
            await backend.revoke(operationId, before.backendRef);
            await audit(
              secretId,
              'revoke',
              'succeeded',
              before.generation,
              operationId,
            );
          } catch {
            await audit(
              secretId,
              'revoke',
              'failed',
              before.generation,
              operationId,
              { reasonCode: 'BACKEND_CLEANUP_FAILED' },
            );
            throw fixedError('BACKEND_CLEANUP_FAILED');
          }
        }),
    });
    admins.set(secretId, admin);
    return admin;
  };

  const catalog = makeExo('SecretCatalog', SecretCatalogInterface, {
    list: async () =>
      harden(
        persistence.listSecretRecords().map(record => ({
          secretId: record.secretId,
          summary: summaryFor(record),
          admin: provideAdmin(record.secretId),
        })),
      ),
  });

  const auditReader = makeExo('SecretAuditReader', SecretAuditReaderInterface, {
    list: async (limit = 100n) => {
      if (limit < 0n || limit > 1000n) throw fixedError('INVALID_LIMIT');
      return harden(persistence.listSecretAuditEvents(Number(limit)));
    },
  });

  /**
   * @param {object} hostPowers
   * @param {(grantId: string, name: string) => Promise<void>} hostPowers.bindGrant
   */
  const makeHostDirectory = ({ bindGrant }) => {
    const importer = makeExo('SecretImporter', SecretImporterInterface, {
      createBase64: async (name, purpose, bytesBase64) => {
        assertPetName(name);
        assertPurpose(purpose);
        const bytes = decodeSecret(bytesBase64);
        const secretId = await randomHex256();
        const grantId = await randomHex256();
        const operationId = await randomHex256();
        const createdAt = now();
        await audit(secretId, 'create', 'attempted', 1n, operationId);
        try {
          const backendRef = await backend.create(operationId, secretId, bytes);
          const record = harden(
            /** @type {SecretRecord} */ ({
              secretId,
              backendRef,
              purpose,
              state: 'active',
              generation: 1n,
              createdAt,
              updatedAt: createdAt,
            }),
          );
          persistence.writeSecretRecord(record);
          persistence.writeSecretGrant(grantId, secretId);
          await bindGrant(grantId, name);
          await audit(secretId, 'create', 'succeeded', 1n, operationId);
          return summaryFor(record);
        } catch {
          await audit(secretId, 'create', 'failed', 1n, operationId, {
            reasonCode: 'CREATE_FAILED',
          });
          throw fixedError('CREATE_FAILED');
        } finally {
          bytes.fill(0);
        }
      },
    });

    const lookup = async path => {
      const names = Array.isArray(path) ? path : [path];
      if (names.length === 1 && names[0] === 'create') return importer;
      if (names.length === 1 && names[0] === 'catalog') return catalog;
      if (names.length === 1 && names[0] === 'audit') return auditReader;
      if (names.length === 2 && names[0] === 'use') {
        return provideBlob(names[1]);
      }
      if (names.length === 2 && names[0] === 'admin') {
        return provideAdmin(names[1]);
      }
      throw fixedError('UNKNOWN_PATH');
    };

    return makeExo('SecretManagerDirectory', SecretManagerDirectoryInterface, {
      help: () =>
        'Manage secret blobs without exposing their values. Use create, catalog, or audit.',
      has: async name => ['create', 'catalog', 'audit'].includes(name),
      list: async () => harden(['audit', 'catalog', 'create']),
      lookup,
    });
  };

  return harden({ makeHostDirectory });
};
harden(makeSecretManager);

export const secretManagerLimits = harden({
  maxSecretBytes: MAX_SECRET_BYTES,
  maxPurposeLength: MAX_PURPOSE_LENGTH,
});
harden(secretManagerLimits);
