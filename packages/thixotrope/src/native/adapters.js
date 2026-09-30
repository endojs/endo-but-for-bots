// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import { encodeSwissnum } from '@endo/ocapn/client/util';

import { makeFirstFailure, makeInFlight } from '../in-flight.js';
import { randomHex128 } from '../random-id.js';

/** @import { NativeWorkerPowers } from '../platform/native-workers.js' */
/** @import { RandomPowers } from '../platform/random.js' */

/**
 * Each native incarnation is an ephemeral session: no heap or input replay.
 *
 * A launcher is described by the code it launches and the manager vat that
 * owns it (`description.workerId`), so the processes a manager started can
 * be closed with the manager: retiring a vat retires the host resources it
 * owns, and a native process is one.
 *
 * @param {{nativeWorkers?: NativeWorkerPowers, random: RandomPowers}} powers
 * @param {{hub: any, importBootstrap: (id: string) => any}} options
 */
export const makeNativeAdapters = (
  { nativeWorkers, random },
  { hub, importBootstrap },
) => {
  const opening = makeInFlight();
  const cleanupFailure = makeFirstFailure();
  /** @type {Set<() => Promise<void>>} */
  const closers = new Set();
  // Owner → the closers of the incarnations it launched, and the launches
  // still in flight, which retirement waits for so that a process started
  // during it is closed before retirement reports done.
  /** @type {Map<string, Set<() => Promise<void>>>} */
  const owned = new Map();
  /** @type {Map<string, Set<Promise<void>>>} */
  const launching = new Map();
  // One id per retired vat for the life of this process; ids are never
  // reused, so the set only tells a late launcher that its owner is gone.
  /** @type {Set<string>} */
  const retiredOwners = new Set();
  let stopped = false;
  /**
   * @template T
   * @param {Map<string, Set<T>>} index
   * @param {string} owner
   */
  const setOf = (index, owner) => {
    let set = index.get(owner);
    if (set === undefined) {
      set = new Set();
      index.set(owner, set);
    }
    return set;
  };

  /** @param {any} description */
  const resource = description => {
    const { workerId: owner } = /** @type {{ workerId?: string }} */ (
      description ?? {}
    );
    return Far('NativeAdapterLauncher', {
      help: () =>
        'create() starts a fresh native adapter from this installation.',
      create: () => {
        const launch = opening.track(
          (async () => {
            if (stopped) throw Error('Native adapters are stopped');
            if (owner !== undefined && retiredOwners.has(owner))
              throw Error('Native adapters of a retired vat cannot start');
            if (!nativeWorkers) throw Error('Native workers are unavailable');
            const id = `transient:native:${randomHex128(random)}`;
            /** @type {any} */
            let sink;
            /** @type {Uint8Array[]} */
            const pending = [];
            let exited = false;
            const child = await nativeWorkers.start({
              id,
              moduleUrl: description.moduleUrl,
              packageIdentity: description.packageIdentity,
              onFrame: bytes => {
                if (exited) return;
                if (sink) sink.deliver(bytes);
                else pending.push(bytes);
              },
              onExit: () => {
                exited = true;
                pending.length = 0;
                try {
                  hub.forgetSession(id);
                } catch (error) {
                  cleanupFailure.record(error);
                }
              },
            });
            const close = async () => {
              try {
                await child.terminate();
              } finally {
                hub.forgetSession(id);
                closers.delete(close);
                if (owner !== undefined) owned.get(owner)?.delete(close);
              }
            };
            closers.add(close);
            if (owner !== undefined && !retiredOwners.has(owner))
              setOf(owned, owner).add(close);
            void child.closed.then(() => {
              closers.delete(close);
              if (owner !== undefined) owned.get(owner)?.delete(close);
            });
            try {
              if (
                stopped ||
                exited ||
                (owner !== undefined && retiredOwners.has(owner))
              )
                throw Error('Native adapter stopped during startup');
              sink = hub.attachSession(id, {
                durable: false,
                send: child.send,
                onAbort: () => {
                  void close().catch(error => cleanupFailure.record(error));
                },
              });
              for (const bytes of pending.splice(0)) sink.deliver(bytes);
              const root = await E(importBootstrap(id)).fetch(
                encodeSwissnum('root'),
              );
              return Far('NativeAdapterIncarnation', {
                getRoot: () => root,
                retire: close,
              });
            } catch (error) {
              await close();
              throw error;
            }
          })(),
        );
        if (owner !== undefined) {
          const settled = launch.then(
            () => {},
            () => {},
          );
          const set = setOf(launching, owner);
          set.add(settled);
          void settled.then(() => set.delete(settled));
        }
        return launch;
      },
    });
  };
  return harden({
    resource,
    /**
     * Close every incarnation a retired vat launched and refuse it new ones.
     * Idempotent: a vat with nothing running has nothing to close.
     * @param {string} workerId
     */
    retireWorker: async workerId => {
      retiredOwners.add(workerId);
      // A launch in flight sees the retirement once its process is up and
      // closes it; wait for that so nothing of the vat's outlives this call.
      await Promise.all(launching.get(workerId) ?? []);
      launching.delete(workerId);
      const set = owned.get(workerId);
      owned.delete(workerId);
      if (set === undefined) return;
      const results = await Promise.allSettled([...set].map(close => close()));
      const failure = makeFirstFailure();
      for (const result of results) {
        if (result.status === 'rejected') failure.record(result.reason);
      }
      failure.assertNone();
    },
    shutdown: async () => {
      stopped = true;
      const results = await Promise.allSettled([
        ...[...closers].map(close => close()),
        opening.drain(),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') cleanupFailure.record(result.reason);
      }
      cleanupFailure.assertNone();
    },
  });
};
harden(makeNativeAdapters);
