// @ts-check

/* eslint-disable no-await-in-loop */

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { Fail, q, makeError } from '@endo/errors';

import {
  AgentLifecycleInterface,
  BoundChildAgentFactoryInterface,
  ChildAgentFactoryInterface,
} from './interfaces.js';
import {
  assertCreateAdmitted,
  assertOrdinaryName,
  intersectPolicy,
  makeRootPolicy,
} from './policy.js';

/**
 * @import { ChildAgentPolicy, EffectivePolicy, PrivateHost, RootPolicy } from './types.js'
 */

/**
 * @typedef {'Intended' | 'GuestCreated' | 'Endowed' | 'DriverCreated' |
 *   'Pinned' | 'Committed' | 'Removing' | 'Removed'} ChildPhase
 */

/**
 * Pet name under which the driver guest holds its child's lifecycle facet. A
 * revived runner resolves it from its powers and checks `isActive` before it
 * opens its message follower.
 */
export const LIFECYCLE_NAME = 'agent-lifecycle';
harden(LIFECYCLE_NAME);

const ROOT = 0;

/**
 * Phases in which a child still holds its name and a quota slot but is not
 * yet visible as committed.
 *
 * @type {ChildPhase[]}
 */
const creationPhases = harden([
  'Intended',
  'GuestCreated',
  'Endowed',
  'DriverCreated',
  'Pinned',
]);

/**
 * Phases in which the driver guest holds a lifecycle facet a revived runner
 * may resolve.
 *
 * @type {ChildPhase[]}
 */
const lifecyclePhases = harden(['DriverCreated', 'Pinned', 'Committed']);

/**
 * Errors raised when a derived name holds a value that does not fit its
 * phase. Only a coordinator defect can produce one, so reconciliation fails
 * closed on it instead of cleaning up.
 *
 * @type {WeakSet<Error>}
 */
const faultErrors = new WeakSet();

/** @param {string} message */
const makeFault = message => {
  const error = makeError(message);
  faultErrors.add(error);
  return error;
};

/** @param {unknown} error */
const isFault = error =>
  typeof error === 'object' &&
  error !== null &&
  faultErrors.has(/** @type {Error} */ (error));

const registryName = (/** @type {number} */ namespaceId) => `ns${namespaceId}`;
const makerName = (/** @type {number} */ namespaceId) => `maker${namespaceId}`;
const journalName = (
  /** @type {number} */ namespaceId,
  /** @type {number} */ sequence,
) => `j${namespaceId}.${sequence}`;
const childName = (
  /** @type {string} */ operationKey,
  /** @type {string} */ piece,
) => `c${operationKey}.${piece}`;

/**
 * @typedef {object} Operation
 * @property {string} key - `<namespace>.<sequence>`, the durable operation id.
 * @property {number} namespaceId
 * @property {string} name - The user-visible child name.
 * @property {ChildPhase} phase
 * @property {string} instructions
 * @property {string[]} endowmentNames
 * @property {number} createdAt
 * @property {string} [fault] - Set when reconciliation failed closed.
 * @property {Promise<void>} [removal] - An in-flight removal to join.
 * @property {Set<() => void>} watchers
 */

/**
 * @typedef {object} Namespace
 * @property {number} id
 * @property {number | undefined} parent
 * @property {string | undefined} name - Its name in the parent's derived index.
 * @property {EffectivePolicy} policy
 * @property {number | undefined} makerNamespaceId - Namespace whose `maker<n>` record
 *   holds this namespace's maker.
 * @property {'Active' | 'Revoking' | 'Revoked'} phase
 * @property {number} nextSequence
 * @property {Map<string, Operation>} children
 * @property {Map<string, number>} derived
 * @property {Promise<void>} [revocation]
 */

/**
 * Create, or revive, the factory coordinator over its private host.
 *
 * The coordinator keeps an append-only journal per namespace in its private
 * directory, rebuilds all state from it, and reconciles every nonterminal
 * record before it answers a facet call. The returned root facet is the
 * deploying host's `ChildAgentFactory`.
 *
 * @param {object} options
 * @param {PrivateHost} options.host
 * @param {RootPolicy} options.rootPolicy
 * @param {() => number} [options.now]
 */
