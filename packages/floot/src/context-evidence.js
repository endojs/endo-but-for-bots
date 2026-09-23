// @ts-check
import { Fail } from '@endo/errors';

import { recoverTurnTranscript } from './transcript-projection.js';

/** @param {any} turn */
const frontier = turn => {
  const sequences = [turn.turnId];
  for (const entry of turn.transcript ?? []) {
    if (['tool-call', 'tool-result'].includes(entry.kind))
      sequences.push(entry.sequence);
  }
  for (const entry of [...(turn.tools ?? []), ...(turn.activity ?? [])]) {
    sequences.push(entry.sequence);
    if (entry.settled) sequences.push(entry.resultSequence);
  }
  if (
    !sequences.every(
      value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value),
    )
  )
    return undefined;
  return `${sequences.map(BigInt).reduce((a, b) => (a > b ? a : b))}`;
};

/**
 * Absence of required tool-evidence exceptions, not dialogue completeness or
 * proof of unobserved native execution. Only immutable archives may use this.
 * @param {any} turn
 * @param {(ref: any) => Promise<string>} readContent
 */
export const certifyContextEvidence = async (turn, readContent) => {
  if (
    [...(turn.tools ?? []), ...(turn.activity ?? [])].some(
      call => !call.settled,
    )
  )
    return undefined;
  const throughSequence = frontier(turn);
  if (throughSequence === undefined) return undefined;
  const exceptions = await recoverTurnTranscript(turn, readContent, {
    evidenceAfter: throughSequence,
  });
  if (exceptions.length) return undefined;
  return harden({ kind: 'no-tool-exceptions', throughSequence });
};
harden(certifyContextEvidence);

/**
 * Check structural consistency without rehydrating the original tool payloads.
 * Semantic completeness is guaranteed by the archival writer's derivation.
 * @param {any} turn
 */
export const assertContextEvidence = turn => {
  const certificate = turn.contextEvidence;
  if (certificate === undefined) return;
  (certificate !== null &&
    typeof certificate === 'object' &&
    Object.keys(certificate).length === 2 &&
    certificate.kind === 'no-tool-exceptions' &&
    typeof certificate.throughSequence === 'string' &&
    certificate.throughSequence === frontier(turn) &&
    [...(turn.tools ?? []), ...(turn.activity ?? [])].every(
      call => call.settled === true,
    )) ||
    Fail`Invalid archived context evidence certificate`;
};
harden(assertContextEvidence);
