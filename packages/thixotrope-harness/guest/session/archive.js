// @ts-check
/**
 * The session vat's side of the record archive (M2 W2.5; D-M2-1;
 * `designs/m2-interfaces.md` 4.3-4.6).
 *
 * The vat stays the system of record: it decides what and when to seal and
 * keeps the index of what it sealed. In the settle crank (S) of a turn, when
 * the session keeps at least `archiveKeepTurns + archiveSegmentTurns`
 * settled turns, `maybeSeal` cuts the oldest kept turns into one segment by
 * the size rule (whole turns; a turn's span runs to the next turn's
 * `TurnStarted`), records the intent (`sealing`) and sends
 * `ArchivePort.seal` in the same crank (intent before effect). The records
 * are dropped only in the crank that receives the adapter's answer that the
 * segment is durable (crank Z, `sealed`), and only when the answer matches
 * the intent and the range still starts the log (durable before drop). A
 * rejection or a retired break (an adapter restart) leaves every record in
 * place; the session seals again `archiveSegmentTurns / 4` settles later.
 *
 * Kept here, each bounded: the `ArchiveState`, one `SegmentEntry` per
 * segment (at most `archiveMaxSegments`; then sealing stops), the intent,
 * and `unresolved`: the infos of archived outcome-unknown turns not yet
 * resolved (at most `maxUnresolvedTurns`; the oldest goes first). No handle
 * per segment: segments are ranges of the session's one archive (4.6).
 */
import { archiveKindLetters, texts } from '../lib/interfaces.js';
import { limits as defaultLimits } from '../lib/limits.js';
import { inCallOrder, plainBytes } from './records.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { RecordLog } from './records.js' */
const { E, Fail } = /** @type {GuestGlobals} */ (globalThis);

/** @type {Map<string, string>} */
const letterOf = new Map(/** @type {any} */ (archiveKindLetters));

/**
 * @param {object} options
 * @param {RecordLog} options.records
 * @param {typeof defaultLimits} [options.limits] `limits.js` (tests pass
 *   smaller bounds)
 * @param {(dropped: string[]) => void} [options.onSealed] crank Z: the turns
 *   whose records were dropped, in start order
 * @param {(error: unknown, ports: any) => void} [options.onNotSealed] the
 *   seal was rejected or broke
 */
