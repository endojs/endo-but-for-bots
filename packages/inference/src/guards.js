// @ts-check

import { M } from '@endo/patterns';

/**
 * The largest delay a host timer honors. Node and the HTML timer steps
 * (WebIDL `long`) turn any longer delay, `Infinity` included, into about
 * 1 ms, so a wall-clock limit above it would trip at once.
 */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

// Patterns cannot say "integer" of a number, so counts are bounded to finite
// values here and the limit enforcer checks integrality where it counts.
const NonNegativeNumberShape = M.and(
  M.number(),
  M.gte(0),
  M.lte(Number.MAX_SAFE_INTEGER),
);
const PositiveNumberShape = M.and(
  M.number(),
  M.gt(0),
  M.lte(Number.MAX_SAFE_INTEGER),
);
const TimerDelayShape = M.and(M.number(), M.gt(0), M.lte(MAX_TIMER_DELAY_MS));

// Every record of the seam is closed (the `{}` rest pattern of
// `M.splitRecord`), so that, for example, no request can carry a credential.

export const InferLimitsShape = harden({
  maxWallClockMs: TimerDelayShape,
  maxOutputBytes: PositiveNumberShape,
  maxTurns: PositiveNumberShape,
});
harden(InferLimitsShape);

// `buildMcpServer` closes over one resolved facet and returns a live server,
// so it crosses as a remotable function and its return is not guarded.
export const GuestToolProjectionShape = harden({
  buildMcpServer: M.remotable('buildMcpServer'),
  toolNames: M.arrayOf(M.string()),
  formulaIdentifier: M.string(),
});
harden(GuestToolProjectionShape);

// `promptOrigin` is any optional string on purpose: a missing or unknown
// origin must reach the prompt-origin gate and become `needs-containment`
// rather than fail the guard.
export const InferRequestShape = M.splitRecord(
  {
    prompt: M.string(),
    guest: GuestToolProjectionShape,
    limits: InferLimitsShape,
    cancelled: M.promise(),
  },
  {
    promptOrigin: M.string(),
    model: M.string(),
  },
  {},
);

export const InferUsageShape = M.splitRecord(
  {},
  {
    inputTokens: NonNegativeNumberShape,
    outputTokens: NonNegativeNumberShape,
    cacheReadTokens: NonNegativeNumberShape,
    cacheWriteTokens: NonNegativeNumberShape,
    turns: NonNegativeNumberShape,
    durationMs: NonNegativeNumberShape,
  },
  {},
);

export const LimitNameShape = M.or('wall-clock', 'output-bytes', 'max-turns');

export const OkResultShape = M.splitRecord(
  { type: 'ok', text: M.string() },
  { usage: InferUsageShape },
  {},
);

export const NeedsContainmentResultShape = harden(
  /** @type {const} */ ({ type: 'needs-containment' }),
);

/**
 * The tags that mean "try again later": each may carry `retryAfterMs`, and
 * each is also a reason a credential source refuses admission.
 */
export const RETRY_LATER_TYPES = harden(
  /** @type {const} */ ([
    'usage-exhausted',
    'rate-limited',
    'budget-exhausted',
  ]),
);

/** Every tag except `ok` and `needs-containment`: the classifier's range. */
export const CLASSIFIED_RESULT_TYPES = harden(
  /** @type {const} */ ([
    'needs-auth',
    ...RETRY_LATER_TYPES,
    'limit-exceeded',
    'cancelled',
    'unavailable',
  ]),
);

/** Every tag of the taxonomy. */
export const INFER_RESULT_TYPES = harden(
  /** @type {const} */ ([
    'ok',
    ...CLASSIFIED_RESULT_TYPES,
    'needs-containment',
  ]),
);

export const ClassifiedResultShape = M.or(
  harden(/** @type {const} */ ({ type: 'needs-auth' })),
  ...RETRY_LATER_TYPES.map(type =>
    M.splitRecord({ type }, { retryAfterMs: NonNegativeNumberShape }, {}),
  ),
  harden(
    /** @type {const} */ ({ type: 'limit-exceeded', which: LimitNameShape }),
  ),
  harden(/** @type {const} */ ({ type: 'cancelled' })),
  harden(/** @type {const} */ ({ type: 'unavailable', detail: M.string() })),
);

export const InferResultShape = M.or(
  OkResultShape,
  NeedsContainmentResultShape,
  ClassifiedResultShape,
);

export const BackendDescriptionShape = M.splitRecord(
  { provider: M.string(), kind: M.string() },
  { version: M.string() },
  {},
);

// `infer` never rejects for any outcome of a turn. The guard can still reject
// a call: a request outside `InferRequestShape` is a caller defect, and a
// result outside the taxonomy is a backend defect, and both surface rather
// than being folded into a tag.
export const InferenceBackendInterface = M.interface('InferenceBackend', {
  describe: M.call().returns(BackendDescriptionShape),
  infer: M.callWhen(InferRequestShape).returns(InferResultShape),
});

export const AdmissionReasonShape = M.or(...RETRY_LATER_TYPES);

export const AdmissionRefusalShape = M.splitRecord(
  { reason: AdmissionReasonShape },
  { retryAfterMs: NonNegativeNumberShape },
  {},
);

export const CredentialGrantShape = harden({
  type: /** @type {const} */ ('granted'),
  env: M.recordOf(M.string(), M.string()),
  release: M.remotable('release'),
});

export const CredentialRefusalShape = harden({
  type: /** @type {const} */ ('refused'),
  admission: AdmissionRefusalShape,
});

export const CredentialSourceInterface = M.interface('CredentialSource', {
  acquire: M.callWhen().returns(
    M.or(CredentialGrantShape, CredentialRefusalShape),
  ),
});

export const InferResultTypeShape = M.or(...INFER_RESULT_TYPES);

export const UsageRecordShape = M.splitRecord(
  {
    provider: M.string(),
    backendKind: M.string(),
    secretIdentifier: M.string(),
    formulaIdentifier: M.string(),
    latencyMs: NonNegativeNumberShape,
    resultType: InferResultTypeShape,
  },
  {
    backendVersion: M.string(),
    promptOrigin: M.string(),
    detail: M.string(),
    turns: NonNegativeNumberShape,
    outputBytes: NonNegativeNumberShape,
    usage: InferUsageShape,
    runIdentifier: M.string(),
    costEstimate: NonNegativeNumberShape,
    verifiedEffect: M.boolean(),
  },
  {},
);

export const UsageSinkInterface = M.interface('UsageSink', {
  write: M.call(UsageRecordShape).returns(M.any()),
});
