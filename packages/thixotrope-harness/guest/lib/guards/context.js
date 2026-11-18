// @ts-check
/**
 * The context window and compaction: shapes, the `TurnSink.compacted`
 * method guard, record kinds, fixed texts and limits (the M8 contract,
 * `designs/m8-interfaces.md` sections 3, 4 and 9; P-36, P-27; R4-33..R4-37,
 * R4-100).
 *
 * Read by the session vat (records, the compaction part, the turn sink) and
 * by the agent-host adapter (the plan, the summary round, the context
 * cache). Constants and guard builders only.
 *
 * How the entries reach the tables (contract section 7, seam G-1): the
 * session table (`./session.js`) spreads `contextShapeBuilders(() => shapes)`
 * into its `shapes`, adds the three record alternatives to `TurnRecord`,
 * spreads `compactionKindLetters` into `archiveKindLetters`, and adds
 * `contextSinkMethods(() => shapes)` to `methodsOf.TurnSink` and
 * `contextMethodNames.TurnSink` to its method names. The builders take a
 * getter of the table that holds them, so this module imports no table
 * above `./base.js` (no import cycle). The fold after the M6/M8/M9/M11
 * merge moves the entries into `./session.js` and deletes this module
 * (contract section 15).
 *
 * Every string and array is bounded; record keys are a fixed vocabulary
 * (architecture rule 12.10). Guest rules.
 */
import { limits } from '../limits.js';
import { text, list, record, count, staged } from './base.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { M } = /** @type {GuestGlobals} */ (globalThis);

// ---------------------------------------------------------------- limits

/**
 * M8's bounds and settings. The fold moves them into `../limits.js`
 * (contract section 15).
 */
export const contextLimits = harden({
  /**
   * R4-100 [default]: compaction fires before a round when the previous
   * request's used tokens reach this share of the window (percent;
   * `floor(window * 70 / 100)`, as lal `context-compaction.js:35`).
   */
  compactionThresholdPercent: 70,
  /**
   * R4-35: the verbatim tail may take 1 / this of the byte headroom left
   * after the system text, the directive and the tools (half).
   */
  tailHeadroomDivisor: 2,
  /**
   * At most this many compaction asks per turn that end `done`; an ask
   * that ends `skipped` ends the asks of its turn (contract D-M8-6).
   */
  compactionsPerTurn: 4,
  /**
   * A summary longer than this (UTF-8 bytes) is refused (`skipped`,
   * `compactionTexts.summaryTooLong`): the model was asked for a compact
   * handoff; the bound keeps one staged field small.
   */
  summaryMaxBytes: 65_536,
  /** Preview of a staged summary in the record (units). */
  summaryPreviewUnits: 256,
  /**
   * Open decision 13 [configured window]: the window a session on the
   * Anthropic API stores at creation when the catalogue reports none
   * (the Messages API's model listing has no context length; G-04).
   */
  anthropicContextTokens: 200_000,
  /** Halvings of the old tool excerpts before a summary request gives up. */
  excerptHalvings: 24,
});

// ---------------------------------------------------------------- kinds

/** The record kinds compaction adds to the session log, in order of use. */
export const compactionKinds = harden([
  'compaction-started',
  'compaction',
  'compaction-skipped',
]);

/**
 * Kind letters for the archive's seal fingerprint (m2-interfaces.md 4.4
 * A1); `./session.js` spreads them into `archiveKindLetters`. Letters not
 * used by M2's kinds (`s d p r i t e v`).
 */
export const compactionKindLetters = harden([
  ['compaction-started', 'c'],
  ['compaction', 'k'],
  ['compaction-skipped', 'x'],
]);

// ---------------------------------------------------------------- texts

/**
 * Fixed texts. Skip reasons are recorded in `CompactionSkipped.reason` and
 * never quote a provider body (R4-79).
 */
