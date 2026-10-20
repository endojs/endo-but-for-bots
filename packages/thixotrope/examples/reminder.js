// @ts-check
/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, describeError, makeExo, M } = /** @type {GuestGlobals} */ (
  globalThis
);

// A delay in milliseconds, as the clock takes it; the application never
// learns what time it is.
const DelayShape = M.and(M.bigint(), M.gte(0n), M.lte(2n ** 53n));

const ReminderI = M.interface('ReminderApplication', {
  help: M.call().returns(M.string()),
  arm: M.call(DelayShape, M.string()).returns(M.boolean()),
  status: M.call().returns(M.record()),
});

/** @param {{clock: any}} powers */
export const make = ({ clock }) => {
  let count = 0n;
  let nextId = 0n;
  /** @type {Array<{id: bigint, delay: bigint, message: string, state: string, firedAt?: bigint, error?: string}>} */
  const items = [];
  return makeExo('ReminderApplication', ReminderI, {
    help: () =>
      'arm(delay, message) records a reminder due that many milliseconds from now; status() reports its durable listener state and firing count.',
    /**
     * @param {bigint} delay
     * @param {string} message
     */
    arm: (delay, message) => {
      nextId += 1n;
      /** @type {(typeof items)[number]} */
      const item = { id: nextId, delay, message, state: 'waiting' };
      items.push(item);
      void E(clock)
        .after(delay)
        .then(
          firedAt => {
            item.state = 'fired';
            item.firedAt = firedAt;
            count += 1n;
          },
          error => {
            item.state = 'failed';
            item.error = describeError(error);
          },
        );
      return true;
    },
    status: () =>
      harden({ count, items: items.map(item => harden({ ...item })) }),
  });
};
harden(make);
