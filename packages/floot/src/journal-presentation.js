// @ts-check
import { Fail } from '@endo/errors';

/**
 * Display-only public reasoning, never canonical model context. The bounds
 * match hosted-turn's existing preview policy, not provider output limits.
 * @param {unknown} value
 * @param {number} transcriptCount
 */
export const encodeJournalPresentation = (value, transcriptCount) => {
  if (!Array.isArray(value) || value.length > 64) {
    throw Fail`Invalid thinking blocks`;
  }
  const ids = new Set();
  let chars = 0;
  let previous = 0;
  const blocks = Array.from(value, raw => {
    (raw && typeof raw === 'object' && !Array.isArray(raw)) ||
      Fail`Invalid thinking block`;
    const block = /** @type {Record<string, unknown>} */ (raw);
    const { id, text, startedAt, endedAt, truncated, beforeTranscriptOrdinal } =
      block;
    Object.keys(block).every(key =>
      [
        'id',
        'text',
        'startedAt',
        'endedAt',
        'truncated',
        'beforeTranscriptOrdinal',
      ].includes(key),
    ) || Fail`Invalid thinking fields`;
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      id.length > 128 ||
      ids.has(id)
    ) {
      throw Fail`Invalid thinking identity`;
    }
    ids.add(id);
    if (typeof text !== 'string' || typeof truncated !== 'boolean') {
      throw Fail`Invalid thinking preview`;
    }
    chars += text.length;
    chars <= 65_536 || Fail`Thinking preview bound exceeded`;
    // Millisecond wall-clock readings within ECMAScript Date's time range.
    /** @param {number} time */
    const validTime = time =>
      Number.isInteger(time) && Math.abs(time) <= 8.64e15;
    (typeof startedAt === 'number' &&
      validTime(startedAt) &&
      (endedAt === undefined ||
        (typeof endedAt === 'number' &&
          validTime(endedAt) &&
          endedAt >= startedAt))) ||
      Fail`Invalid thinking timing`;
    (typeof beforeTranscriptOrdinal === 'string' &&
      /^(0|[1-9][0-9]{0,4})$/.test(beforeTranscriptOrdinal)) ||
      Fail`Invalid thinking anchor`;
    const anchor = Number(beforeTranscriptOrdinal);
    (anchor >= previous && anchor <= transcriptCount && anchor <= 65_536) ||
      Fail`Invalid thinking anchor`;
    previous = anchor;
    return {
      id,
      text,
      startedAt,
      ...(endedAt === undefined ? {} : { endedAt }),
      truncated,
      beforeTranscriptOrdinal,
    };
  });
  return JSON.stringify(blocks);
};
harden(encodeJournalPresentation);
