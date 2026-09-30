// @ts-check
/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
import { initialCount } from './initial-count.js';

// The guest prelude supplies these; the type import bundles nothing.
const { makeExo, M } = /** @type {GuestGlobals} */ (globalThis);

const CounterI = M.interface('CounterApplication', {
  help: M.call().returns(M.string()),
  incr: M.call().returns(M.bigint()),
  read: M.call().returns(M.bigint()),
  powerNames: M.call().returns(M.arrayOf(M.string())),
});

/** @param {{}} powers */
export const make = powers => {
  let count = initialCount;
  return makeExo('CounterApplication', CounterI, {
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
