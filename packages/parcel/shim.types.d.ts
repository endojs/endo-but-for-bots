import type { ParcelConstructor } from './src/parcel-shim.js';

declare global {
  /**
   * The realm's initial `Parcel` constructor, installed first-wins by
   * `@endo/parcel/shim.js` (or lazily on first ponyfill use).
   */
  // eslint-disable-next-line vars-on-top
  var Parcel: ParcelConstructor;
}

export {};
