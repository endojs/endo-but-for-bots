// @ts-check
import { Fail } from '@endo/errors';
import { splitAtLastCompaction } from '@endo/hosted-agent/transcript-records.js';

import { recoverTurnTranscript } from './transcript-projection.js';

/**
 * Model context only. The journal read view must pin all supplied metadata;
 * archive publication order is not dispatch order. Historical tool payloads
 * still require exact reconciliation, but superseded prose is never hydrated.
 * @param {(visit: (turn: any) => Promise<void> | void) => Promise<void>} visitTurns
 * @param {(ref: any) => Promise<string>} readContent
 * @param {string} [excludeTurnId]
 */
const projectContext = async (visitTurns, readContent, excludeTurnId) => {
  const eligible = turn =>
    turn.state !== 'pending' && turn.turnId !== excludeTurnId;
  /** @type {{ turnId: string, ordinal: number, sequence: string } | undefined} */
  let boundary;
  await visitTurns(turn => {
    if (!eligible(turn)) return;
    /** @type {any[]} */
    const transcript = turn.transcript ?? [];
    for (const [ordinal, entry] of transcript.entries()) {
      if (
        entry.kind === 'compaction' &&
        (!boundary ||
          BigInt(turn.turnId) > BigInt(boundary.turnId) ||
          (turn.turnId === boundary.turnId && ordinal > boundary.ordinal))
      ) {
        boundary = { turnId: turn.turnId, ordinal, sequence: entry.sequence };
      }
    }
  });
  const activeGroups = [];
  const exceptionGroups = [];
  let foundBoundary = boundary === undefined;
  await visitTurns(async turn => {
    if (!eligible(turn)) return;
    if (boundary && turn.turnId === boundary.turnId) {
      const entry = turn.transcript?.[boundary.ordinal];
      (entry?.kind === 'compaction' &&
        entry.sequence === boundary.sequence &&
        entry.ordinal === `${boundary.ordinal}`) ||
        Fail`Context checkpoint changed across captured view`;
      foundBoundary = true;
    }
    const before =
      boundary !== undefined && BigInt(turn.turnId) < BigInt(boundary.turnId);
    const selection =
      boundary === undefined
        ? {}
        : before
          ? { evidenceAfter: boundary.sequence }
          : turn.turnId === boundary.turnId
            ? { startOrdinal: boundary.ordinal }
            : {};
    const recovered = await recoverTurnTranscript(
      [],
      turn,
      readContent,
      selection,
    );
    if (recovered.length) {
      const groups = before ? exceptionGroups : activeGroups;
      groups.push({ turnId: turn.turnId, records: recovered });
    }
  });
  foundBoundary || Fail`Context checkpoint missing from captured view`;
  const ordered = groups =>
    groups
      .sort((a, b) =>
        BigInt(a.turnId) < BigInt(b.turnId)
          ? -1
          : BigInt(a.turnId) > BigInt(b.turnId)
            ? 1
            : 0,
      )
      .flatMap(group => group.records);
  const records = ordered(activeGroups);
  const exceptions = ordered(exceptionGroups);
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

/**
 * Array projection for callers already holding a captured view.
 * @param {readonly any[]} turns
 * @param {(ref: any) => Promise<string>} readContent
 * @param {string} [excludeTurnId]
 */
export const projectContextTranscript = (turns, readContent, excludeTurnId) =>
  projectContext(
    async visit => {
      for (const turn of turns) {
        // eslint-disable-next-line no-await-in-loop
        await visit(turn);
      }
    },
    readContent,
    excludeTurnId,
  );
harden(projectContextTranscript);

/**
 * Two passes over the same immutable journal cut. Retain one archive page,
 * the retained-window snapshot and selected output, never all archive metadata.
 * This bounds metadata accumulation, not total archive I/O or active context.
 * @param {any} journal
 * @param {string} [excludeTurnId]
 */
export const readContextTranscript = async (journal, excludeTurnId) => {
  const view = await journal.readView();
  return projectContext(
    async visit => {
      for (const turn of view.retained) {
        // eslint-disable-next-line no-await-in-loop
        await visit(turn);
      }
      let cursor = view.archiveCursor;
      while (cursor !== null) {
        // eslint-disable-next-line no-await-in-loop
        const page = await journal.listArchivedPage(cursor);
        for (const turn of page.records) {
          // eslint-disable-next-line no-await-in-loop
          await visit(turn);
        }
        cursor = page.next;
      }
    },
    ref => journal.readContent(ref),
    excludeTurnId,
  );
};
harden(readContextTranscript);
