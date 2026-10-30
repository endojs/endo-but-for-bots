// @ts-check

import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { InferenceEndpointInterface } from './subscription-share.js';
import {
  compactInferenceTurnEvents,
  effectiveInferenceLimits,
  foldInferenceTurnEvents,
  inferenceAdmissionRefusal,
  inferenceUsageAt,
} from './inference-provider-admission.js';
import {
  conservativeTokenReservation,
  DEFAULT_AGENT_LIMITS,
  DEFAULT_OWNER_INFERENCE_LIMITS,
  DEFAULT_PROVIDER_LIMITS,
  priceUsageMicros,
  raisedInferenceLimits,
  validateAnthropicInferenceRequest,
  validateInferenceLimits,
} from './inference-provider-policy.js';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const GENERATED_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const DISPLAY_NAME_PATTERN = /^[\x20-\x7e]{1,80}$/;
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

const fixedError = code =>
  makeError(X`Inference provider operation failed: ${q(code)}`);

const ProviderDirectoryInterface = M.interface('InferenceProviderDirectory', {
  list: M.callWhen().returns(M.arrayOf(M.record())),
  lookup: M.callWhen(M.string()).returns(M.record()),
  create: M.callWhen(M.record()).returns(M.record()),
  adminFor: M.callWhen(M.string()).returns(M.remotable()),
  getOwnerLimits: M.callWhen().returns(M.record()),
  setOwnerLimits: M.callWhen(M.record(), M.string())
    .optional(M.boolean())
    .returns(M.record()),
  getUsage: M.callWhen().returns(M.record()),
});

const ProviderAdminInterface = M.interface('InferenceProviderAdmin', {
  getSummary: M.callWhen().returns(M.record()),
  setLimits: M.callWhen(M.record(), M.string())
    .optional(M.boolean())
    .returns(M.record()),
  discoverModels: M.callWhen().returns(M.record()),
  supersede: M.callWhen(M.record()).returns(M.record()),
  retire: M.callWhen(M.string()).returns(M.record()),
});

const ProviderUseInterface = M.interface('InferenceProviderUse', {
  grant: M.callWhen(M.record()).returns(M.remotable()),
  setGrantLimits: M.callWhen(M.string(), M.record(), M.string())
    .optional(M.boolean())
    .returns(M.record()),
});

// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(ProviderDirectoryInterface);
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(ProviderAdminInterface);
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(ProviderUseInterface);

/** Refusal records kept for audit; older ones are dropped. */
const MAX_REFUSALS = 1024;

/** @returns {any} */
const emptyState = () =>
  harden({
    version: 1,
    descriptors: {},
    lifecycles: {},
    operations: {},
    grants: {},
    ownerLimits: {},
    modelStates: {},
    turnEvents: [],
    refusals: [],
    audit: [],
  });

/**
 * @param {unknown} left
 * @param {unknown} right
 */
const sameData = (left, right) =>
  JSON.stringify(left) === JSON.stringify(right);

/** @param {any} state */
const copyState = state => ({
  ...state,
  descriptors: { ...state.descriptors },
  lifecycles: { ...state.lifecycles },
  operations: { ...state.operations },
  grants: { ...state.grants },
  ownerLimits: { ...(state.ownerLimits || {}) },
  modelStates: { ...(state.modelStates || {}) },
  turnEvents: [...(state.turnEvents || [])],
  refusals: [...(state.refusals || [])],
  audit: [...state.audit],
});

/**
 * @param {any} descriptor
 * @param {any} lifecycle
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
 * Convert the prior mutable-turn snapshot shape to immutable facts.
 *
 * @param {Record<string, any>} turns
 */
const eventsFromLegacyTurns = turns => {
  const events = [];
  for (const turn of Object.values(turns || {})) {
    events.push(
      harden({
        type: 'reserved',
        version: turn.version,
        turnId: turn.turnId,
        ownerId: turn.ownerId,
        providerId: turn.providerId,
        grantId: turn.grantId,
        agentId: turn.agentId,
        model: turn.model,
        day: turn.day,
        admittedAt: turn.admittedAt,
        admittedAtMs: turn.admittedAtMs,
        reservedTokens: turn.reservedTokens,
        ...(turn.reservedCostMicros === undefined
          ? {}
          : { reservedCostMicros: turn.reservedCostMicros }),
      }),
    );
    if (turn.state === 'settled') {
      events.push(
        harden({
          type: 'settled',
          turnId: turn.turnId,
          disposition: turn.disposition,
          usage: turn.usage,
          chargedTokens: turn.chargedTokens,
          ...(turn.chargedCostMicros === undefined
            ? {}
            : { chargedCostMicros: turn.chargedCostMicros }),
          overrun: turn.overrun,
          settledAt: turn.settledAt,
          settledAtMs: Date.parse(turn.settledAt),
        }),
      );
    }
  }
  return harden(events);
};

