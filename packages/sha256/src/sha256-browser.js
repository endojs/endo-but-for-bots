// @ts-check

/**
 * Browser (and `default`) build of `@endo/sha256`: the pure-JavaScript
 * synchronous digest.  WebCrypto is not used because it is
 * asynchronous; see `designs/platform-neutral-hash.md`.
 *
 * This is also the build any bundler that sets neither `node` nor `xs`
 * resolves.
 */

export { jsSha256 as sha256, jsSha256Into as sha256Into } from './sha256-js.js';
