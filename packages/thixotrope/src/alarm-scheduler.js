// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import { clearTimeout, setTimeout } from 'node:timers';

/**
 * Reconstructible host timer index. The guest clock owns durable registrations.
 * Each host observation has a bounded lifetime and its own disposable session.
 * @param {{openClient: () => Promise<any>, secret: string,
 * now?: () => bigint, setTimer?: (callback: () => void, ms: number) => any,
 * clearTimer?: (handle: any) => void, retryMs?: number,
 * requestTimeoutMs?: number}} options
 */
export const makeAlarmScheduler = ({
  openClient,
  secret,
  now = () => BigInt(Date.now()),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  retryMs = 1000,
  requestTimeoutMs = 30_000,
}) => {
  if (!Number.isInteger(retryMs) || retryMs < 1 || retryMs > 2 ** 31 - 1)
    throw Error('Invalid alarm retry interval');
  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 2 ** 31 - 1
  )
    throw Error('Invalid alarm request timeout');
  const maximum = 2n ** 63n - 1n;
  /** @type {Map<bigint, {deadline: bigint, busy: boolean, retryAt: bigint}>} */
  const alarms = new Map();
  /** @type {Set<() => void>} */
  const cancellations = new Set();
  /** @type {Set<any>} */
  const cleanup = new Set();
  /** @type {Set<Promise<any>>} */
  const openings = new Set();
  /** @type {Set<Promise<any>>} */
  const observations = new Set();
  /** @type {Promise<void> | undefined} */
  let stopping;
  let stopped = false;
  let running = false;
  /** @type {Promise<void> | undefined} */
  let starting;
  let scanning = false;
  let lastError;
  let timer;
  /** @param {unknown} value */
  const assertTime = value => {
    if (typeof value !== 'bigint' || value < 0n || value > maximum)
      throw Error('Expected nonnegative signed 64-bit milliseconds');
  };
  const time = () => {
    const value = now();
    assertTime(value);
    return value;
  };
  /** @param {any} client */
  const closeClient = client => {
    cleanup.add(client);
    client.close();
    cleanup.delete(client);
  };
  /** @param {(control: any) => Promise<any>} action */
  const observe = async action => {
    if (stopped) throw Error('Alarm scheduler stopped');
    if (cleanup.size) throw Error('Alarm observation cleanup is pending');
    let expired = false;
    /** @type {any} */
    let client;
    let timeout;
    let cancel = () => {};
    const interrupted = new Promise((resolve, reject) => {
      cancel = () => {
        expired = true;
        reject(
          Error(
            stopped ? 'Alarm scheduler stopped' : 'Alarm request timed out',
          ),
        );
      };
      timeout = setTimer(cancel, requestTimeoutMs);
      cancellations.add(cancel);
    });
    const operation = (async () => {
      const opening = Promise.resolve().then(openClient);
      openings.add(opening);
      let opened;
      try {
        opened = await opening;
      } finally {
        openings.delete(opening);
      }
      if (expired || stopped) {
        closeClient(opened);
        throw Error('Alarm request expired');
      }
      client = opened;
      const control = await opened.lookup(secret);
      if (expired || stopped) throw Error('Alarm request expired');
      return action(control);
    })();
    try {
      return await Promise.race([operation, interrupted]);
    } finally {
      expired = true;
      clearTimer(timeout);
      cancellations.delete(cancel);
      if (client !== undefined) closeClient(client);
    }
  };
  /** @param {(control: any) => Promise<any>} action */
  const invoke = action => {
    const observation = observe(action);
    observations.add(observation);
    const finished = () => observations.delete(observation);
    void observation.then(finished, finished);
    return observation;
  };
  /**
   * @param {bigint} id
   * @param {bigint} deadline
   */
  const register = (id, deadline) => {
    if (stopped) throw Error('Alarm scheduler stopped');
    assertTime(deadline);
    if (typeof id !== 'bigint' || id <= 0n) throw Error('Invalid alarm id');
    const existing = alarms.get(id);
    if (existing) {
      if (existing.deadline !== deadline)
        throw Error('Alarm deadline mismatch');
      return true;
    }
    if (alarms.size >= 1024) throw Error('Too many pending alarms');
    alarms.set(id, { deadline, busy: false, retryAt: 0n });
    return true;
  };
  const reconcile = async () => {
    if (scanning || stopped) return;
    scanning = true;
    try {
      const pending = await invoke(control => E(control).pending());
      if (stopped) return;
      if (!Array.isArray(pending) || pending.length > 1024)
        throw Error('Invalid pending alarm list');
      for (const { id, deadline } of pending) register(id, deadline);
    } finally {
      scanning = false;
    }
  };
  /** @param {unknown} error */
  const report = error => {
    lastError = String(error).slice(0, 1024);
  };
  const dispatch = () => {
    if (!running || stopped) return;
    const current = time();
    for (const [id, alarm] of alarms) {
      if (
        !alarm.busy &&
        alarm.deadline <= current &&
        alarm.retryAt <= current
      ) {
        alarm.busy = true;
        void invoke(control => {
          const deliveryTime = time();
          if (deliveryTime < alarm.deadline)
            throw Error('Alarm is no longer due after clock change');
          return E(control).fire(id, alarm.deadline, deliveryTime);
        })
          .then(result => {
            if (result !== true) throw Error('Invalid alarm acknowledgment');
            alarms.delete(id);
          })
          .catch(report)
          .finally(() => {
            alarm.busy = false;
            try {
              alarm.retryAt = time() + BigInt(retryMs);
            } catch (error) {
              report(error);
              alarm.retryAt = current + BigInt(retryMs);
            }
          });
      }
    }
  };
  const tick = () => {
    if (!running || stopped) return;
    try {
      for (const client of cleanup) closeClient(client);
      dispatch();
      void reconcile().catch(report);
    } catch (error) {
      report(error);
    }
    timer = setTimer(tick, retryMs);
  };
  const resource = Far('AlarmScheduler', {
    schedule: register,
    now: time,
  });
  return harden({
    resource: () => resource,
    start: async () => {
      if (stopped) throw Error('Alarm scheduler stopped');
      if (running) return;
      starting ??= (async () => {
        await reconcile();
        if (stopped) throw Error('Alarm scheduler stopped');
        running = true;
        tick();
      })();
      try {
        await starting;
      } catch (error) {
        starting = undefined;
        throw error;
      }
    },
    shutdown: () => {
      stopping ??= (async () => {
        stopped = true;
        running = false;
        clearTimer(timer);
        for (const cancel of cancellations) cancel();
        // Cancelling observations runs their finally cleanup without waiting
        // for guest promises. Local client creation itself must finish before
        // the caller can release the daemon's store ownership.
        await Promise.allSettled([...observations]);
        await Promise.allSettled([...openings]);
        // A late opening closes itself before its awaiting continuation yields.
        // Failed closes remain here for one last attempt, and are surfaced if
        // cleanup still cannot commit.
        let failure;
        for (const client of cleanup) {
          try {
            closeClient(client);
          } catch (error) {
            failure ??= error;
          }
        }
        if (failure !== undefined) throw failure;
      })();
      return stopping;
    },
    status: () =>
      harden({
        running,
        pending: alarms.size,
        observations: cancellations.size,
        pendingCleanups: cleanup.size,
        error: lastError,
      }),
  });
};
harden(makeAlarmScheduler);