/**
 * The durable, non-secret provider registry. The caller supplies one Endo
 * snapshot journal, the root-private secret participant, and construction of
 * the existing provider grant issuer. Recreating this object over the same
 * journal is the restart path.
 *
 * @param {object} options
 * @param {{ read(): Promise<any>, write(value: any): Promise<void> }} options.journal
 * @param {{ has(name: string): Promise<boolean>, provide(name: string, description: string, bytesBase64?: string, stableIds?: { secretId: string, grantId: string, operationId: string }): Promise<any>, recover?(name: string, description: string, stableIds: { secretId: string, grantId: string, operationId: string }): Promise<boolean>, revoke(name: string): Promise<void>, revokeStable?(stableIds: { secretId: string, grantId: string, operationId: string }): Promise<void>, state(name: string): Promise<string>, listNames?(): Promise<string[]> }} options.secrets
 * @param {(details: { descriptor: any, lifecycle: any, secret: any }) => Promise<{ openEndpoint(spec: any): Promise<any>, dispose(): Promise<void> | void }> | { openEndpoint(spec: any): Promise<any>, dispose(): Promise<void> | void }} options.makeIssuer
 * @param {(limits: any) => any} [options.validateLimits]
 * @param {(details: { descriptor: any, secret: any }) => Promise<{ observedAt?: number, models: Array<{ id: string, title?: string }> }>} [options.discoverModels]
 * @param {Record<string, { inputPerMillion: number, outputPerMillion: number, cacheReadPerMillion?: number, cacheWritePerMillion?: number }>} [options.modelPrices]
 * @param {Record<string, number>} [options.deploymentCeilings]
 * @param {() => string} options.randomId
 * @param {() => string} [options.now]
 * @param {() => number} [options.nowMillis]
 * @param {number} [options.intentExpiryMs]
 * @param {(boundary: string, details: any) => Promise<void> | void} [options.afterCommit]
 */
