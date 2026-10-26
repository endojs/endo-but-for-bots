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
 * @import { ChildAgentPolicy, EffectivePolicy } from './policy.js'
 */

/**
 * @typedef {'Intended' | 'GuestCreated' | 'Endowed' | 'DriverCreated' |
 *   'Pinned' | 'Committed' | 'Removing' | 'Removed'} ChildPhase
 */

/**
 * @typedef {object} PrivateHost
 * The coordinator's powers, seen through the daemon directory vocabulary. In
 * a deployment this is the dedicated `agent-factory` child host, so every name
 * below is in the coordinator's private namespace. Only the coordinator
 * writes it; no facet, child, or driver receives it.
 * @property {(...path: string[]) => Promise<boolean>} has
 * @property {(...path: string[]) => Promise<any>} lookup - Looking up a
 *   formula incarnates it, which is how the coordinator starts a runner.
 * @property {(...path: string[]) => Promise<string[]>} list
 * @property {(...path: string[]) => Promise<string | undefined>} identify
 * @property {(...path: string[]) => Promise<string | undefined>} formulaType
 * @property {(...path: string[]) => Promise<string | undefined>} powersOf -
 *   The identifier of the powers an unconfined caplet was formulated with.
 * @property {(value: any, path: string | string[]) => Promise<void>} storeValue
 * @property {(...path: string[]) => Promise<void>} remove
 * @property {(...path: string[]) => Promise<void>} cancel
 * @property {(name: string) => Promise<any>} provideGuest
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

const registryName = (/** @type {number} */ nsId) => `ns${nsId}`;
const makerName = (/** @type {number} */ nsId) => `maker${nsId}`;
const journalName = (/** @type {number} */ nsId, /** @type {number} */ seq) =>
  `j${nsId}.${seq}`;
const childName = (/** @type {string} */ opKey, /** @type {string} */ piece) =>
  `c${opKey}.${piece}`;

