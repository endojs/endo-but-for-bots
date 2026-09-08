// @ts-check
/** @import { E as EType, Far as FarType } from '@endo/far' */
const { E, Far } =
  /** @type {typeof globalThis & {E: typeof EType, Far: typeof FarType}} */ (
    globalThis
  );

/** @param {{clock: any}} powers */
export const make = ({ clock }) => {
  let count = 0n;
  let nextId = 0n;
  /** @type {Array<{id: bigint, deadline: bigint, message: string, state: string, firedAt?: bigint, error?: string}>} */
  const items = [];
  return Far('ReminderApplication', {
    help: () =>
      'arm(deadline, message) records a reminder; status() reports its durable listener state and firing count.',
    /**
     * @param {bigint} deadline
     * @param {string} message
     */
    arm: (deadline, message) => {
      if (
        typeof deadline !== 'bigint' ||
        deadline < 0n ||
        deadline >= 2n ** 63n ||
        typeof message !== 'string'
      )
        throw Error('Expected a signed 64-bit Unix deadline and message');
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
