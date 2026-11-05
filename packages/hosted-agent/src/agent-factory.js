// @ts-check

import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { makeAgentGuestPowers } from './agent-guest-powers.js';
import {
  DEFAULT_AGENT_LIMITS,
  validateInferenceLimits,
} from './inference-provider-policy.js';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const GENERATED_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const BOT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MESSAGE_NUMBER_PATTERN = /^(0|[1-9][0-9]{0,30})$/;

const SUBAGENT_CREATION = 'subagent-creation';

const CREATE_FIELDS = harden([
  'idempotencyKey',
  'providerId',
  'harness',
  'name',
  'model',
  'limits',
  'wake',
  'endowments',
  'harnessConfig',
]);

/**
 * @typedef {object} AgentCreateRequest
 * @property {string} idempotencyKey
 * @property {string} providerId
 * @property {string} harness One of the catalog's harness ids.
 * @property {string} name
 * @property {string} model
 * @property {Record<string, unknown>} [limits]
 * @property {boolean} [wake]
 * @property {Array<unknown>} [endowments]
 * @property {Record<string, unknown>} [harnessConfig]
 */

/**
 * @typedef {object} AgentReattachRequest
 * @property {string} idempotencyKey
 * @property {string} providerId
 * @property {string} [model]
 */

/**
 * The part of an `InferenceProviderUse` the factory consults: the owner it
 * was granted to.
 *
 * @typedef {{ describe(): Promise<{ ownerId: string }> }} ProviderUseOwner
 */

/** A harness configuration with one of these could reach key material. */
const FORBIDDEN_HARNESS_CONFIG = harden([
  'authSecretName',
  'authToken',
  'getApiKey',
]);

/**
 * The harnesses the first release offers. It grows from here, not from a
 * client list, and Floot and Jaine stay out until each has a powers profile.
 */
export const AGENT_HARNESS_CATALOG = harden([
  harden({
    id: 'lal',
    label: 'Lal',
    recommended: true,
    description: 'A familiar agent with a fixed set of capability tools.',
    providerKinds: harden(['anthropic']),
  }),
  harden({
    id: 'fae',
    label: 'Fae',
    recommended: false,
    description: 'An advanced agent that adopts tools sent to it as messages.',
    providerKinds: harden(['anthropic']),
  }),
]);

const fixedError = code => makeError(X`Agent operation failed: ${q(code)}`);

/**
 * The fixed code in a participant or registry refusal. Anything else is
 * transient and leaves its operation resumable.
 *
 * @param {any} error
 */
const fixedCodeOf = error =>
  /operation failed: "([a-z-]+)"/.exec(String(error?.message))?.[1];

/**
 * @param {boolean} condition
 * @param {string} code
 */
const refuseUnless = (condition, code) => {
  if (!condition) throw fixedError(code);
};

const AgentDirectoryInterface = M.interface('AgentDirectory', {
  getCatalog: M.callWhen().returns(M.record()),
  list: M.callWhen().returns(M.arrayOf(M.record())),
  get: M.callWhen(M.string()).returns(M.record()),
  create: M.callWhen(M.record()).returns(M.record()),
  setWake: M.callWhen(M.string(), M.record()).returns(M.record()),
  setLimits: M.callWhen(M.string(), M.record()).returns(M.record()),
  reattachOptions: M.callWhen(M.string()).returns(M.arrayOf(M.record())),
  reattach: M.callWhen(M.string(), M.record()).returns(M.record()),
  dismissMail: M.callWhen(M.string(), M.string()).returns(M.record()),
  delete: M.callWhen(M.string(), M.record()).returns(M.record()),
  getOperationStatus: M.callWhen(M.string()).returns(M.record()),
});

const AgentInferenceInterface = M.interface('AgentInference', {
  request: M.callWhen(M.record()).returns(M.record()),
  requestByteStream: M.callWhen(M.record()).returns(M.record()),
  attestation: M.callWhen().returns(M.record()),
});

// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(AgentDirectoryInterface);
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(AgentInferenceInterface);

const emptyState = () =>
  harden({
    version: 1,
    agents: {},
    operations: {},
    names: {},
    reports: [],
  });

/** @param {any} state */
const copyState = state => ({
  ...state,
  agents: { ...state.agents },
  operations: { ...state.operations },
  names: { ...state.names },
  reports: [...state.reports],
});

/**
 * @param {unknown} left
 * @param {unknown} right
 */
const sameData = (left, right) =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * Owner ids, idempotency keys, and agent names may all contain any character,
 * so a delimiter would let one owner's key alias another's.
 *
 * @param {string} ownerId
 * @param {string} key
 */
const ownerScopedKey = (ownerId, key) => JSON.stringify([ownerId, key]);

/**
 * @param {string | undefined} left
 * @param {string | undefined} right
 */
const messageAfter = (left, right) =>
  right === undefined || BigInt(left || '0') > BigInt(right);

/**
 * The owner-facing request fields a creation may carry. Requests are closed:
 * an unknown field cannot select an owner, a credential, or a default.
 *
 * @param {any} request
 */
