// @ts-check
const globals = /** @type {any} */ (globalThis);
globals.nativeModuleInitializations = (globals.nativeModuleInitializations ?? 0) + 1;
/** @param {{Far: any}} powers */
export const make = ({Far}) => {
  let starts = 0;
  return harden({
    registration: Far('Registration', {
      starts: () => starts,
      initializations: () => globals.nativeModuleInitializations,
      setMarker: value => { globals.marker = value; },
      getMarker: () => globals.marker,
    }),
    lifecycle: Far('Lifecycle', {started: () => { starts += 1; }}),
  });
};
harden(make);
