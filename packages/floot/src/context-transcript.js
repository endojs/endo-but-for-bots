// @ts-check
import { splitAtLastCompaction } from '@endo/hosted-agent/transcript-records.js';

import { recoverTurnTranscript } from './transcript-projection.js';

/**
 * Model context only. The journal read view must pin all supplied metadata;
 * archive publication order is not dispatch order. Historical tool payloads
 * still require exact reconciliation, but superseded prose is never hydrated.
 * @param {readonly any[]} turns
 * @param {(ref: any) => Promise<string>} readContent
 * @param {string} [excludeTurnId]
 */
export const projectContextTranscript = async (
  turns,
  readContent,
  excludeTurnId,
) => {
  const eligible = turns
    .filter(turn => turn.state !== 'pending' && turn.turnId !== excludeTurnId)
    .sort((a, b) =>
      BigInt(a.turnId) < BigInt(b.turnId)
        ? -1
        : BigInt(a.turnId) > BigInt(b.turnId)
          ? 1
          : 0,
    );
  let boundaryTurn = -1;
  let boundaryOrdinal = -1;
  for (const [index, turn] of eligible.entries()) {
    for (const [ordinal, entry] of (turn.transcript ?? []).entries()) {
      if (entry.kind === 'compaction') {
        boundaryTurn = index;
        boundaryOrdinal = ordinal;
      }
    }
  }
  const records = [];
  const exceptions = [];
  const boundary = eligible[boundaryTurn]?.transcript[boundaryOrdinal];
  for (const [index, turn] of eligible.entries()) {
    const selection =
      index < boundaryTurn
        ? { evidenceAfter: boundary.sequence }
        : index === boundaryTurn
          ? { startOrdinal: boundaryOrdinal }
          : {};
    // eslint-disable-next-line no-await-in-loop
    const recovered = await recoverTurnTranscript(
      [],
      turn,
      readContent,
      selection,
    );
    if (index < boundaryTurn) exceptions.push(...recovered);
    else records.push(...recovered);
  }
  const active = splitAtLastCompaction(records).active;
  const ids = new Set(
    active
      .filter(record => record.kind === 'tool-call')
      .map(record => record.id),
  );
  const renamed = new Map();
  const recovered = exceptions.map(record => {
    if (record.kind === 'tool-call') {
      let id = record.id;
      while (ids.has(id)) id = `recovered:${id}`;
      ids.add(id);
      renamed.set(record.id, id);
      return { ...record, id };
    }
    if (record.kind === 'tool-result')
      return { ...record, id: renamed.get(record.id) };
    return record;
  });
  return harden([...active, ...recovered]);
};
harden(projectContextTranscript);
