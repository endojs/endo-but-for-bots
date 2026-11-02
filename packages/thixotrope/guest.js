// @ts-check
// Guest code imports the prelude's type from here, so that a bundled module
// can read the guest globals off `globalThis` with one typed destructure; the
// physical file is the fall-through resolution for Node versions without
// `exports` support. Nothing here runs.
/** @import { GuestGlobals } from './src/guest/prelude.js' */
/** @typedef {GuestGlobals} GuestGlobals */
export {};
