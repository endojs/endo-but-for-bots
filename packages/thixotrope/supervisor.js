// @ts-check
// Host composition entry for one local supervisor over a state directory.
// It takes every power from its `platform` argument (compose with
// `@endo/thixotrope/node-powers.js` on Node); importing it grants no I/O.
export { serveThixotrope } from './src/control/supervisor.js';
