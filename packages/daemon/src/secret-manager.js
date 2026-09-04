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

/** @import { SecretAdmin, SecretAuditEvent, SecretBlob, SecretRecord, SecretSummary } from './types.js' */

const MAX_SECRET_BYTES = 1024 * 1024;
const MAX_DESCRIPTION_LENGTH = 200;

export const secretBlobHelp =
  'This capability grants access to secret bytes. Prefer proposing a formula that receives it as an endowment. Do not call readBase64() unless the task specifically requires learning the secret value.';
harden(secretBlobHelp);

const fixedError = code => makeError(X`Secret operation failed: ${q(code)}`);

/**
 * @param {string} description
 */
const assertDescription = description => {
  if (
    typeof description !== 'string' ||
    description.length === 0 ||
    description.length > MAX_DESCRIPTION_LENGTH ||
    description.includes('\n') ||
    description.includes('\r')
  ) {
    throw fixedError('INVALID_DESCRIPTION');
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
 * Decode secret bytes for the duration of one operation and zero the plaintext
 * on every exit path, including guard failures before the backend is reached.
 *
 * The `await` in `return await` is load-bearing: returning the promise
 * unawaited would run the `finally` and zero the buffer out from under the
 * operation still reading it.
 *
 * @template T
 * @param {string} bytesBase64
 * @param {(bytes: Uint8Array) => Promise<T>} operation
 * @returns {Promise<T>}
 */
const withDecodedSecret = async (bytesBase64, operation) => {
  const bytes = decodeSecret(bytesBase64);
  await null;
  try {
    return await operation(bytes);
  } finally {
    bytes.fill(0);
  }
};

/**
 * @typedef {object} SecretPersistence
 * @property {(secretId: string) => SecretRecord | undefined} getSecretRecord
 * @property {(record: SecretRecord) => void} writeSecretRecord
 * @property {() => SecretRecord[]} listSecretRecords
 * @property {(grantId: string) => string | undefined} getSecretIdForGrant
 * @property {(grantId: string, secretId: string) => void} writeSecretGrant
 * @property {(secretId: string) => void} deleteSecret
 * @property {(event: SecretAuditEvent) => void} writeSecretAuditEvent
 * @property {(limit: number) => SecretAuditEvent[]} listSecretAuditEvents
 */

/**
 * @typedef {object} SecretBackend
 * @property {(operationId: string, secretId: string, bytes: Uint8Array) => Promise<string>} create
 * @property {(backendRef: string) => Promise<Uint8Array>} read
 * @property {(operationId: string, backendRef: string, bytes: Uint8Array) => Promise<void>} replace
 * @property {(operationId: string, backendRef: string) => Promise<void>} revoke
 *   Idempotent: revoking already-revoked material must succeed, because
 *   `SecretAdmin.delete` retries revocation before forgetting the record.
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
        description: record.description,
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

  /** @type {Map<string, SecretBlob>} */
  const blobs = new Map();
  /** @type {Map<string, Promise<unknown>>} */
  const mutationTails = new Map();

  /**
   * Secrets whose backing bytes are mid-replacement. `serializeMutation`
   * admits at most one replacement per secret, so a Set suffices. A read that
   * samples the record while a replacement is in flight may have fetched
   * post-write bytes that the pre-replacement generation does not describe.
   *
   * @type {Set<string>}
   */
  const replacementsInFlight = new Set();

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
    // The tag is deliberately constant. An exo tag becomes the remotable's
    // interface name, which marshal transmits verbatim across CapTP and
    // exo-tools splices into guard-violation messages, so a tag bearing the
    // grant identifier would publish a live read capability to every recipient
    // of the blob and into every guard-violation message that mentions it.
    const blob = makeExo('SecretBlob', SecretBlobInterface, {
      help: () => secretBlobHelp,
      getDescription: async () => requireRecord(secretId).description,
      readBase64: async () => {
        const before = requireRecord(secretId);
        const operationId = await randomHex256();
        // Recorded before the state is checked, so exercising a revoked
        // capability leaves a trace. A holder repeatedly retrying a revoked
        // secret is precisely what an audit trail exists to show.
        await audit(
          secretId,
          'read',
          'attempted',
          before.generation,
          operationId,
        );
        let bytes;
        // Carries the specific fixed code out of the try so the audit event
        // and the caller both learn why the read failed. Every value is a
        // fixed code that never reflects secret material.
        let reasonCode = 'READ_FAILED';
        try {
          // This state check is intentionally adjacent to the backend call.
          if (requireRecord(secretId).state !== 'active') {
            reasonCode = 'REVOKED';
            throw fixedError('REVOKED');
          }
          bytes = await backend.read(before.backendRef);
          const after = requireRecord(secretId);
          if (
            after.state !== 'active' ||
            after.generation !== before.generation ||
            // A replacement whose bytes have physically landed but whose
            // generation is not yet committed would otherwise return the new
            // bytes under the old generation, so the audit trail would name a
            // version that was never the one read.
            replacementsInFlight.has(secretId)
          ) {
            bytes.fill(0);
            reasonCode = 'STALE_READ';
            throw fixedError('STALE_READ');
          }
          await audit(
            secretId,
            'read',
            'succeeded',
            after.generation,
            operationId,
          );
          const bytesBase64 = encodeBase64(bytes);
          bytes.fill(0);
          return bytesBase64;
        } catch {
          if (bytes !== undefined) bytes.fill(0);
          await audit(
            secretId,
            'read',
            'failed',
            before.generation,
            operationId,
            { reasonCode },
          );
          throw fixedError(reasonCode);
        }
      },
    });
    blobs.set(grantId, blob);
    return blob;
  };

  /**
   * @param {string} secretId
   * @param {() => Promise<Array<{ grantId: string, path: string[] }>>} listKnownGrantPaths
   * @param {(entries: Array<{ grantId: string, path: string[] }>) => Promise<void>} removeKnownGrantPaths
   */
  const makeAdmin = (secretId, listKnownGrantPaths, removeKnownGrantPaths) => {
    requireRecord(secretId);
    return makeExo(`SecretAdmin ${secretId}`, SecretAdminInterface, {
      getSummary: async () => summaryFor(requireRecord(secretId)),
      replaceBase64: bytesBase64 =>
        serializeMutation(secretId, async () => {
          // State is checked before the caller's bytes are parsed, so a
          // rejected replacement never leaves a decoded plaintext buffer
          // outside the zeroing scope below.
          const before = requireRecord(secretId);
          if (before.state !== 'active') throw fixedError('REVOKED');
          return withDecodedSecret(bytesBase64, async bytes => {
            const operationId = await randomHex256();
            await audit(
              secretId,
              'replace',
              'attempted',
              before.generation,
              operationId,
            );
            replacementsInFlight.add(secretId);
            try {
              await backend.replace(operationId, before.backendRef, bytes);
              const updated = harden({
                ...before,
                generation: before.generation + 1n,
                updatedAt: now(),
              });
              persistence.writeSecretRecord(updated);
              // Synchronously adjacent to the commit: no reader turn can
              // interleave, so no read observes post-write bytes under the
              // pre-replacement generation, and a read starting after the
              // commit is not spuriously failed by a stale marker.
              replacementsInFlight.delete(secretId);
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
              // Idempotent with the clear above; this one covers the failure
              // exits, where no generation is ever committed.
              replacementsInFlight.delete(secretId);
            }
          });
        }),
      setDescription: description =>
        serializeMutation(secretId, async () => {
          assertDescription(description);
          const before = requireRecord(secretId);
          if (before.state === 'revoked') throw fixedError('REVOKED');
          const operationId = await randomHex256();
          await audit(
            secretId,
            'set-description',
            'attempted',
            before.generation,
            operationId,
          );
          try {
            persistence.writeSecretRecord(
              harden({ ...before, description, updatedAt: now() }),
            );
            await audit(
              secretId,
              'set-description',
              'succeeded',
              before.generation,
              operationId,
            );
          } catch {
            await audit(
              secretId,
              'set-description',
              'failed',
              before.generation,
              operationId,
              { reasonCode: 'SET_DESCRIPTION_FAILED' },
            );
            throw fixedError('SET_DESCRIPTION_FAILED');
          }
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
      delete: () =>
        serializeMutation(secretId, async () => {
          const before = requireRecord(secretId);
          if (before.state !== 'revoked') {
            throw fixedError('NOT_REVOKED');
          }
          const operationId = await randomHex256();
          await audit(
            secretId,
            'delete',
            'attempted',
            before.generation,
            operationId,
          );
          try {
            // Revocation backends are required to be idempotent. Retrying here
            // prevents deletion from discarding the only cleanup reference
            // after an earlier backend-revocation failure.
            await backend.revoke(operationId, before.backendRef);
            const paths = (await listKnownGrantPaths()).filter(
              ({ grantId }) =>
                persistence.getSecretIdForGrant(grantId) === secretId,
            );
            await removeKnownGrantPaths(paths);
            persistence.deleteSecret(secretId);
            await audit(
              secretId,
              'delete',
              'succeeded',
              before.generation,
              operationId,
            );
          } catch {
            await audit(
              secretId,
              'delete',
              'failed',
              before.generation,
              operationId,
              { reasonCode: 'DELETE_FAILED' },
            );
            throw fixedError('DELETE_FAILED');
          }
        }),
    });
  };

  const auditReader = makeExo('SecretAuditReader', SecretAuditReaderInterface, {
    list: async (limit = 100n) => {
      if (limit < 0n || limit > 1000n) throw fixedError('INVALID_LIMIT');
      return harden(persistence.listSecretAuditEvents(Number(limit)));
    },
  });

  /**
   * @param {object} hostPowers
   * @param {(grantId: string, name: string) => Promise<void>} hostPowers.bindGrant
   * @param {() => Promise<Array<{ grantId: string, path: string[] }>>} hostPowers.listKnownGrantPaths
   * @param {(entries: Array<{ grantId: string, path: string[] }>) => Promise<void>} hostPowers.removeKnownGrantPaths
   */
  const makeHostDirectory = ({
    bindGrant,
    listKnownGrantPaths,
    removeKnownGrantPaths,
  }) => {
    /** @type {Map<string, SecretAdmin>} */
    const admins = new Map();

    /** @param {string} secretId */
    const provideAdmin = secretId => {
      const existing = admins.get(secretId);
      if (existing !== undefined) return existing;
      const admin = makeAdmin(
        secretId,
        listKnownGrantPaths,
        removeKnownGrantPaths,
      );
      admins.set(secretId, admin);
      return admin;
    };

    const catalog = makeExo('SecretCatalog', SecretCatalogInterface, {
      list: async () => {
        const knownPaths = await listKnownGrantPaths();
        /** @type {Map<string, string[][]>} */
        const pathsBySecretId = new Map();
        for (const { grantId, path } of knownPaths) {
          const secretId = persistence.getSecretIdForGrant(grantId);
          if (secretId !== undefined) {
            const paths = pathsBySecretId.get(secretId);
            if (paths === undefined) {
              pathsBySecretId.set(secretId, [path]);
            } else {
              paths.push(path);
            }
          }
        }
        return harden(
          persistence.listSecretRecords().map(record => ({
            secretId: record.secretId,
            summary: summaryFor(record),
            petNamePaths: (pathsBySecretId.get(record.secretId) || []).sort(
              (left, right) => left.join('/').localeCompare(right.join('/')),
            ),
            admin: provideAdmin(record.secretId),
          })),
        );
      },
    });
    const importer = makeExo('SecretImporter', SecretImporterInterface, {
      createBase64: async (name, description, bytesBase64) => {
        assertPetName(name);
        assertDescription(description);
        return withDecodedSecret(bytesBase64, async bytes => {
          const secretId = await randomHex256();
          const grantId = await randomHex256();
          const operationId = await randomHex256();
          const createdAt = now();
          await audit(secretId, 'create', 'attempted', 1n, operationId);
          try {
            const backendRef = await backend.create(
              operationId,
              secretId,
              bytes,
            );
            const record = harden(
              /** @type {SecretRecord} */ ({
                secretId,
                backendRef,
                description,
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
          }
        });
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
      // There is deliberately no `admin/<secretId>` path. A secretId is
      // published on the catalog, importer, and audit surfaces and in the
      // backend's on-disk file name, so treating it as a selector would make
      // every one of those surfaces a source of replace/revoke/delete
      // authority. Administration facets are vended only by `catalog`, which
      // already carries that authority.
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
  maxDescriptionLength: MAX_DESCRIPTION_LENGTH,
});
harden(secretManagerLimits);
