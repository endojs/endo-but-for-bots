/* The eager first-wins shim entry.
 *
 * Import this in a lockdown bootstrap AFTER `lockdown()` — as with
 * `@endo/immutable-arraybuffer/shim.js` — to race to install the hardened
 * `SturdyRef` constructor at `globalThis.SturdyRef` immediately. First-wins
 * makes this idempotent: importing it in many eval twins converges on one
 * constructor.
 */

import { provideSturdyRef } from './src/sturdyref-shim.js';

provideSturdyRef();
