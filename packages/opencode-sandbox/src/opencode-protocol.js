// @ts-check

import { Fail, makeError, q, X } from '@endo/errors';

export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
harden(DEFAULT_MAX_LINE_BYTES);

/** The closed set of events the in-slice bridge may emit. */
export const BRIDGE_EVENT_TYPES = harden([
  'ready',
  'phase',
  'text-delta',
  'commentary-delta',
  'tool-call',
  'tool-result',
  'usage',
  'end',
  'abort',
]);

/**
 * Decode a UTF-8 newline-delimited JSON stream. The bridge emits one JSON
 * object per line; byte chunks and lines have no one-to-one relationship.
 *
 * @param {AsyncIterable<Uint8Array>} chunks
 * @param {{ maxLineBytes?: number }} [options]
 */
export async function* parseJsonLines(
  chunks,
  { maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {},
) {
  Number.isSafeInteger(maxLineBytes) && maxLineBytes > 0
    ? undefined
    : Fail`maxLineBytes must be a positive integer`;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let record = new Uint8Array(Math.min(4096, Math.max(1, maxLineBytes)));
  let recordBytes = 0;

  /** @param {string} line */
  const parse = line => {
    try {
      const value = JSON.parse(line);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw TypeError('bridge message must be an object');
      }
      return harden(value);
    } catch (error) {
      throw makeError(
        X`opencode bridge emitted malformed JSONL ${q(line.slice(0, 160))}: ${q(
          error instanceof Error ? error.message : `${error}`,
        )}`,
      );
    }
  };

  /** @param {Uint8Array} bytes */
  const append = bytes => {
    if (bytes.byteLength === 0) return;
    const nextBytes = recordBytes + bytes.byteLength;
    if (nextBytes > maxLineBytes) {
      throw makeError(
        X`opencode bridge JSONL line exceeded ${maxLineBytes} bytes`,
      );
    }
    if (nextBytes > record.byteLength) {
      /** @type {number} */
      let capacity = record.byteLength;
      while (capacity < nextBytes) {
        capacity = Math.min(maxLineBytes, Math.max(capacity * 2, nextBytes));
      }
      const grown = new Uint8Array(capacity);
      grown.set(record.subarray(0, recordBytes));
      record = grown;
    }
    record.set(bytes, recordBytes);
    recordBytes = nextBytes;
  };

  const takeLine = () => {
    const line = decoder.decode(record.subarray(0, recordBytes)).trim();
    recordBytes = 0;
    return line;
  };

  for await (const chunk of chunks) {
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] === 0x0a) {
        append(chunk.subarray(start, index));
        const line = takeLine();
        if (line !== '') yield parse(line);
        start = index + 1;
      }
    }
    if (start < chunk.byteLength) {
      append(chunk.subarray(start));
    }
  }
  if (recordBytes > 0) {
    const line = takeLine();
    if (line !== '') yield parse(line);
  }
}

/**
 * Validate and project one bridge event. Unknown extra fields are dropped so a
 * newer bridge cannot smuggle unvalidated shapes into the host client.
 *
 * @param {any} candidate
 */
export const assertBridgeEvent = candidate => {
  (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) ||
    Fail`opencode bridge event must be a record`;
  BRIDGE_EVENT_TYPES.includes(candidate.type) ||
    Fail`unknown opencode bridge event type ${q(candidate.type)}`;
  const { type } = candidate;
  if (type === 'ready') {
    const rawSessionId = candidate.sessionId;
    if (!(
      typeof rawSessionId === 'string' &&
      /^[A-Za-z0-9_.:-]{1,160}$/.test(rawSessionId)
    )) {
      Fail`ready event needs a bounded sessionId`;
    }
    const rawPort = candidate.port;
    if (!(
      typeof rawPort === 'number' &&
      Number.isSafeInteger(rawPort) &&
      rawPort > 0
    )) {
      Fail`ready event needs a port`;
    }
    const sessionId = /** @type {string} */ (rawSessionId);
    const port = /** @type {number} */ (rawPort);
    return harden({ type, sessionId, port });
  }
  if (type === 'phase') {
    ['busy', 'idle', 'error'].includes(candidate.phase) ||
      Fail`invalid phase ${q(candidate.phase)}`;
    return harden({
      type,
      phase: candidate.phase,
      ...(candidate.error === undefined ? {} : { error: `${candidate.error}` }),
    });
  }
  if (type === 'text-delta' || type === 'commentary-delta') {
    typeof candidate.text === 'string' || Fail`${q(type)} needs text`;
    return harden({ type, text: candidate.text });
  }
  if (type === 'tool-call') {
    typeof candidate.id === 'string' && candidate.id !== ''
      ? undefined
      : Fail`tool-call needs an id`;
    typeof candidate.name === 'string' && candidate.name !== ''
      ? undefined
      : Fail`tool-call needs a name`;
    return harden({
      type,
      id: candidate.id,
      name: candidate.name,
      ...(candidate.args === undefined ? {} : { args: candidate.args }),
    });
  }
  if (type === 'tool-result') {
    typeof candidate.id === 'string' && candidate.id !== ''
      ? undefined
      : Fail`tool-result needs an id`;
    typeof candidate.ok === 'boolean' || Fail`tool-result needs ok`;
    return harden({
      type,
      id: candidate.id,
      ok: candidate.ok,
      ...(candidate.name === undefined ? {} : { name: `${candidate.name}` }),
      ...(candidate.error === undefined ? {} : { error: `${candidate.error}` }),
      ...(candidate.result === undefined ? {} : { result: candidate.result }),
    });
  }
  if (type === 'usage') {
    const rawInputTokens = candidate.inputTokens;
    if (!(
      typeof rawInputTokens === 'number' &&
      Number.isFinite(rawInputTokens) &&
      rawInputTokens >= 0
    )) {
      Fail`usage needs inputTokens`;
    }
    const rawOutputTokens = candidate.outputTokens;
    if (!(
      typeof rawOutputTokens === 'number' &&
      Number.isFinite(rawOutputTokens) &&
      rawOutputTokens >= 0
    )) {
      Fail`usage needs outputTokens`;
    }
    const inputTokens = /** @type {number} */ (rawInputTokens);
    const outputTokens = /** @type {number} */ (rawOutputTokens);
    return harden({ type, inputTokens, outputTokens });
  }
  if (type === 'end') {
    return harden({
      type,
      ...(candidate.checkpoint === undefined
        ? {}
        : { checkpoint: `${candidate.checkpoint}` }),
    });
  }
  // abort
  return harden({
    type,
    reason: candidate.reason === undefined ? 'aborted' : `${candidate.reason}`,
  });
};
harden(assertBridgeEvent);
