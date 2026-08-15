// @ts-check

// Re-export the platform-agnostic HTTP server core, so a Node consumer
// gets `makeHttpServer` and the interface guard from one import
// (mirrors `fs-node/index.js` re-exporting the lite `fs` module).
export * from '../http/server.js';

// Node.js-specific backend.
export { makeNodeHttpBackend } from './backend.js';
