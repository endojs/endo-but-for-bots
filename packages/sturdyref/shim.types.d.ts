import type { SturdyRefNamespace } from './src/sturdyref-shim.js';

declare global {
  /**
   * The realm's shared `SturdyRef` namespace, installed first-wins by
   * `@endo/sturdyref/shim.js` (or lazily on first ponyfill use). It has no SES
   * permit and is withheld from child compartments by construction.
   */
  // eslint-disable-next-line no-var, vars-on-top
  var SturdyRef: SturdyRefNamespace;
}

export {};
