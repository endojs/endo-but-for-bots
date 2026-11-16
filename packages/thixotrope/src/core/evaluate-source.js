// @ts-check
import harden from '@endo/harden';
import { Fail } from '@endo/errors';

/**
 * String content, in UTF-8 bytes, that one message into an Ironhorse vat
 * may carry. Every byte of an inbound frame costs the vat a metered
 * property key when the frame is hardened, so one message halts a fresh vat
 * at 51,200-52,224 bytes at a 10 M crank budget and 58,368-59,392 bytes at
 * 50 M and 100 M; this is at most half of the smallest halt point (spike S1
 * of the harness milestone M0; packages/thixotrope-harness/JOURNAL.md
 * J-0140, J-0141).
 */
export const STAGING_FRAME_BYTES = 24_576;

/**
 * UTF-16 code units per staged message: UTF-8 takes at most three bytes
 * per code unit (a surrogate pair is two units and four bytes), so a chunk
 * of this many units fits `STAGING_FRAME_BYTES` whatever its text.
 */
export const STAGING_CHUNK_CHARS = STAGING_FRAME_BYTES / 3;

/**
 * Transfer source in bounded messages, then evaluate it in one crank. A
 * single message is bounded by the vat's inbound frame cost (see
 * `STAGING_FRAME_BYTES`); bootstraps of a few kilobytes go in one message,
 * and a bundle, or anything approaching that bound, goes this way, in
 * chunks of `STAGING_CHUNK_CHARS` code units that never split a surrogate
 * pair.
 *
 * Each concurrent transfer into one vat needs its own staging slot, named by
 * `slot`; two transfers sharing a slot would interleave. A subsequent
 * attempt on a slot replaces an interrupted transfer, whose chunks stay in
 * the vat's heap only until then.
 *
 * @param {{evaluate: (source: string, endowments?: Record<string, unknown>) => Promise<any>}} worker
 * @param {string} source an expression yielding a function of the endowments
 * @param {Record<string, unknown>} endowments
 * @param {{
 *   slot?: 'thixotrope.installSource' | 'thixotrope.mailSource' | 'thixotrope.workspaceMailboxSource',
 *   chunkChars?: number,
 * }} [options]
 *   `slot`: the staging slot, a name this module's callers agree on rather
 *   than anything user-derived; `chunkChars`: UTF-16 code units per staged
 *   message, an integer of at least 2 (default `STAGING_CHUNK_CHARS`)
 */
export const evaluateSource = async (
  worker,
  source,
  endowments,
  { slot = 'thixotrope.installSource', chunkChars = STAGING_CHUNK_CHARS } = {},
) => {
  (Number.isSafeInteger(chunkChars) && chunkChars >= 2) ||
    Fail`chunkChars must be an integer of at least 2, not ${chunkChars}`;
  const holder = `globalThis[Symbol.for(${JSON.stringify(slot)})]`;
  await worker.evaluate(`(${holder} = [], true)`);
  for (let offset = 0; offset < source.length;) {
    let end = Math.min(offset + chunkChars, source.length);
    const last = source.charCodeAt(end - 1);
    if (end < source.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    // eslint-disable-next-line no-await-in-loop
    await worker.evaluate(`(${holder}.push(chunk), true)`, {
      chunk: source.slice(offset, end),
    });
    offset = end;
  }
  return worker.evaluate(
    `(() => {
    const source = ${holder}.join('');
    delete ${holder};
    return globalThis.eval(source)(endowments);
  })()`,
    { endowments: harden(endowments) },
  );
};
harden(evaluateSource);
