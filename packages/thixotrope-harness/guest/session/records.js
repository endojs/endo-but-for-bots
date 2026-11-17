// @ts-check
/**
 * The session's record log (M1a W1a.4; architecture 4.3;
 * `designs/m1a-interfaces.md` section 4; M2 W2.5: the record archive,
 * `designs/m2-interfaces.md` 4).
 *
 * An append-only list of `TurnRecord`s in append order, addressed by
 * absolute index. A record is appended in the same crank as the effect it
 * precedes (intent before effect): the heap and the crank's outbound
 * messages become durable together (M0 S9).
 *
 * M2 (D-M2-1): the log keeps only its tail. `dropBefore(index)` drops the
 * records before `index` in the crank that receives the archive's answer
 * that they are durable in a segment (crank Z); the log then starts at
 * `base()`. Whole turns only: `index` is a turn's `TurnStarted` (or the end).
 * Absolute indexes never change, and turns keep their ordinals (a dropped
 * turn still counts in `messageCount`).
 *
 * Data-keyed state stays in `Map`s (rule 12.10): the turn index maps a turn
 * id to the absolute positions of its records, for kept turns only. A
 * `TurnResolved` of a turn whose records were dropped is appended to the
 * log (it is sealed later with the turns around it) and indexed under no
 * kept turn. Every record is checked against `shapes.TurnRecord` (closed
 * shapes, fixed keys) and hardened before it is kept.
 */
import { shapes } from '../lib/interfaces.js';
import { utf8Bytes } from '../lib/bounded.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Fail } = /** @type {GuestGlobals} */ (globalThis);
/** @type {GuestGlobals['mustMatch']} */
const mustMatch = /** @type {any} */ (globalThis).mustMatch;

/**
 * Exact UTF-8 bytes of the strings (keys included) of a plain record tree:
 * records, arrays, strings, numbers, booleans. Cheaper than `messageBytes`,
 * which asks `passStyleOf` about every node; for the vat's own records. A
 * staged field's `blob` counts its key only (a handle is 0 bytes of text,
 * m2-interfaces.md 4.2).
 * @param {unknown} value
 * @returns {number}
 */
export const plainBytes = value => {
  if (typeof value === 'string') return utf8Bytes(value);
  if (typeof value !== 'object' || value === null) return 0;
  let total = 0;
  if (Array.isArray(value)) {
    for (const item of value) total += plainBytes(item);
    return total;
  }
  for (const key of Object.keys(value)) {
    total += key.length;
    if (key !== 'blob') total += plainBytes(/** @type {any} */ (value)[key]);
  }
  return total;
};
harden(plainBytes);

/**
 * Record kind -> its shape's name in `shapes` (the alternatives of
 * `shapes.TurnRecord`).
 * @type {Map<string, 'TurnStarted' | 'Dispatched' | 'Partial' | 'RoundSettled' | 'ToolIntents' | 'ToolResult' | 'TurnSettled' | 'TurnResolved'>}
 */
const shapeOfKind = new Map([
  ['turn-started', 'TurnStarted'],
  ['dispatched', 'Dispatched'],
  ['partial', 'Partial'],
  ['round-settled', 'RoundSettled'],
  ['tool-intents', 'ToolIntents'],
  ['tool-result', 'ToolResult'],
  ['turn-settled', 'TurnSettled'],
  ['turn-resolved', 'TurnResolved'],
]);

/**
 * @typedef {object} RecordLog
 * @property {(record: any) => number} append check, harden and append; returns its index
 * @property {() => number} count records appended so far (absolute: the
 *   dropped ones count)
 * @property {(index: number) => any[]} since the kept records from `index`
 *   (or from `base()`, whichever is later) on (a copy: callers that need
 *   only a few records use `at`)
 * @property {(index: number) => any} at the record at `index`, or undefined
 *   (dropped or not yet appended)
 * @property {(turnId: string) => any[]} ofTurn a kept turn's records in append order
 * @property {(turnId: string) => number} startOf a kept turn's `TurnStarted`
 *   index, or -1
 * @property {() => number} messageCount the number of `TurnStarted` records
 *   ever appended
 * @property {() => readonly string[]} turnIds kept turn ids in start order
 *   (do not mutate)
 * @property {(turnId: string) => boolean} hasTurn a kept turn
 * @property {() => number} base the index of the first kept record
 * @property {() => number} droppedTurns turns whose records were dropped
 *   (the ordinal of the first kept turn is this plus one)
 * @property {(index: number) => string[]} dropBefore drop every record
 *   before `index` (a kept turn's start, or `count()`); returns the ids of
 *   the turns dropped, in start order
 * @property {(index: number, turns: number) => void} startAt an empty log
 *   whose first `index` records and `turns` turns are archived elsewhere
 *   (an imported archive, W2.7)
 */

