// @ts-check

/**
 * Public entry point for `@endo/ocapn`.
 *
 * The exports map deliberately keeps the public runtime surface tiny:
 * this main entry (which re-exports swissnum helpers below) plus
 * explicit netlayer subpaths such as `@endo/ocapn/netlayer/ws` for the
 * websocket transport. Any new value or type that consumers need should
 * be added here in preference to opening another subpath, since each
 * subpath is a long-term API commitment.
 *
 * Note for typedef forwards below: a JS `export *` does NOT re-export
 * `@typedef` declarations — typedefs aren't part of the runtime
 * namespace, and JSDoc-checkJs only finds them by direct module
 * identity. Forwarding them with explicit `@typedef {import(...)}`
 * lines is what makes `@import { Foo } from '@endo/ocapn'` resolve in
 * downstream JSDoc.
 *
 * @typedef {import('./src/client/types.js').SwissNum} SwissNum
 * @typedef {import('./src/codecs/components.js').OcapnLocation} OcapnLocation
 * @typedef {import('./src/client/sturdyref-uri.js').ParsedSturdyRefUri} ParsedSturdyRefUri
 */

export { makeOcapn } from './src/client/index.js';
// The SturdyRef session-manager tracker: minting a wire-tier SturdyRef
// (with its `(location, swissNum)` details held off-band so the codec can
// serialize it) and revealing those details. Promoted onto the public
// surface for the daemon's own OCapN client, which mints and serves
// SturdyRefs without standing up a full networked `makeOcapn` session
// (see designs/sturdy-refs-cross-peer-bridge.md § "Mint and export").
export { makeSturdyRefTracker } from './src/client/sturdyrefs.js';
export {
  decodeSwissnum,
  swissnumFromBytes,
  swissnumToBytes,
  // The canonical, secret-independent id of a peer location (an `ocapn://…`
  // string). Promoted onto the public surface for the daemon's foreign-
  // SturdyRef dedup index (design cut 5): two internalizations of the same
  // `(location, swissNum)` must key on the same location id to converge on one
  // formula identifier.
  locationToLocationId,
} from './src/client/util.js';
export {
  parseSturdyRefUri,
  formatSturdyRefUri,
} from './src/client/sturdyref-uri.js';
