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
} from './src/claude.types.js';

export type {
  ChildProcessLike,
  ClaudeCliBackendOptions,
  ClaudeCodeResponse,
  ClaudeSdkBackendOptions,
  ClaudeStreamReducer,
  CliArgumentsSpec,
  ConstructedEnvironmentSpec,
  ScratchDirectory,
  SdkOptionsSpec,
  SdkQuery,
  Spawn,
  SpawnOptions,
  StdioProjection,
  StreamReduction,
  StreamTerminal,
  TurnOutcomeSpec,
} from './src/backends.types.js';
