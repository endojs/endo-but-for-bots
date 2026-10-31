// @ts-check
// prefer-endo-primitives-exempt: this module is the SSE/TextDecoder bridge.

import { Fail, b } from '@endo/errors';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Yield the joined `data:` text of each server-sent event in a bounded byte
 * stream. Framing is independent of chunk boundaries and retains multiline
 * data; the caller owns the event grammar. The broker's usage tap is
 * deliberately not an SSE parser: it skips oversized lines and malformed
 * JSON, whereas an inference consumer must reject them.
 *
 * @param {AsyncIterableIterator<Uint8Array>} bytes
 * @param {string} label names the stream in transport errors
 */
export const sseData = async function* sseDataIterator(bytes, label) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let data = [];
  let size = 0;
  /**
   * Split complete lines off `pending`. Until the stream ends, a trailing CR
   * may be the first half of a CRLF, so it waits for the next chunk.
   *
   * @param {boolean} ended
   */
  const takeLines = function* takeLineIterator(ended) {
    const terminator = ended
      ? /^(.*?)(\r\n|\n|\r)/s
      : /^(.*?)(\r\n|\n|\r(?!$))/s;
    for (;;) {
      const match = terminator.exec(pending);
      if (!match) break;
      pending = pending.slice(match[0].length);
      const line = match[1];
      if (line === '') {
        if (data.length > 0) {
          const text = data.join('\n');
          data = [];
          yield text;
        }
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  };
  for await (const chunk of bytes) {
    size += Number(chunk.byteLength);
    size <= MAX_RESPONSE_BYTES ||
      Fail`${b(label)} stream exceeds transport bound`;
    pending += decoder.decode(chunk, { stream: true });
    yield* takeLines(false);
  }
  pending += decoder.decode();
  yield* takeLines(true);
  (!pending.trim() && data.length === 0) ||
    Fail`Truncated ${b(label)} stream event`;
};
harden(sseData);