/** @returns {RecordLog} */
export const makeRecordLog = () => {
  let base = 0;
  let dropped = 0;
  /** @type {any[]} */
  let log = [];
  /**
   * turn id -> absolute positions
   * @type {Map<string, number[]>}
   */
  let byTurn = new Map();
  /** @type {string[]} */
  let turnOrder = [];

  /** @param {any} record */
  const append = record => {
    const kept = harden(record);
    // The shape named by the record's kind: one closed splitRecord match
    // instead of trying the alternatives of shapes.TurnRecord in turn.
    const name = shapeOfKind.get(kept.kind);
    mustMatch(
      kept,
      name === undefined ? shapes.TurnRecord : shapes[name],
      'turn record',
    );
    const index = base + log.length;
    const positions = byTurn.get(kept.turnId);
    if (positions !== undefined) {
      kept.kind !== 'turn-started' || Fail`turn ${kept.turnId} already started`;
      positions.push(index);
    } else if (kept.kind === 'turn-started') {
      byTurn.set(kept.turnId, [index]);
      turnOrder.push(kept.turnId);
    } else {
      // Only a dropped turn's resolution may name a turn the log does not keep.
      (kept.kind === 'turn-resolved' && dropped > 0) ||
        Fail`the first record of a turn must be turn-started, not ${kept.kind}`;
    }
    log.push(kept);
    return index;
  };

  /** @param {number} index */
  const dropBefore = index => {
    const cut = index - base;
    (cut >= 0 && cut <= log.length) || Fail`cannot drop before ${index}`;
    cut === log.length ||
      log[cut].kind === 'turn-started' ||
      Fail`a drop must end at a turn's start`;
    const tail = log.slice(cut);
    /** @type {string[]} */
    const gone = [];
    for (const turnId of turnOrder) {
      const positions = /** @type {number[]} */ (byTurn.get(turnId));
      if (positions[0] >= index) break;
      gone.push(turnId);
    }
    // Fresh arrays and maps for the kept tail (at most the kept turns):
    // nothing keeps the dropped records reachable.
    log = tail;
    base = index;
    dropped += gone.length;
    byTurn = new Map();
    turnOrder = [];
    tail.forEach((record, k) => {
      const positions = byTurn.get(record.turnId);
      if (positions !== undefined) {
        positions.push(index + k);
      } else if (record.kind === 'turn-started') {
        byTurn.set(record.turnId, [index + k]);
        turnOrder.push(record.turnId);
      }
    });
    return gone;
  };

  return harden({
    append,
    count: () => base + log.length,
    since: index => log.slice(Math.max(index - base, 0)),
    at: index => (index < base ? undefined : log[index - base]),
    ofTurn: turnId =>
      (byTurn.get(turnId) ?? []).map(index => log[index - base]),
    startOf: turnId => {
      const positions = byTurn.get(turnId);
      return positions === undefined ? -1 : positions[0];
    },
    messageCount: () => dropped + turnOrder.length,
    turnIds: () => turnOrder,
    hasTurn: turnId => byTurn.has(turnId),
    base: () => base,
    droppedTurns: () => dropped,
    dropBefore,
    startAt: (index, turns) => {
      (log.length === 0 && base === 0 && dropped === 0) ||
        Fail`startAt needs an empty log`;
      base = index;
      dropped = turns;
    },
  });
};
harden(makeRecordLog);

/**
 * Records in presentation order: a round's `ToolResult`s are kept in the
 * slots they were appended to (completion order), but those slots are
 * refilled in call order (R4-44), using the op id order of the
 * `ToolIntents` records among `records`. Results whose intent is not among
 * `records` keep their place. Op ids are compared through a `Map` built
 * here; nothing parses them.
 *
 * @param {readonly any[]} records
 * @returns {any[]}
 */
export const inCallOrder = records => {
  /**
   * op id -> call sequence
   * @type {Map<string, number>}
   */
  const sequence = new Map();
  for (const record of records) {
    if (record.kind === 'tool-intents') {
      for (const intent of record.intents) {
        sequence.set(intent.opId, sequence.size);
      }
    }
  }
  /** @type {number[]} */
  const slots = [];
  /** @type {any[]} */
  const results = [];
  records.forEach((record, index) => {
    if (record.kind === 'tool-result' && sequence.has(record.opId)) {
      slots.push(index);
      results.push(record);
    }
  });
  if (results.length < 2) return [...records];
  results.sort(
    (a, b) =>
      /** @type {number} */ (sequence.get(a.opId)) -
      /** @type {number} */ (sequence.get(b.opId)),
  );
  const ordered = [...records];
  slots.forEach((slot, k) => {
    ordered.splice(slot, 1, results[k]);
  });
  return ordered;
};
harden(inCallOrder);
