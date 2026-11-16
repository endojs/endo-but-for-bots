// @ts-check

/** @import { ERef } from '@endo/eventual-send' */
/** @import { AfterCommit, AuditEntry, CreateOperation, GrantRecord, InferenceEndpointHandle, IssuerHandle, MakeIssuer, ProviderDescriptor, ProviderLifecycle, ProviderLimits, RegistryJournal, RegistryState, RetireOperation, SafeCreateRequest, SecretsPort, StableIds, UntrustedRequest } from './types.js' */

import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { canonicalJson } from './canonical-json.js';

import { InferenceEndpointInterface } from './subscription-share.js';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const GENERATED_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const DISPLAY_NAME_PATTERN = /^[\x20-\x7e]{1,80}$/;
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** @param {string} code */
const fixedError = code =>
  makeError(X`Inference provider operation failed: ${q(code)}`);

/**
 * `RegExp.test` stringifies its argument, so `undefined`, `null` and `['a']`
 * would otherwise pass as "undefined", "null" and "a".
 *
 * @param {RegExp} pattern
 * @param {unknown} value
 * @returns {value is string}
 */
const matches = (pattern, value) =>
  typeof value === 'string' && pattern.test(value);

const ProviderDirectoryInterface = M.interface('InferenceProviderDirectory', {
  list: M.callWhen().returns(M.arrayOf(M.record())),
  lookup: M.callWhen(M.string()).returns(M.record()),
  create: M.callWhen(M.record()).returns(M.record()),
  adminFor: M.callWhen(M.string()).returns(M.remotable()),
});

const ProviderAdminInterface = M.interface('InferenceProviderAdmin', {
  getSummary: M.callWhen().returns(M.record()),
  setLimits: M.callWhen(M.record(), M.string()).returns(M.record()),
  supersede: M.callWhen(M.record()).returns(M.record()),
  retire: M.callWhen(M.string()).returns(M.record()),
});

const ProviderUseInterface = M.interface('InferenceProviderUse', {
  grant: M.callWhen(M.record()).returns(M.remotable()),
});

// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(ProviderDirectoryInterface);
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(ProviderAdminInterface);
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(ProviderUseInterface);

/**
 * Look up a caller-keyed record without reaching `Object.prototype`, so an id
 * such as `constructor` reads as absent.
 *
 * @template T
 * @param {Record<string, T>} record
 * @param {string} key
 * @returns {T | undefined}
 */
const ownEntry = (record, key) =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/**
 * Define rather than assign, so a key such as `__proto__` or `constructor`
 * becomes an own entry instead of reaching `Object.prototype`.
 *
 * @template T
 * @param {Record<string, T>} record
 * @param {string} key
 * @param {T} value
 */
const setEntry = (record, key, value) => {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
};

/** @returns {RegistryState} */
const emptyState = () =>
  harden({
    version: 1,
    descriptors: {},
    lifecycles: {},
    operations: {},
    grants: {},
    audit: [],
  });

/**
 * Refuse data that has no canonical encoding (`NaN`, `undefined`, exotic
 * objects) at intake, so stored requests always compare exactly later.
 *
 * @param {unknown} value
 * @param {string} code
 */
const assertCanonical = (value, code) => {
  try {
    canonicalJson(value);
  } catch {
    throw fixedError(code);
  }
};

/**
 * Compare canonical data: record key order does not matter, and `-0` stays
 * distinct from `0`, where `JSON.stringify` would differ or collapse.
 *
 * @param {unknown} left
 * @param {unknown} right
 */
const sameData = (left, right) => canonicalJson(left) === canonicalJson(right);

/**
 * @param {RegistryState} state
 * @returns {RegistryState}
 */
const copyState = state => ({
  ...state,
  descriptors: { ...state.descriptors },
  lifecycles: { ...state.lifecycles },
  operations: { ...state.operations },
  grants: { ...state.grants },
  audit: [...state.audit],
});

/**
 * @param {ProviderDescriptor} descriptor
 * @param {ProviderLifecycle} lifecycle
 */
const summarize = (descriptor, lifecycle) =>
  harden({
    providerId: descriptor.providerId,
    displayName: descriptor.displayName,
    kind: descriptor.kind,
    ...(descriptor.baseUrl === undefined
      ? {}
      : { baseUrl: descriptor.baseUrl }),
    defaultModel: descriptor.defaultModel,
    createdAt: descriptor.createdAt,
    ...(descriptor.supersedes === undefined
      ? {}
      : { supersedes: descriptor.supersedes }),
    state: lifecycle.state,
    limits: lifecycle.limits,
    updatedAt: lifecycle.updatedAt,
  });

