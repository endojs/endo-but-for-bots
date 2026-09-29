// @ts-check
import { M } from '@endo/patterns';

/** @import { InferResult } from './types.js' */

export const InferLimitsShape = M.splitRecord({
  wallClockMs: M.number(),
  outputBytes: M.number(),
  maxTurns: M.number(),
});
harden(InferLimitsShape);

export const InferUsageShape = M.splitRecord(
  {},
  {
    inputTokens: M.number(),
    outputTokens: M.number(),
    cacheReadTokens: M.number(),
    cacheWriteTokens: M.number(),
    turns: M.number(),
    durationMs: M.number(),
    costUsd: M.number(),
  },
);
harden(InferUsageShape);

export const InferResultShape = M.or(
  M.splitRecord({ type: 'ok', text: M.string() }, { usage: InferUsageShape }),
  harden({ type: 'needs-auth' }),
  M.splitRecord({ type: 'usage-exhausted' }, { resetAt: M.number() }),
  M.splitRecord({ type: 'rate-limited' }, { retryAfterMs: M.number() }),
  harden({
    type: 'limit-exceeded',
    which: M.or('wall-clock', 'output-bytes', 'max-turns', 'budget'),
  }),
  harden({ type: 'cancelled' }),
  harden({ type: 'unavailable', reason: M.string() }),
);
harden(InferResultShape);

export const BackendDescriptionShape = M.splitRecord(
  { kind: M.string(), provider: M.string() },
  { version: M.string() },
);
harden(BackendDescriptionShape);

// gap: see PR body, Gap 1. The design's `GuestToolProjection` carries
// `buildMcpServer(): McpServer`, a live in-process object that no guard can
// describe and that an out-of-process CLI cannot consume. The request guard
// therefore only pins what a remote caller could actually pass.
export const InferRequestShape = M.splitRecord(
  {
    prompt: M.string(),
    guest: M.any(),
    limits: InferLimitsShape,
  },
  { model: M.string(), cancelled: M.promise() },
);
harden(InferRequestShape);

export const InferenceBackendInterface = M.interface('InferenceBackend', {
  describe: M.call().returns(BackendDescriptionShape),
  infer: M.call(InferRequestShape).returns(M.promise()),
});
harden(InferenceBackendInterface);

// Decision 8's comparison record. The credential appears only as the secret
// manager's `secretId` (or a deployment label), never as bytes.
export const UsageRecordShape = M.splitRecord(
  {
    runId: M.string(),
    provider: M.string(),
    backendKind: M.string(),
    credentialId: M.string(),
    startedAt: M.string(),
    latencyMs: M.number(),
    resultType: M.string(),
  },
  {
    backendVersion: M.string(),
    turns: M.number(),
    outputBytes: M.number(),
    usage: InferUsageShape,
    detail: M.string(),
    costUsd: M.number(),
    verifiedEffect: M.boolean(),
  },
);
harden(UsageRecordShape);
