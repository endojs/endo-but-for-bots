// @ts-check
/** @import { GuestGlobals } from '../../../guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);
const globals = /** @type {any} */ (globalThis);
globals.nativeModuleInitializations = (globals.nativeModuleInitializations ?? 0) + 1;
export const make = () => {
  let starts = 0;
  return harden({
    facet: Far('Registration', {
      starts: () => starts,
      initializations: () => globals.nativeModuleInitializations,
      setMarker: value => { globals.marker = value; },
      getMarker: () => globals.marker,
    }),
    lifecycle: Far('Lifecycle', {started: () => { starts += 1; }, exited: () => {}}),
  });
};
harden(make);
