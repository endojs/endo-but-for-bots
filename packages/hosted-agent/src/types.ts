// Types for the durable inference provider registry
// (`inference-provider-registry.js`). Key bytes never enter these records or
// the registry journal; they stay in `@secrets` and reach only the issuer
// factory. The records do hold secret-adjacent identifiers: `StableIds.grantId`
// is redeemable read authority over the key, so treat registry state (including
// `inspect()` output) as confidential.

/** Caller-preallocated identifiers for one idempotent `@secrets` import. */
export type StableIds = {
  secretId: string;
  grantId: string;
  operationId: string;
};

export type ProviderLimits = Record<string, unknown>;

export type UntrustedRequest = Record<string, unknown> | undefined;

/** The validated, key-free part of a create request, kept for idempotency. */
export type SafeCreateRequest = {
  displayName: string;
  kind: 'anthropic';
  baseUrl?: string;
  defaultModel: string;
  limits: ProviderLimits;
  supersedes?: string;
};

export type ProviderDescriptor = {
  version: 1;
  providerId: string;
  ownerId: string;
  displayName: string;
  kind: 'anthropic';
  baseUrl?: string;
  defaultModel: string;
  secretGrantFormulaId: string;
  createdAt: string;
  supersedes?: string;
};

export type LifecycleState = 'active' | 'retiring' | 'retired';

export type ProviderLifecycle = {
  version: 1;
  providerId: string;
  state: LifecycleState;
  limits: ProviderLimits;
  updatedAt: string;
};

export type ProviderSummary = {
  providerId: string;
  displayName: string;
  kind: 'anthropic';
  baseUrl?: string;
  defaultModel: string;
  createdAt: string;
  supersedes?: string;
  state: LifecycleState;
  limits: ProviderLimits;
  updatedAt: string;
};

export type CreateOperationState =
  'intent' | 'secret-created' | 'committed' | 'aborted';

export type RetireOperationState = 'intent' | 'secret-revoked' | 'committed';

type OperationBase = {
  version: 1;
  operationId: string;
  ownerId: string;
  idempotencyKey: string;
  providerId: string;
  secretName: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateOperation = OperationBase & {
  kind: 'create';
  secretIds: StableIds;
  request: SafeCreateRequest;
  state: CreateOperationState;
};

export type RetireOperation = OperationBase & {
  kind: 'retire';
  request: Record<string, never>;
  state: RetireOperationState;
};

export type RegistryOperation = CreateOperation | RetireOperation;

export type GrantRecord = {
  version: 1;
  grantId: string;
  ownerId: string;
  providerId: string;
  agentId: string;
  models: string[];
  caps: Record<string, unknown>;
  state: 'active' | 'revoked';
  generation: number;
  createdAt: string;
  updatedAt: string;
};

export type AuditEntry = {
  providerId: string;
  operationId: string;
  change: 'created' | 'retiring' | 'retired' | 'limits';
  oldValue: ProviderLifecycle | null;
  newValue: ProviderLifecycle;
  occurredAt: string;
};

/** The whole durable journal value, rewritten on every commit. */
export type RegistryState = {
  version: 1;
  descriptors: Record<string, ProviderDescriptor>;
  lifecycles: Record<string, ProviderLifecycle>;
  operations: Record<string, RegistryOperation>;
  grants: Record<string, GrantRecord>;
  audit: AuditEntry[];
};

export type RegistryJournal = {
  read(): Promise<RegistryState | undefined>;
  write(value: RegistryState): Promise<void>;
};

/**
 * The root-private `@secrets` participant. The optional methods are recovery
 * aids; a participant without them still fails closed.
 */
export type SecretsPort = {
  has(name: string): Promise<boolean>;
  /**
   * Import under `stableIds` when given, then return the blob bound at
   * `name`. Throws `key-needed` when there is neither a bound blob nor bytes.
   */
  provide(
    name: string,
    description: string,
    bytesBase64?: string,
    stableIds?: StableIds,
  ): Promise<unknown>;
  /**
   * Finish an import whose bytes were written but whose binding was lost.
   * Without it, such an intent waits for the caller to resupply the key and
   * otherwise expires.
   */
  recover?(
    name: string,
    description: string,
    stableIds: StableIds,
  ): Promise<boolean>;
  revoke(name: string): Promise<void>;
  /**
   * Revoke an expired intent's secret by id when no name was ever bound.
   * Without it, the expired secret is left in `@secrets` unbound.
   */
  revokeStable?(stableIds: StableIds): Promise<void>;
  state(name: string): Promise<string>;
  /**
   * List bound names, for the orphan sweep. Without it, no sweep runs.
   */
  listNames?(): Promise<string[]>;
};

export type InferenceEndpointHandle = {
  request(message: unknown): Promise<Record<string, unknown>>;
  requestByteStream(message: unknown): Promise<Record<string, unknown>>;
  attestation(): Promise<Record<string, unknown>>;
  revoke(): Promise<void>;
};

export type IssuerHandle = {
  openEndpoint(spec: { sessionId: string }): Promise<InferenceEndpointHandle>;
  dispose(): Promise<void> | void;
};

export type IssuerDetails = {
  descriptor: ProviderDescriptor;
  lifecycle: ProviderLifecycle;
  secret: unknown;
};

export type MakeIssuer = (
  details: IssuerDetails,
) => Promise<IssuerHandle> | IssuerHandle;

/** Called after each durable commit boundary, so tests can inject crashes. */
export type AfterCommit = (
  boundary: string,
  details: Record<string, unknown>,
) => Promise<void> | void;