/**
 * @typedef {object} Operation
 * @property {string} key - `<namespace>.<sequence>`, the durable operation id.
 * @property {number} nsId
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
 * @property {number | undefined} makerNs - Namespace whose `maker<n>` record
 *   holds this namespace's maker.
 * @property {'Active' | 'Revoking' | 'Revoked'} phase
 * @property {number} nextSeq
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
 * @param {ChildAgentPolicy} options.rootPolicy
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
  let nextNsId = 0;

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
   * @param {Namespace} ns
   * @param {Record<string, any>} entry
   */
  const append = async (ns, entry) => {
    const seq = ns.nextSeq;
    await E(host).storeValue(harden(entry), journalName(ns.id, seq));
    ns.nextSeq = seq + 1;
    return seq;
  };

  /**
   * @param {Operation} op
   * @param {ChildPhase} phase
   * @param {Record<string, any>} [extra]
   */
  const advanceTo = async (op, phase, extra = {}) => {
    const ns = namespaces.get(op.nsId) || Fail`Unknown namespace`;
    await append(ns, { type: phase, op: op.key, ...extra });
    op.phase = phase;
    for (const watcher of op.watchers) watcher();
  };

  /** @param {number} nsId */
  const isLive = nsId => {
    /** @type {number | undefined} */
    let id = nsId;
    while (id !== undefined) {
      const ns = namespaces.get(id);
      if (!ns || ns.phase !== 'Active') return false;
      id = ns.parent;
    }
    return true;
  };

  /** @param {number} nsId */
  const assertLive = nsId => {
    isLive(nsId) || Fail`This child-agent factory has been revoked`;
  };

  /**
   * Count retained (non-`Removed`) children at or below each namespace.
   *
   * @returns {Map<number, number>}
   */
  const retainedCounts = () => {
    /** @type {Map<number, number>} */
    const counts = new Map();
    for (const op of operations.values()) {
      if (op.phase !== 'Removed') {
        /** @type {number | undefined} */
        let id = op.nsId;
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

  /** @param {Operation} op */
  const isActive = op => op.phase === 'Committed' && isLive(op.nsId);

  /** @param {Operation} op */
  const lifecycleFor = op => {
    let lifecycle = lifecycles.get(op.key);
    if (!lifecycle) {
      lifecycle = makeExo(`AgentLifecycle ${op.key}`, AgentLifecycleInterface, {
        isActive() {
          return isActive(op);
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
                while (reported === isActive(op) && op.phase !== 'Removed') {
                  await new Promise(resolve => {
                    const wake = () => {
                      op.watchers.delete(wake);
                      resolve(undefined);
                    };
                    op.watchers.add(wake);
                  });
                }
                if (reported === isActive(op)) {
                  return harden({ done: true, value: undefined });
                }
                reported = isActive(op);
                return harden({ done: false, value: reported });
              },
            },
          );
        },
      });
      lifecycles.set(op.key, lifecycle);
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

  /** @param {Operation} op */
  const installEndowments = async op => {
    await null;
    const guestName = childName(op.key, 'guest');
    for (let i = 0; i < op.endowmentNames.length; i += 1) {
      const endowmentName = op.endowmentNames[i];
      const retainedName = childName(op.key, `e${i}`);
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
    const expected = [...op.endowmentNames].sort();
    const exact =
      ordinary.length === expected.length &&
      ordinary.every((name, i) => name === expected[i]);
    if (!exact) {
      throw makeFault(
        `Child directory holds ${q(ordinary)}, expected exactly ${q(expected)}`,
      );
    }
  };

  /** @param {Operation} op */
  const makerFor = async op => {
    const ns = namespaces.get(op.nsId) || Fail`Unknown namespace`;
    if (ns.makerNs === undefined) throw Fail`Namespace has no maker`;
    return E(host).lookup(makerName(ns.makerNs));
  };

  /**
   * Drive one operation from its current creation phase to `Committed`.
   *
   * @param {Operation} op
   */
  const rollForward = async op => {
    await null;
    const guestName = childName(op.key, 'guest');
    const driverName = childName(op.key, 'driver');
    const responderName = childName(op.key, 'responder');
    if (op.phase === 'Intended') {
      const ref = await provideProvedGuest(guestName);
      await advanceTo(op, 'GuestCreated', { ref });
    }
    if (op.phase === 'GuestCreated') {
      await installEndowments(op);
      await advanceTo(op, 'Endowed');
    }
    if (op.phase === 'Endowed') {
      const ref = await provideProvedGuest(driverName);
      if (!(await E(host).has(driverName, LIFECYCLE_NAME))) {
        await E(host).storeValue(lifecycleFor(op), [
          driverName,
          LIFECYCLE_NAME,
        ]);
      }
      await advanceTo(op, 'DriverCreated', { ref });
    }
    if (op.phase === 'DriverCreated') {
      const driverId = await E(host).identify(driverName);
      if (!(await proveOrAbsent(responderName, 'unconfined', driverId))) {
        const maker = await makerFor(op);
        const { responder } = await E(maker).installDriver(
          harden({
            agent: await E(host).lookup(guestName),
            driverGuest: await E(host).lookup(driverName),
            lifecycle: lifecycleFor(op),
            ...(op.instructions ? { instructions: op.instructions } : {}),
          }),
        );
        await E(host).storeValue(responder, responderName);
      }
      const ref = await E(host).identify(responderName);
      await advanceTo(op, 'Pinned', { ref });
    }
    if (op.phase === 'Pinned') {
      await advanceTo(op, 'Committed');
    }
  };

  /** @param {Operation} op */
  const startRunner = async op => {
    await E(host).lookup(childName(op.key, 'responder'));
  };

  // ------------------------------------------------------------------
  // Removal

  /**
   * @param {Operation} op
   */
  const runRemoval = async op => {
    await null;
    op.fault === undefined ||
      Fail`Child ${q(op.name)} is reserved by a fault and cannot be removed: ${q(op.fault)}`;
    if (op.phase !== 'Removing') {
      await advanceTo(op, 'Removing');
    }
    const responderName = childName(op.key, 'responder');
    const driverName = childName(op.key, 'driver');
    const guestName = childName(op.key, 'guest');
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
    for (let i = 0; i < op.endowmentNames.length; i += 1) {
      const retainedName = childName(op.key, `e${i}`);
      if (await E(host).has(retainedName)) {
        await E(host).remove(retainedName);
      }
    }
    await advanceTo(op, 'Removed');
    const ns = namespaces.get(op.nsId);
    if (ns && ns.children.get(op.name) === op) ns.children.delete(op.name);
    lifecycles.delete(op.key);
  };

  /** @param {Operation} op */
  const removeJoining = op => {
    if (!op.removal) {
      op.removal = runRemoval(op).finally(() => {
        op.removal = undefined;
      });
    }
    return op.removal;
  };

  /** @param {number} nsId */
  const revoke = async nsId => {
    await null;
    const ns = namespaces.get(nsId) || Fail`Unknown namespace`;
    if (ns.phase === 'Active') {
      await append(ns, { type: 'Revoking' });
      ns.phase = 'Revoking';
      for (const op of ns.children.values()) {
        for (const watcher of op.watchers) watcher();
      }
    }
    for (const childNs of [...ns.derived.values()]) {
      const derivedNs = namespaces.get(childNs);
      if (derivedNs && derivedNs.phase !== 'Revoked') {
        await revoke(childNs);
      }
    }
    for (const op of [...ns.children.values()]) {
      await removeJoining(op);
    }
    await append(ns, { type: 'Revoked' });
    ns.phase = 'Revoked';
    const parent =
      ns.parent === undefined ? undefined : namespaces.get(ns.parent);
    if (parent && ns.name !== undefined) parent.derived.delete(ns.name);
  };

  /** @param {number} nsId */
  const revokeJoining = nsId => {
    const ns = namespaces.get(nsId) || Fail`Unknown namespace`;
    if (!ns.revocation) {
      ns.revocation = revoke(nsId).finally(() => {
        ns.revocation = undefined;
      });
    }
    return ns.revocation;
  };

  // ------------------------------------------------------------------
  // Replay

  /**
   * @param {number} id
   * @param {number | undefined} parent
   * @param {string | undefined} name
   * @param {EffectivePolicy} policy
   * @param {number | undefined} makerNs
   * @returns {Namespace}
   */
  const addNamespace = (id, parent, name, policy, makerNs) => {
    /** @type {Namespace} */
    const ns = {
      id,
      parent,
      name,
      policy,
      makerNs,
      phase: 'Active',
      nextSeq: 0,
      children: new Map(),
      derived: new Map(),
    };
    namespaces.set(id, ns);
    if (parent !== undefined && name !== undefined) {
      const parentNs = namespaces.get(parent) || Fail`Unknown namespace`;
      parentNs.derived.set(name, id);
    }
    return ns;
  };

  /**
   * @param {Namespace} ns
   * @param {Record<string, any>} entry
   */
  const applyEntry = (ns, entry) => {
    const { type } = entry;
    if (type === 'Derived') {
      // The derived namespace's own journal is replayed after this one, and a
      // namespace without its parent's `Derived` entry is an unreachable
      // orphan of a crash between allocation and that entry.
      addNamespace(entry.child, ns.id, entry.name, entry.policy, entry.makerNs);
    } else if (type === 'Revoking' || type === 'Revoked') {
      ns.phase = type;
      if (type === 'Revoked' && ns.parent !== undefined) {
        namespaces
          .get(ns.parent)
          ?.derived.delete(/** @type {string} */ (ns.name));
      }
    } else if (type === 'Intended') {
      /** @type {Operation} */
      const op = {
        key: entry.op,
        nsId: ns.id,
        name: entry.name,
        phase: 'Intended',
        instructions: entry.instructions,
        endowmentNames: entry.endowmentNames,
        createdAt: entry.createdAt,
        watchers: new Set(),
      };
      operations.set(op.key, op);
      ns.children.set(op.name, op);
    } else {
      const op = operations.get(entry.op) || Fail`Journal names unknown op`;
      op.phase = type;
      if (type === 'Removed') {
        ns.children.delete(op.name);
      }
    }
  };

  const replay = async () => {
    await null;
    const names = new Set(await E(host).list());
    while (names.has(registryName(nextNsId))) nextNsId += 1;
    if (!names.has(registryName(ROOT))) {
      const policy = makeRootPolicy(rootPolicy);
      await E(host).storeValue(harden({ policy }), registryName(ROOT));
      nextNsId = Math.max(nextNsId, 1);
      addNamespace(ROOT, undefined, undefined, policy, undefined);
      return;
    }
    const { policy } = await E(host).lookup(registryName(ROOT));
    addNamespace(ROOT, undefined, undefined, policy, undefined);
    // Breadth-first over the derivation tree: a parent's journal introduces
    // each child namespace before the child's own journal is read.
    const pending = [ROOT];
    while (pending.length > 0) {
      const nsId = /** @type {number} */ (pending.shift());
      const ns = /** @type {Namespace} */ (namespaces.get(nsId));
      while (names.has(journalName(nsId, ns.nextSeq))) {
        const entry = await E(host).lookup(journalName(nsId, ns.nextSeq));
        applyEntry(ns, entry);
        ns.nextSeq += 1;
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
   * @param {Operation} op
   */
  const converge = async op => {
    await null;
    try {
      if (op.phase === 'Removing') {
        await removeJoining(op);
      } else if (creationPhases.includes(op.phase)) {
        if (!isLive(op.nsId)) {
          await removeJoining(op);
          return;
        }
        try {
          await rollForward(op);
        } catch (error) {
          if (isFault(error)) throw error;
          await removeJoining(op);
          throw error;
        }
      }
    } catch (error) {
      if (isFault(error)) {
        op.fault = /** @type {Error} */ (error).message;
        faults.set(op.key, op.fault);
      }
      throw error;
    }
  };

  const reconcile = async () => {
    await null;
    for (const ns of [...namespaces.values()]) {
      if (ns.phase === 'Revoking') {
        await revokeJoining(ns.id);
      }
    }
    for (const op of [...operations.values()]) {
      if (op.phase !== 'Committed' && op.phase !== 'Removed') {
        await converge(op).catch(() => {});
      }
    }
    for (const op of operations.values()) {
      if (isActive(op)) {
        await startRunner(op);
      }
    }
  };

  // ------------------------------------------------------------------
  // Facets

  /** @param {Operation} op */
  const summarize = op =>
    harden({
      name: op.name,
      phase: op.phase,
      createdAt: op.createdAt,
      operationId: op.key,
    });

  /** @param {Namespace} ns */
  const listDerivedOf = ns => {
    const counts = retainedCounts();
    return harden(
      [...ns.derived.entries()]
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
   * @param {Namespace} ns
   * @param {string} name
   */
  const revokeDerivedOf = (ns, name) => {
    const id = ns.derived.get(name);
    id !== undefined || Fail`No derived namespace named ${q(name)}`;
    return revokeJoining(/** @type {number} */ (id));
  };

  /**
   * Allocate a namespace derived from `issuer`.
   *
   * @param {Namespace} issuer
   * @param {string} name
   * @param {EffectivePolicy} policy
   * @param {number} makerNs
   * @param {any} [maker] - Present only for `bind`, which records a new maker.
   */
  const derive = async (issuer, name, policy, makerNs, maker) => {
    const id = nextNsId;
    // The registry entry reserves the id; a crash before the issuer's
    // `Derived` entry leaves an unreachable orphan, never a reachable one.
    await E(host).storeValue(harden({ parent: issuer.id }), registryName(id));
    nextNsId = id + 1;
    if (maker !== undefined) {
      await E(host).storeValue(maker, makerName(id));
    }
    await append(issuer, { type: 'Derived', name, child: id, policy, makerNs });
    return addNamespace(id, issuer.id, name, policy, makerNs);
  };

  /** @type {Map<number, any>} */
  const boundFacets = new Map();

  /** @param {number} nsId */
  const boundFacetFor = nsId => {
    let facet = boundFacets.get(nsId);
    if (facet) return facet;
    const ns = /** @type {Namespace} */ (namespaces.get(nsId));
    facet = makeExo('BoundChildAgentFactory', BoundChildAgentFactoryInterface, {
      create(name, { instructions = '', endowments = {} } = {}) {
        return serial(async () => {
          await null;
          assertLive(nsId);
          assertOrdinaryName(name, 'child name');
          const existing = ns.children.get(name);
          !existing ||
            Fail`Child ${q(name)} already exists in phase ${q(existing.phase)}`;
          const endowmentNames = Object.keys(endowments).sort();
          assertCreateAdmitted(ns.policy, instructions, endowmentNames);
          const counts = retainedCounts();
          /** @type {number | undefined} */
          let id = nsId;
          while (id !== undefined) {
            const each = /** @type {Namespace} */ (namespaces.get(id));
            (counts.get(id) || 0) < each.policy.maxChildren ||
              Fail`Child quota exhausted`;
            id = each.parent;
          }

          const key = `${nsId}.${ns.nextSeq}`;
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
          const seq = await append(ns, {
            type: 'Intended',
            op: key,
            name,
            instructions,
            endowmentNames,
            createdAt,
          });
          `${nsId}.${seq}` === key || Fail`Journal sequence moved`;
          /** @type {Operation} */
          const op = {
            key,
            nsId,
            name,
            phase: 'Intended',
            instructions,
            endowmentNames,
            createdAt,
            watchers: new Set(),
          };
          operations.set(key, op);
          ns.children.set(name, op);

          await converge(op);
          await startRunner(op);
          const handle = await E(host).lookup(childName(key, 'guest'), '@self');
          return harden({ summary: summarize(op), handle });
        });
      },
      async lookup(name) {
        await null;
        assertLive(nsId);
        const op = ns.children.get(name);
        if (!op || op.phase !== 'Committed') {
          throw Fail`No committed child named ${q(name)}`;
        }
        return E(host).lookup(childName(op.key, 'guest'), '@self');
      },
      async list() {
        await null;
        assertLive(nsId);
        return harden(
          [...ns.children.values()]
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .map(summarize),
        );
      },
      remove(name) {
        assertLive(nsId);
        const op = ns.children.get(name);
        if (!op) throw Fail`No child named ${q(name)}`;
        if (op.removal) return op.removal;
        return serial(() => {
          assertLive(nsId);
          return removeJoining(op);
        });
      },
      /**
       * @param {string} name
       * @param {ChildAgentPolicy} policy
       */
      attenuate(name, policy) {
        return serial(async () => {
          assertLive(nsId);
          assertOrdinaryName(name, 'derived namespace name');
          !ns.derived.has(name) ||
            Fail`Derived namespace ${q(name)} already exists`;
          const derivedPolicy = intersectPolicy(ns.policy, policy);
          const derived = await derive(
            ns,
            name,
            derivedPolicy,
            /** @type {number} */ (ns.makerNs),
          );
          return boundFacetFor(derived.id);
        });
      },
      async listDerived() {
        await null;
        assertLive(nsId);
        return listDerivedOf(ns);
      },
      revokeDerived(name) {
        assertLive(nsId);
        return serial(() => revokeDerivedOf(ns, name));
      },
    });
    boundFacets.set(nsId, facet);
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
        const id = nextNsId;
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
     * @param {number} nsId
     */
    boundFacet: nsId => {
      (namespaces.has(nsId) && nsId !== ROOT) ||
        Fail`No bound namespace ${q(nsId)}`;
      return boundFacetFor(nsId);
    },
  });
};
harden(prepareChildAgentCoordinator);
