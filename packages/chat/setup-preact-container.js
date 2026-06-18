// @ts-check

// Chat's local entry point for `@endo/preact-container`.
//
// `@endo/preact-container` mounts *untrusted* Preact component code (e.g. a
// guest-supplied widget the host evaluated in a SES `Compartment`) inside an
// ordinary Preact tree without handing it the live DOM. The package documents
// a hard precondition: `lockdown()` must run — with `overrideTaming: 'severe'`
// specifically — before any untrusted component source is evaluated. Two
// independent reasons (see the package README for detail):
//
//   1. Containment integrity. Without `lockdown()`, every endowment handed to
//      confined code reaches the host realm's `Function` via `.constructor`
//      (`endowments.h.constructor('return globalThis')()`). `lockdown()` tames
//      the `Function` constructor and that escape ceases to exist.
//
//   2. `overrideTaming: 'severe'` is *required for Preact to run at all*.
//      Preact instantiates function components by assigning
//      `component.constructor = type`, which hits the SES "override mistake"
//      under the default lockdown. `'severe'` enables `'%ObjectPrototype%':
//      '*'`, making `constructor` overridable so the assignment succeeds.
//      `'min'` and `'moderate'` do not.
//
// IMPORTANT: importing this module calls `lockdown()`, which freezes the
// realm's primordials. The main chat realm deliberately never locks down
// (Monaco and other dependencies rely on mutable intrinsics — see `main.js`),
// so this module is intended to run in its own realm/boundary (an iframe or
// worker) rather than being imported from the main bundle. Keeping the
// confined-Preact surface and the Monaco surface in separate realms is the
// path that reconciles the two taming requirements.

import 'ses';

// `lockdown` is installed on `globalThis` by `import 'ses'` above. Specify the
// taming level `@endo/preact-container` requires.
lockdown({ overrideTaming: 'severe' });

export {
  confineComponent,
  isConfinedComponent,
} from '@endo/preact-container/compartment';

export {
  renderConfined,
  unmount,
  HostPassthrough,
  h,
  Fragment,
  createElement,
} from '@endo/preact-container/renderer';
