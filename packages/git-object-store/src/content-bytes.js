// @ts-check

import harden from '@endo/harden';

/** @import { ContentStoreLike } from './types.js' */

/**
 * Store a single Uint8Array as one ContentStore blob.
 *
 * @param {ContentStoreLike} contentStore
 * @param {Uint8Array} bytes
 * @returns {Promise<string>} sha256 hex
 */
export const storeBytes = async (contentStore, bytes) => {
  const readable = {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
  return contentStore.store(readable);
};
harden(storeBytes);

/**
 * Fetch a ContentStore blob as a single Uint8Array.
 *
 * @param {ContentStoreLike} contentStore
 * @param {string} sha256
 * @returns {Promise<Uint8Array>}
 */
export const fetchBytes = async (contentStore, sha256) => {
  await null;
  const blob = contentStore.fetch(sha256);
  if (typeof blob.readRange === 'function' && typeof blob.size === 'function') {
    const size = await blob.size();
    return blob.readRange(0, Number(size));
  }
  const reader = blob.makeFileReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  // Support both AsyncIterable and AsyncIterator shapes.
  if (Symbol.asyncIterator in /** @type {object} */ (reader)) {
    for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (
      reader
    )) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } else {
    const iterator = /** @type {AsyncIterator<Uint8Array>} */ (reader);
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};
harden(fetchBytes);