export const prepareChildAgentCoordinator = async ({
  host,
  rootPolicy,
  now = () => Date.now(),
}) => {
  /** @type {Map<number, Namespace>} */
  const namespaces = new Map();
  /** @type {Map<string, Operation>} */
  const operations = new Map();
  let nextNamespaceId = 0;

  // One queue serializes every mutation. Nested quota spans namespaces, so a
  // per-namespace queue would let two siblings race for an ancestor's last slot.
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /**
   * @template T
   * @param {() => Promise<T>} thunk
   * @returns {Promise<T>}
   */
  const serial = thunk => {
    const result = queue.then(thunk);
    queue = result.catch(() => {});
    return result;
  };

  /**
   * @param {Namespace} namespace
   * @param {Record<string, any>} entry
   */
  const append = async (namespace, entry) => {
    const sequence = namespace.nextSequence;
    await E(host).storeValue(
      harden(entry),
      journalName(namespace.id, sequence),
    );
    namespace.nextSequence = sequence + 1;
    return sequence;
  };

  /**
   * @param {Operation} operation
   * @param {ChildPhase} phase
   * @param {Record<string, any>} [extra]
   */
  const advanceTo = async (operation, phase, extra = {}) => {
    const namespace =
      namespaces.get(operation.namespaceId) || Fail`Unknown namespace`;
    await append(namespace, {
      type: phase,
      operation: operation.key,
      ...extra,
    });
    operation.phase = phase;
    for (const watcher of operation.watchers) watcher();
  };

  /** @param {number} namespaceId */
  const isLive = namespaceId => {
    /** @type {number | undefined} */
    let id = namespaceId;
    while (id !== undefined) {
      const namespace = namespaces.get(id);
      if (!namespace || namespace.phase !== 'Active') return false;
      id = namespace.parent;
    }
    return true;
  };

  /** @param {number} namespaceId */
  const assertLive = namespaceId => {
    isLive(namespaceId) || Fail`This child-agent factory has been revoked`;
  };

  /**
   * Count retained (non-`Removed`) children at or below each namespace.
   *
   * @returns {Map<number, number>}
   */
  const retainedCounts = () => {
    /** @type {Map<number, number>} */
    const counts = new Map();
    for (const operation of operations.values()) {
      if (operation.phase !== 'Removed') {
        /** @type {number | undefined} */
        let id = operation.namespaceId;
        while (id !== undefined) {
          counts.set(id, (counts.get(id) || 0) + 1);
          id = namespaces.get(id)?.parent;
        }
      }
    }
    return counts;
  };

  // ------------------------------------------------------------------
  // Lifecycle facets

  /** @type {Map<string, any>} */
  const lifecycles = new Map();

  /** @param {Operation} operation */
  const isActive = operation =>
    operation.phase === 'Committed' && isLive(operation.namespaceId);

  /** @param {Operation} operation */
  const lifecycleFor = operation => {
    let lifecycle = lifecycles.get(operation.key);
    if (!lifecycle) {
      lifecycle = makeExo(
        `AgentLifecycle ${operation.key}`,
        AgentLifecycleInterface,
        {
          isActive() {
            return isActive(operation);
          },
          followActive() {
            /** @type {boolean | undefined} */
            let reported;
            return makeExo(
              'ActiveIterator',
              M.interface('ActiveIterator', {
                next: M.callWhen().returns(M.record()),
              }),
              {
                async next() {
                  await null;
                  while (
                    reported === isActive(operation) &&
                    operation.phase !== 'Removed'
                  ) {
                    await new Promise(resolve => {
                      const wake = () => {
                        operation.watchers.delete(wake);
                        resolve(undefined);
                      };
                      operation.watchers.add(wake);
                    });
                  }
                  if (reported === isActive(operation)) {
                    return harden({ done: true, value: undefined });
                  }
                  reported = isActive(operation);
                  return harden({ done: false, value: reported });
                },
              },
            );
          },
        },
      );
      lifecycles.set(operation.key, lifecycle);
    }
    return lifecycle;
  };

  // ------------------------------------------------------------------
  // Creation: one precheck-and-proof step per phase

  /**
   * Adopt the value at a derived name only after proving its formula type, or
   * report that it is unbound.
   *
   * @param {string} name
   * @param {string} expectedType
   * @param {string} [expectedPowers]
   * @returns {Promise<boolean>} whether the name was already bound
   */
  const proveOrAbsent = async (name, expectedType, expectedPowers) => {
    await null;
    if (!(await E(host).has(name))) return false;
    const type = await E(host).formulaType(name);
    if (!(type === expectedType)) {
      throw makeFault(
        `Derived name ${q(name)} holds a ${q(type)}, expected ${q(expectedType)}`,
      );
    }
    if (expectedPowers !== undefined) {
      const powers = await E(host).powersOf(name);
      if (!(powers === expectedPowers)) {
        throw makeFault(
          `Derived name ${q(name)} was formulated with other powers`,
        );
      }
    }
    return true;
  };

  /** @param {string} name */
  const provideProvedGuest = async name => {
    await null;
    if (!(await proveOrAbsent(name, 'guest'))) {
      await E(host).provideGuest(name);
    }
    return E(host).identify(name);
  };

  /** @param {Operation} operation */
  const installEndowments = async operation => {
    await null;
    const guestName = childName(operation.key, 'guest');
    for (let i = 0; i < operation.endowmentNames.length; i += 1) {
      const endowmentName = operation.endowmentNames[i];
      const retainedName = childName(operation.key, `e${i}`);
      const retainedId = await E(host).identify(retainedName);
      if (await E(host).has(guestName, endowmentName)) {
        const boundId = await E(host).identify(guestName, endowmentName);
        if (!(boundId === retainedId)) {
          throw makeFault(
            `Child already binds endowment ${q(endowmentName)} to another value`,
          );
        }
      } else {
        const value = await E(host).lookup(retainedName);
        await E(host).storeValue(value, [guestName, endowmentName]);
      }
    }
    const names = await E(host).list(guestName);
    const ordinary = names.filter(name => !name.startsWith('@')).sort();
    const expected = [...operation.endowmentNames].sort();
    const exact =
      ordinary.length === expected.length &&
      ordinary.every((name, i) => name === expected[i]);
    if (!exact) {
      throw makeFault(
        `Child directory holds ${q(ordinary)}, expected exactly ${q(expected)}`,
      );
    }
  };

  /**
   * Bind this incarnation's lifecycle facet in the driver guest. A facet a
   * prior incarnation stored closes over state that no recovered coordinator
   * updates, so a revived runner resolving it would never observe removal or
   * revocation. Recovery therefore replaces it rather than adopting it.
   *
   * @param {Operation} operation
   */
  const bindLifecycle = async operation => {
    await null;
    const driverName = childName(operation.key, 'driver');
    if (await E(host).has(driverName, LIFECYCLE_NAME)) {
      await E(host).remove(driverName, LIFECYCLE_NAME);
    }
    await E(host).storeValue(lifecycleFor(operation), [
      driverName,
      LIFECYCLE_NAME,
    ]);
  };

  /** @param {Operation} operation */
  const makerFor = async operation => {
    const namespace =
      namespaces.get(operation.namespaceId) || Fail`Unknown namespace`;
    if (namespace.makerNamespaceId === undefined)
      throw Fail`Namespace has no maker`;
    return E(host).lookup(makerName(namespace.makerNamespaceId));
  };

  /**
   * Drive one operation from its current creation phase to `Committed`.
   *
   * @param {Operation} operation
   */
  const rollForward = async operation => {
    await null;
    const guestName = childName(operation.key, 'guest');
    const driverName = childName(operation.key, 'driver');
    const responderName = childName(operation.key, 'responder');
    if (operation.phase === 'Intended') {
      const formulaId = await provideProvedGuest(guestName);
      await advanceTo(operation, 'GuestCreated', { formulaId });
    }
    if (operation.phase === 'GuestCreated') {
      await installEndowments(operation);
      await advanceTo(operation, 'Endowed');
    }
    if (operation.phase === 'Endowed') {
      const formulaId = await provideProvedGuest(driverName);
      await bindLifecycle(operation);
      await advanceTo(operation, 'DriverCreated', { formulaId });
    }
    if (operation.phase === 'DriverCreated') {
      const driverId = await E(host).identify(driverName);
      if (!(await proveOrAbsent(responderName, 'unconfined', driverId))) {
        const maker = await makerFor(operation);
        const { responder } = await E(maker).installDriver(
          harden({
            agent: await E(host).lookup(guestName),
            driverGuest: await E(host).lookup(driverName),
            lifecycle: lifecycleFor(operation),
            ...(operation.instructions
              ? { instructions: operation.instructions }
              : {}),
          }),
        );
        await E(host).storeValue(responder, responderName);
        // The maker is outside the coordinator, so its responder gets the
        // same proof an adopted one does before anything commits or starts
        // it. A mismatch here is the maker's defect, not a coordinator one:
        // cancel the responder and let the caller roll the child back.
        try {
          await proveOrAbsent(responderName, 'unconfined', driverId);
        } catch (error) {
          if (!isFault(error)) throw error;
          await E(host).cancel(responderName);
          throw makeError(
            `Maker returned a responder that is not an unconfined caplet over its driver guest: ${
              /** @type {Error} */ (error).message
            }`,
          );
        }
      }
      const formulaId = await E(host).identify(responderName);
      await advanceTo(operation, 'Pinned', { formulaId });
    }
    if (operation.phase === 'Pinned') {
      await advanceTo(operation, 'Committed');
    }
  };

  /** @param {Operation} operation */
  const startRunner = async operation => {
    await E(host).lookup(childName(operation.key, 'responder'));
  };

  // ------------------------------------------------------------------
  // Removal

  /**
   * @param {Operation} operation
   */
  const runRemoval = async operation => {
    await null;
    operation.fault === undefined ||
      Fail`Child ${q(operation.name)} is reserved by a fault and cannot be removed: ${q(operation.fault)}`;
    if (operation.phase !== 'Removing') {
      await advanceTo(operation, 'Removing');
    }
    const responderName = childName(operation.key, 'responder');
    const driverName = childName(operation.key, 'driver');
    const guestName = childName(operation.key, 'guest');
    // The responder goes first so no later restart can revive the runner.
    if (await E(host).has(responderName)) {
      await E(host).remove(responderName);
    }
    // Cancelling the driver's powers tears down the dependent runner.
    for (const name of [driverName, guestName]) {
      if (await E(host).has(name)) {
        await E(host).cancel(name);
        await E(host).remove(name);
      }
    }
    for (let i = 0; i < operation.endowmentNames.length; i += 1) {
      const retainedName = childName(operation.key, `e${i}`);
      if (await E(host).has(retainedName)) {
        await E(host).remove(retainedName);
      }
    }
    await advanceTo(operation, 'Removed');
    const namespace = namespaces.get(operation.namespaceId);
    if (namespace && namespace.children.get(operation.name) === operation)
      namespace.children.delete(operation.name);
    lifecycles.delete(operation.key);
  };

  /** @param {Operation} operation */
  const removeJoining = operation => {
    if (!operation.removal) {
      operation.removal = runRemoval(operation).finally(() => {
        operation.removal = undefined;
      });
    }
    return operation.removal;
  };

  /** @param {number} namespaceId */
  const revoke = async namespaceId => {
    await null;
    const namespace = namespaces.get(namespaceId) || Fail`Unknown namespace`;
    if (namespace.phase === 'Active') {
      await append(namespace, { type: 'Revoking' });
      namespace.phase = 'Revoking';
      for (const operation of namespace.children.values()) {
        for (const watcher of operation.watchers) watcher();
      }
    }
    for (const childNamespaceId of [...namespace.derived.values()]) {
      const derivedNamespace = namespaces.get(childNamespaceId);
      if (derivedNamespace && derivedNamespace.phase !== 'Revoked') {
        await revoke(childNamespaceId);
      }
    }
    for (const operation of [...namespace.children.values()]) {
      await removeJoining(operation);
    }
    await append(namespace, { type: 'Revoked' });
    namespace.phase = 'Revoked';
    const parent =
      namespace.parent === undefined
        ? undefined
        : namespaces.get(namespace.parent);
    if (parent && namespace.name !== undefined)
      parent.derived.delete(namespace.name);
  };

  /** @param {number} namespaceId */
  const revokeJoining = namespaceId => {
    const namespace = namespaces.get(namespaceId) || Fail`Unknown namespace`;
    if (!namespace.revocation) {
      namespace.revocation = revoke(namespaceId).finally(() => {
        namespace.revocation = undefined;
      });
    }
    return namespace.revocation;
  };

  // ------------------------------------------------------------------
  // Replay

  /**
   * @param {number} id
   * @param {number | undefined} parent
   * @param {string | undefined} name
   * @param {EffectivePolicy} policy
   * @param {number | undefined} makerNamespaceId
   * @returns {Namespace}
   */
  const addNamespace = (id, parent, name, policy, makerNamespaceId) => {
    /** @type {Namespace} */
    const namespace = {
      id,
      parent,
      name,
      policy,
      makerNamespaceId,
      phase: 'Active',
      nextSequence: 0,
      children: new Map(),
      derived: new Map(),
    };
    namespaces.set(id, namespace);
    if (parent !== undefined && name !== undefined) {
      const parentNamespace = namespaces.get(parent) || Fail`Unknown namespace`;
      parentNamespace.derived.set(name, id);
    }
    return namespace;
  };

  /**
   * @param {Namespace} namespace
   * @param {Record<string, any>} entry
   */
  const applyEntry = (namespace, entry) => {
    const { type } = entry;
    if (type === 'Derived') {
      // The derived namespace's own journal is replayed after this one, and a
      // namespace without its parent's `Derived` entry is an unreachable
      // orphan of a crash between allocation and that entry.
      addNamespace(
        entry.child,
        namespace.id,
        entry.name,
        entry.policy,
        entry.makerNamespaceId,
      );
    } else if (type === 'Revoking' || type === 'Revoked') {
      namespace.phase = type;
      if (type === 'Revoked' && namespace.parent !== undefined) {
        namespaces
          .get(namespace.parent)
          ?.derived.delete(/** @type {string} */ (namespace.name));
      }
    } else if (type === 'Intended') {
      /** @type {Operation} */
      const operation = {
        key: entry.operation,
        namespaceId: namespace.id,
        name: entry.name,
        phase: 'Intended',
        instructions: entry.instructions,
        endowmentNames: entry.endowmentNames,
        createdAt: entry.createdAt,
        watchers: new Set(),
      };
      operations.set(operation.key, operation);
      namespace.children.set(operation.name, operation);
    } else {
      const operation =
        operations.get(entry.operation) ||
        Fail`Journal names unknown operation`;
      operation.phase = type;
      if (type === 'Removed') {
        namespace.children.delete(operation.name);
      }
    }
  };

  const replay = async () => {
    await null;
    const names = new Set(await E(host).list());
    while (names.has(registryName(nextNamespaceId))) nextNamespaceId += 1;
    if (!names.has(registryName(ROOT))) {
      const policy = makeRootPolicy(rootPolicy);
      await E(host).storeValue(harden({ policy }), registryName(ROOT));
      nextNamespaceId = Math.max(nextNamespaceId, 1);
      addNamespace(ROOT, undefined, undefined, policy, undefined);
      return;
    }
    const { policy } = await E(host).lookup(registryName(ROOT));
    addNamespace(ROOT, undefined, undefined, policy, undefined);
    // Breadth-first over the derivation tree: a parent's journal introduces
    // each child namespace before the child's own journal is read.
    const pending = [ROOT];
    while (pending.length > 0) {
      const namespaceId = /** @type {number} */ (pending.shift());
      const namespace = /** @type {Namespace} */ (namespaces.get(namespaceId));
      while (names.has(journalName(namespaceId, namespace.nextSequence))) {
        const entry = await E(host).lookup(
          journalName(namespaceId, namespace.nextSequence),
        );
        applyEntry(namespace, entry);
        namespace.nextSequence += 1;
        if (entry.type === 'Derived') pending.push(entry.child);
      }
    }
  };

  /** @type {Map<string, string>} */
  const faults = new Map();

  /**
   * Converge one nonterminal operation. Before `Committed` it rolls forward;
   * an effect that cannot complete is cleaned up by removal. A derived name
   * holding the wrong formula type fails closed: the record stays reserved
   * and nothing is deleted or overwritten.
   *
   * @param {Operation} operation
   */
  const converge = async operation => {
    await null;
    try {
      if (operation.phase === 'Removing') {
        await removeJoining(operation);
      } else if (creationPhases.includes(operation.phase)) {
        if (!isLive(operation.namespaceId)) {
          await removeJoining(operation);
          return;
        }
        try {
          await rollForward(operation);
        } catch (error) {
          if (isFault(error)) throw error;
          await removeJoining(operation);
          throw error;
        }
      }
    } catch (error) {
      if (isFault(error)) {
        operation.fault = /** @type {Error} */ (error).message;
        faults.set(operation.key, operation.fault);
      }
      throw error;
    }
  };

  const reconcile = async () => {
    await null;
    for (const namespace of [...namespaces.values()]) {
      if (namespace.phase === 'Revoking') {
        await revokeJoining(namespace.id);
      }
    }
    for (const operation of [...operations.values()]) {
      if (lifecyclePhases.includes(operation.phase)) {
        await bindLifecycle(operation);
      }
    }
    for (const operation of [...operations.values()]) {
      if (operation.phase !== 'Committed' && operation.phase !== 'Removed') {
        await converge(operation).catch(error => {
          // A fault stays reserved and is reported by `faults()`, and any
          // other creation failure was cleaned up by removal. A failure that
          // left the operation short of `Removed` is unexpected, so the
          // coordinator refuses to answer facet calls over it.
          if (!isFault(error) && operation.phase !== 'Removed') throw error;
        });
      }
    }
    for (const operation of operations.values()) {
      if (isActive(operation)) {
        await startRunner(operation);
      }
    }
  };

  // ------------------------------------------------------------------
  // Facets

  /** @param {Operation} operation */
  const summarize = operation =>
    harden({
      name: operation.name,
      phase: operation.phase,
      createdAt: operation.createdAt,
      operationId: operation.key,
    });

  /** @param {Namespace} namespace */
  const listDerivedOf = namespace => {
    const counts = retainedCounts();
    return harden(
      [...namespace.derived.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, id]) => {
          const derived = /** @type {Namespace} */ (namespaces.get(id));
          return {
            name,
            phase: derived.phase,
            retainedChildren: counts.get(id) || 0,
          };
        }),
    );
  };

  /**
   * @param {Namespace} namespace
   * @param {string} name
   */
  const revokeDerivedOf = (namespace, name) => {
    const id = namespace.derived.get(name);
    id !== undefined || Fail`No derived namespace named ${q(name)}`;
    return revokeJoining(/** @type {number} */ (id));
  };

  /**
   * Allocate a namespace derived from `issuer`.
   *
   * @param {Namespace} issuer
   * @param {string} name
   * @param {EffectivePolicy} policy
   * @param {number} makerNamespaceId
   * @param {any} [maker] - Present only for `bind`, which records a new maker.
   */
  const derive = async (issuer, name, policy, makerNamespaceId, maker) => {
    const id = nextNamespaceId;
    // The registry entry reserves the id; a crash before the issuer's
    // `Derived` entry leaves an unreachable orphan, never a reachable one.
    await E(host).storeValue(harden({ parent: issuer.id }), registryName(id));
    nextNamespaceId = id + 1;
    if (maker !== undefined) {
      await E(host).storeValue(maker, makerName(id));
    }
    await append(issuer, {
      type: 'Derived',
      name,
      child: id,
      policy,
      makerNamespaceId,
    });
    return addNamespace(id, issuer.id, name, policy, makerNamespaceId);
  };

  /** @type {Map<number, any>} */
  const boundFacets = new Map();

  /** @param {number} namespaceId */
  const boundFacetFor = namespaceId => {
    let facet = boundFacets.get(namespaceId);
    if (facet) return facet;
    const namespace = /** @type {Namespace} */ (namespaces.get(namespaceId));
    facet = makeExo('BoundChildAgentFactory', BoundChildAgentFactoryInterface, {
      create(name, { instructions = '', endowments = {} } = {}) {
        return serial(async () => {
          await null;
          assertLive(namespaceId);
          assertOrdinaryName(name, 'child name');
          const existing = namespace.children.get(name);
          !existing ||
            Fail`Child ${q(name)} already exists in phase ${q(existing.phase)}`;
          const endowmentNames = Object.keys(endowments).sort();
          assertCreateAdmitted(namespace.policy, instructions, endowmentNames);
          const counts = retainedCounts();
          /** @type {number | undefined} */
          let id = namespaceId;
          while (id !== undefined) {
            const each = /** @type {Namespace} */ (namespaces.get(id));
            (counts.get(id) || 0) < each.policy.maxChildren ||
              Fail`Child quota exhausted`;
            id = each.parent;
          }

          const key = `${namespaceId}.${namespace.nextSequence}`;
          // Retain the endowment values before the operation starts, so
          // recovery never depends on the caller's arguments. A stale value
          // here belongs to an `Intended` entry a crash never appended.
          for (let i = 0; i < endowmentNames.length; i += 1) {
            const retainedName = childName(key, `e${i}`);
            if (await E(host).has(retainedName)) {
              await E(host).remove(retainedName);
            }
            await E(host).storeValue(
              endowments[endowmentNames[i]],
              retainedName,
            );
          }
          const createdAt = now();
          const sequence = await append(namespace, {
            type: 'Intended',
            operation: key,
            name,
            instructions,
            endowmentNames,
            createdAt,
          });
          `${namespaceId}.${sequence}` === key || Fail`Journal sequence moved`;
          /** @type {Operation} */
          const operation = {
            key,
            namespaceId,
            name,
            phase: 'Intended',
            instructions,
            endowmentNames,
            createdAt,
            watchers: new Set(),
          };
          operations.set(key, operation);
          namespace.children.set(name, operation);

          await converge(operation);
          await startRunner(operation);
          const handle = await E(host).lookup(childName(key, 'guest'), '@self');
          return harden({ summary: summarize(operation), handle });
        });
      },
      async lookup(name) {
        await null;
        assertLive(namespaceId);
        const operation = namespace.children.get(name);
        if (!operation || operation.phase !== 'Committed') {
          throw Fail`No committed child named ${q(name)}`;
        }
        return E(host).lookup(childName(operation.key, 'guest'), '@self');
      },
      async list() {
        await null;
        assertLive(namespaceId);
        return harden(
          [...namespace.children.values()]
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .map(summarize),
        );
      },
      remove(name) {
        assertLive(namespaceId);
        const operation = namespace.children.get(name);
        if (!operation) throw Fail`No child named ${q(name)}`;
        if (operation.removal) return operation.removal;
        return serial(() => {
          assertLive(namespaceId);
          return removeJoining(operation);
        });
      },
      /**
       * @param {string} name
       * @param {ChildAgentPolicy} policy
       */
      attenuate(name, policy) {
        return serial(async () => {
          assertLive(namespaceId);
          assertOrdinaryName(name, 'derived namespace name');
          !namespace.derived.has(name) ||
            Fail`Derived namespace ${q(name)} already exists`;
          const derivedPolicy = intersectPolicy(namespace.policy, policy);
          const derived = await derive(
            namespace,
            name,
            derivedPolicy,
            /** @type {number} */ (namespace.makerNamespaceId),
          );
          return boundFacetFor(derived.id);
        });
      },
      async listDerived() {
        await null;
        assertLive(namespaceId);
        return listDerivedOf(namespace);
      },
      revokeDerived(name) {
        assertLive(namespaceId);
        return serial(() => revokeDerivedOf(namespace, name));
      },
    });
    boundFacets.set(namespaceId, facet);
    return facet;
  };

  await replay();
  await reconcile();

  const root = /** @type {Namespace} */ (namespaces.get(ROOT));

  const rootFacet = makeExo('ChildAgentFactory', ChildAgentFactoryInterface, {
    /**
     * @param {any} maker
     * @param {ChildAgentPolicy} [policy]
     */
    bind(maker, policy) {
      return serial(async () => {
        const id = nextNamespaceId;
        const derived = await derive(
          root,
          `bind-${id}`,
          intersectPolicy(root.policy, policy),
          id,
          maker,
        );
        return boundFacetFor(derived.id);
      });
    },
    async listDerived() {
      return listDerivedOf(root);
    },
    revokeDerived(name) {
      return serial(() => revokeDerivedOf(root, name));
    },
  });

  return harden({
    rootFacet,
    /**
     * Operations reconciliation left reserved because a derived name held the
     * wrong formula type. Reported, never repaired automatically.
     */
    faults: () => harden(Object.fromEntries(faults)),
    /**
     * Re-issue the facet for an existing namespace. Facets are in-memory exos
     * in this slice; a deployment re-derives them from durable formulas.
     *
     * @param {number} namespaceId
     */
    boundFacet: namespaceId => {
      (namespaces.has(namespaceId) && namespaceId !== ROOT) ||
        Fail`No bound namespace ${q(namespaceId)}`;
      return boundFacetFor(namespaceId);
    },
  });
};
harden(prepareChildAgentCoordinator);
