// @ts-check
/**
 * Session compaction (`designs/m8-interfaces.md` 4; P-36; R4-33, R4-34,
 * R4-35, R4-36, R4-100): the session's context window and the runtime part
 * that decides when to ask the adapter to compact.
 *
 * The context window (4.7, `makeContextWindow`) holds two numbers: the
 * epoch (0 until the first accepted compaction) and the boundary (the
 * absolute index of the first record the model still sees after the
 * summary). It is made in `makeSession` over the record log and read by the
 * runner (`RoundRequest.base`), the archive (the seal's epoch), the
 * ContextSource (the page start) and the compaction part. It is not a part:
 * parts may not hold the record log (step3-plan 2.3). Compaction changes
 * what the model sees, never the record (D-M8-3): nothing here deletes or
 * rewrites a record.
 *
 * The part `compaction` (4.6, `compactionPart`):
 * - `hooks.beforeRound` (crank X, the crank that sends round r): when the
 *   reading crosses the threshold (4.1 rules 1-6), it appends
 *   `CompactionStarted`, writes `active.compactionAsk` (the runner puts it
 *   into the round request) and emits the `compacting context` phase;
 * - `compacted(turn, result)` (crank Y, the runner's `TurnSink.compacted`):
 *   checks the adapter's boundary (D-M8-4), records `Compaction` or
 *   `CompactionSkipped`, moves the window, emits `thinking`;
 * - `imageSeen(turnId)`: a `viewImage` result was recorded; the next
 *   round does not ask (R4-34: the model sees each image once first);
 * - `hooks.onSettle`: the per-turn state is cleared (recovery settles the
 *   turn, so no `onRecover` is needed; contract 4.6 lists one).
 *
 * State: one pending ask and five per-turn scalars (bounded; nothing keyed
 * by data; nothing that must survive export or a restart: the epoch and the
 * boundary are rebuilt from the records, 4.5).
 *
 * Guest rules.
 */
import { compactionTexts } from '../lib/guards/session.js';
import { contextLimits } from '../lib/limits.js';

/** @import { RecordLog } from './records.js' */
/** @import { HookTurn, Runtime, RuntimePart } from './runtime-parts.js' */

/**
 * @typedef {object} ContextWindow
 * @property {() => number} epoch 0 until the first compaction
 * @property {() => number} boundary 0 until the first compaction
 * @property {() => ({ epoch: number } | { epoch: number, boundary: number })} baseFields
 *   the window's fields of `RoundRequest.base`
 * @property {() => number} floor the archive's `sealedTo`: a new boundary
 *   is never below it (D-M8-4)
 * @property {() => number} nextIndex the index the next append takes
 * @property {(index: number) => boolean} isCut a kept `turn-started`, or a
 *   kept `round-settled` with `round > 0` (D-M8-4, R4-35)
 * @property {(moved: { epoch: number, boundary: number }) => void} apply
 *   an accepted compaction (the part, crank Y)
 * @property {(record: any, index: number) => void} observe an imported
 *   record at its index (S-8): a `compaction` record moves the window
 * @property {() => number} seenAt the latest adapter time the session has
 *   seen (the runner's clock; the vat has none)
 */

/**
 * @typedef {object} CompactionAsk `RoundRequest.compaction` (3.3)
 * @property {number} epoch the epoch the compaction creates
 * @property {number} boundary the current boundary
 * @property {number} askedAt the index of `CompactionStarted`
 * @property {number} startIndex the index of the turn's `TurnStarted`
 * @property {number} floor the lowest index a new boundary may take
 * @property {number} usedTokens
 * @property {number} windowTokens
 * @property {number} thresholdTokens
 */

/**
 * @param {object} options
 * @param {RecordLog} options.records
 * @param {() => number} [options.seenAt] the runner's `lastKnownTime`
 *   (session.js wires it; read at run time)
 * @returns {ContextWindow}
 */
export const makeContextWindow = ({ records, seenAt = () => 0 }) => {
  let epoch = 0;
  let boundary = 0;
  /** @param {{ epoch: number, boundary: number }} moved */
  const apply = moved => {
    epoch = moved.epoch;
    boundary = moved.boundary;
  };
  return harden({
    epoch: () => epoch,
    boundary: () => boundary,
    baseFields: () => (epoch === 0 ? { epoch } : { epoch, boundary }),
    floor: () => records.base(),
    nextIndex: () => records.count(),
    isCut: index => {
      /** @type {{ kind: string, round: number } | undefined} */
      const record = records.at(index);
      return (
        record?.kind === 'turn-started' ||
        (record?.kind === 'round-settled' && record.round > 0)
      );
    },
    apply,
    observe: (
      /** @type {{ kind: string, epoch: number, boundary: number }} */ record,
      _index,
    ) => {
      if (record.kind === 'compaction' && record.epoch > epoch) apply(record);
    },
    seenAt,
  });
};
harden(makeContextWindow);