export const compactionTexts = harden({
  /** R4-50: the phase while a compaction ask is out. */
  phase: 'compacting context',
  /** R4-35: no complete call-and-result group lies before the tail. */
  nothingToSummarize: 'Compaction skipped: no completed work to summarize',
  /** R4-35: an unresolved unknown tool outcome holds the boundary back. */
  pinnedByUnknownOutcome:
    'Compaction skipped: an unresolved unknown tool outcome must stay visible',
  /** lal `context-compaction.js:58`: the fixed parts alone exceed the headroom. */
  headroomExceeded:
    'Compaction skipped: compaction instructions and tools exceed the model headroom',
  /** lal `context-compaction.js:160`: excerpts halved to nothing still do not fit. */
  summaryInputTooLarge:
    'Compaction skipped: the summary input exceeds the model headroom',
  /** lal `context-compaction.js:219`: empty text or tool calls. */
  invalidSummary: 'Compaction skipped: the model returned no usable summary',
  /** `contextLimits.summaryMaxBytes`. */
  summaryTooLong: 'Compaction skipped: the summary is longer than the limit',
  /** lal `context-compaction.js:231`: the new context is not smaller. */
  noReduction: 'Compaction skipped: the summary did not reduce the context',
  /** lal `context-compaction.js:233`. */
  stillOverHeadroom:
    'Compaction skipped: the summary and the retained tail exceed the model headroom',
  /** The vat refused the boundary the adapter answered (contract 4.3). */
  invalidBoundary: 'Compaction skipped: the proposed boundary is not a cut',
  /** The cache held no records for the plan (contract 5.2). */
  notCached: 'Compaction skipped: the context was not available to plan',
});

// ---------------------------------------------------------------- shapes

/**
 * Shape builders for the session table; `table()` answers the table that
 * holds them (the session's `shapes`), read only when a shape is built.
 * @param {() => any} table
 */
export const contextShapeBuilders = table => ({
  /**
   * `RoundRequest.compaction` (vat -> adapter, outbound): the session asks
   * the adapter to plan and summarize before this round. `epoch` is the
   * epoch the compaction creates; `boundary` the current one; `askedAt` the
   * index of the `compaction-started` record; `startIndex` the index of the
   * current turn's `turn-started`; `floor` the lowest index a new boundary
   * may take (the archive's `sealedTo`, D-M8-4); the token figures are the
   * reading the decision used.
   */
  CompactionAsk: () =>
    record({
      epoch: count,
      boundary: count,
      askedAt: count,
      startIndex: count,
      floor: count,
      usedTokens: count,
      windowTokens: count,
      thresholdTokens: count,
    }),
  /** Recorded in the crank that sends the ask (intent before effect). */
  CompactionStarted: () => {
    const S = table();
    return record({
      kind: 'compaction-started',
      turnId: S.Id,
      round: count,
      epoch: count,
      boundary: count,
      usedTokens: count,
      windowTokens: count,
      at: count,
    });
  },
  /**
   * Recorded when the vat accepts a summary: from now on the model sees
   * `summary` (an assistant message), then `directive` when the boundary
   * lies after the current turn's `turn-started`, then the records from
   * `boundary`.
   */
  Compaction: () => {
    const S = table();
    return record(
      {
        kind: 'compaction',
        turnId: S.Id,
        round: count,
        epoch: count,
        boundary: count,
        summary: staged(S.Text),
        at: count,
      },
      { directive: staged(S.SubmissionText) },
    );
  },
  /** Recorded when the adapter or the vat refused to compact. */
  CompactionSkipped: () => {
    const S = table();
    return record({
      kind: 'compaction-skipped',
      turnId: S.Id,
      round: count,
      reason: S.Reason,
      at: count,
    });
  },
  /**
   * `TurnSink.compacted` argument (adapter -> vat). `usage` is the summary
   * call's counts; the vat adds them to the turn and ignores any `context`
   * reading in it (R4-36: charged, not continuation occupancy).
   */
  CompactionResult: () => {
    const S = table();
    return M.or(
      record(
        {
          round: count,
          at: count,
          outcome: 'done',
          boundary: count,
          summary: staged(text(limits.inlineBytes)),
        },
        { usage: S.Usage, servedBy: S.ServedBy },
      ),
      record(
        { round: count, at: count, outcome: 'skipped', reason: S.Reason },
        { usage: S.Usage },
      ),
    );
  },
  /**
   * `TurnSink.compacted` answer (vat -> adapter). `go: false`: the turn is
   * no longer running this round; send nothing more. `go: true`: the
   * cache's next `{ base, append }` for this round (the records appended
   * since the round request, the compaction record among them).
   */
  CompactionReply: () => {
    const S = table();
    return M.or(
      record({ go: false }),
      record({
        go: true,
        base: record(
          { count, epoch: count },
          { boundary: count, archive: S.ArchiveState },
        ),
        append: list(S.TurnRecord, limits.maxAppendRecords),
      }),
    );
  },
});

/**
 * The method `TurnSink` gains (seam G-1).
 * @param {() => any} table
 */
export const contextSinkMethods = table => ({
  compacted: M.call(table().CompactionResult).returns(table().CompactionReply),
});

/** Method names added per interface. */
export const contextMethodNames = harden({ TurnSink: harden(['compacted']) });
