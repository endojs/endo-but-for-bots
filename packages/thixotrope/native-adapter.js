// @ts-check
// A native resource's `ephemeral.js` runs in a Node process with ordinary
// module resolution and imports the adapter kit from here; the physical file
// is the fall-through resolution for Node versions without `exports` support.
export { makeAdapter } from './src/native/adapter-kit.js';
