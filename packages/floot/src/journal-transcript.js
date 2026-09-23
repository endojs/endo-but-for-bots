// @ts-check
import { Fail } from '@endo/errors';
import {
  assertTranscriptRecord,
  encodeTranscriptRecord,
} from '@endo/hosted-agent/transcript-records.js';

import { assertCompactionCheckpoint } from './compaction-checkpoint.js';

/**
 * Encode model context, not execution authority. Bound both accumulated UTF-16
 * content (16 Mi code units, as in hosted-turn) and indexing overhead (65,536
 * entries per turn). These are storage profiles, not model context limits.
 * @param {unknown} record
 */
export const encodeJournalTranscript = record => {
  const valid = assertTranscriptRecord(record);
  if (valid.kind === 'compaction') assertCompactionCheckpoint(valid);
  const payload = encodeTranscriptRecord(valid);
  payload.length <= 16 * 1024 * 1024 || Fail`Transcript content bound exceeded`;
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
  (typeof ordinal === 'string' && /^(0|[1-9][0-9]{0,4})$/.test(ordinal)) ||
    Fail`Invalid transcript ordinal`;
  const index = Number(ordinal);
  index <= length || Fail`Transcript ordinal gap`;
  index < 65_536 || Fail`Transcript record count bound exceeded`;
  return index;
};
harden(transcriptIndex);

/**
 * @param {number} chars
 */
export const assertTranscriptBudget = chars => {
  (Number.isInteger(chars) && chars >= 0 && chars <= 16 * 1024 * 1024) ||
    Fail`Transcript content bound exceeded`;
};
harden(assertTranscriptBudget);
