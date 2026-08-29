import type { ERef } from '@endo/eventual-send';

export interface ClaudeCredentialsLike {
  issue: (sessionTag: string) => ERef<IssuedCredentialLike>;
  revoke: (sessionTag: string) => ERef<void>;
}

export interface IssuedCredentialLike {
  materialise: () => ERef<string>;
}

export interface Subscription {
  id: string;
  credentials: ClaudeCredentialsLike;
}

export interface AcquiredSlot {
  type: 'acquired';
  subscriptionId: string;
  issued: IssuedCredentialLike;
  /** Frees the occupancy slot and invalidates any outstanding grant. */
  release: (opts?: { failed?: boolean }) => Promise<void>;
}

export interface PoolExhausted {
  type: 'pool-exhausted';
  retryAfterMs?: number;
}

export type AcquireResult = AcquiredSlot | PoolExhausted;

export interface InternalSlot {
  id: string;
  credentials: ClaudeCredentialsLike;
  busy: boolean;
  coolingUntil: number;
  lastIssuedAt: number;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export type PinnedCatalog = Readonly<Record<string, McpToolDescriptor>>;

export interface StdioTransport {
  kind: 'stdio';
  command: string;
  args?: readonly string[];
}

export interface HttpTransport {
  kind: 'http';
  url: string;
  bearer: string;
}

export type McpTransport = StdioTransport | HttpTransport;

export interface Broker {
  toolsList: () => Promise<McpToolDescriptor[]>;
  transport: () => Promise<McpTransport>;
  close?: () => Promise<void>;
}

export interface LaunchSpec {
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  prompt: string;
  sessionTag: string;
  limits: {
    wallClockMs: number;
    outputByteCap: number;
    maxTurns: number;
  };
  cancelled?: unknown;
}

export interface SpawnFiles {
  mcpConfigPath: string;
  settingsPath: string;
  apiKeyHelperCommand: string;
  pathValue: string;
  cleanup: () => Promise<void>;
}

export interface HarnessOptions {
  pinnedModels: string[];
  defaultModel?: string;
  serverName?: string;
  pinnedCliVersion?: string;
  getClaudeVersion: () => Promise<string>;
  mintSessionTag: () => string;
  prepareSpawnFiles: (args: {
    sessionTag: string;
    mcpConfigJson: string;
    settingsJson: string;
  }) => Promise<SpawnFiles>;
  launch: (spec: LaunchSpec) => Promise<InferResult>;
  limits?: {
    wallClockMs: number;
    outputByteCap: number;
    maxTurns: number;
  };
}

export interface OkResult {
  type: 'ok';
  text: string;
  usage: Readonly<Record<string, number | string>>;
}

export interface RateLimitedResult {
  type: 'rate-limited';
  retryAfterMs?: number;
}

export interface PoolExhaustedResult {
  type: 'pool-exhausted';
  retryAfterMs?: number;
}

export interface BridgeDownResult {
  type: 'bridge-down';
  detail: string;
}

export interface FacetThrewResult {
  type: 'facet-threw';
  method: string;
  error: Error;
}

export interface NonzeroExitResult {
  type: 'nonzero-exit';
  code: number;
}

export interface ParseErrorResult {
  type: 'parse-error';
  detail: string;
}

export interface LimitExceededResult {
  type: 'limit-exceeded';
  which: 'wall-clock' | 'output-bytes' | 'max-turns';
}

export interface CancelledResult {
  type: 'cancelled';
  at: 'before-spawn' | 'mid-stream' | 'after-exit';
}

export type InferResult =
  | OkResult
  | RateLimitedResult
  | PoolExhaustedResult
  | BridgeDownResult
  | FacetThrewResult
  | NonzeroExitResult
  | ParseErrorResult
  | LimitExceededResult
  | CancelledResult;

export type GuestFormulaId = string & {
  readonly __brand: 'GuestFormulaId';
};
