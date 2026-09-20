// @ts-check

import { Fail, b } from '@endo/errors';

/**
 * Read a response body as JSON, stopping at a byte bound rather than checking
 * a length after the whole body is in memory, and without letting the body's
 * own text into an error: `JSON.parse` quotes what it choked on.
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @param {string} label for messages, e.g. `Codex usage read`
 */
export const boundedJson = async (response, maxBytes, label) => {
  const reader = response.body?.getReader();
  if (!reader) throw Fail`${b(label)} had no body`;
  const chunks = [];
  let bytes = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      void reader.cancel().catch(() => {});
      throw Fail`${b(label)} too large`;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
  } catch (_error) {
    throw Fail`${b(label)} was not JSON`;
  }
};
harden(boundedJson);
