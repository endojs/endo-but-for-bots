// @ts-check
import { Fail } from '@endo/errors';
import {
  DEFAULT_WORKLOAD_LIMITS,
  readWorkloadLimit,
} from '@endo/hosted-agent/workload-limits.js';
import { defaultContextCompactionSettings } from '@endo/lal/providers/context-compaction.js';
import { readSubagentLimits } from './subagent.js';
import { DEFAULT_MAX_TOOL_ROUNDS } from './turn-engine.js';

/**
 * Validate every retained operator setting before touching host capabilities.
 * @param {Record<string, string | undefined>} env
 */
export const readFaeWorkloadConfig = env => {
  const enabledText = env.FAE_COMPACTION_ENABLED;
  enabledText === undefined ||
    enabledText === '' ||
    enabledText === 'true' ||
    enabledText === 'false' ||
    Fail`Invalid compaction enabled setting`;
  const customInstructions = env.FAE_COMPACTION_CUSTOM_INSTRUCTIONS;
  return harden({
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
    compactionSettings: harden({
      enabled:
        enabledText === undefined || enabledText === ''
          ? defaultContextCompactionSettings.enabled
          : enabledText === 'true',
      reserveTokens: readWorkloadLimit(
        env,
        'FAE_COMPACTION_RESERVE_TOKENS',
        defaultContextCompactionSettings.reserveTokens,
        { min: 0 },
      ),
      keepRecentTokens: readWorkloadLimit(
        env,
        'FAE_COMPACTION_KEEP_RECENT_TOKENS',
        defaultContextCompactionSettings.keepRecentTokens,
        { min: 0 },
      ),
      ...(customInstructions ? { customInstructions } : {}),
    }),
  });
};
harden(readFaeWorkloadConfig);
