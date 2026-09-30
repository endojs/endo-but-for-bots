// @ts-check
import harden from '@endo/harden';
import { Fail, q } from '@endo/errors';
import { Far } from '@endo/far';

/**
 * @import {ThixotropeStore} from '../store/store-fs.js'
 */

/**
 * Endpoint session records: the durable description of the daemon's
 * one reifying session (the endpoint), so a daemon restart re-seats
 * its exports without reconstructing any live state elsewhere — the
 * hub's tables carry every other session.
 *
 * The machine invariant makes the endpoint's exports describable:
 * every value the endpoint exports is either
 *
 * - a host resource: described as `{ kind: 'resource', name,
 *   description }`, re-instantiated by the registered factory on
 *   restore (instances are per-process singletons per name and
 *   description); or
 * - protocol-internal plumbing — the resolver objects the OCapN layer
 *   mints for op:listen subscriptions and op:deliver replies. Their
 *   function is restored separately (resolver obligations re-attach),
 *   so they are recorded as `{ kind: 'internal' }` and re-seat as
 *   tombstones that only keep the position space aligned; calls to one
 *   fail loudly. Ephemeral host observers use this non-revivable description
 *   too: their closures are never persisted or recreated. Their owner must
 *   cancel guest subscriptions on disconnect and discard old ephemeral
 *   subscriptions on supervisor restart.
 *
 * Descriptions are keyed by export slot in the endpoint's worker-store
 * tables record; resolver obligations ride along (promise targets
 * re-subscribe, answer targets reject at-most-once), and the answer
 * epoch partitions the endpoint's question positions across daemon
 * processes.
 *
 * @param {object} options
 * @param {ThixotropeStore} options.store
 * @param {Record<string, (description?: unknown) => object>} [options.resources]
 *   named resource factories; instances are per-process singletons per
 *   (name, description) pair
 * @param {(error: unknown) => void} options.reportError
 *   called when a durable record write fails; required so that a caller cannot
 *   silently drop the failures that would otherwise corrupt recovery state
 */
