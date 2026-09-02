// @ts-check

import { makeError, q, X } from '@endo/errors';

export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
harden(DEFAULT_MAX_LINE_BYTES);

/**
 * Decode a UTF-8 newline-delimited JSON stream. App-server deliberately omits
 * JSON-RPC Content-Length framing, so byte chunks and protocol messages have no
 * one-to-one relationship.
 *
 * @param {AsyncIterable<Uint8Array>} chunks
 * @param {{ maxLineBytes?: number }} [options]
 */
export async function* parseJsonLines(
  chunks,
  { maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {},
) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let record = new Uint8Array(Math.min(4096, Math.max(1, maxLineBytes)));
  let recordBytes = 0;

  const parse = line => {
    try {
      const value = JSON.parse(line);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw TypeError('JSON-RPC message must be an object');
      }
      return harden(value);
    } catch (error) {
      throw makeError(
        X`Codex app-server emitted malformed JSONL ${q(line.slice(0, 160))}: ${q(
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
        X`Codex app-server JSONL line exceeded ${maxLineBytes} bytes`,
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

  const finalLine = takeLine();
  if (finalLine !== '') yield parse(finalLine);
}
harden(parseJsonLines);

/**
 * @param {unknown} message
 * @param {number} [maxBytes]
 */
export const encodeJsonLine = (message, maxBytes = DEFAULT_MAX_LINE_BYTES) => {
  const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
  if (bytes.byteLength > maxBytes) {
    throw makeError(X`Codex app-server request exceeded ${maxBytes} bytes`);
  }
  return bytes;
};
harden(encodeJsonLine);

/**
 * Convert app-server item records into a stable event vocabulary. Output is
 * intentionally small: downstream UI code must not depend on Codex's generated
 * version-specific schema.
 *
 * @param {any} item
 */
export const toolFromItem = item => {
  if (!item || typeof item !== 'object') return undefined;
  switch (item.type) {
    case 'commandExecution':
      return harden({
        id: `${item.id}`,
        name: 'shell',
        args: harden({
          command: `${item.command || ''}`,
          cwd: `${item.cwd || ''}`,
        }),
        result: item.aggregatedOutput ?? '',
        status: item.status,
      });
    case 'fileChange':
      return harden({
        id: `${item.id}`,
        name: 'file_change',
        args: harden({ changes: item.changes || [] }),
        result: item.status || '',
        status: item.status,
      });
    case 'mcpToolCall':
      return harden({
        id: `${item.id}`,
        name: `${item.server || 'mcp'}/${item.tool || 'tool'}`,
        args: item.arguments ?? {},
        result: item.error ?? item.result ?? '',
        status: item.status,
      });
    case 'dynamicToolCall':
      return harden({
        id: `${item.id}`,
        name: item.namespace
          ? `${item.namespace}/${item.tool || 'tool'}`
          : `${item.tool || 'tool'}`,
        args: item.arguments ?? {},
        result: item.contentItems ?? '',
        status: item.status,
      });
    case 'webSearch':
      return harden({
        id: `${item.id}`,
        name: 'web_search',
        args: harden({
          query: `${item.query || ''}`,
          ...(item.action ? { action: item.action } : {}),
        }),
        result: item.results ?? '',
      });
    default:
      return undefined;
  }
};
harden(toolFromItem);