/**
 * The part's value (4.6). Per-turn state: the turn it belongs to; an ask
 * is out (`pending`); the turn's compactions that ended `done`; a skip, or
 * an unanswered ask, ended the turn's asks; the round of the last ask; a
 * `viewImage` result was recorded since the last `beforeRound`.
 * @param {Runtime} runtime
 */
const makeCompaction = runtime => {
  /** @type {string | undefined} */
  let turnId;
  let pending = false;
  let done = 0;
  let ended = false;
  let lastAskRound = -2;
  let imagesUnseen = false;

  /** @param {string} [id] */
  const reset = id => {
    turnId = id;
    pending = false;
    ended = false;
    imagesUnseen = false;
    done = 0;
    lastAskRound = -2;
  };
  /** @param {string} id */
  const forTurn = id => turnId === id || reset(id);
  /**
   * @param {HookTurn} turn
   * @param {any} record
   */
  const append = ({ active, round, append: into }, record) =>
    into({ turnId: active.turnId, round, ...record });
  /**
   * @param {HookTurn} turn
   * @param {string} name
   */
  const phase = ({ active, emit }, name) =>
    emit({ type: 'phase', turnId: active.turnId, phase: name });

  /** @param {HookTurn} turn crank X (4.1) */
  const beforeRound = turn => {
    const { active, round, reading } = turn;
    const window = /** @type {ContextWindow | undefined} */ (
      runtime.contextWindow
    );
    forTurn(active.turnId);
    const postponed = imagesUnseen;
    // An ask still out was never answered (an adapter that does not compact
    // streamed the round; the runner cleared `compactionAsk` before this
    // hook): no more asks in this turn.
    if (pending) ended = true;
    pending = false;
    imagesUnseen = false;
    if (
      !window ||
      !reading ||
      ended ||
      postponed ||
      done >= contextLimits.compactionsPerTurn ||
      round < lastAskRound + 2
    ) {
      return;
    }
    const { usedTokens, windowTokens } = reading;
    const thresholdTokens = Math.floor(
      (windowTokens * contextLimits.compactionThresholdPercent) / 100,
    );
    const boundary = window.boundary();
    const startIndex = /** @type {number} */ (active.startIndex);
    if (
      !(usedTokens > 0 && windowTokens > 0 && usedTokens >= thresholdTokens) ||
      (round === 0 && boundary >= startIndex)
    ) {
      return;
    }
    const epoch = window.epoch() + 1;
    const askedAt = window.nextIndex();
    append(turn, {
      kind: 'compaction-started',
      epoch,
      boundary,
      usedTokens,
      windowTokens,
      at: round === 0 ? active.claimAt : window.seenAt(),
    });
    active.compactionAsk = {
      epoch,
      boundary,
      askedAt,
      startIndex,
      floor: window.floor(),
      usedTokens,
      windowTokens,
      thresholdTokens,
    };
    phase(turn, compactionTexts.phase);
    pending = true;
    lastAskRound = round;
  };

  /**
   * Crank Y (4.2): the runner checked that the ask is this round's.
   * @param {HookTurn} turn
   * @param {{ at: number, outcome: string, boundary: number, summary?: any, reason?: string }} result
   *   CompactionResult (the sink's guard checked it)
   */
  const compacted = (turn, result) => {
    const ask = /** @type {CompactionAsk} */ (turn.active.compactionAsk);
    const window = /** @type {ContextWindow} */ (runtime.contextWindow);
    const { at, boundary: b, outcome } = result;
    pending = false;
    if (
      outcome === 'done' &&
      ask.boundary < b &&
      ask.floor <= b &&
      b <= ask.askedAt &&
      window.isCut(b)
    ) {
      append(turn, {
        kind: 'compaction',
        epoch: ask.epoch,
        boundary: b,
        summary: result.summary,
        at,
        ...(b > ask.startIndex ? { directive: turn.active.info.input } : {}),
      });
      window.apply({ epoch: ask.epoch, boundary: b });
      done += 1;
    } else {
      append(turn, {
        kind: 'compaction-skipped',
        reason:
          outcome === 'done' ? compactionTexts.invalidBoundary : result.reason,
        at,
      });
      ended = true;
    }
    phase(turn, 'thinking');
  };

  return harden({
    // Recovery settles the turn (recovery.js step 8), so `onSettle` clears
    // it then too; a recovery that settles nothing leaves the state of a
    // turn no longer current, which `forTurn` drops.
    hooks: { beforeRound, onSettle: () => reset() },
    /** @param {string} id the turn whose `viewImage` result was recorded */
    imageSeen: id => {
      forTurn(id);
      imagesUnseen = true;
    },
    compacted,
  });
};

/** @type {RuntimePart} */
export const compactionPart = harden({
  name: 'compaction',
  make: makeCompaction,
});
