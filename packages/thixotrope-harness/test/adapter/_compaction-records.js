// @ts-check
// Test helpers for the compaction plan (resources/agent-host/impl/providers/
// compaction.js): a session record log built turn by turn with the real
// record log (its guards check every record), the cache's plan input over
// it, and the session's compaction ask. Import after the guest prelude.
/* eslint-disable import/no-relative-packages */
import { makeRecordLog } from '../../guest/session/records.js';
import { contextLimits } from '../../guest/lib/guards/context.js';
/* eslint-enable import/no-relative-packages */
import { encodeImageEnvelope } from '../../resources/agent-host/impl/providers/images.js';
import { makeFakeBlobSink } from './_m1b-blobs.js';
import { USAGE } from './_m1b-context.js';

/** The recovery text of an unknown outcome (records only need its shape). */
const UNKNOWN_TEXT = 'Tool outcome unknown; do not automatically retry.';

/**
 * @typedef {object} CallSpec
 * @property {string} [name] default `echo`
 * @property {string} [args] default `{}`
 * @property {any} [result] the result text (or a staged field)
 * @property {boolean} [failed]
 * @property {boolean} [unknown] recorded as recovery records it
 *
 * @typedef {object} RoundSpec
 * @property {any} [text] the reply text (or a staged field)
 * @property {CallSpec[]} [calls]
 *
 * @typedef {object} TurnSpec
 * @property {any} [input] the user's input (or a staged field)
 * @property {RoundSpec[]} [rounds]
 * @property {string | null} [status] the settled status; `null` leaves the
 *   turn running (the current turn)
 * @property {boolean} [dispatched] default true
 */

export const makeTurnLog = () => {
  const records = makeRecordLog();
  const { sink } = makeFakeBlobSink();
  /** @type {Map<any, string>} */
  const texts = new Map();
  let turns = 0;
  const at = 1_700_000_000_000;

  /**
   * A staged field holding `text` (a blob handle as the fake manager sink
   * mints them) and its entry in the texts map.
   * @param {string} text
   */
  const staged = text => {
    const [{ blob }] = sink.mintBlobs();
    texts.set(blob, text);
    return harden({ blob, preview: text.slice(0, 16), bytes: text.length });
  };

  /**
   * Append one turn; answers its id, the index of its `turn-started` and
   * the indices of its `round-settled` records by round.
   * @param {TurnSpec} [spec]
   */
  const turn = ({
    input,
    rounds = [{ text: 'done' }],
    status = 'completed',
    dispatched = true,
  } = {}) => {
    turns += 1;
    const turnId = `t${turns}`;
    const startIndex = records.append({
      kind: 'turn-started',
      turnId,
      input: input ?? `input of ${turnId}`,
      at,
    });
    /** @type {number[]} */
    const settled = [];
    if (dispatched) {
      records.append({ kind: 'dispatched', turnId, round: 0 });
      rounds.forEach(({ text = '', calls = [] }, round) => {
        settled.push(
          records.append({
            kind: 'round-settled',
            turnId,
            round,
            text,
            callCount: calls.length,
            usage: USAGE,
            at,
          }),
        );
        if (calls.length === 0) return;
        const intents = calls.map(({ name = 'echo', args = '{}' }, i) =>
          harden({ opId: `${turnId}/${round}/${i}`, callId: '', name, args }),
        );
        records.append({ kind: 'tool-intents', turnId, round, intents });
        calls.forEach(({ result = 'ok', failed = false, unknown }, i) => {
          records.append({
            kind: 'tool-result',
            turnId,
            opId: intents[i].opId,
            name: intents[i].name,
            result: unknown ? UNKNOWN_TEXT : result,
            failed: unknown ? true : failed,
            ...(unknown ? { outcome: 'unknown' } : {}),
          });
        });
      });
    }
    if (status !== null) {
      records.append({ kind: 'turn-settled', turnId, status, at });
    }
    return harden({ turnId, startIndex, settled });
  };

  /** @param {string} turnId */
  const resolve = turnId =>
    records.append({ kind: 'turn-resolved', turnId, note: 'seen', at });

  /**
   * The `compaction-started` record of an ask (it lands at `askedAt`).
   * @param {string} turnId
   * @param {number} round
   */
  const started = (turnId, round) =>
    records.append({
      kind: 'compaction-started',
      turnId,
      round,
      epoch: 1,
      boundary: 0,
      usedTokens: 80,
      windowTokens: 100,
      at,
    });

  /**
   * The cache's plan input: every kept record, and the sealed part given.
   * @param {readonly any[]} [sealed]
   */
  const planInput = (sealed = []) => {
    const start = records.base();
    return harden({ start, records: records.since(start), texts, sealed });
  };

  return harden({ records, texts, staged, turn, resolve, started, planInput });
};

/**
 * The session's ask (guards/context.js `CompactionAsk`), with a reading of
 * 80 used of a 100-token window (the threshold 70) unless given.
 * @param {Partial<import('../../resources/agent-host/impl/providers/compaction.js').CompactionAsk>} fields
 */
export const askOf = fields => {
  const windowTokens = fields.windowTokens ?? 100;
  return harden({
    epoch: 1,
    boundary: 0,
    askedAt: 0,
    startIndex: 0,
    floor: 0,
    usedTokens: 80,
    windowTokens,
    thresholdTokens: Math.floor(
      (windowTokens * contextLimits.compactionThresholdPercent) / 100,
    ),
    ...fields,
  });
};

/**
 * A `viewImage` result's content: the envelope of `bytes` raw bytes of PNG
 * signature and filler (only the envelope's form is read here).
 * @param {number} bytes a multiple of 3
 */
export const imageEnvelope = bytes => {
  const raw = Buffer.alloc(bytes, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(raw);
  return encodeImageEnvelope({
    mediaType: 'image/png',
    data: raw.toString('base64'),
  });
};
