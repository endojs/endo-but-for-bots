// @ts-check
import { Fail, q } from '@endo/errors';
import {
  DEFAULT_WORKLOAD_LIMITS,
  readWorkloadLimit,
} from '@endo/hosted-agent/workload-limits.js';
import { defaultContextCompactionSettings } from '@endo/lal/providers/index.js';
import {
  readSubagentLimits,
  SUBAGENT_LIMIT_SUFFIXES,
} from '@endo/fae/src/subagent.js';

import { DEFAULT_MAX_TOOL_ROUNDS } from '@endo/fae/src/turn-engine.js';
import { readTranscriptLimits } from './journal-transcript.js';

/** Setup persists only this closed set into the factory's Endo formula. */
export const FLOOT_WORKLOAD_ENV_KEYS = harden([
  'FLOOT_MAX_TOOL_ROUNDS',
  'FLOOT_MAX_TRANSCRIPT_CHARS',
  'FLOOT_MAX_TRANSCRIPT_RECORDS',
  'FLOOT_MAX_CONTENT_CHARS',
  'FLOOT_SHELL_TIMEOUT_MS',
  'FLOOT_SHELL_MAX_OUTPUT_BYTES',
  'FLOOT_PROVIDER_REQUEST_TIMEOUT_MS',
  'FLOOT_COMPACTION_ENABLED',
  'FLOOT_COMPACTION_RESERVE_TOKENS',
  'FLOOT_COMPACTION_KEEP_RECENT_TOKENS',
  'FLOOT_COMPACTION_CUSTOM_INSTRUCTIONS',
  'FLOOT_MAX_SUBAGENTS',
  'FLOOT_MAX_SUBAGENT_DEPTH',
  ...Object.values(SUBAGENT_LIMIT_SUFFIXES).map(suffix => `FLOOT_${suffix}`),
]);
harden(FLOOT_WORKLOAD_ENV_KEYS);

/** @param {Record<string,string|undefined>} env */
export const readFlootWorkloadConfig = env => {
  const rawEnabled = env.FLOOT_COMPACTION_ENABLED;
  rawEnabled === undefined ||
    rawEnabled === '' ||
    rawEnabled === 'true' ||
    rawEnabled === 'false' ||
    Fail`Invalid compaction setting ${q('FLOOT_COMPACTION_ENABLED')}`;
  const customInstructions = env.FLOOT_COMPACTION_CUSTOM_INSTRUCTIONS;
  customInstructions === undefined ||
    customInstructions === '' ||
    customInstructions.trim() !== '' ||
    Fail`Invalid compaction setting ${q('FLOOT_COMPACTION_CUSTOM_INSTRUCTIONS')}`;
  return harden({
    maxToolRounds: readWorkloadLimit(
      env,
      'FLOOT_MAX_TOOL_ROUNDS',
      DEFAULT_MAX_TOOL_ROUNDS,
    ),
    transcriptLimits: readTranscriptLimits(env),
    subagentLimits: readSubagentLimits(env, 'FLOOT'),
    shellTimeoutMs: readWorkloadLimit(
      env,
      'FLOOT_SHELL_TIMEOUT_MS',
      DEFAULT_WORKLOAD_LIMITS.shellTimeoutMs,
    ),
    shellOutputBytes: readWorkloadLimit(
      env,
      'FLOOT_SHELL_MAX_OUTPUT_BYTES',
      DEFAULT_WORKLOAD_LIMITS.shellOutputBytes,
    ),
    requestTimeoutMs: readWorkloadLimit(
      env,
      'FLOOT_PROVIDER_REQUEST_TIMEOUT_MS',
      DEFAULT_WORKLOAD_LIMITS.inferenceTimeoutMs,
    ),
    maxSubagents: readWorkloadLimit(
      env,
      'FLOOT_MAX_SUBAGENTS',
      DEFAULT_WORKLOAD_LIMITS.subagents,
    ),
    maxSubagentDepth: readWorkloadLimit(
      env,
      'FLOOT_MAX_SUBAGENT_DEPTH',
      DEFAULT_WORKLOAD_LIMITS.subagentDepth,
      { min: 0 },
    ),
    compactionSettings: harden({
      enabled:
        rawEnabled === undefined || rawEnabled === ''
          ? defaultContextCompactionSettings.enabled
          : rawEnabled === 'true',
      // Absent stays absent so the planner can apply the default's 30% cap;
      // an explicit value, even 16384, is authoritative.
      ...(env.FLOOT_COMPACTION_RESERVE_TOKENS
        ? {
            reserveTokens: readWorkloadLimit(
              env,
              'FLOOT_COMPACTION_RESERVE_TOKENS',
              defaultContextCompactionSettings.reserveTokens,
              { min: 0 },
            ),
          }
        : {}),
      keepRecentTokens: readWorkloadLimit(
        env,
        'FLOOT_COMPACTION_KEEP_RECENT_TOKENS',
        defaultContextCompactionSettings.keepRecentTokens,
        { min: 0 },
      ),
      ...(customInstructions ? { customInstructions } : {}),
    }),
  });
};
harden(readFlootWorkloadConfig);
