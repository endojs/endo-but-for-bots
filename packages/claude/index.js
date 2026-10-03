// @ts-check
// reexport-policy-exempt: this is the package's own entry point, not a
// compatibility shim; its re-exports are the public API.
//
// `@endo/claude`: confined `claude -p` inference for an Endo guest from a Claude
// subscription, whose only capability surface is the MCP projection of one guest
// formula's granted facet.
//
// The public entry is the maker `make(powers, context, options)` (the in-tree
// caplet-module contract), which returns a host-only `inferenceProvider` exo.
// See README.md and designs/endo-claude.md for the confinement contract.

export { make } from './src/harness.js';

// Re-exported building blocks (the confinement primitives), so a deployment
// companion or a test can drive them directly. The confinement contract lives in
// these modules, not in the maker alone.
export {
  pruneAndPinCatalog,
  deriveAllowList,
  isDispatchable,
  isAdmissibleToolName,
  catalogToolNames,
  KNOWN_BUILTIN_TOOLS,
} from './src/tool-permissions.js';
export {
  buildArgv,
  assertConfinedArgv,
  assertPinnedVersion,
  REQUIRED_FLAGS,
  PINNED_CLI_VERSION,
} from './src/argv.js';
export {
  buildChildEnv,
  assertChildEnvAllowed,
  ALLOWED_ENV_KEYS,
} from './src/child-env.js';
export { renderMcpConfig, serializeMcpConfig } from './src/mcp-config.js';
export {
  makeCredentialsPool,
  renderApiKeyHelperSettings,
} from './src/credentials-pool.js';
export { assertGuestFormulaId, isGuestFormulaId } from './src/formula-id.js';
export { INFER_RESULT_TYPES } from './src/results.js';

// The confined shape: the harness-owned broker and relay from
// `@endo/agent-mcp-stdio`, composed with this package's argv, environment, and
// launch (designs/endo-guest-stdio-mcp.md § How the confinement properties
// change, shape 1).
export {
  runConfinedTurn,
  readClaudeVersion,
  makeGuestConnect,
} from './src/confined-turn.js';
export { makeLaunch, resultFromStream } from './src/launch.js';
export { makeSpawnFilesPreparer } from './src/spawn-files.js';
