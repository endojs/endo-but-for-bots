// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import { encodeSwissnum } from '@endo/ocapn/client/util';

import { makeFirstFailure, makeInFlight } from '../in-flight.js';
import { randomHex128 } from '../random-id.js';

/** @import { NativeWorkerPowers } from '../platform/native-workers.js' */
/** @import { RandomPowers } from '../platform/random.js' */
/** @import { TimerHandle, TimerPowers } from '../platform/timers.js' */

/**
 * An incarnation that lived shorter than this before exiting on its own is
 * a quick exit; consecutive quick exits back off the exit notice, doubling
 * from one second up to the ceiling, so a process that dies at once is not
 * rebuilt in a tight loop. The first exit after a long life is reported at
 * once.
 */
export const QUICK_EXIT_MS = 10_000;
harden(QUICK_EXIT_MS);
export const MAX_EXIT_NOTICE_DELAY_MS = 30_000;
harden(MAX_EXIT_NOTICE_DELAY_MS);

/**
 * Each native incarnation is an ephemeral session: no heap or input replay.
 *
 * A launcher is bound to the manager vat that owns it (`workerId`), so the
 * processes a manager started can be closed with the manager: retiring a
 * vat retires the host resources bound to it, and a native process is one.
 * Its key is the code it launches, the digest of the stored ephemeral
 * bundle. `bundlePath` says where the store keeps a bundle, for the process
 * to load; the process checks the digest over the bytes it finds there.
 *
 * An incarnation that exits on its own, rather than through `retire`, its
 * owner's retirement or shutdown, is reported to its owner through
 * `onAdapterExit` after the backoff above, so the manager can rebuild it
 * while it still desires anything, without waiting for the next operation
 * that needs an adapter or for the next daemon start.
 *
 * @param {{nativeWorkers?: NativeWorkerPowers, random: RandomPowers, timers: TimerPowers}} powers
 * @param {{hub: any, importBootstrap: (id: string) => any, bundlePath: (digest: string) => string, onAdapterExit?: (workerId: string) => void}} options
 */
export const makeNativeAdapters = (
  { nativeWorkers, random, timers },
  { hub, importBootstrap, bundlePath, onAdapterExit = () => {} },
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
  // Owner → consecutive quick exits, and the exit notices not yet delivered.
  /** @type {Map<string, number>} */
  const quickExits = new Map();
  /** @type {Map<string, Set<TimerHandle>>} */
  const notices = new Map();
  let stopped = false;
  /**
   * Report an incarnation's own exit to its owner, after a delay that grows
   * with consecutive quick exits.
   * @param {string} owner
   * @param {number} livedMs
   */
  const scheduleExitNotice = (owner, livedMs) => {
    const quick =
      livedMs < QUICK_EXIT_MS ? (quickExits.get(owner) ?? 0) + 1 : 0;
    quickExits.set(owner, quick);
    const delay =
      quick === 0
        ? 0
        : Math.min(MAX_EXIT_NOTICE_DELAY_MS, 1000 * 2 ** (quick - 1));
    const pending = setOf(notices, owner);
    /** @type {TimerHandle} */
    const timer = timers.setTimer(() => {
      pending.delete(timer);
      if (stopped || retiredOwners.has(owner)) return;
      try {
        onAdapterExit(owner);
      } catch (error) {
        // A timer callback has no caller to throw to.
        cleanupFailure.record(error);
      }
    }, delay);
    pending.add(timer);
    timers.unrefTimer?.(timer);
  };
  /** @param {string} owner */
  const cancelExitNotices = owner => {
    for (const timer of notices.get(owner) ?? []) timers.clearTimer(timer);
    notices.delete(owner);
  };
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
    const { workerId: owner, key: bundleDigest } =
      /** @type {{ workerId?: string, key?: string }} */ (description ?? {});
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
            // A launcher recorded by a build that started the process from
            // the resource's directory names no bundle, and nothing can be
            // launched for it now: the installation is to be made again.
            if (typeof bundleDigest !== 'string')
              throw Error(
                'This native resource was installed before its ephemeral module was bundled at installation; remove it and install it again',
              );
            const id = `transient:native:${randomHex128(random)}`;
            /** @type {any} */
            let sink;
            /** @type {Uint8Array[]} */
            const pending = [];
            let exited = false;
            const child = await nativeWorkers.start({
              id,
              bundlePath: bundlePath(bundleDigest),
              bundleDigest,
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
            // Ending the process: `close` is an end someone asked for (the
            // manager's retirement, its owner's, or shutdown) and is not
            // reported; `end` alone, as on a hub abort, is one the owner
            // must hear about like any other exit it did not ask for.
            let closing = false;
            let ready = false;
            const end = async () => {
              try {
                await child.terminate();
              } finally {
                hub.forgetSession(id);
                closers.delete(close);
                if (owner !== undefined) owned.get(owner)?.delete(close);
              }
            };
            const close = () => {
              closing = true;
              return end();
            };
            closers.add(close);
            if (owner !== undefined && !retiredOwners.has(owner))
              setOf(owned, owner).add(close);
            const launchedAt = timers.monotonicNow();
            void child.closed.then(() => {
              closers.delete(close);
              if (owner !== undefined) owned.get(owner)?.delete(close);
              if (owner === undefined) return;
              const livedMs = timers.monotonicNow() - launchedAt;
              // A long life ends the run of quick exits however it ends.
              if (livedMs >= QUICK_EXIT_MS) quickExits.delete(owner);
              // An exit nobody asked for is the owner's to hear about, once
              // the incarnation was the owner's to use: one that dies before
              // its root is fetched is reported by `create()` rejecting.
              if (ready && !closing && !stopped && !retiredOwners.has(owner)) {
                try {
                  scheduleExitNotice(owner, livedMs);
                } catch (error) {
                  cleanupFailure.record(error);
                }
              }
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
                  void end().catch(error => cleanupFailure.record(error));
                },
              });
              for (const bytes of pending.splice(0)) sink.deliver(bytes);
              const root = await E(importBootstrap(id)).fetch(
                encodeSwissnum('root'),
              );
              ready = true;
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
      cancelExitNotices(workerId);
      quickExits.delete(workerId);
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
    /**
     * Stop reporting exits, ahead of shutdown: a notice delivered while the
     * daemon is parking its vats would wake one it just put to sleep.
     */
    quiesce: () => {
      stopped = true;
      for (const owner of [...notices.keys()]) cancelExitNotices(owner);
    },
    shutdown: async () => {
      stopped = true;
      for (const owner of [...notices.keys()]) cancelExitNotices(owner);
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
