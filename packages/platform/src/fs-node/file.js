// @ts-check
/* eslint-disable no-await-in-loop */

import fs from 'node:fs';
import harden from '@endo/harden';
import { makeExo } from '@endo/exo';
import { makeNodeReader } from '@endo/stream-node';

import { FileInterface, ReadableBlobInterface } from '../fs/interfaces.js';
import { makeReaderRef } from '../fs/reader-ref.js';
import { makeRefIterator } from '../fs/ref-reader.js';

/** @import { SnapshotStore } from '../fs/types.js' */

/**
 * Concatenates Uint8Array chunks into a single Uint8Array.
 *
 * Avoids `Buffer.concat` so the same aggregator pattern works in XS and SES
 * realms where Node `Buffer` is unavailable.
 *
 * @param {Uint8Array[]} chunks
 * @returns {Uint8Array}
 */
const concatChunks = chunks => {
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

/**
 * Creates a mutable File Exo backed by a local filesystem path.
 *
 * @param {string} filePath - Absolute path to the file.
 * @param {object} [options]
 * @param {SnapshotStore} [options.store] - Snapshot store for snapshot().
 * @returns {object}
 */
export const makeFile = (filePath, options = {}) => {
  const { store } = options;

  /** @type {object | undefined} */
  let readOnlyFacet;

  return makeExo(
    'File',
    FileInterface,
    /** @type {any} */ ({
      streamBase64: () => {
        const reader = makeNodeReader(fs.createReadStream(filePath));
        return makeReaderRef(reader);
      },
      text: () => fs.promises.readFile(filePath, 'utf-8'),
      json: async () =>
        JSON.parse(await fs.promises.readFile(filePath, 'utf-8')),

      /**
       * @param {string} content
       */
      writeText: async content => {
        await fs.promises.writeFile(filePath, content, 'utf-8');
      },

      /**
       * @param {unknown} readableRef - Remotable async iterator of Uint8Array.
       */
      writeBytes: async readableRef => {
        const iterator = makeRefIterator(
          /** @type {import('@endo/far').ERef<AsyncIterator<Uint8Array>>} */ (
            readableRef
          ),
        );
        /** @type {Uint8Array[]} */
        const chunks = [];
        for await (const chunk of iterator) {
          chunks.push(chunk);
        }
        await fs.promises.writeFile(filePath, concatChunks(chunks));
      },

      /**
       * @param {string} text
       */
      append: async text => {
        await fs.promises.appendFile(filePath, text, 'utf-8');
      },

      readOnly: () => {
        if (!readOnlyFacet) {
          readOnlyFacet = makeExo('ReadableBlob', ReadableBlobInterface, {
            streamBase64: () => {
              const reader = makeNodeReader(fs.createReadStream(filePath));
              return makeReaderRef(reader);
            },
            text: () => fs.promises.readFile(filePath, 'utf-8'),
            json: async () =>
              JSON.parse(await fs.promises.readFile(filePath, 'utf-8')),
          });
        }
        return readOnlyFacet;
      },

      snapshot: async () => {
        if (!store) {
          throw new Error('No snapshot store provided');
        }
        const reader = makeNodeReader(fs.createReadStream(filePath));
        const sha256 = await store.store(reader);
        return store.loadBlob(sha256);
      },
    }),
  );
};
harden(makeFile);
