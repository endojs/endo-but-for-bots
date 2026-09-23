// @ts-check
import { Fail } from '@endo/errors';
import {
  assertTranscriptRecord,
  pairToolCalls,
} from '@endo/hosted-agent/transcript-records.js';

/**
 * Admit only self-contained context snapshots. Until ordered checkpoint
 * journaling can reconcile a later result with a retained call, accepting an
 * incomplete tail would silently lose that result during tree projection.
 * This is an admission restriction, not a restriction of the canonical format.
 *
 * @param {unknown} value
 */
export const assertCompactionCheckpoint = value => {
  const checkpoint = assertTranscriptRecord(value);
  if (checkpoint.kind !== 'compaction')
    throw Fail`Expected compaction checkpoint`;
  const { unanswered } = pairToolCalls(checkpoint.retainedTail ?? [], {
    perTurn: true,
  });
  if (unanswered.length)
    Fail`Compaction retained tail must contain settled tool calls`;
  return checkpoint;
};
harden(assertCompactionCheckpoint);
