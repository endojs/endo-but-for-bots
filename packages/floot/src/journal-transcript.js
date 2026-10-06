// @ts-check
import { Fail } from '@endo/errors';
import {
  DEFAULT_WORKLOAD_LIMITS,
  readWorkloadLimit,
} from '@endo/hosted-agent/workload-limits.js';
import {
  assertTranscriptRecord,
  encodeTranscriptRecord,
  pairToolCalls,
} from '@endo/hosted-agent/transcript-records.js';

import { assertCompactionCheckpoint } from './compaction-checkpoint.js';

/** Admission settings; replay uses structural bounds, not a new lower budget. */
export const DEFAULT_TRANSCRIPT_LIMITS = harden({
  maxChars: DEFAULT_WORKLOAD_LIMITS.transcriptChars,
  maxRecords: DEFAULT_WORKLOAD_LIMITS.transcriptRecords,
  maxContentChars: DEFAULT_WORKLOAD_LIMITS.contentChars,
});
harden(DEFAULT_TRANSCRIPT_LIMITS);

/** @param {Record<string,string|undefined>} env */
export const readTranscriptLimits = env =>
  harden({
    maxChars: readWorkloadLimit(
      env,
      'FLOOT_MAX_TRANSCRIPT_CHARS',
      DEFAULT_TRANSCRIPT_LIMITS.maxChars,
      { max: 0xffff_ffff },
    ),
    maxRecords: readWorkloadLimit(
      env,
      'FLOOT_MAX_TRANSCRIPT_RECORDS',
      DEFAULT_TRANSCRIPT_LIMITS.maxRecords,
      { max: 0xffff_ffff },
    ),
    maxContentChars: readWorkloadLimit(
      env,
      'FLOOT_MAX_CONTENT_CHARS',
      DEFAULT_TRANSCRIPT_LIMITS.maxContentChars,
      { max: 0x7fff_ffff },
    ),
  });
harden(readTranscriptLimits);

/**
 * Encode model context, not execution authority. Bound both accumulated UTF-16
 * content and indexing overhead. These are storage profiles, not model context
 * limits. A replay must not become unreadable when admission settings change.
 * @param {unknown} record
 * @param {number} [maxContentChars] Admission budget; replay uses the structural range.
 */
export const encodeJournalTranscript = (
  record,
  maxContentChars = 0x7fff_ffff,
) => {
  const valid = assertTranscriptRecord(record);
  if (valid.kind === 'compaction') assertCompactionCheckpoint(valid);
  if (valid.kind === 'native-context') {
    const { unanswered } = pairToolCalls(valid.context, { perTurn: true });
    if (unanswered.length) Fail`Native context must contain settled tool calls`;
  }
  const payload = encodeTranscriptRecord(valid);
  payload.length <= maxContentChars || Fail`Transcript content bound exceeded`;
  return payload;
};
harden(encodeJournalTranscript);

/**
 * Validate the index without coercing malformed or noncanonical positions.
 * An identical existing record can still be acknowledged at the quota.
 * @param {unknown} ordinal
 * @param {number} length Array length, hence within the JavaScript index domain.
 */
export const transcriptIndex = (ordinal, length) => {
  (typeof ordinal === 'string' && /^(0|[1-9][0-9]{0,9})$/.test(ordinal)) ||
    Fail`Invalid transcript ordinal`;
  const index = Number(ordinal);
  index <= length || Fail`Transcript ordinal gap`;
  index < 0xffff_ffff || Fail`Transcript record count bound exceeded`;
  return index;
};
harden(transcriptIndex);

/**
 * @param {number} chars
 * @param {number} [maxChars]
 */
export const assertTranscriptBudget = (chars, maxChars = 0xffff_ffff) => {
  (Number.isInteger(chars) && chars >= 0 && chars <= maxChars) ||
    Fail`Transcript content bound exceeded`;
};
harden(assertTranscriptBudget);
