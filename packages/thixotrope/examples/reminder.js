// @ts-check
/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, makeExo, M } = /** @type {GuestGlobals} */ (globalThis);

// A signed 64-bit Unix deadline in milliseconds, as the clock takes it.
const DeadlineShape = M.and(M.bigint(), M.gte(0n), M.lt(2n ** 63n));

const ReminderI = M.interface('ReminderApplication', {
  help: M.call().returns(M.string()),
  arm: M.call(DeadlineShape, M.string()).returns(M.boolean()),
  status: M.call().returns(M.record()),
});

/** @param {{clock: any}} powers */
export const make = ({ clock }) => {
  let count = 0n;
  let nextId = 0n;
  /** @type {Array<{id: bigint, deadline: bigint, message: string, state: string, firedAt?: bigint, error?: string}>} */
  const items = [];
  return makeExo('ReminderApplication', ReminderI, {
    help: () =>
      'arm(deadline, message) records a reminder; status() reports its durable listener state and firing count.',
    /**
     * @param {bigint} deadline
     * @param {string} message
     */
    arm: (deadline, message) => {
      nextId += 1n;
      /** @type {(typeof items)[number]} */
      const item = { id: nextId, deadline, message, state: 'waiting' };
      items.push(item);
      void E(clock)
        .when(deadline)
        .then(
          firedAt => {
            item.state = 'fired';
            item.firedAt = firedAt;
            count += 1n;
          },
          error => {
            item.state = 'failed';
            item.error = String(error);
          },
        );
      return true;
    },
    status: () =>
      harden({ count, items: items.map(item => harden({ ...item })) }),
  });
};
harden(make);
