// @ts-check
import { Fail } from '@endo/errors';
import { imageResultText } from '@endo/hosted-agent/image-result.js';
import {
  pairToolCalls,
  selectActiveTranscript,
} from '@endo/hosted-agent/transcript-records.js';

import { recoverTurnTranscript } from './transcript-projection.js';
import { assertContextEvidence } from './context-evidence.js';

/**
 * Model context only. The journal read view must pin all supplied metadata;
 * archive publication order is not dispatch order. Historical tool payloads
 * still require exact reconciliation, but superseded prose is never hydrated.
 * @param {(visit: (turn: any, archived?: boolean) => Promise<void> | void) => Promise<void>} visitTurns
 * @param {(ref: any) => Promise<string>} readContent
 * @param {string} [excludeTurnId]
 * @param {{ turnId: string, ordinal: number, sequence: string }} [initialBoundary]
 * @param {(visit: (turn: any) => Promise<void> | void) => Promise<void>} [selectTurns]
 * @param {{ portableFallback?: boolean, reconciledNativeSuffix?: boolean, toolArgumentKey?: (args: string) => string, omitIncompleteImages?: boolean }} [options] `portableFallback` is for
 *   a backend that rebuilds its conversation from the supplied records on
 *   every turn (`continuity: 'transcript'`). When native context cannot be
 *   restored without hiding evidence, it gets the whole conversation as
 *   portable records instead: each native checkpoint is replaced by its own
 *   portable context, and the evidence it could not cover follows as records.
 *   Nothing is hidden; only native fidelity is lost, until the next turn
 *   captures a new checkpoint. A backend that keeps its own thread (Codex's
 *   `opaque-reconciled`) may instead restore a safe native checkpoint and
 *   inject a settled later suffix when `reconciledNativeSuffix` is enabled.
 *   Unknown outcomes require an operator resolution; unsafe evidence within
 *   or before the checkpoint still refuses. The native bytes are never flattened.
 *   `toolArgumentKey` compares arguments through the selected backend's encoding;
 *   without it, argument text must match exactly. Stored records are unchanged.
 */