export const makeSessionArchive = ({
  records,
  limits = defaultLimits,
  onSealed = () => {},
  onNotSealed = () => {},
}) => {
  let sealedTurns = 0;
  let digest = '';
  /** @type {any[]} */
  const entries = [];
  /** @type {{ generation: number, from: number, to: number, firstTurn: number, turns: number, records: number } | undefined} */
  let sealing;
  let generation = 0;
  /** settles seen (maybeSeal calls), for the retry rule (4.3 item 6) */
  let settles = 0;
  let failedAt = -Infinity;
  let fenced = false;
  /**
   * Archived outcome-unknown turns not yet resolved: turn id -> info,
   * oldest first (4.6).
   * @type {Map<string, any>}
   */
  const unresolved = new Map();

  const state = () =>
    harden({
      sealedTo: records.base(),
      sealedTurns,
      segments: entries.length,
      digest,
    });

  /**
   * The next segment's range by the size rule (4.2), or undefined.
   * @returns {{ to: number, count: number, recordCount: number, bytes: number } | undefined}
   */
  const rangeOf = () => {
    const ids = records.turnIds();
    const last = ids.length - limits.archiveKeepTurns;
    let count = 0;
    let recordCount = 0;
    let bytes = 0;
    let to = records.base();
    for (let k = 0; k < last && count < limits.archiveSegmentTurns; k += 1) {
      const start = records.startOf(ids[k]);
      const end = records.startOf(ids[k + 1]);
      const spanRecords = end - start;
      if (
        count > 0 &&
        recordCount + spanRecords > limits.archiveSegmentRecords
      ) {
        break;
      }
      let spanBytes = 0;
      let settled = false;
      for (let i = start; i < end; i += 1) {
        const record = records.at(i);
        spanBytes += plainBytes(record);
        if (record.kind === 'turn-settled' && record.turnId === ids[k]) {
          settled = true;
        }
      }
      // Only settled turns are sealed (never the turn a claim may start).
      if (!settled) break;
      if (count > 0 && bytes + spanBytes > limits.archiveSegmentBytes) break;
      count += 1;
      recordCount += spanRecords;
      bytes += spanBytes;
      to = end;
      if (
        recordCount > limits.archiveSegmentRecords ||
        bytes > limits.archiveSegmentBytes
      ) {
        break;
      }
    }
    return count === 0 ? undefined : { to, count, recordCount, bytes };
  };

  /**
   * Crank S (4.3, 4.4): start a seal when every condition holds. Called by
   * the runner in a settle crank with no turn current (or after an import),
   * before the next entry is claimed.
   * @param {{ ports: any, context: any }} options
   * @returns {boolean} whether a seal was sent
   */
  const maybeSeal = ({ ports, context }) => {
    settles += 1;
    if (sealing !== undefined || fenced) return false;
    if (ports?.archive === undefined) return false;
    if (entries.length >= limits.archiveMaxSegments) return false;
    if (settles - failedAt < limits.archiveSegmentTurns / 4) return false;
    const ids = records.turnIds();
    if (ids.length < limits.archiveKeepTurns + limits.archiveSegmentTurns) {
      return false;
    }
    const range = rangeOf();
    if (range === undefined) return false;
    const from = records.base();
    /** @type {string[]} */
    const letters = [];
    const head = inCallOrder(
      records
        .since(from)
        .slice(0, Math.min(range.recordCount, limits.archiveSegmentRecords)),
    );
    for (const record of head) {
      letters.push(/** @type {string} */ (letterOf.get(record.kind)));
    }
    generation += 1;
    const intent = harden({
      generation,
      from,
      to: range.to,
      firstTurn: sealedTurns + 1,
      turns: range.count,
      records: range.recordCount,
    });
    // Intent before effect: recorded in the crank whose frame carries the seal.
    sealing = intent;
    const request = harden({
      from,
      to: range.to,
      firstTurn: intent.firstTurn,
      turns: range.count,
      records: range.recordCount,
      bytes: range.bytes,
      firstTurnId: ids[0],
      lastTurnId: ids[range.count - 1],
      kinds: letters.join(''),
      epoch: 0,
      previous: digest,
      context,
    });
    E(ports.archive)
      .seal(request)
      .then(
        answer => {
          if (sealing !== intent) return;
          const dropped = sealed(answer);
          if (dropped !== undefined) {
            onSealed(dropped);
            return;
          }
          // An answer that does not match the intent: not sealed.
          sealing = undefined;
          failedAt = settles;
        },
        error => {
          if (sealing !== intent) return;
          sealing = undefined;
          failedAt = settles;
          onNotSealed(error, ports);
        },
      );
    return true;
  };

  /**
   * Crank Z: apply a seal answer when it matches the intent and its range
   * still starts the log; returns the dropped turn ids, else undefined.
   * @param {any} answer a SegmentEntry
   * @returns {string[] | undefined}
   */
  const sealed = answer => {
    const intent = sealing;
    if (
      intent === undefined ||
      answer.from !== intent.from ||
      answer.to !== intent.to ||
      answer.firstTurn !== intent.firstTurn ||
      answer.turns !== intent.turns ||
      answer.records !== intent.records ||
      answer.from !== records.base()
    ) {
      return undefined;
    }
    sealing = undefined;
    entries.push(
      harden({
        from: answer.from,
        to: answer.to,
        firstTurn: answer.firstTurn,
        turns: answer.turns,
        records: answer.records,
        bytes: answer.bytes,
        digest: answer.digest,
      }),
    );
    sealedTurns += answer.turns;
    digest = answer.digest;
    return records.dropBefore(answer.to);
  };

  /**
   * Keep an archived turn's info resolvable (4.6); the oldest beyond
   * `maxUnresolvedTurns` is no longer resolvable.
   * @param {string} turnId
   * @param {any} info
   */
  const keepUnresolved = (turnId, info) => {
    unresolved.set(turnId, info);
    if (unresolved.size > limits.maxUnresolvedTurns) {
      const oldest = unresolved.keys().next().value;
      if (oldest !== undefined) unresolved.delete(oldest);
    }
  };

  /** @param {string} [cursor] `s<n>`: entries from the n-th on (0-based) */
  const segments = cursor => {
    let start = 0;
    if (cursor !== undefined) {
      const match = /^s(0|[1-9][0-9]*)$/.exec(cursor);
      start = match === null ? NaN : Number(match[1]);
      if (!(Number.isSafeInteger(start) && start <= entries.length)) {
        throw Error(texts.badCursor);
      }
    }
    const page = entries.slice(start, start + limits.segmentPageEntries);
    /** @type {Record<string, any>} */
    const result = { segments: harden(page) };
    if (start + page.length < entries.length) {
      result.next = `s${start + page.length}`;
    }
    return harden(result);
  };

  return harden({
    state,
    /** The index, oldest first (a copy). */
    entries: () => harden([...entries]),
    segments,
    maybeSeal,
    sealed,
    unresolved,
    keepUnresolved,
    /** Whether the session has sealed any segment. */
    any: () => entries.length > 0,
    /** The archived turns (ordinals 1 .. sealedTurns). */
    sealedTurns: () => sealedTurns,
    /** The intent of the seal in flight, or undefined. */
    sealing: () => sealing,
    /** No seal starts from now on (delete, 7.1). */
    fence: () => {
      fenced = true;
    },
    /**
     * Adopt an archive the adapter imported (W2.7): the log must be empty.
     * @param {{ archive: any, segments: readonly any[] }} imported
     */
    adopt: ({ archive, segments: list }) => {
      (entries.length === 0 && records.count() === 0) ||
        Fail`only an empty session adopts an archive`;
      list.length === archive.segments || Fail`the segment list is incomplete`;
      for (const entry of list) entries.push(harden({ ...entry }));
      sealedTurns = archive.sealedTurns;
      digest = archive.digest;
      records.startAt(archive.sealedTo, archive.sealedTurns);
    },
  });
};
harden(makeSessionArchive);
