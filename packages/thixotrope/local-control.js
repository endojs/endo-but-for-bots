// @ts-check
// Client of a supervisor's local control socket. The socket and random
// powers come from the caller (`@endo/thixotrope/node-powers.js` on Node);
// importing it grants no I/O.
export { connectLocalControl } from './src/control/local-control.js';
