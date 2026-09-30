// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * A clock that lives in the guest vat that uses it.
 *
 * Orthogonal persistence keeps this clock's promises and outstanding cleanup
 * acknowledgements across sleep and restart. The host retains deadlines and
 * outcomes only until this vat has recorded a local settlement.
 *
 * The host contributes one thing a vat cannot do for itself: a promise that
 * settles at a deadline and survives the host's own restart. Listening on it
 * is what wakes this vat when the time comes.
 *
 * Shipped by source: the supervisor evaluates this factory in a vat, so it
 * may import only what the guest prelude provides, under those names.
 *
 * @param {any} alarms a DurableAlarms facet
 * @param {object} options
 * @param {string} options.restartMessage the message a host answer carries
 *   when it was broken by a host restart (`PENDING_ANSWER_ABORTED_MESSAGE`
 *   from `@endo/ocapn`); only the message crosses the wire, and only this
 *   one failure is worth retrying at once
 */
export const makeGuestClock = (alarms, { restartMessage }) => {
  let nextId = 0n;
  /** @type {Set<string>} */
  const releases = new Set();
  /** @type {Map<string, Promise<void>>} */
  const releasing = new Map();

  /** @param {string} id @returns {Promise<void>} */
  const release = id => {
    const existing = releasing.get(id);
    if (existing) return existing;
    const job = (async () => {
      for (;;) {
        try {
          // Idempotent even if the host committed this call before restart.
          // eslint-disable-next-line no-await-in-loop
          await E(alarms).release(id);
          releases.delete(id);
          return;
        } catch (error) {
          if (/** @type {Error} */ (error).message !== restartMessage) {
            // Storage or other persistent failures retry on the next arm,
            // rather than spinning. Only restart aborts retry immediately.
            return;
          }
        }
      }
    })().finally(() => releasing.delete(id));
    releasing.set(id, job);
    return job;
  };

  // Only arming pays for outstanding cleanup: it is the one operation that
  // needs a row, and a release that failed for a persistent reason should not
  // be re-issued by every reading of the clock. A vat that never arms again
  // therefore keeps its unreleased rows until it is retired; they count
  // against the shared limit, which is acceptable because a persistent
  // storage failure on the host affects every vat's rows alike.
  const retryReleases = () =>
    releases.size === 0
      ? Promise.resolve([])
      : Promise.all([...releases].map(release));
  /** @param {string} id */
  const queueRelease = id => {
    releases.add(id);
    void release(id);
  };

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
    await retryReleases();
    nextId += 1n;
    const id = `${nextId}`;
    try {
      // Only this vat observes the host promise. Callers, including other vats,
      // receive a local promise whose settlement persists before the outbound
      // release is delivered to the host.
      const { settlement: hostSettlement } = await E(alarms).arm(id, deadline);
      const settlement = Promise.resolve(hostSettlement).then(
        at => {
          queueRelease(id);
          return at;
        },
        error => {
          queueRelease(id);
          throw error;
        },
      );
      // A discarded alarm must not produce an unhandled rejection.
      void settlement.catch(() => {});
      return harden({ id, settlement });
    } catch (error) {
      // An interrupted answer does not prove the host failed to arm it.
      queueRelease(id);
      throw error;
    }
  };

  return Far('GuestClock', {
    help: () =>
      'when(deadline) settles durably at or after Unix milliseconds; arm(deadline) also returns a capability to cancel that one alarm; now() reads host time.',

    /**
     * Arm an alarm and hand back a promise that settles at or after the
     * deadline, with the host time it settled at.
     *
     * Arming is an ordinary host call, so a host restart in the middle of it
     * rejects. The clock releases any host row left by that interrupted call.
     * Once arming succeeds, the waiting afterwards is durable.
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
          cancel: () => E(alarms).cancel(id),
        }),
      });
    },

    now: () => E(alarms).now(),
  });
};
harden(makeGuestClock);
