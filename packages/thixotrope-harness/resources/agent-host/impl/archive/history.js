// @ts-check
/**
 * `History` and `SealedText` (M2 W2.8; `designs/m2-interfaces.md` 4.9):
 * history pages of any session the caller holds, archived turns served from
 * segment files in this process without a vat crank.
 *
 * - `page(session, cursor?)`: without a cursor, or with `h<n>` above the
 *   session's sealed turns, the session's own `getHistoryPage` answers (one
 *   session crank; its `archive` is observed: validation and
 *   acknowledgment). `h<n>` with n <= `sealedTurns` is served here: turns
 *   n down to max(1, n - 31), newest first, each a `SealedTurnPreview`
 *   (records in call order, text cut to previews as the vat does, every
 *   staged field a `SealedField`), within `frameBytes`; `next` is
 *   `h<o - 1>` for the oldest ordinal o shown. Before serving a sealed
 *   cursor for a session not validated in this incarnation, the vat's
 *   newest page is asked once for its `ArchiveState`.
 * - `turnContent(session, turnId, cursor?)`: an archived turn's records in
 *   full, log order, staged fields as `SealedField`s, pages of at most
 *   `pageRecords` and `contextPageBytes`, cursor `c<n>`; a turn the archive
 *   does not hold throws `texts.unknownTurn`.
 * - `SealedText.read(range)` reads the blob file by key as `Content.read`
 *   does; `describe()` its bytes, preview and digest. Minted per key and
 *   kept (bounded) for this incarnation.
 *
 * The preview rule and its bounds are the vat's own
 * (`guest/lib/record-preview.js`, HR-SYN-28), so a turn previews the same
 * kept and archived; the page and turn assembly follows the vat's
 * `guest/session/history.js`.
 *
 * Node only.
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { E } from '@endo/far';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';

import { interfaces, texts } from '../../../../guest/lib/interfaces.js';
import { limits } from '../../../../guest/lib/limits.js';
import {
  PAGE_SLACK,
  TURN_PREVIEW_KEYS_BYTES,
  previewRecord as previewOf,
} from '../../../../guest/lib/record-preview.js';
import { inCallOrder } from '../../../../guest/session/records.js';
/* eslint-enable import/no-relative-packages */
import { decodeRecord, isKeyedStaged, readSegment } from './segment.js';

const { makeExo } = /** @type {any} */ (globalThis);

/** Bytes kept free in a content page for its wrapper. */
const CONTENT_SLACK = 2048;
/** SealedText exos kept per incarnation. */
const MAX_SEALED_TEXTS = 4096;

/**
 * String bytes and keys, as the vat's `plainBytes` (remotables count 0).
 * @param {any} value
 * @returns {number}
 */
