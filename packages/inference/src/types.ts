import type { Pattern } from '@endo/patterns';

/**
 * The MCP server a projection builds. `@endo/inference` depends on no MCP
 * package, so the server is opaque here; the plugin that consumes it knows
 * its concrete type.
 */
export type McpServer = unknown;

/**
 * The guest's tools as one backend turn sees them. The closure over one
 * already-resolved facet inside `buildMcpServer` is the only authority;
 * `formulaIdentifier` is a host-set audit and join label that a plugin must
 * not forward to its provider.
 */
export type GuestToolProjection = {
  buildMcpServer: () => McpServer;
  toolNames: readonly string[];
  formulaIdentifier: string;
};

export type InferLimits = {
  maxWallClockMs: number;
  maxOutputBytes: number;
  maxTurns: number;
};

export type PromptOrigin = 'root-authored' | 'guest-influenced';

export type InferRequest = {
  prompt: string;
  /**
   * Admitted as any string, so that a missing or unknown origin reaches the
   * prompt-origin gate and becomes `needs-containment` instead of a guard
   * rejection. The meaningful values are those of `PromptOrigin`.
   */
  promptOrigin?: string;
  guest: GuestToolProjection;
  limits: InferLimits;
  model?: string;
  /** Rejects to cancel the turn; never fulfills. */
  cancelled: PromiseLike<unknown>;
};

export type InferUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  turns?: number;
  durationMs?: number;
};

export type LimitName = 'wall-clock' | 'output-bytes' | 'max-turns';

export type OkResult = { type: 'ok'; text: string; usage?: InferUsage };
export type NeedsAuthResult = { type: 'needs-auth' };
export type UsageExhaustedResult = {
  type: 'usage-exhausted';
  retryAfterMs?: number;
};
export type RateLimitedResult = { type: 'rate-limited'; retryAfterMs?: number };
export type BudgetExhaustedResult = {
  type: 'budget-exhausted';
  retryAfterMs?: number;
};
export type LimitExceededResult = { type: 'limit-exceeded'; which: LimitName };
export type CancelledResult = { type: 'cancelled' };
export type NeedsContainmentResult = { type: 'needs-containment' };
/**
 * `detail` is display text and is copied into the usage record, so a plugin
 * must not put secret material or raw provider error text in it.
 */
export type UnavailableResult = { type: 'unavailable'; detail: string };

export type InferResult =
  | OkResult
  | NeedsAuthResult
  | UsageExhaustedResult
  | RateLimitedResult
  | BudgetExhaustedResult
  | LimitExceededResult
  | CancelledResult
  | NeedsContainmentResult
  | UnavailableResult;

/** The tags the pinned-table classifier may write. */
export type ClassifiedResult = Exclude<
  InferResult,
  OkResult | NeedsContainmentResult
>;

export type BackendDescription = {
  /** The vendor, such as `anthropic` or `openai`. */
  provider: string;
  /** The harness, such as `claude-cli`, `claude-sdk`, or `codex-app-server`. */
  kind: string;
  version?: string;
};

export interface InferenceBackend {
  describe(): BackendDescription;
  /** Never rejects; every outcome is an `InferResult`. */
  infer(request: InferRequest): Promise<InferResult>;
}

export type AdmissionReason =
  'rate-limited' | 'usage-exhausted' | 'budget-exhausted';

export type AdmissionRefusal = {
  reason: AdmissionReason;
  retryAfterMs?: number;
};

export type CredentialGrant = {
  type: 'granted';
  env: Record<string, string>;
  release: () => void;
};

export type CredentialRefusal = {
  type: 'refused';
  admission: AdmissionRefusal;
};

/**
 * Admission and delivery for one credential. Refusal is admission; a grant is
 * delivery. A plugin acquires once per turn and releases the grant on every
 * terminal result.
 */
export interface CredentialSource {
  acquire(): Promise<CredentialGrant | CredentialRefusal>;
}

/**
 * One record per turn. The usage recorder fills the fields it can observe;
 * the deployment supplies `secretIdentifier` at construction; the sink adds `runIdentifier`
 * and `costEstimate` when it writes; an evaluation harness adds
 * `verifiedEffect` in a comparison run.
 */
export type UsageRecord = {
  provider: string;
  backendKind: string;
  backendVersion?: string;
  /** The secret manager's identifier for the credential, never its bytes. */
  secretIdentifier: string;
  promptOrigin?: string;
  formulaIdentifier: string;
  latencyMs: number;
  resultType: InferResult['type'];
  /** `unavailable.detail` or `limit-exceeded.which`. */
  detail?: string;
  turns?: number;
  outputBytes?: number;
  usage?: InferUsage;
  runIdentifier?: string;
  costEstimate?: number;
  verifiedEffect?: boolean;
};

export interface UsageSink {
  write(record: UsageRecord): void | Promise<void>;
}

/**
 * One pinned row of a provider's response-shape table: a raw response
 * matching `pattern` classifies as `result`.
 */
export type ShapeTableEntry = {
  pattern: Pattern;
  result: ClassifiedResult;
  /**
   * Reads the refill time from the matching response, for the
   * `rate-limited`, `usage-exhausted`, and `budget-exhausted` tags.
   */
  retryAfterMs?: (response: unknown) => number | undefined;
};

/** Rows keyed by the exact provider version they were captured against. */
export type ShapeTable = Record<string, readonly ShapeTableEntry[]>;

export type ShapeClassifier = {
  versions: () => readonly string[];
  classify: (
    version: string | undefined,
    response: unknown,
  ) => ClassifiedResult | undefined;
};

export type LimitTimers = {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  // `any`, not `unknown`: the host's own `clearTimeout` takes a narrower
  // handle type and must still be assignable here.
  clearTimeout: (handle: any) => void;
};

export type LimitEnforcer = {
  countOutputBytes: (byteCount: number) => boolean;
  countTurn: () => boolean;
  abort: (result: ClassifiedResult) => void;
  outcome: () => ClassifiedResult | undefined;
  stop: () => void;
};
