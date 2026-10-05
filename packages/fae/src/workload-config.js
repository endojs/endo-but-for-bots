// @ts-check
import {
  DEFAULT_WORKLOAD_LIMITS,
  readWorkloadLimit,
} from '@endo/hosted-agent/workload-limits.js';
import { readSubagentLimits } from './subagent.js';
import { DEFAULT_MAX_TOOL_ROUNDS } from './turn-engine.js';

/**
 * Validate every retained operator setting before touching host capabilities.
 * @param {Record<string, string | undefined>} env
 */
export const readFaeWorkloadConfig = env =>
  harden({
    subagentLimits: readSubagentLimits(env, 'FAE'),
    maxToolRounds: readWorkloadLimit(
      env,
      'FAE_MAX_TOOL_ROUNDS',
      DEFAULT_MAX_TOOL_ROUNDS,
    ),
    requestTimeoutMs: readWorkloadLimit(
      env,
      'FAE_PROVIDER_REQUEST_TIMEOUT_MS',
      DEFAULT_WORKLOAD_LIMITS.inferenceTimeoutMs,
    ),
    maxSubagents: readWorkloadLimit(
      env,
      'FAE_MAX_SUBAGENTS',
      DEFAULT_WORKLOAD_LIMITS.subagents,
    ),
    maxDepth: readWorkloadLimit(
      env,
      'FAE_MAX_SUBAGENT_DEPTH',
      DEFAULT_WORKLOAD_LIMITS.subagentDepth,
      { min: 0 },
    ),
  });
harden(readFaeWorkloadConfig);
