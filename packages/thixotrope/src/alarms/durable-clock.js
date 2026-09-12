// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * Self-contained guest factory. Only the public clock is granted to programs;
 * the host keeps the control facet for recovery and delivery.
 * @param {any} scheduler
 */
export const makeDurableClock = scheduler => {
  const maximum = 2n ** 63n - 1n;
  let nextId = 0n;
  /** @type {Map<bigint, {deadline: bigint, resolve: (value: bigint) => void}>} */
  const alarms = new Map();
  /** @param {unknown} deadline */
  const validDeadline = deadline => {
    if (typeof deadline !== 'bigint' || deadline < 0n || deadline > maximum)
      throw Error('Deadline must be nonnegative signed 64-bit milliseconds');
  };
  const clock = Far('DurableClock', {
    help: () =>
      'when(deadline) resolves durably at or after Unix milliseconds; now() reads host time.',
    /** @param {bigint} deadline */
    when: deadline => {
      validDeadline(deadline);
      if (alarms.size >= 1024) throw Error('Too many pending alarms');
      nextId += 1n;
      const id = nextId;
      const promise = new Promise(resolve => {
        alarms.set(id, { deadline, resolve });
      });
      // The guest map is authoritative. Startup and periodic host scans repair
      // registrations whose ephemeral acknowledgment was lost or rejected.
      void E(scheduler)
        .schedule(id, deadline)
        .catch(() => {});
      return promise;
    },
    now: () => E(scheduler).now(),
  });
  const control = Far('DurableClockControl', {
    pending: () =>
      harden([...alarms].map(([id, { deadline }]) => harden({ id, deadline }))),
    /**
     * @param {bigint} id
     * @param {bigint} deadline
     * @param {bigint} now
     */
    fire: (id, deadline, now) => {
      validDeadline(deadline);
      validDeadline(now);
      if (typeof id !== 'bigint' || id <= 0n || id > nextId)
        throw Error('Unknown alarm');
      const alarm = alarms.get(id);
      if (alarm === undefined) return true;
      if (alarm.deadline !== deadline) throw Error('Alarm deadline mismatch');
      if (now < deadline) throw Error('Alarm is not due');
      alarms.delete(id);
      alarm.resolve(now);
      return true;
    },
  });
  return Far('DurableClockKit', {
    getClock: () => clock,
    getControl: () => control,
  });
};
harden(makeDurableClock);