const projectContext = async (
  visitTurns,
  readContent,
  excludeTurnId,
  initialBoundary,
  selectTurns = visitTurns,
  {
    portableFallback = false,
    reconciledNativeSuffix = false,
    toolArgumentKey,
    omitIncompleteImages = false,
  } = {},
) => {
  const eligible = turn =>
    turn.state !== 'pending' &&
    turn.turnId !== excludeTurnId &&
    // An admitted prompt is history, not prior backend dialogue. This state
    // is established by the journal's write-before-send contract, never by
    // absence of streamed events or a transport's delivery report.
    turn.dispatchState !== 'not-dispatched';
  /** @type {{ turnId: string, ordinal: number, sequence: string } | undefined} */
  let boundary = initialBoundary;
  await selectTurns(turn => {
    if (!eligible(turn)) return;
    /** @type {any[]} */
    const transcript = turn.transcript ?? [];
    for (const [ordinal, entry] of transcript.entries()) {
      if (
        (entry.kind === 'compaction' || entry.kind === 'native-context') &&
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
  let activeEvidenceUnsafe = false;
  let checkpointTurnUnsafe = false;
  let suffixSettled = true;
  /** @type {any} */
  let checkpointTurn;
  let nativeContextRequired = false;
  let foundBoundary = boundary === undefined;
  await visitTurns(async (turn, archived = false) => {
    if (!eligible(turn)) return;
    if (boundary && turn.turnId === boundary.turnId) {
      const entry = turn.transcript?.[boundary.ordinal];
      ((entry?.kind === 'compaction' || entry?.kind === 'native-context') &&
        entry.sequence === boundary.sequence &&
        entry.ordinal === `${boundary.ordinal}`) ||
        Fail`Context checkpoint changed across captured view`;
      foundBoundary = true;
    }
    const before =
      boundary !== undefined && BigInt(turn.turnId) < BigInt(boundary.turnId);
    if (
      archived &&
      boundary !== undefined &&
      before &&
      turn.contextEvidence !== undefined
    ) {
      assertContextEvidence(turn);
      if (
        BigInt(turn.contextEvidence.throughSequence) <=
        BigInt(boundary.sequence)
      )
        return;
    }
    const selection =
      boundary === undefined
        ? {}
        : before
          ? { evidenceAfter: boundary.sequence }
          : turn.turnId === boundary.turnId
            ? { startOrdinal: boundary.ordinal }
            : {};
    if (!before && turn.nativeContextFormat !== undefined) {
      nativeContextRequired = true;
    }
    const recovered = await recoverTurnTranscript(turn, readContent, {
      ...selection,
      reportNativeSafety: safe => {
        if (!before && !safe) activeEvidenceUnsafe = true;
        if (!safe && boundary && turn.turnId === boundary.turnId)
          checkpointTurnUnsafe = true;
      },
    });
    if (boundary && BigInt(turn.turnId) > BigInt(boundary.turnId)) {
      suffixSettled &&=
        (['completed', 'failed', 'cancelled'].includes(turn.state) ||
          (turn.state === 'outcome-unknown' &&
            typeof turn.resolution === 'string')) &&
        (turn.tools ?? []).every(tool => tool.settled === true) &&
        pairToolCalls(recovered, { perTurn: true }).unanswered.length === 0;
    }
    if (recovered.length) {
      const groups = before ? exceptionGroups : activeGroups;
      // API providers rebuild their context each request. An image rejected by
      // a provider must not poison every subsequent request. Keep the durable
      // evidence, but require an explicit new read in a later turn. Native
      // opaque checkpoints are deliberately not rewritten by this projection.
      const recoverImage = record => {
        if (record.kind === 'tool-result') {
          const receipt = imageResultText(record.content);
          if (receipt !== record.content)
            return {
              ...record,
              content: `${receipt} [Not replayed after an incomplete turn; use viewImage again if needed.]`,
            };
        }
        if (record.kind === 'compaction')
          return {
            ...record,
            retainedTail: record.retainedTail.map(recoverImage),
          };
        return record;
      };
      groups.push({
        turnId: turn.turnId,
        records:
          omitIncompleteImages && turn.state !== 'completed'
            ? recovered.map(recoverImage)
            : recovered,
      });
    }
    if (boundary && turn.turnId === boundary.turnId) checkpointTurn = turn;
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
  let active = selectActiveTranscript(records).active;
  let exceptions = ordered(exceptionGroups);
  // A completed native checkpoint and a later, fully accounted-for suffix
  // are distinct evidence. Codex restores the former into a new thread and
  // injects the latter as data before starting a new turn. Never reinterpret
  // an unsafe checkpoint, erase effects, or turn an unsettled call into success.
  if (
    reconciledNativeSuffix &&
    active[0]?.kind === 'native-context' &&
    active[0].format === 'codex-rollout-v1' &&
    active.length > 1 &&
    !checkpointTurnUnsafe &&
    exceptions.length === 0 &&
    suffixSettled
  ) {
    return harden(active);
  }
  if (
    (nativeContextRequired ||
      active.some(record => record.kind === 'native-context')) &&
    (exceptions.length || activeEvidenceUnsafe)
  ) {
    portableFallback ||
      Fail`Native context cannot conceal unresolved or recovered tool evidence`;
    // The checkpoint's own turn: what its checkpoint may not cover follows
    // the portable context as recovered evidence, never silently dropped
    // (host-only, unsettled, host-settled or late results).
    const carried =
      checkpointTurnUnsafe && boundary
        ? await recoverTurnTranscript(checkpointTurn, readContent, {
            evidenceAfter: boundary.sequence,
          })
        : [];
    exceptions = [...carried, ...exceptions];
    // Only the selected checkpoint is replaced; what it superseded stays
    // superseded.
    active = selectActiveTranscript(
      active.flatMap(record =>
        record.kind === 'native-context' ? record.context : [record],
      ),
    ).active;
    // A checkpoint captured after an earlier fallback already holds the
    // recovered evidence Floot handed it, under the same id. Repeat only
    // evidence the context does not hold verbatim.
    const comparable = record => {
      if (record.kind !== 'tool-call' || !toolArgumentKey) {
        return JSON.stringify(record);
      }
      return JSON.stringify({ ...record, args: toolArgumentKey(record.args) });
    };
    const held = new Set(active.map(comparable));
    const heldPair = id =>
      exceptions
        .filter(record => record.id === id)
        .every(record => held.has(comparable(record)));
    exceptions = exceptions.filter(
      record =>
        !['tool-call', 'tool-result'].includes(record.kind) ||
        !heldPair(record.id),
    );
    if (!exceptions.some(record => record.kind === 'tool-call'))
      exceptions = [];
    // A result whose call the checkpoint superseded cannot stand alone in a
    // portable file. Its evidence is carried, paired, among the exceptions;
    // one that is not stops here rather than being dropped.
    // Each carried result accounts for one stray result, at most.
    const unclaimed = carried.filter(record => record.kind === 'tool-result');
    const calls = new Set();
    active = active.filter(record => {
      if (record.kind === 'tool-call') calls.add(record.id);
      if (record.kind !== 'tool-result' || calls.has(record.id)) return true;
      const index = unclaimed.findIndex(
        other => other.content === record.content,
      );
      index >= 0 ||
        Fail`Native context cannot conceal unresolved or recovered tool evidence`;
      unclaimed.splice(index, 1);
      return false;
    });
  }
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
 * @param {{ portableFallback?: boolean, reconciledNativeSuffix?: boolean, toolArgumentKey?: (args: string) => string, omitIncompleteImages?: boolean }} [options] See `projectContext`.
 */
export const projectContextTranscript = (
  turns,
  readContent,
  excludeTurnId,
  options = {},
) => {
  const visitTurns = async visit => {
    for (const turn of turns) {
      // eslint-disable-next-line no-await-in-loop
      await visit(turn);
    }
  };
  return projectContext(
    visitTurns,
    readContent,
    excludeTurnId,
    undefined,
    visitTurns,
    options,
  );
};
harden(projectContextTranscript);

/**
 * Select from a snapshot-owned archived candidate plus retained metadata, then
 * project one page at a time from the same immutable cut. Excluding the archived
 * maximum falls back to a selection pass. Archive I/O and active output still
 * grow with history; superseded metadata is not accumulated in memory.
 * @param {any} journal
 * @param {string} [excludeTurnId]
 * @param {{ portableFallback?: boolean, reconciledNativeSuffix?: boolean, toolArgumentKey?: (args: string) => string, omitIncompleteImages?: boolean }} [options] See `projectContext`.
 */
export const readContextTranscript = async (
  journal,
  excludeTurnId,
  options = {},
) => {
  const view = await journal.readView();
  view.archivedCheckpoint !== undefined ||
    Fail`Missing archived checkpoint index`;
  const visitRetained = async visit => {
    for (const turn of view.retained) {
      // eslint-disable-next-line no-await-in-loop
      await visit(turn);
    }
  };
  const visitAll = async visit => {
    await visitRetained(visit);
    let cursor = view.archiveCursor;
    while (cursor !== null) {
      // eslint-disable-next-line no-await-in-loop
      const page = await journal.listArchivedPage(cursor);
      for (const turn of page.records) {
        // eslint-disable-next-line no-await-in-loop
        await visit(turn, true);
      }
      cursor = page.next;
    }
  };
  const checkpoint = view.archivedCheckpoint;
  // Excluding an arbitrary archived maximum needs the previous candidate.
  // Production excludes the active turn, but preserve the general contract.
  const indexed = checkpoint === null || checkpoint.turnId !== excludeTurnId;
  return projectContext(
    visitAll,
    ref => journal.readContent(ref),
    excludeTurnId,
    indexed && checkpoint !== null
      ? {
          turnId: checkpoint.turnId,
          ordinal: Number(checkpoint.ordinal),
          sequence: checkpoint.sequence,
        }
      : undefined,
    indexed ? visitRetained : visitAll,
    options,
  );
};
harden(readContextTranscript);