/**
 * The durable, non-secret provider registry. The caller supplies one Endo
 * snapshot journal, the root-private secret participant, and construction of
 * the existing provider grant issuer. Recreating this object over the same
 * journal is the restart path.
 *
 * @param {object} options
 * @param {RegistryJournal} options.journal
 * @param {SecretsPort} options.secrets
 * @param {MakeIssuer} options.makeIssuer
 * @param {(limits: unknown) => ProviderLimits} options.validateLimits
 * @param {() => string} options.randomId
 * @param {() => string} [options.now]
 * @param {number} [options.intentExpiryMs]
 * @param {AfterCommit} [options.afterCommit]
 */
export const makeInferenceProviderRegistry = async ({
  journal,
  secrets,
  makeIssuer,
  validateLimits,
  randomId,
  now = () => new Date().toISOString(),
  intentExpiryMs = 24 * 60 * 60 * 1000,
  afterCommit = () => {},
}) => {
  await null;
  const restored = await journal.read();
  /** @type {RegistryState} */
  let state = restored || emptyState();
  state.version === 1 ||
    (() => {
      throw fixedError('unsupported-version');
    })();

  /** @type {Promise<void>} */
  let mutationTail = Promise.resolve();
  /** @type {Map<string, object>} */
  const directories = new Map();
  /** @type {Map<string, object>} */
  const admins = new Map();
  /** @type {Map<string, object>} */
  const uses = new Map();
  /** @type {Map<string, object>} */
  const inferences = new Map();
  /** @type {Map<string, Promise<IssuerHandle>>} */
  const issuers = new Map();
  /** @type {Map<string, Promise<InferenceEndpointHandle>>} */
  const endpoints = new Map();

  /**
   * @template T
   * @param {() => Promise<T>} operation
   */
  const inOrder = operation => {
    const result = mutationTail.then(operation);
    mutationTail = result.then(
      () => {},
      () => {},
    );
    return result;
  };

  /** @param {RegistryState} next */
  const commit = async next => {
    const hardened = harden(next);
    await journal.write(hardened);
    state = hardened;
  };

  /** @param {unknown} ownerId */
  const assertOwnerId = ownerId => {
    matches(IDENTIFIER_PATTERN, ownerId) ||
      (() => {
        throw fixedError('invalid-owner');
      })();
  };

  /** @param {string} providerId */
  const requireProvider = providerId => {
    const descriptor = ownEntry(state.descriptors, providerId);
    const lifecycle = ownEntry(state.lifecycles, providerId);
    if (descriptor === undefined || lifecycle === undefined) {
      throw fixedError('provider-not-found');
    }
    return { descriptor, lifecycle };
  };

  /**
   * @param {string} ownerId
   * @param {string} providerId
   */
  const requireOwnedProvider = (ownerId, providerId) => {
    const found = requireProvider(providerId);
    if (found.descriptor.ownerId !== ownerId) {
      throw fixedError('provider-not-found');
    }
    return found;
  };

  /**
   * @param {string} ownerId
   * @param {UntrustedRequest} request
   * @param {string | undefined} supersedes
   * @returns {Promise<SafeCreateRequest>}
   */
  const safeCreateRequest = async (ownerId, request, supersedes) => {
    await null;
    const { idempotencyKey, displayName, kind, baseUrl, defaultModel, limits } =
      request || {};
    matches(IDENTIFIER_PATTERN, idempotencyKey) ||
      (() => {
        throw fixedError('invalid-idempotency-key');
      })();
    matches(DISPLAY_NAME_PATTERN, displayName) ||
      (() => {
        throw fixedError('invalid-display-name');
      })();
    kind === 'anthropic' ||
      (() => {
        throw fixedError('invalid-kind');
      })();
    baseUrl === undefined ||
      (() => {
        throw fixedError('invalid-base-url');
      })();
    matches(MODEL_PATTERN, defaultModel) ||
      (() => {
        throw fixedError('invalid-model');
      })();
    const checkedLimits = validateLimits(limits);
    assertCanonical(checkedLimits, 'invalid-limits');
    return harden({
      displayName,
      kind,
      defaultModel,
      limits: checkedLimits,
      ...(supersedes === undefined ? {} : { supersedes }),
    });
  };

  /**
   * @param {string} ownerId
   * @param {UntrustedRequest} request
   * @param {string | undefined} supersedes
   */
  const createProvider = (ownerId, request, supersedes) =>
    inOrder(async () => {
      assertOwnerId(ownerId);
      const safeRequest = await safeCreateRequest(ownerId, request, supersedes);
      const { idempotencyKey, keyBase64 } =
        /** @type {Record<string, unknown>} */ (request);
      const operationKey = `create:${ownerId}:${idempotencyKey}`;
      let operation = /** @type {CreateOperation | undefined} */ (
        ownEntry(state.operations, operationKey)
      );
      if (operation !== undefined) {
        if (!sameData(operation.request, safeRequest)) {
          throw fixedError('idempotency-conflict');
        }
        if (operation.state === 'committed') {
          const found = requireOwnedProvider(ownerId, operation.providerId);
          return summarize(found.descriptor, found.lifecycle);
        }
        if (operation.state === 'aborted')
          throw fixedError('operation-aborted');
      } else {
        const operationId = randomId();
        matches(GENERATED_ID_PATTERN, operationId) ||
          (() => {
            throw fixedError('invalid-generated-id');
          })();
        const providerId = randomId();
        matches(GENERATED_ID_PATTERN, providerId) ||
          (() => {
            throw fixedError('invalid-generated-id');
          })();
        const secretIds = harden({
          secretId: randomId(),
          grantId: randomId(),
          operationId: randomId(),
        });
        Object.values(secretIds).every(value =>
          matches(GENERATED_ID_PATTERN, value),
        ) ||
          (() => {
            throw fixedError('invalid-generated-id');
          })();
        if (ownEntry(state.descriptors, providerId) !== undefined) {
          throw fixedError('invalid-generated-id');
        }
        const createdAt = now();
        operation = harden({
          version: /** @type {const} */ (1),
          operationId,
          ownerId,
          idempotencyKey: /** @type {string} */ (idempotencyKey),
          kind: /** @type {const} */ ('create'),
          providerId,
          secretName: `inference-provider-${operationId}`,
          secretIds,
          request: safeRequest,
          state: /** @type {const} */ ('intent'),
          createdAt,
          updatedAt: createdAt,
        });
        const next = copyState(state);
        setEntry(next.operations, operationKey, operation);
        await commit(next);
        await afterCommit('create-intent', harden({ operationId, providerId }));
      }

      if (operation.state === 'intent') {
        const exists = await secrets.has(operation.secretName);
        if (!exists && typeof keyBase64 !== 'string') {
          throw fixedError('key-needed');
        }
        await secrets.provide(
          operation.secretName,
          `Inference provider ${operation.providerId}`,
          exists ? undefined : /** @type {string} */ (keyBase64),
          operation.secretIds,
        );
        await afterCommit(
          'create-secret',
          harden({ operationId: operation.operationId }),
        );
        const next = copyState(state);
        operation = harden({
          ...operation,
          state: /** @type {const} */ ('secret-created'),
          updatedAt: now(),
        });
        setEntry(next.operations, operationKey, operation);
        await commit(next);
        await afterCommit(
          'create-secret-recorded',
          harden({ operationId: operation.operationId }),
        );
      }

      if (operation.state === 'secret-created') {
        const createdAt = operation.createdAt;
        const descriptor = harden({
          version: /** @type {const} */ (1),
          providerId: operation.providerId,
          ownerId,
          displayName: operation.request.displayName,
          kind: operation.request.kind,
          ...(operation.request.baseUrl === undefined
            ? {}
            : { baseUrl: operation.request.baseUrl }),
          defaultModel: operation.request.defaultModel,
          secretGrantFormulaId: operation.secretName,
          createdAt,
          ...(operation.request.supersedes === undefined
            ? {}
            : { supersedes: operation.request.supersedes }),
        });
        const lifecycle = harden({
          version: /** @type {const} */ (1),
          providerId: operation.providerId,
          state: /** @type {const} */ ('active'),
          limits: operation.request.limits,
          updatedAt: now(),
        });
        const next = copyState(state);
        setEntry(next.descriptors, operation.providerId, descriptor);
        setEntry(next.lifecycles, operation.providerId, lifecycle);
        operation = harden({
          ...operation,
          state: /** @type {const} */ ('committed'),
          updatedAt: now(),
        });
        setEntry(next.operations, operationKey, operation);
        next.audit.push(
          harden({
            providerId: operation.providerId,
            operationId: operation.operationId,
            change: /** @type {const} */ ('created'),
            oldValue: null,
            newValue: lifecycle,
            occurredAt: now(),
          }),
        );
        await commit(next);
        await afterCommit(
          'create-committed',
          harden({ operationId: operation.operationId }),
        );
      }

      await afterCommit(
        'create-response',
        harden({ operationId: operation.operationId }),
      );
      const found = requireOwnedProvider(ownerId, operation.providerId);
      return summarize(found.descriptor, found.lifecycle);
    });

  /** @param {string} providerId */
  const disposeProvider = async providerId => {
    await null;
    const issuer = issuers.get(providerId);
    issuers.delete(providerId);
    for (const [grantId, endpoint] of endpoints.entries()) {
      if (ownEntry(state.grants, grantId)?.providerId === providerId) {
        endpoints.delete(grantId);
        void endpoint.then(value => E(value).revoke()).catch(() => {});
      }
    }
    if (issuer !== undefined) {
      await issuer.then(value => value.dispose());
    }
  };

  /**
   * @param {string} ownerId
   * @param {string} providerId
   * @param {string} idempotencyKey
   */
  const retireProvider = (ownerId, providerId, idempotencyKey) =>
    inOrder(async () => {
      await null;
      matches(IDENTIFIER_PATTERN, idempotencyKey) ||
        (() => {
          throw fixedError('invalid-idempotency-key');
        })();
      const { descriptor, lifecycle } = requireOwnedProvider(
        ownerId,
        providerId,
      );
      // One retirement per provider: the idempotency key is recorded, not
      // part of the key, so a retry under any key drives the same record.
      const operationKey = `retire:${providerId}`;
      let operation = /** @type {RetireOperation | undefined} */ (
        ownEntry(state.operations, operationKey)
      );
      if (operation?.state === 'committed') {
        return summarize(descriptor, requireProvider(providerId).lifecycle);
      }
      if (operation === undefined) {
        const operationId = randomId();
        const changedAt = now();
        operation = harden({
          version: /** @type {const} */ (1),
          operationId,
          ownerId,
          idempotencyKey,
          kind: /** @type {const} */ ('retire'),
          providerId,
          secretName: descriptor.secretGrantFormulaId,
          request: {},
          state: /** @type {const} */ ('intent'),
          createdAt: changedAt,
          updatedAt: changedAt,
        });
        const retiring = harden({
          ...lifecycle,
          state: /** @type {const} */ ('retiring'),
          updatedAt: changedAt,
        });
        const next = copyState(state);
        setEntry(next.operations, operationKey, operation);
        setEntry(next.lifecycles, providerId, retiring);
        next.audit.push(
          harden({
            providerId,
            operationId,
            change: /** @type {const} */ ('retiring'),
            oldValue: lifecycle,
            newValue: retiring,
            occurredAt: changedAt,
          }),
        );
        await commit(next);
        await afterCommit('retire-intent', harden({ operationId }));
      }
      await disposeProvider(providerId);
      if (operation.state === 'intent') {
        await secrets.revoke(operation.secretName);
        await afterCommit(
          'retire-secret',
          harden({ operationId: operation.operationId }),
        );
        const next = copyState(state);
        operation = harden({
          ...operation,
          state: /** @type {const} */ ('secret-revoked'),
          updatedAt: now(),
        });
        setEntry(next.operations, operationKey, operation);
        await commit(next);
        await afterCommit(
          'retire-secret-recorded',
          harden({ operationId: operation.operationId }),
        );
      }
      if (operation.state === 'secret-revoked') {
        const before = requireProvider(providerId).lifecycle;
        const retired = harden({
          ...before,
          state: /** @type {const} */ ('retired'),
          updatedAt: now(),
        });
        const next = copyState(state);
        setEntry(next.lifecycles, providerId, retired);
        operation = harden({
          ...operation,
          state: /** @type {const} */ ('committed'),
          updatedAt: now(),
        });
        setEntry(next.operations, operationKey, operation);
        next.audit.push(
          harden({
            providerId,
            operationId: operation.operationId,
            change: /** @type {const} */ ('retired'),
            oldValue: before,
            newValue: retired,
            occurredAt: now(),
          }),
        );
        await commit(next);
        await afterCommit(
          'retire-committed',
          harden({ operationId: operation.operationId }),
        );
      }
      return summarize(descriptor, requireProvider(providerId).lifecycle);
    });

  /** @param {string} providerId */
  const provideIssuer = providerId => {
    let issuer = issuers.get(providerId);
    if (issuer === undefined) {
      issuer = (async () => {
        const { descriptor, lifecycle } = requireProvider(providerId);
        lifecycle.state === 'active' ||
          (() => {
            throw fixedError('provider-retired');
          })();
        // The non-stable `provide` path returns the blob even for a revoked
        // secret, so the `active` check above must stay ahead of it.
        const secret = await secrets.provide(
          descriptor.secretGrantFormulaId,
          `Inference provider ${providerId}`,
          undefined,
          undefined,
        );
        return makeIssuer({ descriptor, lifecycle, secret });
      })();
      issuers.set(providerId, issuer);
      issuer.catch(() => issuers.delete(providerId));
    }
    return issuer;
  };

  /** @param {string} grantId */
  const requireActiveGrant = grantId => {
    const grant = ownEntry(state.grants, grantId);
    if (grant === undefined || grant.state !== 'active') {
      throw fixedError('agent-deleted');
    }
    const { lifecycle } = requireProvider(grant.providerId);
    lifecycle.state === 'active' ||
      (() => {
        throw fixedError('provider-retired');
      })();
    return grant;
  };

  /** @param {string} grantId */
  const provideEndpoint = grantId => {
    requireActiveGrant(grantId);
    let endpoint = endpoints.get(grantId);
    if (endpoint === undefined) {
      endpoint = (async () => {
        const grant = requireActiveGrant(grantId);
        const issuer = await provideIssuer(grant.providerId);
        const opened = await issuer.openEndpoint({ sessionId: grantId });
        try {
          requireActiveGrant(grantId);
        } catch (error) {
          // A revoke or retire landed while the endpoint was opening, after
          // the cleanup that would otherwise have found it.
          await E(opened).revoke();
          throw error;
        }
        return opened;
      })();
      endpoints.set(grantId, endpoint);
      endpoint.catch(() => endpoints.delete(grantId));
    }
    return endpoint;
  };

  /** @param {unknown} grantId */
  const assertGrantId = grantId => {
    matches(IDENTIFIER_PATTERN, grantId) ||
      (() => {
        throw fixedError('invalid-grant');
      })();
  };

  /** @param {string} grantId */
  const provideInference = grantId => {
    assertGrantId(grantId);
    let inference = inferences.get(grantId);
    if (inference !== undefined) return inference;
    inference = makeExo('AgentInference', InferenceEndpointInterface, {
      request: async message => {
        await null;
        return E(await provideEndpoint(grantId)).request(message);
      },
      requestByteStream: async message => {
        await null;
        return E(await provideEndpoint(grantId)).requestByteStream(message);
      },
      attestation: async () => {
        const grant = requireActiveGrant(grantId);
        const underlying = await E(
          await provideEndpoint(grantId),
        ).attestation();
        return harden({
          ...underlying,
          grantId,
          providerId: grant.providerId,
          agentId: grant.agentId,
          generation: grant.generation,
        });
      },
      revoke: async () => {
        await revokeGrant(grantId);
      },
    });
    inferences.set(grantId, inference);
    return inference;
  };

  /** @param {string} grantId */
  const revokeGrant = grantId =>
    inOrder(async () => {
      assertGrantId(grantId);
      const grant = ownEntry(state.grants, grantId);
      if (grant === undefined || grant.state === 'revoked') return;
      const next = copyState(state);
      setEntry(
        next.grants,
        grantId,
        harden({
          ...grant,
          state: 'revoked',
          generation: grant.generation + 1,
          updatedAt: now(),
        }),
      );
      await commit(next);
      const endpoint = endpoints.get(grantId);
      endpoints.delete(grantId);
      // The grant is already revoked; an endpoint that failed to open or to
      // tear down must not report that revoke as failed.
      if (endpoint !== undefined) {
        await endpoint.then(value => E(value).revoke()).catch(() => {});
      }
    });

  /**
   * @param {string} ownerId
   * @param {string} providerId
   */
  const provideUse = (ownerId, providerId) => {
    requireOwnedProvider(ownerId, providerId);
    const cacheKey = `${ownerId}:${providerId}`;
    let use = uses.get(cacheKey);
    if (use !== undefined) return use;
    use = makeExo('InferenceProviderUse', ProviderUseInterface, {
      grant: request =>
        inOrder(async () => {
          const { descriptor, lifecycle } = requireProvider(providerId);
          if (descriptor.ownerId !== request?.ownerId) {
            throw fixedError('provider-owner-mismatch');
          }
          lifecycle.state === 'active' ||
            (() => {
              throw fixedError('provider-retired');
            })();
          matches(IDENTIFIER_PATTERN, request.agentId) ||
            (() => {
              throw fixedError('invalid-agent');
            })();
          matches(MODEL_PATTERN, request.model) ||
            (() => {
              throw fixedError('invalid-model');
            })();
          request.model === descriptor.defaultModel ||
            (() => {
              throw fixedError('invalid-model');
            })();
          const grantId =
            request.grantId === undefined ? randomId() : request.grantId;
          matches(IDENTIFIER_PATTERN, grantId) ||
            (() => {
              throw fixedError('invalid-generated-id');
            })();
          const caps = request.caps === undefined ? {} : request.caps;
          assertCanonical(caps, 'invalid-caps');
          const existing = ownEntry(state.grants, grantId);
          const desired = harden({
            version: /** @type {const} */ (1),
            grantId,
            ownerId: request.ownerId,
            providerId,
            agentId: request.agentId,
            models: [request.model],
            caps: /** @type {Record<string, unknown>} */ (caps),
          });
          if (existing !== undefined) {
            sameData(
              desired,
              harden({
                version: existing.version,
                grantId: existing.grantId,
                ownerId: existing.ownerId,
                providerId: existing.providerId,
                agentId: existing.agentId,
                models: existing.models,
                caps: existing.caps,
              }),
            ) ||
              (() => {
                throw fixedError('grant-conflict');
              })();
            existing.state === 'active' ||
              (() => {
                throw fixedError('agent-deleted');
              })();
            return provideInference(grantId);
          }
          const changedAt = now();
          const next = copyState(state);
          setEntry(
            next.grants,
            grantId,
            harden({
              ...desired,
              state: /** @type {const} */ ('active'),
              generation: 1,
              createdAt: changedAt,
              updatedAt: changedAt,
            }),
          );
          await commit(next);
          return provideInference(grantId);
        }),
    });
    uses.set(cacheKey, use);
    return use;
  };

  /**
   * @param {string} ownerId
   * @param {string} providerId
   */
  const provideAdmin = (ownerId, providerId) => {
    requireOwnedProvider(ownerId, providerId);
    const cacheKey = `${ownerId}:${providerId}`;
    let admin = admins.get(cacheKey);
    if (admin !== undefined) return admin;
    admin = makeExo('InferenceProviderAdmin', ProviderAdminInterface, {
      getSummary: async () => {
        const found = requireOwnedProvider(ownerId, providerId);
        return summarize(found.descriptor, found.lifecycle);
      },
      setLimits: (limits, operationId) =>
        inOrder(async () => {
          matches(IDENTIFIER_PATTERN, operationId) ||
            (() => {
              throw fixedError('invalid-operation-id');
            })();
          const found = requireOwnedProvider(ownerId, providerId);
          const checkedLimits = validateLimits(limits);
          const prior = state.audit.find(
            event =>
              event.change === 'limits' &&
              event.providerId === providerId &&
              event.operationId === operationId,
          );
          if (prior !== undefined) {
            sameData(prior.newValue.limits, checkedLimits) ||
              (() => {
                throw fixedError('idempotency-conflict');
              })();
            return summarize(found.descriptor, found.lifecycle);
          }
          found.lifecycle.state === 'active' ||
            (() => {
              throw fixedError('provider-retired');
            })();
          const changed = harden({
            ...found.lifecycle,
            limits: checkedLimits,
            updatedAt: now(),
          });
          const next = copyState(state);
          setEntry(next.lifecycles, providerId, changed);
          next.audit.push(
            harden({
              providerId,
              operationId,
              change: /** @type {const} */ ('limits'),
              oldValue: found.lifecycle,
              newValue: changed,
              occurredAt: now(),
            }),
          );
          await commit(next);
          return summarize(found.descriptor, changed);
        }),
      supersede: request => {
        const found = requireOwnedProvider(ownerId, providerId);
        found.lifecycle.state === 'active' ||
          (() => {
            throw fixedError('provider-retired');
          })();
        return createProvider(ownerId, request, providerId);
      },
      retire: idempotencyKey =>
        retireProvider(ownerId, providerId, idempotencyKey),
    });
    admins.set(cacheKey, admin);
    return admin;
  };

  /** @param {string} ownerId */
  const directoryFor = ownerId => {
    assertOwnerId(ownerId);
    let directory = directories.get(ownerId);
    if (directory !== undefined) return directory;
    directory = makeExo(
      'InferenceProviderDirectory',
      ProviderDirectoryInterface,
      {
        list: async () =>
          harden(
            Object.values(state.descriptors)
              .filter(descriptor => descriptor.ownerId === ownerId)
              .map(descriptor =>
                summarize(
                  descriptor,
                  requireProvider(descriptor.providerId).lifecycle,
                ),
              )
              .sort((left, right) =>
                left.providerId.localeCompare(right.providerId),
              ),
          ),
        lookup: async providerId => {
          const found = requireOwnedProvider(ownerId, providerId);
          return summarize(found.descriptor, found.lifecycle);
        },
        create: request => createProvider(ownerId, request, undefined),
        adminFor: async providerId => provideAdmin(ownerId, providerId),
      },
    );
    directories.set(ownerId, directory);
    return directory;
  };

  const reconcile = () =>
    inOrder(async () => {
      for (const [operationKey, initial] of Object.entries(state.operations)) {
        let operation = initial;
        if (operation.state === 'committed' || operation.state === 'aborted') {
          // eslint-disable-next-line no-continue
          continue;
        }
        if (operation.kind === 'create') {
          if (operation.state === 'intent') {
            let exists;
            // eslint-disable-next-line no-await-in-loop
            exists = await secrets.has(operation.secretName);
            if (!exists && secrets.recover !== undefined) {
              // eslint-disable-next-line no-await-in-loop
              exists = await secrets.recover(
                operation.secretName,
                `Inference provider ${operation.providerId}`,
                operation.secretIds,
              );
            }
            if (exists) {
              const next = copyState(state);
              operation = harden({
                ...operation,
                state: /** @type {const} */ ('secret-created'),
                updatedAt: now(),
              });
              setEntry(next.operations, operationKey, operation);
              // eslint-disable-next-line no-await-in-loop
              await commit(next);
            } else if (
              Date.parse(now()) - Date.parse(operation.createdAt) >=
              intentExpiryMs
            ) {
              const next = copyState(state);
              setEntry(
                next.operations,
                operationKey,
                harden({
                  ...operation,
                  state: /** @type {const} */ ('aborted'),
                  updatedAt: now(),
                }),
              );
              if (secrets.revokeStable !== undefined) {
                // eslint-disable-next-line no-await-in-loop
                await secrets.revokeStable(operation.secretIds);
              }
              // eslint-disable-next-line no-await-in-loop
              await commit(next);
              // eslint-disable-next-line no-continue
              continue;
            } else {
              // A live intent needs the caller to resupply the cleared key.
              // eslint-disable-next-line no-continue
              continue;
            }
          }
          if (operation.state === 'secret-created') {
            const createdAt = operation.createdAt;
            const descriptor = harden({
              version: /** @type {const} */ (1),
              providerId: operation.providerId,
              ownerId: operation.ownerId,
              displayName: operation.request.displayName,
              kind: operation.request.kind,
              ...(operation.request.baseUrl === undefined
                ? {}
                : { baseUrl: operation.request.baseUrl }),
              defaultModel: operation.request.defaultModel,
              secretGrantFormulaId: operation.secretName,
              createdAt,
              ...(operation.request.supersedes === undefined
                ? {}
                : { supersedes: operation.request.supersedes }),
            });
            const lifecycle = harden({
              version: /** @type {const} */ (1),
              providerId: operation.providerId,
              state: /** @type {const} */ ('active'),
              limits: operation.request.limits,
              updatedAt: now(),
            });
            const next = copyState(state);
            setEntry(next.descriptors, operation.providerId, descriptor);
            setEntry(next.lifecycles, operation.providerId, lifecycle);
            setEntry(
              next.operations,
              operationKey,
              harden({
                ...operation,
                state: /** @type {const} */ ('committed'),
                updatedAt: now(),
              }),
            );
            next.audit.push(
              harden({
                providerId: operation.providerId,
                operationId: operation.operationId,
                change: /** @type {const} */ ('created'),
                oldValue: null,
                newValue: lifecycle,
                occurredAt: now(),
              }),
            );
            // eslint-disable-next-line no-await-in-loop
            await commit(next);
          }
        } else if (operation.kind === 'retire') {
          // A retiring lifecycle is already the fail-closed fence. Drive the
          // secret and tombstone forward after every restart.
          // eslint-disable-next-line no-await-in-loop
          await disposeProvider(operation.providerId);
          if (operation.state === 'intent') {
            // eslint-disable-next-line no-await-in-loop
            await secrets.revoke(operation.secretName);
            const next = copyState(state);
            operation = harden({
              ...operation,
              state: /** @type {const} */ ('secret-revoked'),
              updatedAt: now(),
            });
            setEntry(next.operations, operationKey, operation);
            // eslint-disable-next-line no-await-in-loop
            await commit(next);
          }
          if (operation.state === 'secret-revoked') {
            const before = requireProvider(operation.providerId).lifecycle;
            const retired = harden({
              ...before,
              state: /** @type {const} */ ('retired'),
              updatedAt: now(),
            });
            const next = copyState(state);
            setEntry(next.lifecycles, operation.providerId, retired);
            setEntry(
              next.operations,
              operationKey,
              harden({
                ...operation,
                state: /** @type {const} */ ('committed'),
                updatedAt: now(),
              }),
            );
            next.audit.push(
              harden({
                providerId: operation.providerId,
                operationId: operation.operationId,
                change: /** @type {const} */ ('retired'),
                oldValue: before,
                newValue: retired,
                occurredAt: now(),
              }),
            );
            // eslint-disable-next-line no-await-in-loop
            await commit(next);
          }
        }
      }

      // Sweeping unreferenced names is sound only because every mutation runs
      // through `inOrder`: no create can be between naming and recording here.
      if (secrets.listNames !== undefined) {
        const referenced = new Set(
          Object.values(state.operations).map(
            operation => operation.secretName,
          ),
        );
        for (const name of await secrets.listNames()) {
          if (name.startsWith('inference-provider-') && !referenced.has(name)) {
            // eslint-disable-next-line no-await-in-loop
            await secrets.revoke(name);
          }
        }
      }
    });

  await reconcile();

  return harden({
    directoryFor,
    useFor: provideUse,
    inferenceFor: provideInference,
    revokeGrant,
    reconcile,
    inspect: () => state,
    close: async () => {
      await Promise.allSettled(
        [...issuers.values()].map(async issuer => (await issuer).dispose()),
      );
      issuers.clear();
      endpoints.clear();
    },
  });
};
harden(makeInferenceProviderRegistry);