export const makeInferenceProviderRegistry = async ({
  journal,
  secrets,
  makeIssuer,
  validateLimits: validateLimitsHook,
  discoverModels,
  modelPrices = harden({}),
  deploymentCeilings = harden({}),
  randomId,
  now = () => new Date().toISOString(),
  nowMillis = () => Date.parse(now()),
  intentExpiryMs = 24 * 60 * 60 * 1000,
  afterCommit = () => {},
}) => {
  await null;
  const restored = await journal.read();
  /** @type {ReturnType<typeof emptyState>} */
  let state;
  if (restored?.turns !== undefined && restored?.turnEvents === undefined) {
    const { turns, ...withoutTurns } = restored;
    state = harden({
      ...emptyState(),
      ...withoutTurns,
      turnEvents: eventsFromLegacyTurns(turns),
    });
    await journal.write(state);
  } else {
    state = harden({ ...emptyState(), ...(restored || {}) });
  }
  state.version === 1 ||
    (() => {
      throw fixedError('unsupported-version');
    })();
  // A turn still reserved at restart lost its in-flight request with the
  // prior incarnation. Charge its reservation and release its slot.
  const orphaned = Object.values(
    foldInferenceTurnEvents(state.turnEvents || []),
  ).filter(turn => turn.state === 'reserved');
  if (orphaned.length > 0) {
    const recoveredAtMs = nowMillis();
    const turnEvents = [...state.turnEvents];
    for (const turn of orphaned) {
      turnEvents.push(
        harden({
          type: 'settled',
          turnId: turn.turnId,
          disposition: 'estimated',
          usage: harden({
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          }),
          chargedTokens: turn.reservedTokens,
          ...(turn.reservedCostMicros === undefined
            ? {}
            : { chargedCostMicros: turn.reservedCostMicros }),
          overrun: false,
          settledAt: now(),
          settledAtMs: recoveredAtMs,
        }),
      );
    }
    state = harden({
      ...state,
      turnEvents: compactInferenceTurnEvents(turnEvents, recoveredAtMs),
    });
    await journal.write(state);
  }

  /** @type {Promise<void>} */
  let mutationTail = Promise.resolve();
  /** @type {Map<string, any>} */
  const directories = new Map();
  /** @type {Map<string, any>} */
  const admins = new Map();
  /** @type {Map<string, any>} */
  const uses = new Map();
  /** @type {Map<string, any>} */
  const inferences = new Map();
  /** @type {Map<string, Promise<any>>} */
  const issuers = new Map();
  /** @type {Map<string, Promise<any>>} */
  const endpoints = new Map();

  /**
   * @param {any} limits
   * @param {Record<string, number>} defaults
   */
  const checkLimits = (limits, defaults) => {
    const checked = validateInferenceLimits(
      limits,
      defaults,
      deploymentCeilings,
    );
    return validateLimitsHook === undefined
      ? checked
      : harden(validateLimitsHook(checked));
  };

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

  /** @param {any} next */
  const commit = async next => {
    const hardened = harden(next);
    await journal.write(hardened);
    state = hardened;
  };

  /** @param {string} ownerId */
  const assertOwnerId = ownerId => {
    IDENTIFIER_PATTERN.test(ownerId) ||
      (() => {
        throw fixedError('invalid-owner');
      })();
  };

  /** @param {string} providerId */
  const requireProvider = providerId => {
    const descriptor = state.descriptors[providerId];
    const lifecycle = state.lifecycles[providerId];
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
   * @param {any} request
   * @param {string | undefined} supersedes
   */
  const safeCreateRequest = async (ownerId, request, supersedes) => {
    await null;
    const { idempotencyKey, displayName, kind, baseUrl, defaultModel, limits } =
      request || {};
    IDENTIFIER_PATTERN.test(idempotencyKey) ||
      (() => {
        throw fixedError('invalid-idempotency-key');
      })();
    DISPLAY_NAME_PATTERN.test(displayName) ||
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
    MODEL_PATTERN.test(defaultModel) ||
      (() => {
        throw fixedError('invalid-model');
      })();
    const checkedLimits = checkLimits(limits || {}, DEFAULT_PROVIDER_LIMITS);
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
   * @param {any} request
   * @param {string | undefined} supersedes
   */
  const createProvider = (ownerId, request, supersedes) =>
    inOrder(async () => {
      assertOwnerId(ownerId);
      const safeRequest = await safeCreateRequest(ownerId, request, supersedes);
      const { idempotencyKey, keyBase64 } = request;
      const operationKey = `create:${ownerId}:${idempotencyKey}`;
      let operation = state.operations[operationKey];
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
        GENERATED_ID_PATTERN.test(operationId) ||
          (() => {
            throw fixedError('invalid-generated-id');
          })();
        const providerId = randomId();
        GENERATED_ID_PATTERN.test(providerId) ||
          (() => {
            throw fixedError('invalid-generated-id');
          })();
        const secretIds = harden({
          secretId: randomId(),
          grantId: randomId(),
          operationId: randomId(),
        });
        Object.values(secretIds).every(value =>
          GENERATED_ID_PATTERN.test(value),
        ) ||
          (() => {
            throw fixedError('invalid-generated-id');
          })();
        const createdAt = now();
        operation = harden({
          version: 1,
          operationId,
          ownerId,
          idempotencyKey,
          kind: 'create',
          providerId,
          secretName: `inference-provider-${operationId}`,
          secretIds,
          request: safeRequest,
          state: 'intent',
          createdAt,
          updatedAt: createdAt,
        });
        const next = copyState(state);
        next.operations[operationKey] = operation;
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
          exists ? undefined : keyBase64,
          operation.secretIds,
        );
        await afterCommit(
          'create-secret',
          harden({ operationId: operation.operationId }),
        );
        const next = copyState(state);
        operation = harden({
          ...operation,
          state: 'secret-created',
          updatedAt: now(),
        });
        next.operations[operationKey] = operation;
        await commit(next);
        await afterCommit(
          'create-secret-recorded',
          harden({ operationId: operation.operationId }),
        );
      }

      if (operation.state === 'secret-created') {
        const createdAt = operation.createdAt;
        const descriptor = harden({
          version: 1,
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
          version: 1,
          providerId: operation.providerId,
          state: 'active',
          limits: operation.request.limits,
          updatedAt: now(),
        });
        const next = copyState(state);
        next.descriptors[operation.providerId] = descriptor;
        next.lifecycles[operation.providerId] = lifecycle;
        next.modelStates[operation.providerId] = harden({
          catalogState: 'unavailable',
          observedAt: null,
          models: [],
          verification: harden({ [descriptor.defaultModel]: 'unverified' }),
        });
        next.ownerLimits[ownerId] ||= DEFAULT_OWNER_INFERENCE_LIMITS;
        operation = harden({
          ...operation,
          state: 'committed',
          updatedAt: now(),
        });
        next.operations[operationKey] = operation;
        next.audit.push(
          harden({
            providerId: operation.providerId,
            operationId: operation.operationId,
            change: 'created',
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
      if (state.grants[grantId]?.providerId === providerId) {
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
      IDENTIFIER_PATTERN.test(idempotencyKey) ||
        (() => {
          throw fixedError('invalid-idempotency-key');
        })();
      const { descriptor, lifecycle } = requireOwnedProvider(
        ownerId,
        providerId,
      );
      const operationKey = `retire:${ownerId}:${idempotencyKey}`;
      let operation = state.operations[operationKey];
      if (operation !== undefined && operation.providerId !== providerId) {
        throw fixedError('idempotency-conflict');
      }
      if (operation?.state === 'committed') {
        return summarize(descriptor, state.lifecycles[providerId]);
      }
      if (operation === undefined) {
        const operationId = randomId();
        const changedAt = now();
        operation = harden({
          version: 1,
          operationId,
          ownerId,
          idempotencyKey,
          kind: 'retire',
          providerId,
          secretName: descriptor.secretGrantFormulaId,
          request: {},
          state: 'intent',
          createdAt: changedAt,
          updatedAt: changedAt,
        });
        const retiring = harden({
          ...lifecycle,
          state: 'retiring',
          updatedAt: changedAt,
        });
        const next = copyState(state);
        next.operations[operationKey] = operation;
        next.lifecycles[providerId] = retiring;
        next.audit.push(
          harden({
            providerId,
            operationId,
            change: 'retiring',
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
          state: 'secret-revoked',
          updatedAt: now(),
        });
        next.operations[operationKey] = operation;
        await commit(next);
        await afterCommit(
          'retire-secret-recorded',
          harden({ operationId: operation.operationId }),
        );
      }
      if (operation.state === 'secret-revoked') {
        const before = state.lifecycles[providerId];
        const retired = harden({
          ...before,
          state: 'retired',
          updatedAt: now(),
        });
        const next = copyState(state);
        next.lifecycles[providerId] = retired;
        operation = harden({
          ...operation,
          state: 'committed',
          updatedAt: now(),
        });
        next.operations[operationKey] = operation;
        next.audit.push(
          harden({
            providerId,
            operationId: operation.operationId,
            change: 'retired',
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
      return summarize(descriptor, state.lifecycles[providerId]);
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
    const grant = state.grants[grantId];
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

  /** @param {any} grant @param {string} reason */
  const appendRefusal = async (grant, reason) => {
    const next = copyState(state);
    next.refusals = next.refusals.slice(-(MAX_REFUSALS - 1));
    next.refusals.push(
      harden({
        ownerId: grant.ownerId,
        providerId: grant.providerId,
        grantId: grant.grantId,
        agentId: grant.agentId,
        reason,
        occurredAt: now(),
      }),
    );
    await commit(next);
  };

  /** @param {string} grantId @param {string} reason */
  const refuse = (grantId, reason) =>
    inOrder(async () => {
      const grant = requireActiveGrant(grantId);
      await appendRefusal(grant, reason);
    });

  /** @param {any} usage */
  const usageCounts = usage => {
    const observed = usage?.usage ?? usage;
    const count = value =>
      typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : 0;
    return harden({
      inputTokens: count(observed?.inputTokens),
      outputTokens: count(observed?.outputTokens),
      cacheReadTokens: count(
        observed?.cacheReadTokens ?? observed?.cachedInputTokens,
      ),
      cacheWriteTokens: count(
        observed?.cacheWriteTokens ?? observed?.cacheWriteInputTokens,
      ),
    });
  };

  /**
   * Atomically reserve against the agent, provider, and owner scopes.
   * @param {string} grantId
   * @param {{ inputBytes: number, maxOutputTokens: number }} request
   */
  const admit = (grantId, request) =>
    inOrder(async () => {
      await null;
      const grant = requireActiveGrant(grantId);
      const { lifecycle } = requireProvider(grant.providerId);
      const ownerLimits =
        state.ownerLimits?.[grant.ownerId] || DEFAULT_OWNER_INFERENCE_LIMITS;
      const providerLimits = lifecycle.limits;
      const agentLimits = effectiveInferenceLimits(grant.caps, providerLimits);
      const admittedAtMs = nowMillis();
      Number.isFinite(admittedAtMs) ||
        (() => {
          throw fixedError('invalid-clock');
        })();
      const day = new Date(admittedAtMs).toISOString().slice(0, 10);
      const scopes = [
        {
          name: 'agent',
          limits: agentLimits,
          field: 'grantId',
          value: grantId,
        },
        {
          name: 'provider',
          limits: providerLimits,
          field: 'providerId',
          value: grant.providerId,
        },
        {
          name: 'owner',
          limits: ownerLimits,
          field: 'ownerId',
          value: grant.ownerId,
        },
      ];
      const reservedTokens = conservativeTokenReservation(request);
      const price = Object.hasOwn(modelPrices, grant.models[0])
        ? modelPrices[grant.models[0]]
        : undefined;
      const reservedCostMicros = priceUsageMicros(
        request.inputBytes * 2,
        request.maxOutputTokens,
        0,
        0,
        price,
      );
      // Per-turn enforcers and post-result usage sinks cannot protect this
      // boundary: admission spans grants and owners and must happen before the
      // endpoint reads the API key. Policy therefore decides from a pure value
      // snapshot; this layer only records the resulting fact.
      const refusal = inferenceAdmissionRefusal({
        usage: inferenceUsageAt(state.turnEvents, admittedAtMs),
        scopes,
        reservedTokens,
        reservedCostMicros,
      });
      if (refusal !== undefined) {
        await appendRefusal(grant, refusal);
        throw fixedError('inference-request-refused');
      }
      const turnId = randomId();
      const next = copyState(state);
      next.turnEvents.push(
        harden({
          type: 'reserved',
          version: 1,
          turnId,
          ownerId: grant.ownerId,
          providerId: grant.providerId,
          grantId,
          agentId: grant.agentId,
          model: grant.models[0],
          day,
          admittedAt: now(),
          admittedAtMs,
          reservedTokens,
          ...(reservedCostMicros === undefined ? {} : { reservedCostMicros }),
        }),
      );
      await commit(next);
      return turnId;
    });

  /**
   * @param {string} turnId
   * @param {any} settlement
   * @param {'settled' | 'estimated' | 'released'} disposition
   */
  const settle = (turnId, settlement, disposition) =>
    inOrder(async () => {
      const prior = foldInferenceTurnEvents(state.turnEvents)[turnId];
      if (prior === undefined || prior.state !== 'reserved') return;
      const counts = usageCounts(settlement);
      const observedTokens = Object.values(counts).reduce(
        (total, count) => total + count,
        0,
      );
      const known = observedTokens > 0;
      const chargedTokens =
        disposition === 'released'
          ? 0
          : known
            ? observedTokens
            : prior.reservedTokens;
      const observedCost = priceUsageMicros(
        counts.inputTokens,
        counts.outputTokens,
        counts.cacheReadTokens,
        counts.cacheWriteTokens,
        Object.hasOwn(modelPrices, prior.model)
          ? modelPrices[prior.model]
          : undefined,
      );
      const chargedCostMicros =
        disposition === 'released'
          ? 0
          : known && observedCost !== undefined
            ? observedCost
            : prior.reservedCostMicros;
      const settledAtMs = nowMillis();
      const next = copyState(state);
      const settlementEvent = harden({
        type: 'settled',
        turnId,
        disposition: known ? 'reported' : disposition,
        usage: counts,
        chargedTokens,
        ...(chargedCostMicros === undefined ? {} : { chargedCostMicros }),
        // Reported usage is charged in full even above the reservation, so a
        // day's spend can pass its budget by the overrun of turns already in
        // flight; later admissions that day are then refused.
        overrun:
          Number(chargedTokens) > Number(prior.reservedTokens) ||
          Number(chargedCostMicros ?? 0) >
            Number(prior.reservedCostMicros ?? Infinity),
        settledAt: now(),
        settledAtMs,
      });
      next.turnEvents = compactInferenceTurnEvents(
        [...next.turnEvents, settlementEvent],
        settledAtMs,
      );
      await commit(next);
    });

  /** @param {string} providerId @param {string} model */
  const markModelVerified = (providerId, model) =>
    inOrder(async () => {
      const current = state.modelStates?.[providerId] || {
        catalogState: 'unavailable',
        observedAt: null,
        models: [],
        verification: {},
      };
      if (current.verification?.[model] === 'verified') return;
      const next = copyState(state);
      next.modelStates[providerId] = harden({
        ...current,
        verification: harden({
          ...(current.verification || {}),
          [model]: 'verified',
        }),
      });
      await commit(next);
    });

  /** @param {string} providerId */
  const refreshModels = async providerId => {
    const { descriptor, lifecycle } = requireProvider(providerId);
    lifecycle.state === 'active' ||
      (() => {
        throw fixedError('provider-retired');
      })();
    if (discoverModels === undefined) {
      return (
        state.modelStates?.[providerId] ||
        harden({
          catalogState: 'unsupported',
          observedAt: null,
          models: [],
          verification: {},
        })
      );
    }
    let observation;
    try {
      const secret = await secrets.provide(
        descriptor.secretGrantFormulaId,
        `Inference provider ${providerId}`,
        undefined,
        undefined,
      );
      observation = await discoverModels({ descriptor, secret });
      (observation && Array.isArray(observation.models)) ||
        (() => {
          throw Error('invalid model catalog');
        })();
    } catch (_error) {
      const unavailable = harden({
        ...(state.modelStates?.[providerId] || {}),
        catalogState: 'unavailable',
        observedAt: null,
        models: [],
      });
      await inOrder(async () => {
        const next = copyState(state);
        next.modelStates[providerId] = unavailable;
        await commit(next);
      });
      return unavailable;
    }
    const models = observation.models.map(model => {
      (model && MODEL_PATTERN.test(model.id)) ||
        (() => {
          throw fixedError('invalid-model-catalog');
        })();
      return harden({ id: model.id, title: model.title || model.id });
    });
    const verification = {
      ...(state.modelStates?.[providerId]?.verification || {}),
    };
    for (const model of models) verification[model.id] = 'verified';
    const available = harden({
      catalogState: 'current',
      observedAt: observation.observedAt ?? nowMillis(),
      models: harden(models),
      verification: harden(verification),
    });
    await inOrder(async () => {
      const next = copyState(state);
      next.modelStates[providerId] = available;
      await commit(next);
    });
    return available;
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
        requireActiveGrant(grantId);
        return opened;
      })();
      endpoints.set(grantId, endpoint);
      endpoint.catch(() => endpoints.delete(grantId));
    }
    return endpoint;
  };

  /** @param {string} grantId */
  const provideInference = grantId => {
    let inference = inferences.get(grantId);
    if (inference !== undefined) return inference;
    inference = makeExo('AgentInference', InferenceEndpointInterface, {
      request: async message => {
        await null;
        const grant = requireActiveGrant(grantId);
        let checked;
        try {
          checked = validateAnthropicInferenceRequest(message, {
            model: grant.models[0],
            maxOutputTokens: grant.caps.maxOutputTokens,
            maxRequestBytes: grant.caps.maxRequestBytes,
          });
        } catch (_error) {
          await refuse(grantId, 'inference-request-refused');
          throw fixedError('inference-request-refused');
        }
        const turnId = await admit(grantId, checked);
        let endpoint;
        try {
          endpoint = await provideEndpoint(grantId);
        } catch (error) {
          await settle(turnId, undefined, 'released');
          throw error;
        }
        let response;
        try {
          response = await E(endpoint).request(checked.message);
        } catch (error) {
          // Once dispatched, an unknown/cancelled turn is conservatively
          // charged its reservation even though its concurrency slot releases.
          await settle(turnId, undefined, 'estimated');
          throw error;
        }
        let observed;
        try {
          observed = await response.usage;
        } catch (error) {
          await settle(turnId, undefined, 'estimated');
          throw error;
        }
        await settle(turnId, observed, 'estimated');
        if (response.status === 404) {
          await refuse(grantId, 'model-not-available');
          throw fixedError('model-not-available');
        }
        if (Number(response.status) >= 200 && Number(response.status) < 300) {
          await markModelVerified(grant.providerId, grant.models[0]);
        }
        return response;
      },
      requestByteStream: async message => {
        await null;
        const grant = requireActiveGrant(grantId);
        let checked;
        try {
          checked = validateAnthropicInferenceRequest(message, {
            model: grant.models[0],
            maxOutputTokens: grant.caps.maxOutputTokens,
            maxRequestBytes: grant.caps.maxRequestBytes,
          });
        } catch (_error) {
          await refuse(grantId, 'inference-request-refused');
          throw fixedError('inference-request-refused');
        }
        const turnId = await admit(grantId, checked);
        let endpoint;
        try {
          endpoint = await provideEndpoint(grantId);
        } catch (error) {
          await settle(turnId, undefined, 'released');
          throw error;
        }
        let response;
        try {
          response = await E(endpoint).requestByteStream(checked.message);
        } catch (error) {
          await settle(turnId, undefined, 'estimated');
          throw error;
        }
        const usage = Promise.resolve(response.usage).then(
          async observed => {
            await settle(turnId, observed, 'estimated');
            if (
              Number(response.status) >= 200 &&
              Number(response.status) < 300
            ) {
              await markModelVerified(grant.providerId, grant.models[0]);
            }
            return observed;
          },
          async error => {
            await settle(turnId, undefined, 'estimated');
            throw error;
          },
        );
        usage.catch(() => {});
        if (response.status === 404) {
          await usage.catch(() => {});
          await refuse(grantId, 'model-not-available');
          throw fixedError('model-not-available');
        }
        return harden({ ...response, usage });
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
      const grant = state.grants[grantId];
      if (grant === undefined || grant.state === 'revoked') return;
      const next = copyState(state);
      next.grants[grantId] = harden({
        ...grant,
        state: 'revoked',
        generation: grant.generation + 1,
        updatedAt: now(),
      });
      await commit(next);
      const endpoint = endpoints.get(grantId);
      endpoints.delete(grantId);
      if (endpoint !== undefined) await E(await endpoint).revoke();
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
      setGrantLimits: (grantId, limits, operationId, confirmed = false) =>
        inOrder(async () => {
          IDENTIFIER_PATTERN.test(operationId) ||
            (() => {
              throw fixedError('invalid-operation-id');
            })();
          const grant = state.grants[grantId];
          (grant !== undefined &&
            grant.ownerId === ownerId &&
            grant.providerId === providerId) ||
            (() => {
              throw fixedError('agent-not-found');
            })();
          grant.state === 'active' ||
            (() => {
              throw fixedError('agent-deleted');
            })();
          const { lifecycle } = requireOwnedProvider(ownerId, providerId);
          const checked = checkLimits(limits, grant.caps);
          sameData(
            checked,
            effectiveInferenceLimits(checked, lifecycle.limits),
          ) ||
            (() => {
              throw fixedError('invalid-agent-limits');
            })();
          confirmed ||
            raisedInferenceLimits(grant.caps, checked).length === 0 ||
            (() => {
              throw fixedError('limit-raise-unconfirmed');
            })();
          const updatedAt = now();
          const next = copyState(state);
          next.grants[grantId] = harden({
            ...grant,
            caps: checked,
            updatedAt,
          });
          next.audit.push(
            harden({
              providerId,
              grantId,
              operationId,
              change: 'agent-limits',
              oldValue: grant.caps,
              newValue: checked,
              occurredAt: updatedAt,
            }),
          );
          await commit(next);
          return harden({ grantId, caps: checked, updatedAt });
        }),
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
          IDENTIFIER_PATTERN.test(request.agentId) ||
            (() => {
              throw fixedError('invalid-agent');
            })();
          MODEL_PATTERN.test(request.model) ||
            (() => {
              throw fixedError('invalid-model');
            })();
          const agentDefaults = effectiveInferenceLimits(
            DEFAULT_AGENT_LIMITS,
            lifecycle.limits,
          );
          const caps = checkLimits(request.caps || {}, agentDefaults);
          sameData(caps, effectiveInferenceLimits(caps, lifecycle.limits)) ||
            (() => {
              throw fixedError('invalid-agent-limits');
            })();
          const grantId = request.grantId || randomId();
          IDENTIFIER_PATTERN.test(grantId) ||
            (() => {
              throw fixedError('invalid-generated-id');
            })();
          const existing = state.grants[grantId];
          const desired = harden({
            version: 1,
            grantId,
            ownerId: request.ownerId,
            providerId,
            agentId: request.agentId,
            models: [request.model],
            caps,
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
          const providerModels = state.modelStates?.[providerId] || {
            catalogState: 'unavailable',
            observedAt: null,
            models: [],
            verification: {},
          };
          next.modelStates[providerId] = harden({
            ...providerModels,
            verification: harden({
              ...(providerModels.verification || {}),
              [request.model]:
                providerModels.verification?.[request.model] || 'unverified',
            }),
          });
          next.grants[grantId] = harden({
            ...desired,
            state: 'active',
            generation: 1,
            createdAt: changedAt,
            updatedAt: changedAt,
          });
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
      setLimits: (limits, operationId, confirmed = false) =>
        inOrder(async () => {
          IDENTIFIER_PATTERN.test(operationId) ||
            (() => {
              throw fixedError('invalid-operation-id');
            })();
          const found = requireOwnedProvider(ownerId, providerId);
          found.lifecycle.state === 'active' ||
            (() => {
              throw fixedError('provider-retired');
            })();
          const checkedLimits = checkLimits(limits, found.lifecycle.limits);
          confirmed ||
            raisedInferenceLimits(found.lifecycle.limits, checkedLimits)
              .length === 0 ||
            (() => {
              throw fixedError('limit-raise-unconfirmed');
            })();
          const changed = harden({
            ...found.lifecycle,
            limits: checkedLimits,
            updatedAt: now(),
          });
          const next = copyState(state);
          next.lifecycles[providerId] = changed;
          next.audit.push(
            harden({
              providerId,
              operationId,
              change: 'limits',
              oldValue: found.lifecycle,
              newValue: changed,
              occurredAt: now(),
            }),
          );
          await commit(next);
          return summarize(found.descriptor, changed);
        }),
      discoverModels: async () => refreshModels(providerId),
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
                summarize(descriptor, state.lifecycles[descriptor.providerId]),
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
        getOwnerLimits: async () =>
          state.ownerLimits?.[ownerId] || DEFAULT_OWNER_INFERENCE_LIMITS,
        setOwnerLimits: (limits, operationId, confirmed = false) =>
          inOrder(async () => {
            IDENTIFIER_PATTERN.test(operationId) ||
              (() => {
                throw fixedError('invalid-operation-id');
              })();
            const prior =
              state.ownerLimits?.[ownerId] || DEFAULT_OWNER_INFERENCE_LIMITS;
            const checked = checkLimits(limits, prior);
            confirmed ||
              raisedInferenceLimits(prior, checked).length === 0 ||
              (() => {
                throw fixedError('limit-raise-unconfirmed');
              })();
            const next = copyState(state);
            next.ownerLimits[ownerId] = checked;
            next.audit.push(
              harden({
                ownerId,
                operationId,
                change: 'owner-limits',
                oldValue: prior,
                newValue: checked,
                occurredAt: now(),
              }),
            );
            await commit(next);
            return checked;
          }),
        getUsage: async () => {
          const turns = Object.values(
            foldInferenceTurnEvents(state.turnEvents),
          ).filter(turn => turn.ownerId === ownerId);
          const refusals = (state.refusals || []).filter(
            refusal => refusal.ownerId === ownerId,
          );
          return harden({ turns: harden(turns), refusals: harden(refusals) });
        },
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
          // Finished operations have no recovery work.
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
                state: 'secret-created',
                updatedAt: now(),
              });
              next.operations[operationKey] = operation;
              // eslint-disable-next-line no-await-in-loop
              await commit(next);
            } else if (
              Date.parse(now()) - Date.parse(operation.createdAt) >=
              intentExpiryMs
            ) {
              const next = copyState(state);
              next.operations[operationKey] = harden({
                ...operation,
                state: 'aborted',
                updatedAt: now(),
              });
              if (secrets.revokeStable !== undefined) {
                // eslint-disable-next-line no-await-in-loop
                await secrets.revokeStable(operation.secretIds);
              }
              // eslint-disable-next-line no-await-in-loop
              await commit(next);
              // This expired intent has no participant effect to drive.
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
              version: 1,
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
              version: 1,
              providerId: operation.providerId,
              state: 'active',
              limits: operation.request.limits,
              updatedAt: now(),
            });
            const next = copyState(state);
            next.descriptors[operation.providerId] = descriptor;
            next.lifecycles[operation.providerId] = lifecycle;
            next.modelStates[operation.providerId] ||= harden({
              catalogState: 'unavailable',
              observedAt: null,
              models: [],
              verification: harden({ [descriptor.defaultModel]: 'unverified' }),
            });
            next.ownerLimits[operation.ownerId] ||=
              DEFAULT_OWNER_INFERENCE_LIMITS;
            next.operations[operationKey] = harden({
              ...operation,
              state: 'committed',
              updatedAt: now(),
            });
            next.audit.push(
              harden({
                providerId: operation.providerId,
                operationId: operation.operationId,
                change: 'created',
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
              state: 'secret-revoked',
              updatedAt: now(),
            });
            next.operations[operationKey] = operation;
            // eslint-disable-next-line no-await-in-loop
            await commit(next);
          }
          if (operation.state === 'secret-revoked') {
            const before = state.lifecycles[operation.providerId];
            const retired = harden({
              ...before,
              state: 'retired',
              updatedAt: now(),
            });
            const next = copyState(state);
            next.lifecycles[operation.providerId] = retired;
            next.operations[operationKey] = harden({
              ...operation,
              state: 'committed',
              updatedAt: now(),
            });
            next.audit.push(
              harden({
                providerId: operation.providerId,
                operationId: operation.operationId,
                change: 'retired',
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
    inspect: () =>
      harden({
        ...state,
        turns: foldInferenceTurnEvents(state.turnEvents),
      }),
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
 * @param {any} powers Root Endo host powers.
 */
export const makeEndoSecretParticipant = powers => {
  const lookupBlob = name => E(powers).lookup(['secrets', name]);
  const has = async name => {
    await null;
    try {
      return await E(powers).has('secrets', name);
    } catch (_error) {
      return false;
    }
  };
  const catalog = () => E(powers).lookup(['@secrets', 'catalog']);
  return harden({
    has,
    provide: async (name, description, bytesBase64, stableIds) => {
      if (stableIds !== undefined) {
        typeof bytesBase64 === 'string' ||
          (await has(name)) ||
          (() => {
            throw fixedError('key-needed');
          })();
        const importer = await E(powers).lookup(['@secrets', 'create']);
        await E(importer).provideBase64(
          name,
          description,
          bytesBase64,
          stableIds,
        );
      } else if (!(await has(name))) {
        throw fixedError('key-needed');
      }
      return lookupBlob(name);
    },
    recover: async (name, description, stableIds) => {
      const importer = await E(powers).lookup(['@secrets', 'create']);
      try {
        await E(importer).provideBase64(
          name,
          description,
          undefined,
          stableIds,
        );
        return true;
      } catch (error) {
        if (/KEY_NEEDED/.test(/** @type {Error} */ (error).message)) {
          return false;
        }
        throw error;
      }
    },
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
