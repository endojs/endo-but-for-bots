// @ts-check
// prefer-endo-primitives-exempt: `@endo/bytes` has no streaming UTF-8
// decoder, and a chunk may split a multibyte sequence.
/// <reference types="ses"/>

/**
 * Strict LF-delimited JSON (JSONL) framing for the stdio RPC bridge.
 *
 * Pi's framing rule, which this bridge honors: records are separated by
 * `\n` and nothing else. Node's `readline` is non-compliant because it
 * also splits on a bare `\r`; a spawning host in another language must
 * not, so neither does this decoder. A bare `\r` stays in the line (a `CRLF`
 * sender yields a line with a trailing `\r`, which `JSON.parse` tolerates as
 * whitespace); `U+2028` / `U+2029` are ordinary characters inside a record.
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
 * Encode a record as one JSONL output line.
 *
 * @param {unknown} record
 * @returns {string}
 */
export const encodeRecord = record => `${JSON.stringify(record)}\n`;
harden(encodeRecord);
