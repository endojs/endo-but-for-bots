// @ts-check
/// <reference types="ses"/>

/**
 * Strict LF-delimited JSON (JSONL) framing for the stdio RPC bridge.
 *
 * Pi's framing rule, which this bridge honours: records are separated by
 * `\n` and nothing else. Node's `readline` is non-compliant because it
 * also splits on `\r`, `U+2028`, and `U+2029`; a spawning host in another
 * language must not, so neither does this decoder. A bare `\r` stays in
 * the line (a `CRLF` sender yields a line with a trailing `\r`, which
 * `JSON.parse` tolerates as whitespace); `U+2028` / `U+2029` are ordinary
 * characters inside a record.
 *
 * The decoder is stateful: it buffers a partial trailing line across
 * `push` calls and decodes bytes with a streaming `TextDecoder` so a
 * multibyte UTF-8 sequence split across chunk boundaries reassembles
 * correctly.
 */

/** @import { JsonlDecoder } from './types.js' */

/**
 * Create a strict newline-delimited line decoder.
 *
 * @returns {JsonlDecoder}
 */
export const makeJsonlDecoder = () => {
  let buffer = '';
  const textDecoder = new TextDecoder('utf-8');

  /**
   * @param {string} text
   * @returns {string[]}
   */
  const absorb = text => {
    buffer += text;
    /** @type {string[]} */
    const lines = [];
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
    return lines;
  };

  return harden({
    /** @param {string | Uint8Array} chunk */
    push(chunk) {
      const text =
        typeof chunk === 'string'
          ? chunk
          : textDecoder.decode(chunk, { stream: true });
      return harden(absorb(text));
    },
    flush() {
      // Drain any buffered multibyte remainder from the streaming decoder,
      // then surface a final unterminated line so a host that omits the
      // trailing newline still has its last command delivered.
      const tail = textDecoder.decode();
      if (tail !== '') {
        buffer += tail;
      }
      if (buffer === '') {
        return harden([]);
      }
      const remainder = buffer;
      buffer = '';
      return harden([remainder]);
    },
  });
};
harden(makeJsonlDecoder);

/**
 * Encode a record as one JSONL output line (JSON text plus a single
 * trailing `\n`).
 *
 * @param {unknown} record
 * @returns {string}
 */
export const encodeRecord = record => `${JSON.stringify(record)}\n`;
harden(encodeRecord);
