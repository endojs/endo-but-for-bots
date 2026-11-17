// @ts-check
// Test helpers for W2.8 (the record archive's adapter side): a fake session
// vat that keeps the vat's side of the archive protocol as
// designs/m2-interfaces.md 4.3-4.9 specifies it (W2.5 builds the real one):
// the full record list (the oracle), the kept tail from `sealedTo`, the
// `ArchiveState` and its index of `SegmentEntry`s, sealing by the size
// rule with the intent recorded before the call and the records dropped
// only on a matching answer (crank Z), a ContextSource from `sealedTo`
// (`texts.recordsSealed` below it) with `segments()`, RoundRequests with
// `base.archive`, and a Session whose `getHistoryPage` serves kept turns.
// Import after the guest prelude.
/* eslint-disable import/no-relative-packages */
import { archiveKindLetters, texts } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { inCallOrder } from '../../guest/session/records.js';
/* eslint-enable import/no-relative-packages */
import { makeRandom, USAGE } from './_m1b-context.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

const letterOf = new Map(archiveKindLetters.map(([k, l]) => [k, l]));

/**
 * String bytes and keys; a Blob handle counts 0 (the vat's `plainBytes`).
 * @param {any} value
 * @returns {number}
 */
export const plainBytes = value => {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (typeof value !== 'object' || value === null) return 0;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += plainBytes(item);
    return total;
  }
  let total = 0;
  for (const key of Object.keys(value)) {
    total += key.length + plainBytes(value[key]);
  }
  return total;
};

/**
 * @typedef {object} FakeVatOptions
 * @property {number} [seed]
 * @property {any} [store] a BlobStore; without one nothing is staged
 * @property {number} [stagedChance]
 * @property {number} [interruptedChance]
 * @property {number} [cancelChance]
 * @property {number} [unknownChance]
 * @property {number} [resolveChance] an outcome-unknown turn is resolved
 *   at a later turn's start (a TurnResolved in the log)
 * @property {number} [toolChance]
 * @property {number} [maxCalls]
 * @property {number} [nativeChance]
 * @property {number} [textUnits]
 * @property {number} [fallbackChance] a request sent with `append: []`
 * @property {number} [keepTurns]
 * @property {number} [segmentTurns]
 * @property {number} [segmentRecords]
 * @property {number} [segmentBytes]
 */

