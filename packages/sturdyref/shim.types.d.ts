import type { SturdyRefConstructor } from './src/sturdyref-shim.js';

declare global {
  /**
   * The realm's shared `SturdyRef` constructor, installed first-wins by
   * `@endo/sturdyref/shim.js` (or lazily on first ponyfill use).
   */
  // eslint-disable-next-line vars-on-top
  var SturdyRef: SturdyRefConstructor;
}

export {};
