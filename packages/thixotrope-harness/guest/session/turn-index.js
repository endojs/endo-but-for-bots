// @ts-check
/**
 * The session's turns as records (J-9152; `designs/m2-interfaces.md` 4.6,
 * 4.9, 5.3): part of the turn runner.
 *
 * Keeps, each bounded or with a delete path (ARCH 12.6):
 * - `TurnInfo` by turn id for every kept turn (a sealed turn's info goes in
 *   the archive's crank Z, `archived`);
 * - the Turn objects of settled turns handed out most recently, at most
 *   `limits.retainedTurnHandles` (a Map keeps insertion order; a hit is
 *   deleted and set again, so no element moves in place);
 * - the turn counter: turn ids are `t<ordinal>` (F.2 d).
 *
 * A Turn is minted from its info when a page or a receipt hands one out
 * (`mint`, the runner's Turn class), so a Turn minted again for a settled
 * turn behaves as the first one. The current turn's own Turn comes from the
 * runner (`live`).
 *
 * Guest rules; data-keyed state in Maps (12.10). Sends nothing.
 */
import { texts } from '../lib/guards/session.js';

/** @import { TurnInfo } from './turn-types.js' */

/**
 * @param {object} options
 * @param {{ retainedTurnHandles: number }} options.limits
 * @param {{ unresolvedInfo: (turnId: string) => any, keepUnresolved: (turnId: string, info: any) => void }} options.archive
 * @param {(info: TurnInfo) => any} options.mint a new Turn for this info
 * @param {() => ({ info: TurnInfo, turn: any } | undefined)} options.live
 *   the current turn, whose Turn is its own
 */
export const makeTurnIndex = ({ limits, archive, mint, live }) => {
  let counter = 0;
  /**
   * turn id -> info (records only; J-9152)
   * @type {Map<string, TurnInfo>}
   */
  const turns = new Map();
  /**
   * Turn objects of settled turns, least recently handed out first.
   * @type {Map<string, any>}
   */
  const handles = new Map();

  /**
   * Keep `handle` as the most recently handed-out Turn of `turnId`; drop
   * the least recently used beyond `retainedTurnHandles`.
   * @param {string} turnId
   * @param {any} handle
   */
  const remember = (turnId, handle) => {
    handles.delete(turnId);
    handles.set(turnId, handle);
    if (handles.size > limits.retainedTurnHandles) {
      const oldest = handles.keys().next().value;
      if (oldest !== undefined) handles.delete(oldest);
    }
  };

  /**
   * The Turn object of a turn: the current turn's own, else a recent handle,
   * else one minted from the record (J-9152).
   * @param {TurnInfo} info
   */
  const handle = info => {
    const current = live();
    if (current !== undefined && current.info === info) return current.turn;
    const known = handles.get(info.turnId);
    const turn = known ?? mint(info);
    remember(info.turnId, turn);
    return turn;
  };

  /**
   * The Turn of a turn id while the session keeps the turn (live, kept or
   * unresolved), else undefined (an archived turn; 2.4, 5.3).
   * @param {string} turnId
   */
  const byId = turnId => {
    const info = turns.get(turnId) ?? archive.unresolvedInfo(turnId);
    return info === undefined ? undefined : handle(info);
  };

  return harden({
    /** The id the next turn gets. */
    nextId: () => `t${counter + 1}`,
    /** The number of turns started (claimed or imported). */
    count: () => counter,
    /** A turn was claimed: the counter moves on. */
    claimed: () => {
      counter += 1;
    },
    /**
     * Keep a turn's info.
     * @param {TurnInfo} info
     */
    add: info => {
      turns.set(info.turnId, info);
    },
    /**
     * A kept turn's info, or undefined.
     * @param {string} turnId
     */
    info: turnId => turns.get(turnId),
    /** The kept infos, in start order. */
    infos: () => turns.values(),
    remember,
    handle,
    byId,
    /**
     * `Session.findTurn` (4.9): a kept turn's handle, or an archived
     * unresolved one's; another archived turn throws `turnSealed`, anything
     * else `unknownTurn`.
     * @param {string} turnId
     */
    find: turnId => {
      const found = byId(turnId);
      if (found !== undefined) return found;
      const match = /^t([1-9][0-9]*)$/.exec(turnId);
      if (match !== null && Number(match[1]) <= counter) {
        throw Error(texts.turnSealed);
      }
      throw Error(texts.unknownTurn);
    },
    /**
     * The archive's crank Z (4.4): the sealed turns' infos go; an archived
     * outcome-unknown turn not yet resolved stays resolvable (4.6).
     * @param {string[]} dropped
     */
    archived: dropped => {
      for (const turnId of dropped) {
        const info = turns.get(turnId);
        turns.delete(turnId);
        if (info !== undefined) {
          info.sealed = true;
          if (
            info.state === 'outcome-unknown' &&
            info.resolution === undefined
          ) {
            archive.keepUnresolved(turnId, info);
          }
        }
      }
    },
  });
};
harden(makeTurnIndex);

/** @typedef {ReturnType<typeof makeTurnIndex>} TurnIndex */