const safeCreateRequest = request => {
  const {
    idempotencyKey,
    providerId,
    harness,
    name,
    model,
    limits,
    wake,
    endowments,
    harnessConfig,
  } = request || {};
  refuseUnless(
    Reflect.ownKeys(request || {}).every(key =>
      CREATE_FIELDS.includes(String(key)),
    ),
    'invalid-request',
  );
  refuseUnless(
    IDENTIFIER_PATTERN.test(idempotencyKey),
    'invalid-idempotency-key',
  );
  refuseUnless(IDENTIFIER_PATTERN.test(providerId), 'provider-not-found');
  refuseUnless(
    AGENT_HARNESS_CATALOG.some(({ id }) => id === harness),
    'invalid-harness',
  );
  refuseUnless(BOT_NAME_PATTERN.test(name), 'invalid-agent-name');
  refuseUnless(MODEL_PATTERN.test(model), 'invalid-model');
  refuseUnless(typeof wake === 'boolean', 'invalid-request');
  refuseUnless(
    Array.isArray(endowments) &&
      endowments.every(endowment => endowment === SUBAGENT_CREATION),
    'invalid-request',
  );
  if (harnessConfig !== undefined) {
    refuseUnless(
      harnessConfig.provider === 'brokered-messages' &&
        !FORBIDDEN_HARNESS_CONFIG.some(field =>
          Object.hasOwn(harnessConfig, field),
        ),
      'invalid-harness-configuration',
    );
  }
  try {
    validateInferenceLimits(limits || {}, DEFAULT_AGENT_LIMITS);
  } catch (_error) {
    throw fixedError('invalid-agent-limits');
  }
  return harden({
    providerId,
    harness,
    name,
    model,
    limits: harden({ ...limits }),
    wake,
    subagentCreation: endowments.includes(SUBAGENT_CREATION),
  });
};

/**
 * The root-private coordinator of agent creation, wake, limits, reattachment
 * and deletion. It owns `AgentRecord` and the operation records; the guest,
 * the registry grant, the responder and the owner's inventory are participants
 * that each make one idempotent, name-keyed effect. Recreating this object over
 * the same journal is the restart path.
 *
 * @param {object} options
 * @param {{ read(): Promise<any>, write(value: any): Promise<void> }} options.journal
 * @param {any} options.registry Root capability of the provider registry.
 * @param {any} options.guests Dedicated guests by root-private name.
 * @param {any} options.inventory The owners' inventories, by owner key.
 * @param {any} options.responders The wake-on-message participant.
 * @param {any} [options.spawners] Fills the subagent-creation slot.
 * @param {() => string} options.randomId
 * @param {() => string} [options.now]
 * @param {() => number} [options.nowMillis]
 * @param {number} [options.turnWallClockMs]
 * @param {(boundary: string, details: any) => Promise<void> | void} [options.afterBoundary]
 */