/**
 * Adapt a root Endo host's `@secrets` directory to the registry participant.
 * The deterministic registry-assigned name is the recovery handle: after a
 * crash, `provide` returns the already-bound blob and never imports twice.
 *
 * @param {ERef<any>} powers Root Endo host powers.
 * @returns {SecretsPort}
 */
export const makeEndoSecretParticipant = powers => {
  /** @param {string} name */
  const lookupBlob = name => E(powers).lookup(['secrets', name]);
  /** @param {string} name */
  const has = async name => {
    await null;
    // An absent `secrets` directory is the only "absent" answer; every other
    // failure (a dead powers reference, a disconnect) propagates rather than
    // reading as "the user must re-enter the key".
    if (!(await E(powers).has('secrets'))) return false;
    return E(powers).has('secrets', name);
  };
  const catalog = () => E(powers).lookup(['@secrets', 'catalog']);
  /**
   * @param {string} name
   * @param {string} description
   * @param {string | undefined} bytesBase64
   * @param {StableIds} stableIds
   */
  const provideStable = async (name, description, bytesBase64, stableIds) => {
    const importer = await E(powers).lookup(['@secrets', 'create']);
    const summary = await E(importer).provideBase64(
      name,
      description,
      bytesBase64,
      stableIds,
    );
    return summary.state !== 'provisioning';
  };
  return harden({
    has,
    provide: async (name, description, bytesBase64, stableIds) => {
      if (stableIds !== undefined) {
        typeof bytesBase64 === 'string' ||
          (await has(name)) ||
          (() => {
            throw fixedError('key-needed');
          })();
        (await provideStable(name, description, bytesBase64, stableIds)) ||
          (() => {
            throw fixedError('key-needed');
          })();
      } else if (!(await has(name))) {
        throw fixedError('key-needed');
      }
      return lookupBlob(name);
    },
    recover: async (name, description, stableIds) =>
      provideStable(name, description, undefined, stableIds),
    revoke: async name => {
      const blob = await lookupBlob(name);
      const admin = await E(await catalog()).adminFor(blob);
      const summary = await E(admin).getSummary();
      if (summary.state !== 'revoked') await E(admin).revoke();
    },
    state: async name => {
      const blob = await lookupBlob(name);
      const admin = await E(await catalog()).adminFor(blob);
      return (await E(admin).getSummary()).state;
    },
    revokeStable: async ({ secretId }) => {
      const entries = await E(await catalog()).list();
      const entry = entries.find(candidate => candidate.secretId === secretId);
      if (entry === undefined) return;
      const summary = await E(entry.admin).getSummary();
      if (summary.state !== 'revoked') await E(entry.admin).revoke();
    },
    listNames: async () => {
      if (!(await E(powers).has('secrets'))) return [];
      return E(powers).list('secrets');
    },
  });
};
harden(makeEndoSecretParticipant);
