// @ts-check
/**
 * The session's record log (M1a W1a.4; architecture 4.3;
 * `designs/m1a-interfaces.md` section 4).
 *
 * An append-only array of `TurnRecord`s in append order. A record is
 * appended in the same crank as the effect it precedes (intent before
 * effect): the heap and the crank's outbound messages become durable
 * together (M0 S9). Nothing is ever removed (transcript content is kept
 * until the session is deleted, R4-64).
 *
 * Data-keyed state stays in `Map`s (rule 12.10): the turn index maps a turn
 * id to the positions of its records. Every record is checked against
 * `shapes.TurnRecord` (closed shapes, fixed keys) and hardened before it is
 * kept.
 */
import { shapes } from '../lib/interfaces.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Fail } = /** @type {GuestGlobals} */ (globalThis);
/** @type {GuestGlobals['mustMatch']} */
const mustMatch = /** @type {any} */ (globalThis).mustMatch;

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
 * @property {() => number} count records appended so far
 * @property {(index: number) => any[]} since the records from `index` on
 *   (a copy: callers that need only a few records use `at`)
 * @property {(index: number) => any} at the record at `index`, or undefined
 * @property {(turnId: string) => any[]} ofTurn one turn's records in append order
 * @property {() => number} messageCount the number of `TurnStarted` records
 * @property {() => readonly string[]} turnIds turn ids in start order (do not mutate)
 * @property {(turnId: string) => boolean} hasTurn
 */

/** @returns {RecordLog} */
export const makeRecordLog = () => {
  /** @type {any[]} */
  const log = [];
  /**
   * turn id -> positions in `log`
   * @type {Map<string, number[]>}
   */
  const byTurn = new Map();
  /** @type {string[]} */
  const turnOrder = [];

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
    let positions = byTurn.get(kept.turnId);
    if (positions === undefined) {
      kept.kind === 'turn-started' ||
        Fail`the first record of a turn must be turn-started, not ${kept.kind}`;
      positions = [];
      byTurn.set(kept.turnId, positions);
      turnOrder.push(kept.turnId);
    } else {
      kept.kind !== 'turn-started' || Fail`turn ${kept.turnId} already started`;
    }
    const index = log.length;
    log.push(kept);
    positions.push(index);
    return index;
  };

  return harden({
    append,
    count: () => log.length,
    since: index => log.slice(index),
    at: index => log[index],
    ofTurn: turnId => (byTurn.get(turnId) ?? []).map(index => log[index]),
    messageCount: () => turnOrder.length,
    turnIds: () => turnOrder,
    hasTurn: turnId => byTurn.has(turnId),
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
    ordered[slot] = results[k];
  });
  return ordered;
};
harden(inCallOrder);
