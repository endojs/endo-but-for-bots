/**
 * Public type surface for `@endo/claude`.
 *
 * The runtime entry is the maker `make` (see `./index.js`); these are the types a
 * consumer or a deployment companion needs: the `InferResult` union (Design
 * Decision 8), the powers record `make` takes, and the branded 64-hex guest
 * formula id.
 */

export type {
  AcquireResult,
  AcquiredSlot,
  Broker,
  GuestFormulaId,
  HarnessOptions,
  HttpTransport,
  InferResult,
  LaunchSpec,
  McpToolDescriptor,
  McpTransport,
  PinnedCatalog,
  PoolExhausted,
  SpawnFiles,
  StdioTransport,
  Subscription,
} from './src/types.js';
