// @ts-check

import { decodeUtf8 } from '@endo/utf8/decode.js';
import { makeExo } from '@endo/exo';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import harden from '@endo/harden';

import { ReadableBlobInterface } from './fs/interfaces.js';

const CHUNK_BYTES = 48 * 1024;

/**
 * @param {Uint8Array | Promise<Uint8Array>} bytesOrPromise
 */
async function* byteChunks(bytesOrPromise) {
  const bytes = await bytesOrPromise;
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    const end = Math.min(offset + CHUNK_BYTES, bytes.length);
    yield bytes.subarray(offset, end);
  }
}

/**
 * Make a ReadableBlob from bytes that may be available asynchronously.
 *
 * @param {Uint8Array | Promise<Uint8Array>} bytesOrPromise
 */
export const blobFromBytes = bytesOrPromise => {
  const bytes = () => Promise.resolve(bytesOrPromise);
  return makeExo('Blob', ReadableBlobInterface, {
    /** @param {unknown} synHead */
    stream: synHead =>
      bytesReaderFromIterator(byteChunks(bytes())).stream(
        /** @type {any} */ (synHead),
      ),
    text: () => bytes().then(decodeUtf8),
    json: () =>
      bytes().then(resolvedBytes => JSON.parse(decodeUtf8(resolvedBytes))),
    /** @param {string} [method] */
    help: method =>
      method === undefined
        ? 'Blob: read-only bytes (stream, text, json).'
        : `No documentation for method ${method}.`,
  });
};
harden(blobFromBytes);
