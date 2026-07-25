/* The workspace `.` export of `@endo/sturdyref` carries no types condition, so
 * type-checking this package reaches the shim's source without the ambient
 * `globalThis.SturdyRef` declaration it relies on. Import the `./shim.js`
 * export, whose types condition is `shim.types.d.ts`, to bring that global
 * declaration into the program. */
import '@endo/sturdyref/shim.js';