export const makeWorkerSessionRecords = ({
  store,
  resources = {},
  reportError,
}) => {
  /** @type {WeakMap<object, string>} connection -> workerId */
  const workerIdForConnection = new WeakMap();
  /** @type {WeakMap<object, { name: string, description: unknown }>} */
  const resourceOrigins = new WeakMap();
  /** @type {Map<string, object>} (name, description) -> singleton */
  const resourceInstances = new Map();
  /** @type {Map<string, any>} workerId -> ResumedSession controls */
  const resumedByWorkerId = new Map();
  // Pins for the resolvers of *answers* owed by this process. An unrooted
  // host promise, such as a resource method returning `new Promise(() => {})`,
  // leaves no reaction holding the guest's resolver, so the weak import table
  // would collect it; that collection is not a local event: the
  // FinalizationRegistry fires `slotCollected`, which sends op:gc-exports, and
  // the guest retires the very position `pendingResolvers` recorded. The
  // guest awaiting that answer lives in a heap that outlives this process, so
  // local reachability does not bound the obligation. Pinning the import
  // until settlement lets a restart still reject the abandoned answer; it
  // retains the route, never the promise or its computation.
  //
  // The hook pins every obligation this process takes on, promise targets
  // included, though those would be retained anyway: their resolver is held
  // by the reaction on the exported promise, and the export table is strong.
  // Nothing restored after a restart is pinned: answer targets are rejected
  // there, and promise targets re-link to a local export. A pin lives until
  // its obligation settles, so one for an answer that never settles, or for
  // a peer retired mid-listen, lives as long as the process: the endpoint
  // cannot tell which guest a resolver position belongs to, so retiring a
  // worker does not release its pins. test/resource-answer-gc.test.js fails
  // without the map.
  /** @type {Map<string, object>} */
  const pendingResolverReferences = new Map();
  /** True while re-seating exports, whose re-fired hooks are echoes. */
  let restoring = false;

  /** The promise seated where a retired promise export used to be. */
  const unrestorablePromise = () => {
    const promise = Promise.reject(
      harden(Error('Promise export was retired before it settled')),
    );
    // Only a peer still listening should learn of it.
    void promise.catch(() => {});
    return promise;
  };

  /**
   * @param {string} name
   * @param {unknown} description
   */
  const resourceKey = (name, description) =>
    `${name}|${JSON.stringify(description)}`;

  /**
   * @param {string} name
   * @param {unknown} [description]
   */
  const provideResource = (name, description = null) => {
    const key = resourceKey(name, description);
    let instance = resourceInstances.get(key);
    if (instance === undefined) {
      const makeResource = resources[name];
      typeof makeResource === 'function' ||
        Fail`thixotrope worker sessions: unknown resource ${q(name)}`;
      instance = makeResource(description);
      resourceInstances.set(key, instance);
      resourceOrigins.set(instance, harden({ name, description }));
    }
    return instance;
  };

  /**
   * @param {any} description
   * @returns {object}
   */
  const provideCapability = description => {
    if (description.kind === 'resource') {
      return provideResource(description.name, description.description ?? null);
    }
    if (description.kind === 'internal') {
      // A protocol-internal resolver from the previous process; its
      // function is restored by resolver obligations and promise
      // re-subscription. This tombstone only keeps the position space
      // aligned.
      return Far('SessionInternalTombstone', {});
    }
    throw Fail`thixotrope worker sessions: unknown description kind ${q(
      description.kind,
    )}`;
  };

  const sessionHooks = harden({
    /**
     * @param {object} connection
     * @param {string} slot
     * @param {object} value
     */
    onExport: (connection, slot, value) => {
      const workerId = workerIdForConnection.get(connection);
      if (workerId === undefined || restoring) {
        return;
      }
      try {
        // Position 0 is the bootstrap object, recreated by every
        // session; later positions must be re-seatable.
        if (slot.endsWith('+0')) {
          return;
        }
        const resource = resourceOrigins.get(value);
        const description =
          resource === undefined
            ? harden({ kind: 'internal' })
            : harden({ kind: 'resource', ...resource });
        const workerStore = store.provideWorkerStore(workerId);
        const record = /** @type {any} */ (workerStore.getTablesRecord()) ?? {};
        workerStore.setTablesRecord({
          ...record,
          exports: { ...record.exports, [slot]: description },
        });
      } catch (error) {
        reportError(error);
      }
    },
    /**
     * The peer released every reference to an export: nothing will ever ask
     * for that position again, so its description need not be re-seated.
     *
     * @param {object} connection
     * @param {string} slot
     */
    onExportReleased: (connection, slot) => {
      const workerId = workerIdForConnection.get(connection);
      if (workerId === undefined || restoring) {
        return;
      }
      try {
        const workerStore = store.provideWorkerStore(workerId);
        const record = /** @type {any} */ (workerStore.getTablesRecord()) ?? {};
        let changed = false;
        const exports = { ...record.exports };
        if (slot in exports) {
          delete exports[slot];
          changed = true;
        }
        // A released promise export can still be named by a resolver
        // obligation (the peer had listened on it, then let it go, or the
        // peer's session was retired with the listen outstanding). Nothing
        // can be delivered to that resolver now, and a restart that tried to
        // re-link it would find no export at the position. The two records
        // go together.
        const pendingResolvers = { ...record.pendingResolvers };
        if (slot.startsWith('p+')) {
          const position = slot.slice(2);
          for (const [resolverSlot, target] of Object.entries(
            pendingResolvers,
          )) {
            const found = /** @type {any} */ (target);
            if (found.kind === 'promise' && found.position === position) {
              delete pendingResolvers[resolverSlot];
              changed = true;
            }
          }
        }
        if (changed) {
          workerStore.setTablesRecord({ ...record, exports, pendingResolvers });
        }
      } catch (error) {
        reportError(error);
      }
    },
    /**
     * @param {object} connection
     * @param {string} resolverSlot
     * @param {{ kind: 'promise' | 'answer', position: bigint }} target
     */
    onPendingResolver: (connection, resolverSlot, target) => {
      const workerId = workerIdForConnection.get(connection);
      if (workerId === undefined || restoring) {
        return;
      }
      try {
        const resumed = resumedByWorkerId.get(workerId);
        resumed !== undefined || Fail`Worker session is not established`;
        pendingResolverReferences.set(
          `${workerId}:${resolverSlot}`,
          resumed.provideImport({
            type: 'o',
            position: BigInt(resolverSlot.slice(2)),
          }),
        );
        const workerStore = store.provideWorkerStore(workerId);
        const record = /** @type {any} */ (workerStore.getTablesRecord()) ?? {};
        workerStore.setTablesRecord({
          ...record,
          pendingResolvers: {
            ...record.pendingResolvers,
            [resolverSlot]: {
              kind: target.kind,
              position: target.position.toString(),
            },
          },
        });
      } catch (error) {
        reportError(error);
      }
    },
    /**
     * @param {object} connection
     * @param {string} resolverSlot
     */
    onResolverSettled: (connection, resolverSlot) => {
      const workerId = workerIdForConnection.get(connection);
      if (workerId === undefined) {
        return;
      }
      try {
        const workerStore = store.provideWorkerStore(workerId);
        const record = /** @type {any} */ (workerStore.getTablesRecord()) ?? {};
        if (
          record.pendingResolvers &&
          resolverSlot in record.pendingResolvers
        ) {
          const pendingResolvers = { ...record.pendingResolvers };
          delete pendingResolvers[resolverSlot];
          workerStore.setTablesRecord({ ...record, pendingResolvers });
        }
        pendingResolverReferences.delete(`${workerId}:${resolverSlot}`);
      } catch (error) {
        reportError(error);
      }
    },
  });

  return harden({
    sessionHooks,
    provideResource,
    /**
     * Forget a resource: drop its per-process instance so the next
     * `provideResource` for the same description makes a fresh one, and null
     * its recorded exports so a restart seats tombstones at those positions
     * rather than re-running the factory for a description whose meaning has
     * ended. A live export the peer still holds is untouched; the peer's
     * reference keeps working until the peer releases it.
     *
     * This is the retirement half of the resource contract: without it a
     * settled-by-description promise (an alarm, say) would be re-created on
     * every restart for as long as the state directory lived.
     *
     * Each call is one read-modify-write of the endpoint's tables record,
     * the same cost as recording an export.
     *
     * @param {string} name
     * @param {unknown} [description]
     * @returns {boolean} whether an instance or a record was forgotten
     */
    retireResource: (name, description = null) => {
      const key = resourceKey(name, description);
      const instance = resourceInstances.get(key);
      let retired = resourceInstances.delete(key);
      if (instance !== undefined) resourceOrigins.delete(instance);
      const wanted = JSON.stringify(description);
      for (const workerId of resumedByWorkerId.keys()) {
        const workerStore = store.provideWorkerStore(workerId);
        const record = /** @type {any} */ (workerStore.getTablesRecord()) ?? {};
        /** @type {Record<string, unknown>} */
        const exports = { ...record.exports };
        let changed = false;
        for (const [slot, recorded] of Object.entries(exports)) {
          const found = /** @type {any} */ (recorded);
          if (
            found?.kind === 'resource' &&
            found.name === name &&
            JSON.stringify(found.description ?? null) === wanted
          ) {
            exports[slot] = null;
            changed = true;
          }
        }
        if (changed) {
          workerStore.setTablesRecord({ ...record, exports });
          retired = true;
        }
      }
      return retired;
    },
    /**
     * Bind a connection to its session's record id so the hooks can
     * attribute session traffic. Call before restoring the session.
     *
     * @param {object} connection
     * @param {string} workerId
     */
    registerWorkerConnection: (connection, workerId) => {
      workerIdForConnection.set(connection, workerId);
    },
    /**
     * Note a session's restore controls (fresh or restored daemon
     * alike), so `restoreWorker` can re-seat into it.
     *
     * @param {string} workerId
     * @param {any} resumed the client's `resumeSession` result
     */
    registerResumedSession: (workerId, resumed) => {
      resumedByWorkerId.set(workerId, resumed);
    },
    /**
     * Re-seat every recorded export and resolver obligation for the
     * session in a restarted daemon.
     *
     * @param {string} workerId
     */
    restoreWorker: workerId => {
      const resumed = resumedByWorkerId.get(workerId);
      resumed !== undefined ||
        Fail`thixotrope worker sessions: worker ${q(workerId)} is not established`;
      const workerStore = store.provideWorkerStore(workerId);
      const record = /** @type {any} */ (workerStore.getTablesRecord()) ?? {};
      // The hub's tables still hold answer registrations from every
      // previous daemon process (only op:gc-answers releases them, and
      // a dead process sends none). Partition the answer-position
      // space by daemon epoch so this process's fresh question counter
      // can never collide with a predecessor's.
      const answerEpoch = (record.answerEpoch ?? 0) + 1;
      workerStore.setTablesRecord({ ...record, answerEpoch });
      resumed.advanceAnswerPosition(BigInt(answerEpoch) * 2n ** 32n);
      restoring = true;
      try {
        for (const [slot, description] of Object.entries(
          record.exports ?? {},
        )) {
          const position = BigInt(slot.slice(2));
          let value =
            description === null
              ? Far('UnrestorableExport', {})
              : provideCapability(description);
          // A promise position must re-seat as a promise: an object there
          // would be found by the same position lookup and *fulfil* any
          // listener the peer still has on it. A retired or otherwise
          // unrestorable promise breaks that listener instead.
          if (slot.startsWith('p+') && !(value instanceof Promise)) {
            value = unrestorablePromise();
          }
          resumed.restoreExport(position, value);
        }
        /** @type {Record<string, any>} */
        const pendingResolvers = { ...record.pendingResolvers };
        let changed = false;
        for (const [resolverSlot, target] of Object.entries(pendingResolvers)) {
          if (
            target.kind === 'promise' &&
            !(`p+${target.position}` in (record.exports ?? {}))
          ) {
            // The export this obligation would re-link to is gone (released
            // by the peer before the record caught up); there is nothing to
            // deliver and nothing to attach. Drop it rather than refuse to
            // start.
            delete pendingResolvers[resolverSlot];
            changed = true;
          } else {
            resumed.restorePendingResolver({
              resolverPosition: BigInt(resolverSlot.slice(2)),
              target: {
                kind: target.kind,
                position: BigInt(target.position),
              },
            });
          }
          if (target.kind === 'answer') {
            // The break is a send-only on a later turn, so this process may
            // crash after writing the record and before the hub persists the
            // frame. Keep the record for one more boot, which re-breaks the
            // position (harmless on a settled guest promise), and drop it
            // only once a previous boot has already broken it. Losing the
            // break takes two crashes in that window, not one, and no record
            // outlives its second boot.
            if (target.brokenAtEpoch === undefined) {
              pendingResolvers[resolverSlot] = {
                ...target,
                brokenAtEpoch: answerEpoch,
              };
            } else {
              delete pendingResolvers[resolverSlot];
            }
            changed = true;
          }
        }
        if (changed) {
          workerStore.setTablesRecord({
            ...workerStore.getTablesRecord(),
            pendingResolvers,
          });
        }
      } finally {
        restoring = false;
      }
    },
  });
};
harden(makeWorkerSessionRecords);
