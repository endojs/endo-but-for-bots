// @ts-check
import {
  DEFAULT_WORKLOAD_LIMITS,
  readWorkloadLimit,
} from '@endo/hosted-agent/workload-limits.js';
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
  'FLOOT_MAX_SUBAGENTS',
  'FLOOT_MAX_SUBAGENT_DEPTH',
  ...Object.values(SUBAGENT_LIMIT_SUFFIXES).map(suffix => `FLOOT_${suffix}`),
]);
harden(FLOOT_WORKLOAD_ENV_KEYS);

/** @param {Record<string,string|undefined>} env */
export const readFlootWorkloadConfig = env =>
  harden({
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
  });
harden(readFlootWorkloadConfig);
