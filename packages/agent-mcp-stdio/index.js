// @ts-check
// reexport-policy-exempt: this is the package's own entry point, not a
// compatibility shim; each name has no older home to deprecate.
export {
  FORMULA_ID_ENV,
  SERVER_LABEL,
  connectToDaemon,
  constructGuestMcpServer,
  makeGuestMcpServer,
  readFormulaId,
  resolveGuest,
} from './src/server.js';
export {
  hostOnlyMethods,
  makeAgentTools,
  requiredGuestMethods,
} from './src/agent-interface.js';
export { makeMcpConfig, renderGuestAllowedTools } from './src/config.js';
export { parseClaudeStreamJson } from './src/claude-stream.js';
export { serveStdio, makeLineWriter } from './src/stdio.js';
