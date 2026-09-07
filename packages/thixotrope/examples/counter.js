// @ts-check
/* global Far */
import { initialCount } from './initial-count.js';

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