/** @param {FakeVatOptions} [options] */
export const makeFakeVat = ({
  seed = 1,
  store,
  stagedChance = 0.2,
  interruptedChance = 0.06,
  cancelChance = 0.06,
  unknownChance = 0.06,
  resolveChance = 0.5,
  toolChance = 0.5,
  maxCalls = 4,
  nativeChance = 0.3,
  textUnits = 40,
  fallbackChance = 0.05,
  keepTurns = limits.archiveKeepTurns,
  segmentTurns = limits.archiveSegmentTurns,
  segmentRecords = limits.archiveSegmentRecords,
  segmentBytes = limits.archiveSegmentBytes,
} = {}) => {
  const random = makeRandom(seed);
  /** Every record, never dropped: the oracle. @type {any[]} */
  const all = [];
  /** Turns in start order: id, start index, settled. */
  /** @type {Array<{ turnId: string, start: number, settled: boolean, status?: string, at: number }>} */
  const turns = [];
  /** @type {string[]} outcome-unknown turns not resolved */
  const unknown = [];
  /** @type {Map<string, string>} */
  const resolutions = new Map();
  let sealedTo = 0;
  let sealedTurns = 0;
  let digest = '';
  /** @type {any[]} the vat's index */
  const entries = [];
  /** @type {any} */
  let sealing;
  let generation = 0;
  let sent = 0;
  let at = 1_700_000_000_000;
  const counts = { seals: 0, sealed: 0, rejected: 0, ignored: 0, pages: 0 };

  const state = () =>
    entries.length === 0
      ? undefined
      : harden({ sealedTo, sealedTurns, segments: entries.length, digest });

  /** @param {string} prefix */
  const words = prefix => {
    const units = 1 + random.int(textUnits);
    return `${prefix} ${'abcdefghij'.repeat(Math.ceil(units / 10)).slice(0, units)} é😀`;
  };
  /**
   * @param {string} text
   * @param {number} previewUnits
   * @param {boolean} [always]
   */
  const field = async (text, previewUnits, always = false) =>
    store !== undefined && (always || random.chance(stagedChance))
      ? store.stage(text, { previewUnits })
      : text;

  /** @param {any} record */
  const append = record => {
    const kept = harden(record);
    all.push(kept);
    return all.length - 1;
  };

  const context = Far('ContextSource', {
    /** @param {string} [cursor] */
    page(cursor) {
      counts.pages += 1;
      const count = all.length;
      let from = sealedTo;
      if (cursor !== undefined) {
        const match = /^p(0|[1-9][0-9]*)$/.exec(cursor);
        const n = match === null ? NaN : Number(match[1]);
        if (Number.isSafeInteger(n) && n < sealedTo) {
          throw Error(texts.recordsSealed);
        }
        if (!(Number.isSafeInteger(n) && n <= count)) {
          throw Error(texts.badCursor);
        }
        from = n;
      }
      const budget = limits.contextPageBytes - 2048;
      /** @type {any[]} */
      const page = [];
      let used = 0;
      for (
        let i = from;
        i < count && page.length < limits.pageRecords;
        i += 1
      ) {
        const bytes = plainBytes(all[i]);
        if (page.length > 0 && used + bytes > budget) break;
        page.push(all[i]);
        used += bytes;
      }
      /** @type {Record<string, any>} */
      const result = { from, records: harden(page) };
      if (from + page.length < count) result.next = `p${from + page.length}`;
      return harden(result);
    },
    /** @param {string} [cursor] */
    segments(cursor) {
      const start = cursor === undefined ? 0 : Number(cursor.slice(1));
      const page = entries.slice(start, start + limits.segmentPageEntries);
      /** @type {Record<string, any>} */
      const result = { segments: harden(page) };
      if (start + page.length < entries.length) {
        result.next = `s${start + page.length}`;
      }
      return harden(result);
    },
  });

  /** A Turn handle per turn, for vat history pages. @type {Map<string, any>} */
  const handles = new Map();
  /** @param {string} turnId */
  const turnHandle = turnId => {
    let handle = handles.get(turnId);
    if (handle === undefined) {
      handle = Far('Turn', {});
      handles.set(turnId, handle);
      if (handles.size > 64) {
        const oldest = handles.keys().next().value;
        if (oldest !== undefined) handles.delete(oldest);
      }
    }
    return handle;
  };

  /**
   * One turn's records (log order) from the full list, a later TurnResolved
   * included (the vat's `ofTurn`); with `before`, only records below it.
   * @param {number} ordinal 1-based
   * @param {number} [before]
   */
  const recordsOfTurn = (ordinal, before = all.length) => {
    const turn = turns[ordinal - 1];
    return all
      .slice(turn.start, before)
      .filter(record => record.turnId === turn.turnId);
  };

  const session = Far('Session', {
    /** @param {string} [cursor] */
    getHistoryPage(cursor) {
      let n = turns.length;
      if (cursor !== undefined) {
        const match = /^h([1-9][0-9]*)$/.exec(cursor);
        n = match === null ? NaN : Number(match[1]);
        if (!(Number.isSafeInteger(n) && n <= turns.length)) {
          throw Error(texts.badCursor);
        }
      }
      /** @type {Record<string, any>} */
      const result = {};
      const archive = state();
      if (archive !== undefined) result.archive = archive;
      if (n <= sealedTurns) {
        return harden({ ...result, turns: [], next: `h${n}`, archived: true });
      }
      /** @type {any[]} */
      const page = [];
      let records = 0;
      let ordinal = n;
      while (
        ordinal > sealedTurns &&
        page.length < limits.historyPageTurns &&
        records < limits.historyPageRecords
      ) {
        const turn = turns[ordinal - 1];
        const shown = inCallOrder(recordsOfTurn(ordinal)).slice(0, 8);
        records += shown.length;
        page.push(
          harden({
            turn: turnHandle(turn.turnId),
            turnId: turn.turnId,
            state: turn.settled ? turn.status : 'running',
            at: turn.at,
            records: shown,
            cut: true,
          }),
        );
        ordinal -= 1;
      }
      if (ordinal >= 1) {
        result.next = `h${ordinal}`;
        if (ordinal <= sealedTurns) result.archived = true;
      }
      return harden({ ...result, turns: page });
    },
  });

  /**
   * A RoundRequest's cache-relevant part, as turn.js builds it (M2:
   * `base.archive` once the session has sealed).
   * @param {string} turnId
   * @param {number} round
   * @param {boolean} [fallback]
   */
  const request = (turnId, round, fallback = false) => {
    const from = Math.max(sent, sealedTo);
    const to = all.length;
    sent = to;
    const archive = state();
    /** @type {{ count: number, epoch: number, archive?: any }} */
    const base = { count: fallback ? to : from, epoch: 0 };
    if (archive !== undefined) base.archive = archive;
    return harden({
      turnId,
      round,
      base,
      append: fallback ? [] : inCallOrder(all.slice(from, to)),
      context,
    });
  };

  /**
   * @param {string} turnId
   * @param {string} status
   */
  const settle = (turnId, status) => {
    append({ kind: 'turn-settled', turnId, status, at });
    const turn = turns[turns.length - 1];
    turn.settled = true;
    turn.status = status;
    if (status === 'outcome-unknown') unknown.push(turnId);
  };

  /**
   * One turn; `onRequest` is awaited at each point turn.js would send a
   * RoundRequest.
   * @param {(req: any) => Promise<void>} onRequest
   */
  /* eslint-disable no-await-in-loop -- one record after another, in order */
  const turn = async onRequest => {
    // An outcome-unknown turn is resolved between turns (Turn.resolve).
    if (unknown.length > 0 && random.chance(resolveChance)) {
      const turnId = unknown.splice(random.int(unknown.length), 1)[0];
      const note = `resolved ${turnId}`;
      resolutions.set(turnId, note);
      append({ kind: 'turn-resolved', turnId, note, at });
    }
    const turnId = `t${turns.length + 1}`;
    at += 1000;
    const send = async (/** @type {number} */ round) =>
      onRequest(request(turnId, round, random.chance(fallbackChance)));
    const start = append({
      kind: 'turn-started',
      turnId,
      input: await field(words(`input ${turnId}`), 1024),
      at,
    });
    turns.push({ turnId, start, settled: false, at });
    await send(0);
    if (random.chance(interruptedChance)) {
      settle(turnId, 'interrupted');
      return;
    }
    append({ kind: 'dispatched', turnId, round: 0 });
    for (let round = 0; round < 4; round += 1) {
      if (random.chance(cancelChance)) {
        append({
          kind: 'partial',
          turnId,
          round,
          text: await field(words(`partial ${turnId}/${round}`), 1024),
        });
        settle(turnId, 'cancelled');
        return;
      }
      const calls = random.chance(toolChance) ? 1 + random.int(maxCalls) : 0;
      /** @type {Record<string, any>} */
      const settled = {
        kind: 'round-settled',
        turnId,
        round,
        text: random.chance(0.2)
          ? ''
          : await field(words(`reply ${turnId}/${round}`), 1024),
        callCount: calls,
        usage: USAGE,
        at,
      };
      if (store !== undefined && random.chance(nativeChance)) {
        settled.nativeContext = await field(
          words(`native ${turnId}/${round}`),
          0,
          true,
        );
      }
      append(settled);
      if (calls === 0) {
        settle(turnId, 'completed');
        return;
      }
      /** @type {any[]} */
      const intents = [];
      for (let i = 0; i < calls; i += 1) {
        intents.push(
          harden({
            opId: `${turnId}/${round}/${i}`,
            callId: '',
            name: 'echo',
            args: await field(
              JSON.stringify({ text: words(`args ${i}`) }),
              256,
            ),
          }),
        );
      }
      append({ kind: 'tool-intents', turnId, round, intents });
      const isUnknown = random.chance(unknownChance);
      const order = intents.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = random.int(i + 1);
        [order[i], order[j]] = [order[j], order[i]];
      }
      const settledCount = isUnknown ? random.int(calls) : calls;
      for (const i of order.slice(0, settledCount)) {
        append({
          kind: 'tool-result',
          turnId,
          opId: intents[i].opId,
          name: 'echo',
          result: await field(words(`result ${i}`), 256),
          failed: random.chance(0.1),
        });
      }
      if (isUnknown) {
        for (const i of order.slice(settledCount)) {
          append({
            kind: 'tool-result',
            turnId,
            opId: intents[i].opId,
            name: 'echo',
            result: 'Tool outcome unknown; do not automatically retry.',
            failed: true,
            outcome: 'unknown',
          });
        }
        settle(turnId, 'outcome-unknown');
        return;
      }
      await send(round + 1);
    }
    settle(turnId, 'failed');
  };
  /* eslint-enable no-await-in-loop */

  /**
   * Crank S: the seal request when 4.3's conditions hold (records the
   * intent), else undefined.
   */
  const startSeal = () => {
    if (sealing !== undefined) return undefined;
    const firstKept = sealedTurns; // index into turns
    const settledKept = turns
      .slice(firstKept)
      .filter(one => one.settled).length;
    if (settledKept < keepTurns + segmentTurns) return undefined;
    if (entries.length >= limits.archiveMaxSegments) return undefined;
    let count = 0;
    let records = 0;
    let bytes = 0;
    let to = sealedTo;
    for (let k = firstKept; k < turns.length - keepTurns; k += 1) {
      const one = turns[k];
      if (!one.settled) break;
      // A turn's span runs to the next turn's start: it absorbs any
      // TurnResolved appended between them.
      const end = turns[k + 1].start;
      let spanBytes = 0;
      for (let i = one.start; i < end; i += 1) spanBytes += plainBytes(all[i]);
      const spanRecords = end - one.start;
      if (
        count > 0 &&
        (count + 1 > segmentTurns ||
          records + spanRecords > segmentRecords ||
          bytes + spanBytes > segmentBytes)
      ) {
        break;
      }
      count += 1;
      records += spanRecords;
      bytes += spanBytes;
      to = end;
      if (records > segmentRecords || bytes > segmentBytes) break;
    }
    if (count === 0) return undefined;
    generation += 1;
    const kinds = all
      .slice(sealedTo, Math.min(to, sealedTo + limits.archiveSegmentRecords))
      .map(record => letterOf.get(record.kind))
      .join('');
    sealing = {
      generation,
      from: sealedTo,
      to,
      firstTurn: sealedTurns + 1,
      turns: count,
      records,
    };
    return harden({
      from: sealedTo,
      to,
      firstTurn: sealedTurns + 1,
      turns: count,
      records,
      bytes,
      firstTurnId: turns[firstKept].turnId,
      lastTurnId: turns[firstKept + count - 1].turnId,
      kinds,
      epoch: 0,
      previous: digest,
      context,
    });
  };

  /**
   * Crank Z: apply a seal answer (ignored unless it matches `sealing`).
   * @param {any} answer
   */
  const sealed = answer => {
    if (
      sealing === undefined ||
      answer.from !== sealing.from ||
      answer.to !== sealing.to ||
      answer.turns !== sealing.turns ||
      answer.records !== sealing.records ||
      answer.from !== sealedTo
    ) {
      counts.ignored += 1;
      return false;
    }
    entries.push(answer);
    sealedTo = answer.to;
    sealedTurns += answer.turns;
    digest = answer.digest;
    sealing = undefined;
    counts.sealed += 1;
    return true;
  };

  /** A rejection or a retired break: not sealed. */
  const notSealed = () => {
    sealing = undefined;
    counts.rejected += 1;
  };

  /**
   * Settle-crank sealing against `port`, awaited (the next turn claims
   * after the answer in these tests).
   * @param {any} port
   */
  const maybeSeal = async port => {
    const req = startSeal();
    if (req === undefined) return undefined;
    counts.seals += 1;
    try {
      const answer = await E(port).seal(req);
      sealed(answer);
      return answer;
    } catch (error) {
      notSealed();
      throw error;
    }
  };

  // Not hardened: `all`, `turns` and `entries` keep growing.
  return {
    all,
    turns,
    session,
    context,
    turn,
    request,
    state,
    startSeal,
    sealed,
    notSealed,
    maybeSeal,
    resolutions,
    entries,
    recordsOfTurn,
    /** Records the vat keeps (from sealedTo). */
    kept: () => all.slice(sealedTo),
    sealedTo: () => sealedTo,
    sealedTurns: () => sealedTurns,
    counts,
  };
};
