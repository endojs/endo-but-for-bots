// @ts-check

import { encodeBase64 } from '@endo/base64';
import { bytesToText } from '@endo/bytes/to-string.js';
import { makeExo } from '@endo/exo';
import { makeReaderPump } from '@endo/exo-stream/reader-pump.js';
import harden from '@endo/harden';
import { createHash } from 'node:crypto';

import { ReadableBlobInterface } from './fs/interfaces.js';

const BASE64_CHUNK_RAW_BYTES = 48 * 1024;

/**
 * @param {Uint8Array | Promise<Uint8Array>} bytesOrPromise
 */
async function* base64Chunks(bytesOrPromise) {
  const bytes = await bytesOrPromise;
  for (
    let offset = 0;
    offset < bytes.length;
    offset += BASE64_CHUNK_RAW_BYTES
  ) {
    const end = Math.min(offset + BASE64_CHUNK_RAW_BYTES, bytes.length);
    yield encodeBase64(bytes.subarray(offset, end));
  }
}

/**
 * Make a ReadableBlob from bytes that may be available asynchronously.
 *
 * @param {Uint8Array | Promise<Uint8Array>} bytesOrPromise
 */
export const blobFromBytes = bytesOrPromise => {
  const bytes = () =>
    Promise.resolve(bytesOrPromise).then(value => new Uint8Array(value));
  const rangeBytes = async (start, end) => {
    if (
      typeof start !== 'bigint' ||
      typeof end !== 'bigint' ||
      start < 0n ||
      end < start ||
      end > BigInt(Number.MAX_SAFE_INTEGER) ||
      start > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error('EINVAL: invalid range endpoints');
    }
    const value = await bytes();
    return value.slice(Number(start), Math.min(Number(end), value.length));
  };
  /**
   * @param {number} startLine
   * @param {number} endLine
   */
  const textRangeBytes = async (startLine, endLine) => {
    if (
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLine) ||
      startLine < 0 ||
      endLine < startLine
    ) {
      throw new Error('EINVAL: invalid line range endpoints');
    }
    const value = await bytes();
    const starts = [0];
    for (let offset = 0; offset < value.length; offset += 1)
      if (value[offset] === 0x0a) starts.push(offset + 1);
    return value.slice(
      starts[Math.min(startLine, starts.length - 1)],
      endLine >= starts.length ? value.length : starts[endLine],
    );
  };
  return makeExo('Blob', ReadableBlobInterface, {
    /** @param {unknown} synHead */
    streamBase64: synHead =>
      makeReaderPump(base64Chunks(bytes()))(/** @type {any} */ (synHead)),
    text: () => bytes().then(bytesToText),
    json: () =>
      bytes().then(resolvedBytes => JSON.parse(bytesToText(resolvedBytes))),
    async getInfo() {
      const value = await bytes();
      return harden({
        algorithm: 'sha256',
        hash: encodeBase64(createHash('sha256').update(value).digest()),
        size: BigInt(value.length),
      });
    },
    async range(start, end) {
      return blobFromBytes(rangeBytes(start, end));
    },
    async textRange(startLine, endLine) {
      return blobFromBytes(textRangeBytes(startLine, endLine));
    },
    /** @param {string} [method] */
    help: method =>
      method === undefined
        ? 'Blob: read-only bytes (streamBase64, text, json, getInfo, range, textRange).'
        : `No documentation for method ${method}.`,
  });
};
harden(blobFromBytes);