export const makeAgentFactory = async ({
  journal,
  registry,
  guests,
  inventory,
  responders,
  spawners,
  randomId,
  now = () => new Date().toISOString(),
  nowMillis = () => Date.parse(now()),
  turnWallClockMs = 60 * 60 * 1000,
  afterBoundary = () => {},
}) => {
  await null;
  /** @type {ReturnType<typeof emptyState>} */
  let state = harden((await journal.read()) || emptyState());
  /** @type {Promise<unknown>} */
  let mutationTail = Promise.resolve();
  /** @type {Map<string, any>} */
  const directories = new Map();
  /** @type {Map<string, any>} */
  const inferences = new Map();

  /**
   * @template T
   * @param {() => Promise<T>} action
   * @returns {Promise<T>}
   */
  const inOrder = action => {
    const result = mutationTail.then(action);
    mutationTail = result.catch(() => {});
    return result;
  };

  /** @param {any} next */
  const commit = async next => {
    const hardened = harden(next);
    await journal.write(hardened);
    state = hardened;
  };

  /**
   * @param {string} boundary
   * @param {any} operation
   */
  const boundaryReached = (boundary, operation) =>
    afterBoundary(boundary, harden({ operationId: operation.operationId }));

  /**
   * Record an operation's next state, then cross that commit boundary.
   *
   * @param {string} key
   * @param {string} nextState
   * @param {any} [patch]
   * @param {(next: any) => void} [alsoChange] Applied in the same commit.
   */
  const advance = async (key, nextState, patch = {}, alsoChange = () => {}) => {
    const next = copyState(state);
    const operation = harden({
      ...next.operations[key],
      ...patch,
      state: nextState,
      updatedAt: now(),
    });
    next.operations[key] = operation;
    alsoChange(next);
    await commit(next);
    await boundaryReached(`${operation.kind}-${nextState}`, operation);
    return operation;
  };

  /** @param {string} agentId */
  const applyWake = async agentId => {
    const record = state.agents[agentId];
    const present = await E(responders).has(record.names.responder);
    if (record.wake) {
      if (!present) {
        await E(responders).provide(
          harden({
            name: record.names.responder,
            guestName: record.names.guest,
            agentId,
            harness: record.harness,
            startAfter: record.mailCursor,
          }),
        );
      }
      await E(responders).setPaused(
        record.names.responder,
        false,
        record.mailCursor,
      );
    } else if (present) {
      await E(responders).setPaused(
        record.names.responder,
        true,
        record.mailCursor,
      );
    }
  };

  /**
   * Undo a creation's effects in reverse order. Each participant call is keyed
   * by a preallocated name, so recovery can repeat this after a crash.
   *
   * @param {string} key
   */
  const finishAbort = async key => {
    const operation = state.operations[key];
    const { names, ownerId, request } = operation;
    await null;
    if (operation.kind === 'create') {
      if (operation.handleId !== undefined) {
        await E(inventory).remove(ownerId, request.name, operation.handleId);
      }
      await boundaryReached('create-abort-name-removed', operation);
      await E(responders).remove(names.guest, names.responder);
      await boundaryReached('create-abort-responder-removed', operation);
      await E(registry).revokeGrant(names.grant);
      await boundaryReached('create-abort-grant-revoked', operation);
      await E(guests).release(names.guest);
      await boundaryReached('create-abort-guest-released', operation);
    }
    return advance(key, 'aborted', {}, next => {
      if (operation.kind !== 'create') return;
      const nameKey = ownerScopedKey(ownerId, request.name);
      if (next.names[nameKey] === operation.agentId) delete next.names[nameKey];
    });
  };

  /**
   * The prior grant is fenced from the moment reattachment commits, so a new
   * turn cannot use it. Revoking it would cancel a turn already running, so
   * that waits until the turn settles or passes the wall clock.
   *
   * @param {string} grantId
   */
  const grantDrained = async grantId => {
    const grants = await E(registry).listGrants();
    const grant = grants.find(candidate => candidate.grantId === grantId);
    if (grant === undefined) return true;
    const cutoff = nowMillis() - turnWallClockMs;
    return !grant.activeTurnAdmittedAt.some(
      admitted => Number(admitted) > cutoff,
    );
  };

  /**
   * One step per operation state. Each performs its effect, crosses a boundary
   * so a test can crash between the effect and its record, and records the next
   * state. The steps before `committed` may abort; the rest only roll forward.
   *
   * @type {Record<string, Record<string, (key: string, operation: any) => Promise<any>>>}
   */
  const STEPS = harden({
    create: {
      intent: async (key, operation) => {
        const { handleId } = await E(guests).provide(operation.names.guest);
        await boundaryReached('create-guest-effect', operation);
        return advance(key, 'guest-created', { handleId });
      },
      'guest-created': async (key, operation) => {
        const { ownerId, agentId, names, request } = operation;
        const use = await E(registry).useFor(ownerId, request.providerId);
        await E(use).grant(
          harden({
            ownerId,
            agentId,
            grantId: names.grant,
            model: request.model,
            caps: request.limits,
          }),
        );
        await boundaryReached('create-inference-effect', operation);
        return advance(key, 'inference-bound');
      },
      'inference-bound': async (key, operation) => {
        const { agentId, names, request } = operation;
        if (request.wake) {
          await E(responders).provide(
            harden({
              name: names.responder,
              guestName: names.guest,
              agentId,
              harness: request.harness,
            }),
          );
          await boundaryReached('create-responder-effect', operation);
        }
        return advance(key, 'responder-ready');
      },
      'responder-ready': async (key, operation) => {
        await E(inventory).write(
          operation.ownerId,
          operation.request.name,
          operation.handleId,
        );
        await boundaryReached('create-name-effect', operation);
        return advance(key, 'named');
      },
      named: async (key, operation) => {
        const { ownerId, agentId, names, request, handleId } = operation;
        const grants = await E(registry).listGrants();
        const grant = grants.find(({ grantId }) => grantId === names.grant);
        refuseUnless(grant !== undefined, 'agent-not-found');
        return advance(key, 'committed', {}, next => {
          next.agents[agentId] = harden({
            version: 1,
            agentId,
            ownerId,
            name: request.name,
            harness: request.harness,
            providerId: request.providerId,
            model: request.model,
            grantId: names.grant,
            limits: grant.caps,
            wake: request.wake,
            subagentCreation: request.subagentCreation,
            names,
            handleId,
            lifecycle: 'active',
            createdAt: operation.createdAt,
            updatedAt: now(),
          });
        });
      },
      committed: async (key, operation) => {
        await applyWake(operation.agentId);
        await boundaryReached('create-activate-effect', operation);
        return advance(key, 'completed');
      },
    },
    'set-wake': {
      intent: async (key, operation) =>
        advance(key, 'committed', {}, next => {
          const record = next.agents[operation.agentId];
          next.agents[operation.agentId] = harden({
            ...record,
            wake: operation.request.wake,
            ...(operation.request.mailCursor === undefined
              ? {}
              : { mailCursor: operation.request.mailCursor }),
            updatedAt: now(),
          });
        }),
      committed: async (key, operation) => {
        await applyWake(operation.agentId);
        await boundaryReached('set-wake-activate-effect', operation);
        return advance(key, 'completed');
      },
    },
    'set-limits': {
      intent: async (key, operation) => {
        const { agentId, operationId, ownerId, request } = operation;
        const record = state.agents[agentId];
        const use = await E(registry).useFor(ownerId, record.providerId);
        const { caps } = await E(use).setGrantLimits(
          record.grantId,
          request.limits,
          operationId,
          request.confirmed,
        );
        await boundaryReached('set-limits-effect', operation);
        return advance(key, 'completed', {}, next => {
          next.agents[agentId] = harden({
            ...next.agents[agentId],
            limits: caps,
            updatedAt: now(),
          });
        });
      },
    },
    reattach: {
      intent: async (key, operation) => {
        const { agentId, operationId, ownerId, request } = operation;
        const record = state.agents[agentId];
        const directory = await E(registry).directoryFor(ownerId);
        const result = await E(directory).reattach(
          harden({
            idempotencyKey: `factory-${operationId}`,
            grantId: record.grantId,
            providerId: request.providerId,
            model: request.model,
          }),
        );
        await boundaryReached('reattach-grant-effect', operation);
        return advance(key, 'inference-bound', {
          priorGrantId: record.grantId,
          grantId: result.grantId,
          caps: result.caps,
        });
      },
      'inference-bound': async (key, operation) => {
        const { agentId, grantId, caps, request } = operation;
        return advance(key, 'committed', {}, next => {
          next.agents[agentId] = harden({
            ...next.agents[agentId],
            providerId: request.providerId,
            model: request.model,
            grantId,
            limits: caps,
            updatedAt: now(),
          });
        });
      },
      committed: async (key, operation) => {
        if (!(await grantDrained(operation.priorGrantId))) return undefined;
        await E(registry).revokeGrant(operation.priorGrantId);
        await boundaryReached('reattach-revoke-effect', operation);
        return advance(key, 'completed');
      },
    },
    delete: {
      intent: async (key, operation) =>
        advance(key, 'committed', {}, next => {
          next.agents[operation.agentId] = harden({
            ...next.agents[operation.agentId],
            lifecycle: 'deleting',
            updatedAt: now(),
          });
        }),
      committed: async (key, operation) => {
        const { agentId, ownerId } = operation;
        const record = state.agents[agentId];
        await E(responders).remove(record.names.guest, record.names.responder);
        await boundaryReached('delete-responder-effect', operation);
        await E(registry).revokeGrant(record.grantId);
        await boundaryReached('delete-grant-effect', operation);
        await E(inventory).remove(ownerId, record.name, record.handleId);
        await boundaryReached('delete-name-effect', operation);
        await E(guests).release(record.names.guest);
        await boundaryReached('delete-guest-effect', operation);
        return advance(key, 'completed', {}, next => {
          next.agents[agentId] = harden({
            ...record,
            lifecycle: 'deleted',
            updatedAt: now(),
          });
          const nameKey = ownerScopedKey(ownerId, record.name);
          if (next.names[nameKey] === agentId) delete next.names[nameKey];
        });
      },
    },
  });

  /**
   * Drive an operation until it finishes or cannot progress now. A fixed
   * refusal before commit aborts it; a transient failure leaves it for a retry
   * or the reconciler.
   *
   * @param {string} key
   */
  const runOperation = async key => {
    await null;
    /* eslint-disable no-await-in-loop -- an operation's steps run strictly in sequence. */
    for (;;) {
      const operation = state.operations[key];
      if (operation.state === 'completed' || operation.state === 'aborted') {
        return operation;
      }
      if (operation.state === 'aborting') {
        await finishAbort(key);
      } else {
        const step = STEPS[operation.kind][operation.state];
        const rollsForward =
          operation.state === 'committed' ||
          // Once the registry commits a reattachment, the prior grant is
          // fenced, so the only way out is forward.
          (operation.kind === 'reattach' &&
            operation.state === 'inference-bound');
        try {
          const advanced = await step(key, operation);
          if (advanced === undefined) return state.operations[key];
        } catch (error) {
          const code = fixedCodeOf(error);
          if (code === undefined || rollsForward) throw error;
          await advance(key, 'aborting', { refusal: code });
        }
      }
    }
    /* eslint-enable no-await-in-loop */
  };

  /** @param {any} operation */
  const throwIfAborted = operation => {
    if (operation.state === 'aborted') {
      throw fixedError(operation.refusal || 'operation-aborted');
    }
  };

  /**
   * @param {string} ownerId
   * @param {string} idempotencyKey
   * @param {string} kind
   * @param {any} request
   * @param {string} agentId
   * @param {any} [extra]
   * @param {(next: any) => void} [alsoChange]
   */
  const writeIntent = async (
    ownerId,
    idempotencyKey,
    kind,
    request,
    agentId,
    extra = {},
    alsoChange = _next => {},
  ) => {
    const key = ownerScopedKey(ownerId, idempotencyKey);
    const operationId = randomId();
    refuseUnless(
      GENERATED_ID_PATTERN.test(operationId),
      'invalid-generated-id',
    );
    const createdAt = now();
    const operation = harden({
      version: 1,
      operationId,
      ownerId,
      idempotencyKey,
      kind,
      agentId,
      request,
      state: 'intent',
      createdAt,
      updatedAt: createdAt,
      ...extra,
    });
    const next = copyState(state);
    next.operations[key] = operation;
    alsoChange(next);
    await commit(next);
    await boundaryReached(`${kind}-intent`, operation);
    return key;
  };

  /**
   * Find an idempotent retry of this request, or refuse a different request
   * under the same key.
   *
   * @param {string} ownerId
   * @param {string} idempotencyKey
   * @param {string} kind
   * @param {any} request
   */
  const findRetry = (ownerId, idempotencyKey, kind, request) => {
    const existing = state.operations[ownerScopedKey(ownerId, idempotencyKey)];
    if (existing === undefined) return undefined;
    refuseUnless(
      existing.ownerId === ownerId &&
        existing.kind === kind &&
        sameData(existing.request, request),
      'idempotency-conflict',
    );
    return existing;
  };

  /**
   * @param {string} ownerId
   * @param {string} agentId
   */
  const requireOwnedAgent = (ownerId, agentId) => {
    const record = state.agents[agentId];
    refuseUnless(
      record !== undefined && record.ownerId === ownerId,
      'agent-not-found',
    );
    return record;
  };

  /**
   * @param {string} ownerId
   * @param {string} agentId
   */
  const requireLiveAgent = (ownerId, agentId) => {
    const record = requireOwnedAgent(ownerId, agentId);
    refuseUnless(record.lifecycle === 'active', 'agent-deleted');
    return record;
  };

  /**
   * Resolve a provider only through the owner's own directory, so an unknown
   * and a foreign id are the same `provider-not-found`.
   *
   * @param {string} ownerId
   * @param {string} providerId
   */
  const requireActiveProvider = async (ownerId, providerId) => {
    const directory = await E(registry).directoryFor(ownerId);
    const provider = await E(directory).lookup(providerId);
    refuseUnless(provider.state === 'active', 'provider-retired');
    return { directory, provider };
  };

  /**
   * A model is excluded only by a current catalog. When discovery fails the
   * shape check is all there is, and the registry records the id `unverified`.
   *
   * @param {any} directory
   * @param {string} providerId
   * @param {string} model
   */
  const assertModelOffered = async (directory, providerId, model) => {
    const admin = await E(directory).adminFor(providerId);
    const catalog = await E(admin).discoverModels();
    refuseUnless(
      catalog.catalogState !== 'current' ||
        catalog.models.some(({ id }) => id === model),
      'model-not-available',
    );
    return catalog;
  };

  /**
   * The binding check for a provider capability handed to the factory directly,
   * rather than named by id in the owner's directory.
   *
   * @param {string} ownerId
   * @param {ProviderUseOwner} use
   */
  const assertUseMatchesOwner = async (ownerId, use) => {
    const { ownerId: providerOwnerId } = await E(use).describe();
    refuseUnless(providerOwnerId === ownerId, 'provider-owner-mismatch');
  };

  /**
   * @param {string} ownerId
   * @param {any} request
   */
  const createAgent = async (ownerId, request) => {
    const safe = safeCreateRequest(request);
    const { idempotencyKey } = request;
    // Discovery may wait on the upstream, so it stays outside the queue. A
    // retry skips it because the operation already holds the decision.
    const key = ownerScopedKey(ownerId, idempotencyKey);
    if (state.operations[key] === undefined) {
      const { directory, provider } = await requireActiveProvider(
        ownerId,
        safe.providerId,
      );
      const harness = AGENT_HARNESS_CATALOG.find(
        ({ id }) => id === safe.harness,
      );
      refuseUnless(
        harness !== undefined && harness.providerKinds.includes(provider.kind),
        'provider-kind-unsupported',
      );
      await assertModelOffered(directory, safe.providerId, safe.model);
      refuseUnless(
        !safe.subagentCreation || spawners !== undefined,
        'subagent-creation-unavailable',
      );
    }
    return inOrder(async () => {
      const retry = findRetry(ownerId, idempotencyKey, 'create', safe);
      if (retry === undefined) {
        const nameKey = ownerScopedKey(ownerId, safe.name);
        refuseUnless(state.names[nameKey] === undefined, 'agent-name-conflict');
        const operationSuffix = randomId();
        const agentId = `agent-${operationSuffix}`;
        refuseUnless(
          GENERATED_ID_PATTERN.test(agentId),
          'invalid-generated-id',
        );
        await writeIntent(
          ownerId,
          idempotencyKey,
          'create',
          safe,
          agentId,
          {
            names: harden({
              guest: agentId,
              grant: `grant-${operationSuffix}`,
              responder: `responder-${operationSuffix}`,
            }),
          },
          next => {
            next.names[nameKey] = agentId;
          },
        );
      }
      const finished = await runOperation(key);
      throwIfAborted(finished);
      return summarize(finished.agentId);
    });
  };

  /**
   * @param {any} mail
   * @param {string | undefined} cursor
   */
  const queuedAfter = (mail, cursor) =>
    mail.filter(({ number }) => messageAfter(number, cursor));

  /** @param {string} agentId */
  const mailFor = async agentId => {
    const record = state.agents[agentId];
    return harden(await E(guests).listMail(record.names.guest));
  };

  /**
   * @param {any} record
   * @param {Array<any>} turns
   */
  const usageFor = (record, turns) => {
    /** @type {Record<string, { providerId: string, turns: number, chargedTokens: number, chargedCostMicros: number }>} */
    const byProvider = {};
    for (const turn of turns) {
      if (turn.agentId === record.agentId) {
        const row = byProvider[turn.providerId] || {
          providerId: turn.providerId,
          turns: 0,
          chargedTokens: 0,
          chargedCostMicros: 0,
        };
        row.turns += 1;
        row.chargedTokens += turn.chargedTokens || 0;
        row.chargedCostMicros += turn.chargedCostMicros || 0;
        byProvider[turn.providerId] = row;
      }
    }
    return harden(Object.values(byProvider));
  };

  /** @param {any} record */
  const statusOf = record => {
    if (record.lifecycle !== 'active') return record.lifecycle;
    const pendingWake = Object.values(state.operations).some(
      operation =>
        operation.agentId === record.agentId &&
        operation.state === 'committed' &&
        (operation.kind === 'create' || operation.kind === 'set-wake'),
    );
    if (pendingWake) return 'waking';
    return record.wake ? 'awake' : 'asleep';
  };

  /** @param {string} agentId */
  const summarize = async agentId => {
    const record = state.agents[agentId];
    if (record.lifecycle === 'deleted') {
      return harden({ agentId, name: record.name, lifecycle: 'deleted' });
    }
    const directory = await E(registry).directoryFor(record.ownerId);
    const [mail, usage, provider] = await Promise.all([
      mailFor(agentId).catch(() => harden([])),
      E(directory)
        .getUsage()
        .catch(() => harden({ turns: [] })),
      E(directory)
        .lookup(record.providerId)
        .catch(() => undefined),
    ]);
    const unread = queuedAfter(mail, record.mailCursor);
    const lastMessage = mail.reduce(
      (latest, { number }) => (messageAfter(number, latest) ? number : latest),
      undefined,
    );
    return harden({
      agentId,
      name: record.name,
      providerId: record.providerId,
      providerName: provider?.displayName ?? record.providerId,
      harness: record.harness,
      model: record.model,
      limits: record.limits,
      wake: record.wake,
      status: statusOf(record),
      lifecycle: record.lifecycle,
      unreadCount: unread.length,
      unread,
      ...(lastMessage === undefined ? {} : { lastMessage }),
      subagentCreation: record.subagentCreation,
      usage: usageFor(record, usage.turns),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  };

  /**
   * Enabling wake with queued mail spends the provider's budget, so it needs a
   * decision naming the mail the owner saw. Mail arriving later is new mail.
   *
   * @param {any} record
   * @param {any} request
   */
  const safeWakeRequest = async (record, request) => {
    const { wake, queuedMail, confirmedCursor } = request;
    refuseUnless(typeof wake === 'boolean', 'invalid-request');
    if (!wake) return harden({ wake });
    const unread = queuedAfter(
      await mailFor(record.agentId),
      record.mailCursor,
    );
    if (record.wake || unread.length === 0) return harden({ wake });
    refuseUnless(
      queuedMail === 'process' || queuedMail === 'skip',
      'wake-confirmation-required',
    );
    // The cursor must name queued mail the owner was shown; a cursor beyond it
    // would silently skip mail that has not arrived yet.
    refuseUnless(
      MESSAGE_NUMBER_PATTERN.test(confirmedCursor) &&
        unread.some(({ number }) => number === confirmedCursor),
      'wake-confirmation-required',
    );
    return harden({
      wake,
      queuedMail,
      confirmedCursor,
      ...(queuedMail === 'skip' ? { mailCursor: confirmedCursor } : {}),
    });
  };

  /**
   * Run a non-creating operation on an existing agent. A retry finds its record
   * by idempotency key before any freshness check, so a request that succeeded
   * still answers after the state it depended on has moved on.
   *
   * @param {string} ownerId
   * @param {string} agentId
   * @param {any} request
   * @param {string} kind
   * @param {() => Promise<any>} prepare
   * @param {boolean} [requireLive]
   */
  const runAgentOperation = async (
    ownerId,
    agentId,
    request,
    kind,
    prepare,
    requireLive = true,
  ) => {
    const { idempotencyKey, ...asked } = request || {};
    refuseUnless(
      IDENTIFIER_PATTERN.test(idempotencyKey),
      'invalid-idempotency-key',
    );
    const key = ownerScopedKey(ownerId, idempotencyKey);
    // Preparing may wait on the upstream or the guest, so it stays outside the
    // queue. A retry skips it because the operation already holds the decision.
    const prepared =
      state.operations[key] === undefined ? await prepare() : undefined;
    return inOrder(async () => {
      const existing = state.operations[key];
      if (existing === undefined) {
        if (requireLive) requireLiveAgent(ownerId, agentId);
        else requireOwnedAgent(ownerId, agentId);
        await writeIntent(ownerId, idempotencyKey, kind, prepared, agentId, {
          asked,
        });
      } else {
        refuseUnless(
          existing.kind === kind &&
            existing.agentId === agentId &&
            sameData(existing.asked, asked),
          'idempotency-conflict',
        );
      }
      const finished = await runOperation(key);
      throwIfAborted(finished);
      return summarize(agentId);
    });
  };

  /**
   * @param {string} ownerId
   * @param {string} agentId
   * @param {any} request
   */
  const reattachAgent = (ownerId, agentId, request) => {
    const { providerId, model } = request || {};
    return runAgentOperation(
      ownerId,
      agentId,
      request,
      'reattach',
      async () => {
        const record = requireLiveAgent(ownerId, agentId);
        refuseUnless(IDENTIFIER_PATTERN.test(providerId), 'provider-not-found');
        const target = await requireActiveProvider(ownerId, providerId).catch(
          error => {
            // A retired target is simply not available to this owner.
            if (fixedCodeOf(error) === 'provider-retired') {
              throw fixedError('provider-not-found');
            }
            throw error;
          },
        );
        const harness = AGENT_HARNESS_CATALOG.find(
          ({ id }) => id === record.harness,
        );
        refuseUnless(
          harness !== undefined &&
            harness.providerKinds.includes(target.provider.kind),
          'provider-kind-unsupported',
        );
        const targetModel = model ?? record.model;
        refuseUnless(MODEL_PATTERN.test(targetModel), 'invalid-model');
        await assertModelOffered(target.directory, providerId, targetModel);
        return harden({ providerId, model: targetModel });
      },
    );
  };

  /**
   * @param {string} ownerId
   * @param {string} agentId
   */
  const reattachOptions = async (ownerId, agentId) => {
    const record = requireLiveAgent(ownerId, agentId);
    const directory = await E(registry).directoryFor(ownerId);
    const providers = await E(directory).list();
    const harness = AGENT_HARNESS_CATALOG.find(
      ({ id }) => id === record.harness,
    );
    const eligible = providers.filter(
      provider =>
        provider.state === 'active' &&
        provider.providerId !== record.providerId &&
        harness?.providerKinds.includes(provider.kind),
    );
    return harden(
      await Promise.all(
        eligible.map(async provider => {
          const admin = await E(directory).adminFor(provider.providerId);
          const catalog = await E(admin).discoverModels();
          const lowered = Object.entries(record.limits)
            .filter(
              ([name, value]) =>
                provider.limits[name] !== undefined &&
                Number(provider.limits[name]) < Number(value),
            )
            .map(([name, value]) =>
              harden({ name, from: value, to: provider.limits[name] }),
            );
          return harden({
            providerId: provider.providerId,
            displayName: provider.displayName,
            defaultModel: provider.defaultModel,
            catalogState: catalog.catalogState,
            models: catalog.models,
            effectiveLimits: harden({
              ...record.limits,
              ...Object.fromEntries(lowered.map(row => [row.name, row.to])),
            }),
            lowered: harden(lowered),
          });
        }),
      ),
    );
  };

  /** @param {string} ownerId */
  const directoryFor = ownerId => {
    refuseUnless(IDENTIFIER_PATTERN.test(ownerId), 'invalid-owner');
    let directory = directories.get(ownerId);
    if (directory !== undefined) return directory;
    directory = makeExo('AgentDirectory', AgentDirectoryInterface, {
      getCatalog: async () =>
        harden({
          harnesses: AGENT_HARNESS_CATALOG,
          subagentCreation: spawners !== undefined,
        }),
      list: async () => {
        const live = Object.values(state.agents).filter(
          record => record.ownerId === ownerId && record.lifecycle === 'active',
        );
        const creating = Object.values(state.operations)
          .filter(
            operation =>
              operation.ownerId === ownerId &&
              operation.kind === 'create' &&
              state.agents[operation.agentId] === undefined &&
              operation.state !== 'aborted',
          )
          .map(operation =>
            harden({
              agentId: operation.agentId,
              name: operation.request.name,
              providerId: operation.request.providerId,
              harness: operation.request.harness,
              model: operation.request.model,
              status: operation.state === 'aborting' ? 'aborting' : 'creating',
              lifecycle: 'creating',
            }),
          );
        return harden([
          ...creating,
          ...(await Promise.all(live.map(({ agentId }) => summarize(agentId)))),
        ]);
      },
      get: async agentId => {
        requireLiveAgent(ownerId, agentId);
        return summarize(agentId);
      },
      create: request => createAgent(ownerId, request),
      setWake: (agentId, request) =>
        runAgentOperation(ownerId, agentId, request, 'set-wake', () =>
          safeWakeRequest(requireLiveAgent(ownerId, agentId), request),
        ),
      setLimits: (agentId, request) =>
        runAgentOperation(ownerId, agentId, request, 'set-limits', async () => {
          requireLiveAgent(ownerId, agentId);
          try {
            validateInferenceLimits(request.limits, DEFAULT_AGENT_LIMITS);
          } catch (_error) {
            throw fixedError('invalid-agent-limits');
          }
          return harden({
            limits: harden({ ...request.limits }),
            confirmed: request.confirmed === true,
          });
        }),
      reattachOptions: agentId => reattachOptions(ownerId, agentId),
      reattach: (agentId, request) => reattachAgent(ownerId, agentId, request),
      dismissMail: async (agentId, number) => {
        const record = requireLiveAgent(ownerId, agentId);
        refuseUnless(MESSAGE_NUMBER_PATTERN.test(number), 'invalid-request');
        await E(guests).dismissMail(record.names.guest, number);
        return summarize(agentId);
      },
      delete: (agentId, request) =>
        runAgentOperation(
          ownerId,
          agentId,
          request,
          'delete',
          async () => {
            requireOwnedAgent(ownerId, agentId);
            return harden({});
          },
          false,
        ),
      getOperationStatus: async idempotencyKey => {
        await null;
        const operation =
          state.operations[ownerScopedKey(ownerId, idempotencyKey)];
        if (operation === undefined) {
          return harden({ idempotencyKey, status: 'not-found' });
        }
        return harden({
          idempotencyKey,
          kind: operation.kind,
          agentId: operation.agentId,
          state: operation.state,
          status: operation.state,
          ...(operation.refusal === undefined
            ? {}
            : { refusal: operation.refusal }),
        });
      },
    });
    directories.set(ownerId, directory);
    return directory;
  };

  /**
   * The inference an agent's driver holds. It follows the record's current
   * grant, so a reattachment moves new turns without replacing the driver's
   * reference, and a deleted agent fails every call.
   *
   * @param {string} agentId
   */
  const inferenceFor = agentId => {
    let inference = inferences.get(agentId);
    if (inference !== undefined) return inference;
    const current = () => {
      const record = state.agents[agentId];
      refuseUnless(
        record !== undefined && record.lifecycle === 'active',
        'agent-deleted',
      );
      return E(registry).inferenceFor(record.grantId);
    };
    inference = makeExo('AgentInference', AgentInferenceInterface, {
      request: message => E(current()).request(message),
      requestByteStream: message => E(current()).requestByteStream(message),
      attestation: () => E(current()).attestation(),
    });
    inferences.set(agentId, inference);
    return inference;
  };

  /**
   * Exactly what the agent's driver receives. The slot holds a spawner only when
   * the creation request named one; nothing here adds a default.
   *
   * @param {string} agentId
   */
  const endowmentFor = async agentId => {
    const record = state.agents[agentId];
    refuseUnless(
      record !== undefined && record.lifecycle === 'active',
      'agent-not-found',
    );
    const guest = await E(guests).guestFor(record.names.guest);
    return harden({
      powers: makeAgentGuestPowers(guest, record.harness),
      inference: inferenceFor(agentId),
      model: record.model,
      harnessConfig: harden({ provider: 'brokered-messages' }),
      ...(record.subagentCreation
        ? {
            subagentCreation: await E(spawners).provide(
              harden({
                agentId,
                ownerId: record.ownerId,
                grantId: record.grantId,
              }),
            ),
          }
        : {}),
    });
  };

  /**
   * Revoke grants left by aborted operations and deleted agents, and any whose
   * owner differs from its agent's binding. It never creates or repairs one.
   */
  const reconcileGrants = async () => {
    const grants = await E(registry).listGrants();
    const liveOperationAgents = new Set(
      Object.values(state.operations)
        .filter(
          operation =>
            operation.kind === 'create' &&
            operation.state !== 'completed' &&
            operation.state !== 'aborted' &&
            operation.state !== 'aborting',
        )
        .map(operation => operation.agentId),
    );
    const aborted = new Set(
      Object.values(state.operations)
        .filter(
          operation =>
            operation.kind === 'create' && operation.state === 'aborted',
        )
        .map(operation => operation.agentId),
    );
    const revoked = [];
    const reports = [];
    for (const grant of grants) {
      if (grant.state !== 'revoked') {
        const record = state.agents[grant.agentId];
        const mismatch =
          record !== undefined &&
          (grant.ownerId !== record.ownerId ||
            grant.providerOwnerId !== record.ownerId);
        const residue =
          aborted.has(grant.agentId) ||
          record?.lifecycle === 'deleted' ||
          (grant.state === 'reattached' &&
            !Object.values(state.operations).some(
              operation =>
                operation.priorGrantId === grant.grantId &&
                operation.state !== 'completed',
            ));
        if (mismatch || (residue && !liveOperationAgents.has(grant.agentId))) {
          // eslint-disable-next-line no-await-in-loop
          await E(registry).revokeGrant(grant.grantId);
          revoked.push(grant.grantId);
          if (mismatch) {
            reports.push(
              harden({
                code: 'provider-owner-mismatch',
                agentId: grant.agentId,
                grantId: grant.grantId,
                reportedAt: now(),
              }),
            );
          }
        }
      }
    }
    if (reports.length > 0) {
      const next = copyState(state);
      next.reports.push(...reports);
      await commit(next);
    }
    return revoked;
  };

  /**
   * Resume every unfinished operation, reapply each active agent's desired wake
   * state, and clear grant residue. One participant's failure is left for the
   * next pass rather than blocking the rest.
   */
  const reconcile = () =>
    inOrder(async () => {
      const failures = [];
      for (const key of Object.keys(state.operations)) {
        const { state: operationState } = state.operations[key];
        if (operationState !== 'completed' && operationState !== 'aborted') {
          try {
            // eslint-disable-next-line no-await-in-loop
            await runOperation(key);
          } catch (error) {
            failures.push(harden({ key, error: String(error) }));
          }
        }
      }
      for (const record of Object.values(state.agents)) {
        if (record.lifecycle === 'active') {
          try {
            // eslint-disable-next-line no-await-in-loop
            await applyWake(record.agentId);
          } catch (error) {
            failures.push(
              harden({ agentId: record.agentId, error: String(error) }),
            );
          }
        }
      }
      const revoked = await reconcileGrants();
      return harden({ failures, revoked });
    });

  return harden({
    directoryFor,
    /**
     * @param {string} ownerId
     * @param {AgentCreateRequest} request
     * @param {ProviderUseOwner} use
     */
    createWithUse: async (ownerId, request, use) => {
      await assertUseMatchesOwner(ownerId, use);
      return createAgent(ownerId, request);
    },
    /**
     * @param {string} ownerId
     * @param {string} agentId
     * @param {AgentReattachRequest} request
     * @param {ProviderUseOwner} use
     */
    reattachWithUse: async (ownerId, agentId, request, use) => {
      await assertUseMatchesOwner(ownerId, use);
      return reattachAgent(ownerId, agentId, request);
    },
    endowmentFor,
    inferenceFor,
    reconcile,
    inspect: () => state,
  });
};
harden(makeAgentFactory);
