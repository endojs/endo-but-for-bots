// @ts-check
/**
 * Server-sent events, parsed linearly (M2 W2.1a; designs/m2-interfaces.md
 * 8.1). Adapted from lal `providers/subscription-responses.js`
 * (`responseEvents`): framing is independent of chunk boundaries, `\r\n`,
 * `\n` and `\r` all end a line (a `\n` right after a `\r` that ended the
 * previous chunk is that line end's second half), multi-line data is joined with
 * `\n`, and UTF-8 is decoded `fatal` (an invalid byte fails the stream). The
 * lal version re-slices the pending text once per line and rescans a long
 * line from its start on every chunk; this one scans each chunk once and
 * keeps an unfinished line as pieces joined once when it ends, so every
 * byte is decoded once and scanned once (linear in the stream).
 *
 * Fields (WHATWG HTML 9.2.6): `data` appends a line, `event` names the
 * event, `id` and `retry` are ignored, a line starting with `:` is a comment
 * (providers send keep-alives that way), a line without `:` is a field with
 * an empty value. A blank line dispatches the event when it has data.
 *
 * Bounds and failures: a line longer than `maxLineUnits`, or an event whose
 * data is longer than `maxEventUnits`, fails the stream; a stream that ends
 * inside an event (data without the blank line that dispatches it) fails it
 * too, because a provider stream cut there is not a whole answer (lal does
 * the same). Every failure is an `SseError` with one of the fixed messages
 * of `sseErrors`: no text of the stream ever appears in it.
 *
 * Node only (adapter).
 */

/** The fixed failure messages (never stream text). */
export const sseErrors = harden({
  lineTooLong: 'SSE line exceeds its bound',
  eventTooLarge: 'SSE event exceeds its bound',
  truncated: 'SSE stream ended inside an event',
  invalidUtf8: 'SSE stream is not valid UTF-8',
});

/** A parse failure; `message` is one of `sseErrors`. */
export class SseError extends Error {}
harden(SseError);

/** Default bounds (UTF-16 units): 16 Mi per line and per event. */
export const SSE_DEFAULT_MAX_UNITS = 16 * 1024 * 1024;

/**
 * @typedef {{ event?: string, data: string }} SseEvent
 */

/**
 * The events of each body chunk together (a non-empty array per chunk that
 * completed at least one event), so a consumer can coalesce what arrived at
 * once (W2.1a: one delta per network read, not per event; J-0413).
 * @param {AsyncIterable<Uint8Array> | Iterable<Uint8Array>} chunks the
 *   response body
 * @param {object} [options]
 * @param {number} [options.maxLineUnits]
 * @param {number} [options.maxEventUnits]
 * @returns {AsyncGenerator<SseEvent[], void, undefined>}
 */
export async function* parseSseBatches(
  chunks,
  {
    maxLineUnits = SSE_DEFAULT_MAX_UNITS,
    maxEventUnits = SSE_DEFAULT_MAX_UNITS,
  } = {},
) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  /** Pieces of the line not ended yet (joined once, when it ends). */
  /** @type {string[]} */
  let partial = [];
  let partialUnits = 0;
  /** The last chunk ended with CR: a LF starting the next one is its pair. */
  let skipLf = false;
  /** @type {string[]} */
  let data = [];
  let dataUnits = 0;
  /** @type {string | undefined} */
  let eventName;
  /** @type {SseEvent[]} */
  const ready = [];

  /** @param {string} line */
  const takeLine = line => {
    if (line === '') {
      if (data.length > 0) {
        ready.push(
          eventName === undefined
            ? { data: data.join('\n') }
            : { event: eventName, data: data.join('\n') },
        );
      }
      data = [];
      dataUnits = 0;
      eventName = undefined;
      return;
    }
    if (line.charCodeAt(0) === 0x3a) return; // ':' comment
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 0x20) value = value.slice(1);
    if (field === 'data') {
      dataUnits += value.length + 1;
      if (dataUnits > maxEventUnits)
        throw new SseError(sseErrors.eventTooLarge);
      data.push(value);
    } else if (field === 'event') {
      eventName = value;
    }
  };

  /**
   * Consume the whole lines of one decoded chunk; keep the unfinished one.
   * @param {string} text
   */
  const feed = text => {
    const n = text.length;
    let i = 0;
    if (skipLf) {
      skipLf = false;
      if (n > 0 && text.charCodeAt(0) === 0x0a) i = 1;
    }
    let start = i;
    while (i < n) {
      const code = text.charCodeAt(i);
      if (code === 0x0a || code === 0x0d) {
        const piece = text.slice(start, i);
        let line = piece;
        if (partial.length > 0) {
          partial.push(piece);
          line = partial.join('');
          partial = [];
          partialUnits = 0;
        }
        takeLine(line);
        i += 1;
        if (code === 0x0d) {
          if (i === n) skipLf = true;
          else if (text.charCodeAt(i) === 0x0a) i += 1;
        }
        start = i;
      } else {
        i += 1;
      }
    }
    if (start < n) {
      partial.push(text.slice(start));
      partialUnits += n - start;
      if (partialUnits > maxLineUnits)
        throw new SseError(sseErrors.lineTooLong);
    }
  };

  /** @param {Uint8Array} [chunk] */
  const decode = chunk => {
    try {
      return chunk === undefined
        ? decoder.decode()
        : decoder.decode(chunk, { stream: true });
    } catch {
      throw new SseError(sseErrors.invalidUtf8);
    }
  };

  for await (const chunk of chunks) {
    feed(decode(chunk));
    if (ready.length > 0) yield ready.splice(0);
  }
  feed(decode());
  if (ready.length > 0) yield ready.splice(0);
  if (data.length > 0 || partial.join('').trim() !== '') {
    throw new SseError(sseErrors.truncated);
  }
}
harden(parseSseBatches);

/**
 * The events one by one.
 * @param {AsyncIterable<Uint8Array> | Iterable<Uint8Array>} chunks
 * @param {Parameters<typeof parseSseBatches>[1]} [options]
 * @returns {AsyncGenerator<SseEvent, void, undefined>}
 */
export async function* parseSse(chunks, options) {
  for await (const batch of parseSseBatches(chunks, options)) yield* batch;
}
harden(parseSse);
