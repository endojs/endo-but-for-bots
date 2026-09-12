// @ts-check
/** @import { NodePowers } from '../platform/node-powers.js' */
import { E, Far } from '@endo/far';
import { Fail } from '@endo/errors';
import harden from '@endo/harden';

import { makeAlarmScheduler } from './alarm-scheduler.js';
import { makeDurableClock } from './durable-clock.js';
/** @import { SyncStringAtom } from '../store/sync-string-atom.js' */

/** @import { makeThixotropeDaemon } from '../core/daemon.js' */
/** @typedef {{version: 1, allocationId: string, workerId?: string, secret: string}} ClockConfig */
/**
 * Owns one private clock vat and its reconstructible host timer index.
 * Construct only under the daemon's engine lease. Reifying its scheduler is
 * inert; neither restoration nor start allocates an unused clock vat.
 * The public clock is the only capability returned to application grant code.
 * @param {Pick<NodePowers, 'timers' | 'randomBytes' | 'now'>} powers
 * @param {object} options
 * @param {SyncStringAtom} options.storage
 * @param {() => Awaited<ReturnType<typeof makeThixotropeDaemon>>} options.getDaemon
 * @param {() => bigint} [options.now]
 */
export const makeClockService = (powers, { storage, getDaemon, now }) => {
  const randomId = () =>
    Array.from(powers.randomBytes(16), byte =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
  /** @type {ClockConfig | undefined} */
  let config;
  const saved = storage.read();
  if (saved !== undefined) config = JSON.parse(saved);
  if (
    config !== undefined &&
    (config === null ||
      config.version !== 1 ||
      typeof config.allocationId !== 'string' ||
      !/^[0-9a-f]{32}$/.test(config.allocationId) ||
      (config.workerId !== undefined &&
        (typeof config.workerId !== 'string' ||
          !/^[0-9a-f]{32}$/.test(config.workerId))) ||
      typeof config.secret !== 'string' ||
      !/^[0-9a-f]{32}$/.test(config.secret))
  )
    throw Fail`Invalid clock metadata`;
  /** @type {ReturnType<typeof makeAlarmScheduler> | undefined} */
  let scheduler;
  /** @type {object | undefined} */
  let schedulerResource;
  /** @type {any} */
  let clock;
  /** @type {Promise<void> | undefined} */
  let initializing;
  let initialized = false;
  let stopped = false;
  /** @type {unknown} */
  let failure;
  /** @type {() => void} */
  let resolveReady = () => {};
  /** @type {(reason: unknown) => void} */
  let rejectReady = () => {};
  const ready = new Promise((resolve, reject) => {
    resolveReady = () => resolve(undefined);
    rejectReady = reject;
  });
  void ready.catch(() => {});

  const provideScheduler = () => {
    if (!config) throw Fail`Clock has not been allocated`;
    scheduler ??= makeAlarmScheduler(powers, {
      secret: config.secret,
      openClient: () => getDaemon().openEphemeralClient(),
      ...(now === undefined ? {} : { now }),
    });
    return scheduler;
  };

  /** @param {boolean} allocate */
  const initialize = allocate => {
    if (stopped) return Promise.reject(Error('Clock service is shut down'));
    if (failure !== undefined) return Promise.reject(failure);
    if (initialized) return Promise.resolve();
    if (initializing) return initializing;
    if (!config && !allocate) return Promise.resolve();
    initializing = (async () => {
      const daemon = getDaemon();
      await null;
      if (stopped) throw Fail`Clock service is shut down`;
      if (!config) {
        const intent = harden({
          version: /** @type {const} */ (1),
          allocationId: randomId(),
          secret: randomId(),
        });
        // Persist an unguessable allocation intent before giving any vat the
        // scheduler. A public debug label is not proof of system ownership.
        storage.write(JSON.stringify(intent));
        config = intent;
      }
      const label = `durable-clock:${config.allocationId}`;
      if (config.workerId === undefined) {
        const candidates = daemon
          .inspectWorkers()
          .filter(worker => worker.debugLabel === label);
        candidates.length <= 1 || Fail`Ambiguous interrupted clock allocation`;
        const workerId =
          candidates[0]?.workerId ??
          (await daemon.createWorker({ debugLabel: label })).workerId;
        if (stopped) throw Fail`Clock service is shut down`;
        const selected = harden({ ...config, workerId });
        // Selection commits before initialization; recovery adopts only the
        // private allocation's vat and preserves its existing clockKit.
        storage.write(JSON.stringify(selected));
        config = selected;
      }
      const selected = config;
      if (
        selected.workerId === undefined ||
        !daemon.listWorkerIds().includes(selected.workerId) ||
        !daemon
          .inspectWorkers()
          .some(
            worker =>
              worker.workerId === selected.workerId &&
              worker.debugLabel === label,
          )
      ) {
        throw Fail`Clock metadata does not select a clock vat`;
      }
      const worker = daemon.getWorker(selected.workerId);
      const resource = daemon.makeResource('alarm-scheduler', {
        workerId: selected.workerId,
      });
      const kit = await worker.evaluate(
        `(globalThis.clockKit ??= (${makeDurableClock.toString()})(scheduler))`,
        { scheduler: resource },
      );
      if (stopped) throw Fail`Clock service is shut down`;
      const control = await E(kit).getControl();
      if (stopped) throw Fail`Clock service is shut down`;
      daemon.publish(control, selected.secret);
      clock = await E(kit).getClock();
      if (stopped) throw Fail`Clock service is shut down`;
      await provideScheduler().start();
      if (stopped) throw Fail`Clock service is shut down`;
      initialized = true;
      resolveReady();
    })().catch(error => {
      failure = error;
      rejectReady(error);
      throw error;
    });
    return initializing;
  };

  return harden({
    /** @param {unknown} description */
    resource: description => {
      if (
        !description ||
        typeof description !== 'object' ||
        !('workerId' in description) ||
        description.workerId !== config?.workerId ||
        config?.workerId === undefined
      ) {
        throw Fail`Invalid alarm scheduler description`;
      }
      const instance = provideScheduler();
      schedulerResource ??= Far('ClockSchedulerResource', {
        /**
         * @param {bigint} id
         * @param {bigint} deadline
         */
        schedule: async (id, deadline) => {
          await ready;
          !stopped || Fail`Clock service is shut down`;
          return E(instance.resource()).schedule(id, deadline);
        },
        now: async () => {
          await ready;
          !stopped || Fail`Clock service is shut down`;
          return E(instance.resource()).now();
        },
      });
      return schedulerResource;
    },
    start: () => initialize(false),
    getClock: async () => {
      await initialize(true);
      return clock;
    },
    status: () =>
      harden({
        configured: config !== undefined,
        workerId: config?.workerId,
        initialized,
        stopped,
        scheduler: scheduler?.status(),
        error: failure === undefined ? undefined : String(failure),
      }),
    shutdown: async () => {
      stopped = true;
      rejectReady(Error('Clock service is shut down'));
      const [cleanup] = await Promise.allSettled([
        Promise.resolve().then(() => scheduler?.shutdown()),
        initializing,
      ]);
      if (cleanup.status === 'rejected') throw cleanup.reason;
    },
  });
};
harden(makeClockService);
