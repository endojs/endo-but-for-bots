// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * A clock that lives in the guest vat that uses it.
 *
 * This is the manual-persistence counterpart to `clock-service.js`. There is
 * no host-side registry of alarms, no control facet the host calls into, and
 * no reconciliation: the map below is the only record, and orthogonal
 * persistence keeps it — resolvers included — across sleep and host restart.
 *
 * The host contributes one thing a vat cannot do for itself: a promise that
 * settles at a deadline and survives the host's own restart. Listening on it
 * is what wakes this vat when the time comes.
 *
 * Self-contained, because the supervisor ships this factory's source into a
 * vat where only E, Far and harden are in scope.
 *
 * @param {any} alarms a DurableAlarms facet
 */
export const makeGuestClock = alarms => {
  let nextId = 0n;
  /** @type {Map<string, bigint>} */
  const pending = new Map();

  /** @param {unknown} deadline */
  const assertDeadline = deadline => {
    if (
      typeof deadline !== 'bigint' ||
      deadline < 0n ||
      deadline > 2n ** 63n - 1n
    )
      throw Error('Deadline must be nonnegative signed 64-bit milliseconds');
  };

  return Far('GuestClock', {
    help: () =>
      'when(deadline) settles durably at or after Unix milliseconds; cancel(id) breaks a pending alarm; now() reads host time; pending() lists outstanding alarms.',

    /**
     * Arm an alarm and hand back the host's promise for it.
     *
     * Arming is an ordinary host call, so a host restart in the middle of it
     * rejects — the caller learns the alarm was not armed, which is true. The
     * waiting afterwards is durable, which is the part that matters.
     *
     * @param {bigint} deadline
     */
    when: async deadline => {
      assertDeadline(deadline);
      nextId += 1n;
      const id = `${nextId}`;
      // The host hands the promise over inside a record; see durable-alarms.js.
      const { settlement } = await E(alarms).arm(id, deadline);
      pending.set(id, deadline);
      // Forget the record once it settles, however it settles; the host has
      // already dropped its own row.
      const forget = () => pending.delete(id);
      void Promise.resolve(settlement).then(forget, forget);
      return harden({ id, settlement });
    },

    /** @param {string} id */
    cancel: async id => {
      pending.delete(id);
      return E(alarms).cancel(id);
    },

    now: () => E(alarms).now(),

    pending: () =>
      harden([...pending].map(([id, deadline]) => harden({ id, deadline }))),
  });
};
harden(makeGuestClock);
