export type PolicyMode =
  'strict' | 'tofu-auto' | 'tofu-prompt' | 'tofu-attenuator';

export type BindingState = 'Pinned-Allow' | 'Pinned-Deny' | 'Revoked';

export type Binding = {
  target: string;
  state: BindingState;
  decidedAt: number;
  decidedBy: string;
  decisionMode: PolicyMode;
  note?: string;
};

export type AuditEntry = {
  at: number;
  target: string;
  fromState: 'Unknown' | 'Pending' | BindingState;
  toState: 'Unknown' | 'Pending' | BindingState;
  decisionMode: PolicyMode;
  decidedBy: string;
  context?: {
    method?: string;
    userAgentNote?: string;
  };
};

// What a PolicyAuthority may return: either a bare verdict string or a record.
export type Decision =
  | 'allow'
  | 'deny'
  | {
      decision?: 'allow' | 'deny';
      allow?: boolean;
      decidedBy?: string;
      note?: string;
    };

// The internal, normalized shape `normalizeDecision` produces from a Decision:
// `decision` is always present and `allow` has been folded away.
export type NormalizedDecision = {
  decision: 'allow' | 'deny';
  decidedBy?: string;
  note?: string;
};

// The hardened, persistable snapshot handed to a `makeHttpClientAndControl`
// `onPolicyChange` callback after any durable mutation. `policy.allowedOrigins`
// is the STATIC allowlist (not the effective set), so reconstitution with
// `allowedOrigins: snapshot.policy.allowedOrigins` and
// `initialBindings: snapshot.bindings` reproduces an identical pair.
export type PolicySnapshot = {
  policy: {
    allowedOrigins: string[];
    maxRequestsPerMinute: number;
    maxResponseBytes: number;
    maxRequestBytes: number;
    policyMode: PolicyMode;
    revoked: boolean;
  };
  bindings: Binding[];
};

export type PolicyAuthority = {
  decide: (request: {
    kind: 'http-origin';
    target: string;
    context: { method?: string; userAgentNote?: string };
  }) => Promise<Decision> | Decision;
};

export type FetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  /**
   * A string or `Uint8Array` is sent as-is and refused before dialing when it
   * exceeds `maxRequestBytes`. An `@endo/exo-stream` bytes reader — local or a
   * CapTP presence for a remote one — or a local async iterable of byte chunks
   * is streamed in fixed-size frames, so a large upload is never resident
   * whole, and is refused at the first frame that crosses the cap.
   */
  body?: unknown;
};

export type FetchLikeRequestOptions = FetchOptions & {
  redirect: 'manual';
  signal?: AbortSignal;
};

export type FetchLikeBodyReader = {
  read: () => Promise<{ done?: boolean; value?: unknown }>;
  cancel?: (reason?: unknown) => Promise<void>;
  releaseLock?: () => void;
};

export type FetchLikeResponse = {
  // Null for null-body responses (204, 205, 304, and answers to HEAD).
  body?: {
    getReader: () => FetchLikeBodyReader;
  } | null;
  status?: number;
  statusText?: string;
  ok?: boolean;
  headers?: Headers | Record<string, string> | Iterable<[string, string]>;
  url?: string;
};

export type FetchLike = (
  url: string,
  options?: FetchLikeRequestOptions,
) => Promise<FetchLikeResponse> | FetchLikeResponse;

export type HttpResponse = {
  status: () => number;
  statusText: () => string;
  ok: () => boolean;
  headers: () => Record<string, string>;
  url: () => string;
  truncated: () => boolean;
  maxResponseBytes: () => number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
  stream: () => import('@endo/exo-stream').PassableBytesReader;
  help: () => string;
};

export type HttpClient = {
  fetch: (url: string, options?: FetchOptions) => Promise<HttpResponse>;
  allowedOrigins: () => string[];
  help: () => string;
};

export type HttpClientControl = {
  inspect: () => {
    allowedOrigins: string[];
    maxRequestsPerMinute: number;
    maxResponseBytes: number;
    maxRequestBytes: number;
    policyMode: string;
    revoked: boolean;
  };
  setAllowedOrigins: (origins: string[]) => void;
  addAllowedOrigin: (origin: string) => void;
  removeAllowedOrigin: (origin: string) => void;
  setMaxRequestsPerMinute: (n: number) => void;
  setMaxResponseBytes: (n: number) => void;
  setMaxRequestBytes: (n: number) => void;
  revoke: () => void;
  isRevoked: () => boolean;
  listBindings: () => Binding[];
  revokeBinding: (origin: string) => void;
  unpin: (origin: string) => void;
  setPolicyMode: (mode: PolicyMode) => void;
  listAuditEntries: (options?: {
    since?: number;
    limit?: number;
  }) => AuditEntry[];
  help: () => string;
};
