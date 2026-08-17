/**
 * Public type surface for `@endo/claude`.
 *
 * The runtime entry is the maker `make` (see `./index.js`); these are the types a
 * consumer or a deployment companion needs: the `InferResult` union (Design
 * Decision 8), the powers record `make` takes, and the branded 64-hex guest
 * formula id.
 */

export type { InferResult } from './src/results.js';
export type { GuestFormulaId } from './src/formula-id.js';
export type {
  Broker,
  HarnessOptions,
  LaunchSpec,
  SpawnFiles,
} from './src/harness.js';
export type {
  McpTransport,
  StdioTransport,
  HttpTransport,
} from './src/mcp-config.js';
export type {
  Subscription,
  AcquireResult,
  AcquiredSlot,
  PoolExhausted,
} from './src/credentials-pool.js';
export type {
  PinnedCatalog,
  McpToolDescriptor,
} from './src/tool-permissions.js';
