/* The eager first-wins shim entry.
 *
 * Import this in a lockdown bootstrap, BEFORE or AFTER `lockdown()`, to race
 * to install the `SturdyRef` constructor at `globalThis.SturdyRef`
 * immediately. Like the `HandledPromise` shim, installing BEFORE `lockdown()`
 * is preferred: SES then admits `SturdyRef` as a shared intrinsic, hardens it,
 * and gives it to every child compartment. Installing before `lockdown()` does
 * not use `@endo/harden`, so it does not trip `lockdown`'s prior-harden check.
 * First-wins makes this idempotent: importing it in many eval twins converges
 * on one constructor.
 */

import { provideSturdyRef } from './src/sturdyref-shim.js';

provideSturdyRef();
