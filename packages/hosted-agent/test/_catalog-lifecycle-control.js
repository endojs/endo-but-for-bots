// @ts-check

import { Far } from '@endo/far';

/** Test-only gates live in a different formula than the cancelled owner. */
export const make = () => {
  let markEntered = () => {};
  const entered = new Promise(resolve => {
    markEntered = () => resolve(undefined);
  });
  let releaseRead = () => {};
  const release = new Promise(resolve => {
    releaseRead = () => resolve(undefined);
  });
  /** @type {string[]} */
  const events = [];
  return Far('CatalogLifecycleControl', {
    note: event => {
      events.push(event);
    },
    renew: async () => {
      events.push('renew-start');
      markEntered();
      await release;
      events.push('renew-finish');
    },
    entered: () => entered,
    release: () => releaseRead(),
    events: () => harden([...events]),
  });
};
harden(make);
