// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import harden from '@endo/harden';
import { makeExo } from '@endo/exo';

import { TreeWriterInterface } from '../fs/interfaces.js';

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
 * Creates a TreeWriter Exo that writes to a local directory.
 *
 * @param {string} dirPath - Root directory to write into.
 */
export const makeTreeWriter = dirPath => {
  return makeExo(
    'TreeWriter',
    TreeWriterInterface,
    /** @type {any} */ ({
      /**
       * @param {string[]} pathSegments
       * @param {AsyncIterable<Uint8Array>} readable
       */
      writeBlob: async (pathSegments, readable) => {
        const filePath = path.join(dirPath, ...pathSegments);
        const parentDir = path.dirname(filePath);
        await fs.promises.mkdir(parentDir, { recursive: true });
        const chunks = [];
        for await (const chunk of readable) {
          chunks.push(chunk);
        }
        await fs.promises.writeFile(filePath, concatChunks(chunks));
      },
      /**
       * @param {string[]} pathSegments
       */
      makeDirectory: async pathSegments => {
        await fs.promises.mkdir(path.join(dirPath, ...pathSegments), {
          recursive: true,
        });
      },
    }),
  );
};
harden(makeTreeWriter);
