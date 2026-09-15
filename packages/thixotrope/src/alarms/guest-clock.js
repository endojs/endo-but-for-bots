// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * A clock that lives in the guest vat that uses it.
 *
 * This replaces a host-side clock service. There is
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

  /** @param {bigint} deadline */
  const arm = async deadline => {
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
  };

  return Far('GuestClock', {
    help: () =>
      'when(deadline) settles durably at or after Unix milliseconds; arm(deadline) also returns a capability to cancel that one alarm; now() reads host time.',

    /**
     * Arm an alarm and hand back a promise that settles at or after the
     * deadline, with the host time it settled at.
     *
     * Arming is an ordinary host call, so a host restart in the middle of it
     * rejects — the caller learns the alarm was not armed, which is true. The
     * waiting afterwards is durable, which is the part that matters.
     *
     * @param {bigint} deadline
     * @returns {Promise<bigint>}
     */
    when: async deadline => {
      const { settlement } = await arm(deadline);
      return settlement;
    },

    /**
     * `when`, plus the authority to cancel this one alarm.
     *
     * The cancel is a capability rather than an id, and there is deliberately
     * no way to list alarms. This clock is shared through the inventory, so a
     * holder that could enumerate or name alarms by id could see and cancel
     * ones armed by every other holder.
     *
     * @param {bigint} deadline
     */
    arm: async deadline => {
      const { id, settlement } = await arm(deadline);
      return harden({
        settlement,
        canceller: Far('AlarmCanceller', {
          cancel: () => {
            pending.delete(id);
            return E(alarms).cancel(id);
          },
        }),
      });
    },

    now: () => E(alarms).now(),
  });
};
harden(makeGuestClock);
