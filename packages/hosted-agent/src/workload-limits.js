// @ts-check
import { Fail, q } from '@endo/errors';

/** Operator workload guards, not provider context windows or wire profiles. */
export const DEFAULT_WORKLOAD_LIMITS = harden({
  transcriptChars: 1024 ** 3,
  transcriptRecords: 1024 ** 2,
  contentChars: 256 * 1024 ** 2,
  shellTimeoutMs: 24 * 60 * 60 * 1000,
  shellOutputBytes: 16 * 1024 ** 2,
  networkConnections: 1024,
  networkBytes: 1024n ** 4n,
  networkTunnelTimeoutMs: 24 * 60 * 60 * 1000,
  inferenceTimeoutMs: 60 * 60 * 1000,
  subagents: 1024,
  subagentDepth: 32,
  subagentReplyTimeoutSeconds: 24 * 60 * 60,
  subagentMaxReplyTimeoutSeconds: 7 * 24 * 60 * 60,
  subagentTaskChars: 1024 ** 2,
  subagentAnswerChars: 16 * 1024 ** 2,
});
harden(DEFAULT_WORKLOAD_LIMITS);

/**
 * Parse trusted construction settings before acquiring resources. Timer values
 * use Node's signed 32-bit timer range; counts/lengths can use uint32 instead.
 * Missing or empty settings use the default; malformed settings never do.
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @param {number} fallback
 * @param {{ min?: number, max?: number }} [range]
 */
export const readWorkloadLimit = (
  env,
  name,
  fallback,
  { min = 1, max = 0x7fff_ffff } = {},
) => {
  const text = env[name];
  if (text === undefined || text === '') return fallback;
  /^\d+$/.test(text) || Fail`Invalid workload limit ${q(name)}`;
  const value = Number(text);
  (Number.isInteger(value) && value >= min && value <= max) ||
    Fail`Invalid workload limit ${q(name)}`;
  return value;
};
harden(readWorkloadLimit);

/**
 * Traffic is a natural-number byte count, not a JavaScript array index.
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @param {bigint} fallback
 */
export const readWorkloadBytes = (env, name, fallback) => {
  const text = env[name];
  if (text === undefined || text === '') return fallback;
  /^\d+$/.test(text) || Fail`Invalid workload limit ${q(name)}`;
  const value = BigInt(text);
  value > 0n || Fail`Invalid workload limit ${q(name)}`;
  return value;
};
harden(readWorkloadBytes);
