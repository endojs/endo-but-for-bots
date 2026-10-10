// @ts-check
import { initialCount } from './initial-count.js';

/** @import { Far as FarType } from '@endo/far' */
// The guest realm supplies Far; the type import does not bundle its library.
const { Far } = /** @type {typeof globalThis & { Far: typeof FarType }} */ (
  globalThis
);

/** @param {{}} powers */
export const make = powers => {
  let count = initialCount;
  return Far('CounterApplication', {
    help: () => 'incr() increments the persistent counter; read() returns it.',
    incr: () => {
      count += 1n;
      return count;
    },
    read: () => count,
    powerNames: () => harden(Object.keys(powers)),
  });
};
harden(make);