const plainBytes = value => {
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

/** @param {any} value */
const isSealedField = value =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  'sealed' in value &&
  'preview' in value &&
  'bytes' in value;

/**
 * @typedef {object} ArchiveView one session's validated archive
 * @property {string} key
 * @property {string} dir
 * @property {{ sealedTo: number, sealedTurns: number, segments: number, digest: string }} state
 * @property {ReadonlyArray<import('./store.js').ManifestEntry>} entries the
 *   acknowledged chain
 *
 * @typedef {object} SealedTurn
 * @property {string} turnId
 * @property {number} ordinal
 * @property {any[]} records keyed, log order
 *
 * @typedef {object} ParsedSegment
 * @property {SealedTurn[]} turns
 */

/**
 * @param {object} options
 * @param {import('../blobs.js').BlobStore} options.blobs
 * @param {(session: any) => Promise<string | undefined>} options.keyFor
 * @param {(session: any, newestPage: () => Promise<any>) => Promise<ArchiveView | undefined>} options.archiveOf
 * @param {(session: any, key: string, state: any) => Promise<void>} options.observe
 * @param {number} [options.segmentCache]
 */
export const makeHistory = ({
  blobs,
  keyFor,
  archiveOf,
  observe,
  segmentCache = 8,
}) => {
  /** key -> SealedText. @type {Map<string, any>} */
  const sealedTexts = new Map();
  /** `<dir>/<file>` -> parsed segment, least recently used first. */
  /** @type {Map<string, ParsedSegment>} */
  const parsed = new Map();
  /** `<dir>` -> { segments, resolutions, ordinals }. */
  /** @type {Map<string, { segments: number, digest: string, resolutions: Map<string, [string, number]>, ordinals: Map<string, number> }>} */
  const indexes = new Map();
  const counts = { vatPages: 0, sealedPages: 0, contentPages: 0, reads: 0 };

  /**
   * @param {{ key: string, preview: string, bytes: number, digest?: string }} info
   */
  const sealedText = info => {
    let found = sealedTexts.get(info.key);
    if (found === undefined) {
      /** @type {Record<string, any>} */
      const described = { bytes: info.bytes, preview: info.preview };
      if (typeof info.digest === 'string') described.digest = info.digest;
      const description = harden(described);
      const { key } = info;
      found = makeExo('SealedText', interfaces.SealedText, {
        /** @param {{ offset: number, maxBytes: number }} range */
        read: ({ offset, maxBytes }) => {
          counts.reads += 1;
          return blobs.readPageKey(key, offset, maxBytes);
        },
        describe: () => description,
      });
      sealedTexts.set(info.key, found);
      if (sealedTexts.size > MAX_SEALED_TEXTS) {
        const oldest = sealedTexts.keys().next().value;
        if (oldest !== undefined) sealedTexts.delete(oldest);
      }
    }
    return found;
  };

  /**
   * A keyed record as History shows it: staged fields as SealedFields.
   * @param {any} keyed
   */
  const toShown = keyed =>
    harden(
      decodeRecord(keyed, info => {
        /** @type {Record<string, any>} */
        const field = {
          sealed: sealedText(info),
          preview: info.preview,
          bytes: info.bytes,
        };
        if (typeof info.digest === 'string') field.digest = info.digest;
        return field;
      }),
    );

  /**
   * @param {ArchiveView} archive
   * @param {import('./store.js').ManifestEntry} entry
   * @returns {Promise<ParsedSegment>}
   */
  const loadSegment = async (archive, entry) => {
    const path = join(archive.dir, entry.file);
    const known = parsed.get(path);
    if (known !== undefined) {
      parsed.delete(path);
      parsed.set(path, known);
      return known;
    }
    const { records } = await readSegment(path);
    /** @type {SealedTurn[]} */
    const turns = [];
    /** @type {Map<string, SealedTurn>} */
    const byId = new Map();
    for (const record of records) {
      if (record.kind === 'turn-started') {
        const turn = {
          turnId: record.turnId,
          ordinal: entry.firstTurn + turns.length,
          records: [record],
        };
        turns.push(turn);
        byId.set(record.turnId, turn);
      } else {
        // A TurnResolved of an earlier segment's turn is in the index.
        byId.get(record.turnId)?.records.push(record);
      }
    }
    const segment = { turns };
    parsed.set(path, segment);
    while (parsed.size > segmentCache) {
      const oldest = parsed.keys().next().value;
      if (oldest === undefined) break;
      parsed.delete(oldest);
    }
    return segment;
  };

  /** @param {ArchiveView} archive */
  const indexOf = archive => {
    const known = indexes.get(archive.dir);
    if (
      known !== undefined &&
      known.segments === archive.state.segments &&
      known.digest === archive.state.digest
    ) {
      return known;
    }
    /** @type {Map<string, [string, number]>} */
    const resolutions = new Map();
    /** @type {Map<string, number>} */
    const ordinals = new Map();
    for (const entry of archive.entries) {
      entry.turnIds.forEach((turnId, i) =>
        ordinals.set(turnId, entry.firstTurn + i),
      );
      for (const [turnId, note, at] of entry.resolutions) {
        if (!resolutions.has(turnId)) resolutions.set(turnId, [note, at]);
      }
    }
    const index = {
      segments: archive.state.segments,
      digest: archive.state.digest,
      resolutions,
      ordinals,
    };
    indexes.set(archive.dir, index);
    while (indexes.size > 64) {
      const oldest = indexes.keys().next().value;
      if (oldest === undefined) break;
      indexes.delete(oldest);
    }
    return index;
  };

  /**
   * @param {ArchiveView} archive
   * @param {number} ordinal 1 .. sealedTurns
   * @returns {Promise<SealedTurn>}
   */
  const turnAt = async (archive, ordinal) => {
    const { entries } = archive;
    let lo = 0;
    let hi = entries.length - 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const entry = entries[mid];
      if (ordinal < entry.firstTurn) hi = mid - 1;
      else if (ordinal >= entry.firstTurn + entry.turns) lo = mid + 1;
      else {
        // eslint-disable-next-line no-await-in-loop
        const segment = await loadSegment(archive, entry);
        const turn = segment.turns[ordinal - entry.firstTurn];
        if (turn === undefined) break;
        return turn;
      }
    }
    throw Error(texts.unknownTurn);
  };

  /**
   * A keyed record cut to its preview (the vat's rule), in its shown form.
   * @param {any} keyed
   * @returns {{ record: any, cut: boolean, bytes: number }}
   */
  const previewRecord = keyed => {
    // Not hardened here: the shown form is built from it next.
    const cutRecord = previewOf(keyed, {
      isStaged: isKeyedStaged,
      intentBytes: one => plainBytes(toShown(one)),
      finish: value => value,
    });
    const shown = toShown(cutRecord);
    let hasStaged = false;
    const visit = (/** @type {any} */ v) => {
      if (hasStaged || typeof v !== 'object' || v === null) return;
      if (isSealedField(v)) {
        hasStaged = true;
        return;
      }
      for (const item of Array.isArray(v) ? v : Object.values(v)) visit(item);
    };
    visit(shown);
    return {
      record: shown,
      cut: cutRecord !== keyed || hasStaged,
      bytes: plainBytes(shown),
    };
  };

  /**
   * A sealed turn's records with its sealed TurnResolved, wherever it was
   * sealed (the vat's `ofTurn` holds it too).
   * @param {SealedTurn} turn
   * @param {[string, number] | undefined} resolution
   */
  const withResolution = (turn, resolution) =>
    resolution === undefined ||
    turn.records.some(r => r.kind === 'turn-resolved')
      ? turn.records
      : [
          ...turn.records,
          {
            kind: 'turn-resolved',
            turnId: turn.turnId,
            note: resolution[0],
            at: resolution[1],
          },
        ];

  /**
   * @param {ArchiveView} archive
   * @param {SealedTurn} turn
   * @param {number} [budget]
   * @returns {{ preview: any, bytes: number }}
   */
  const previewTurn = (archive, turn, budget = Infinity) => {
    const resolution = indexOf(archive).resolutions.get(turn.turnId);
    const ordered = inCallOrder(withResolution(turn, resolution));
    const settled = turn.records.find(r => r.kind === 'turn-settled');
    const state = settled?.status ?? 'interrupted';
    let cut = ordered.length > limits.historyTurnRecords;
    /** @type {number} */
    let bytes =
      TURN_PREVIEW_KEYS_BYTES + turn.turnId.length + String(state).length;
    /** @type {any[]} */
    const shown = [];
    for (const record of ordered.slice(0, limits.historyTurnRecords)) {
      const preview = previewRecord(record);
      if (bytes + preview.bytes > budget) {
        cut = true;
        break;
      }
      if (preview.cut) cut = true;
      shown.push(preview.record);
      bytes += preview.bytes;
    }
    /** @type {Record<string, any>} */
    const preview = {
      turnId: turn.turnId,
      state,
      at: turn.records[0].at,
      sealed: true,
      records: harden(shown),
    };
    if (cut) preview.cut = true;
    if (resolution !== undefined) {
      preview.resolution = resolution[0];
      bytes += 10 + Buffer.byteLength(resolution[0]);
    }
    return { preview: harden(preview), bytes };
  };

  /**
   * @param {ArchiveView} archive
   * @param {number} n
   */
  const sealedPage = async (archive, n) => {
    counts.sealedPages += 1;
    const budget = limits.frameBytes - PAGE_SLACK;
    /** @type {any[]} */
    const page = [];
    let used = 0;
    let ordinal = n;
    while (ordinal >= 1 && page.length < limits.historyPageTurns) {
      // eslint-disable-next-line no-await-in-loop
      const turn = await turnAt(archive, ordinal);
      const whole = previewTurn(archive, turn);
      if (used + whole.bytes > budget) {
        if (page.length > 0) break;
        page.push(previewTurn(archive, turn, budget).preview);
        ordinal -= 1;
        break;
      }
      page.push(whole.preview);
      used += whole.bytes;
      ordinal -= 1;
    }
    /** @type {Record<string, any>} */
    const result = { turns: harden(page) };
    if (ordinal >= 1) result.next = `h${ordinal}`;
    return harden(result);
  };

  /** @param {string} cursor */
  const ordinalOfCursor = cursor => {
    const match = /^h([1-9][0-9]*)$/.exec(cursor);
    const n = match === null ? NaN : Number(match[1]);
    if (!Number.isSafeInteger(n)) throw Error(texts.badCursor);
    return n;
  };

  /**
   * @param {any} session
   * @param {any} answer a vat page
   */
  const observePage = async (session, answer) => {
    const key = await keyFor(session).catch(() => undefined);
    if (key === undefined) return;
    await observe(session, key, answer?.archive).catch(() => {});
  };

  const history = makeExo('History', interfaces.History, {
    /**
     * @param {any} session
     * @param {string} [cursor]
     */
    page: async (session, cursor) => {
      if (cursor === undefined) {
        counts.vatPages += 1;
        const answer = await E(session).getHistoryPage();
        await observePage(session, answer);
        return answer;
      }
      const n = ordinalOfCursor(cursor);
      let archive = await archiveOf(session, () => E(session).getHistoryPage());
      if (archive === undefined || n > archive.state.sealedTurns) {
        counts.vatPages += 1;
        const answer = await E(session).getHistoryPage(cursor);
        await observePage(session, answer);
        const sealedTurns = Number(answer?.archive?.sealedTurns ?? 0);
        if (n > sealedTurns) return answer;
        archive = await archiveOf(session, async () => answer);
        if (archive === undefined || n > archive.state.sealedTurns) {
          return answer;
        }
      }
      return sealedPage(archive, n);
    },
    /**
     * @param {any} session
     * @param {string} turnId
     * @param {string} [cursor]
     */
    turnContent: async (session, turnId, cursor) => {
      counts.contentPages += 1;
      const archive = await archiveOf(session, () =>
        E(session).getHistoryPage(),
      );
      if (archive === undefined) throw Error(texts.unknownTurn);
      const index = indexOf(archive);
      const ordinal = index.ordinals.get(turnId);
      if (ordinal === undefined) throw Error(texts.unknownTurn);
      const turn = await turnAt(archive, ordinal);
      const records = withResolution(turn, index.resolutions.get(turnId));
      let start = 0;
      if (cursor !== undefined) {
        const match = /^c(0|[1-9][0-9]*)$/.exec(cursor);
        start = match === null ? NaN : Number(match[1]);
        if (!(Number.isSafeInteger(start) && start <= records.length)) {
          throw Error(texts.badCursor);
        }
      }
      const budget = limits.contextPageBytes - CONTENT_SLACK;
      /** @type {any[]} */
      const page = [];
      let used = 0;
      let at = start;
      while (at < records.length && page.length < limits.pageRecords) {
        const shown = toShown(records[at]);
        const bytes = plainBytes(shown);
        if (page.length > 0 && used + bytes > budget) break;
        page.push(shown);
        used += bytes;
        at += 1;
      }
      /** @type {Record<string, any>} */
      const result = { records: harden(page) };
      if (at < records.length) result.next = `c${at}`;
      return harden(result);
    },
  });

  return history;
};
harden(makeHistory);
