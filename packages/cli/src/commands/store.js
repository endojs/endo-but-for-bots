/* global process */
import fs from 'fs';
import nodePath from 'path';
import os from 'os';

import { makeNodeReader } from '@endo/stream-node';
import { makeReaderRef } from '@endo/daemon';
import { makeLocalTree } from '@endo/platform/fs/node';
import { concatBytes } from '@endo/bytes/concat.js';
import { bytesToText } from '@endo/bytes/to-string.js';
import { E } from '@endo/far';

import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/**
 * @param {AsyncIterable<Uint8Array>} reader
 */
const asyncConcat = async reader => {
  const chunks = [];
  for await (const chunk of reader) {
    chunks.push(chunk);
  }
  return concatBytes(chunks);
};

/**
 * Throw a usage error without a trace.
 * Usage errors must be reported as strings so the CLI top-level swallows
 * the stack trace; see `endo.js` error handling.
 *
 * @param {string} message
 * @returns {never}
 */
const usage = message => {
  // eslint-disable-next-line no-throw-literal
  throw message;
};

const REPRESENTATIONS = ['blob', 'text', 'json', 'bigint', 'tree'];
const SOURCES = ['path', 'stdin', 'literal'];

/**
 * Pick exactly one truthy axis value, or throw a usage error.
 *
 * @param {Record<string, unknown>} axis
 * @param {string[]} keys
 * @param {string} axisName
 */
const pickAxis = (axis, keys, axisName) => {
  const present = keys.filter(k => axis[k] !== undefined);
  if (present.length === 0) {
    usage(
      `Must provide exactly one ${axisName} flag (one of: ${keys
        .map(k => `--${k}`)
        .join(', ')}).`,
    );
  }
  if (present.length > 1) {
    usage(
      `Must provide exactly one ${axisName} flag, got: ${present
        .map(k => `--${k}`)
        .join(', ')}.`,
    );
  }
  return present[0];
};

/**
 * `endo store` — unified storage verb across three orthogonal axes:
 *   representation: --blob | --text | --json | --bigint | --tree
 *   source:         -p <file> | --stdin | --literal <s>
 *   destination:    -n <name-path>
 *
 * See `designs/cli-store-verb-text-modes.md`.
 *
 * @param {object} opts
 * @param {string} opts.name - destination pet-name path (required)
 * @param {string} [opts.agentNames]
 * @param {boolean} [opts.blob]
 * @param {boolean} [opts.text]
 * @param {boolean} [opts.json]
 * @param {boolean} [opts.bigint]
 * @param {boolean} [opts.tree]
 * @param {string}  [opts.path]    - filesystem path (source `-p <file>`)
 * @param {boolean} [opts.stdin]   - read source bytes from stdin
 * @param {string}  [opts.literal] - argv literal source
 */
export const store = async ({
  name,
  agentNames,
  blob,
  text,
  json,
  bigint,
  tree,
  path: srcPath,
  stdin,
  literal,
}) => {
  if (name === undefined) {
    usage('Missing required -n <name> argument.');
  }

  const representation = pickAxis(
    { blob, text, json, bigint, tree },
    REPRESENTATIONS,
    'representation',
  );
  const source = pickAxis({ path: srcPath, stdin, literal }, SOURCES, 'source');

  // Disallow combinations the design rejects:
  if (representation === 'tree' && source === 'stdin') {
    usage(
      '`endo store --tree --stdin` is incoherent: stdin is a stream of bytes ' +
        'with no directory structure. Use the explicit zip form ' +
        '(`endo store --tree --zip --stdin -n <name>`) once zip support lands.',
    );
  }
  if (representation === 'tree' && source === 'literal') {
    usage('`endo store --tree --literal` is not supported.');
  }
  if (representation === 'bigint' && source !== 'literal') {
    usage('`endo store --bigint` requires `--literal <number>`.');
  }

  const parsedName = parsePetNamePath(name);

  await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    await null;

    // ----- Representation: text/json/bigint --> primitive value formula -----
    if (representation === 'text') {
      let value;
      if (source === 'literal') {
        value = literal;
      } else if (source === 'stdin') {
        const reader = makeNodeReader(process.stdin);
        const bytes = await asyncConcat(reader);
        value = bytesToText(bytes);
      } else {
        const bytes = await fs.promises.readFile(
          /** @type {string} */ (srcPath),
        );
        value = bytesToText(bytes);
      }
      await E(agent).storeValue(value, parsedName);
      return;
    }
    if (representation === 'json') {
      let jsonText;
      if (source === 'literal') {
        jsonText = literal;
      } else if (source === 'stdin') {
        const reader = makeNodeReader(process.stdin);
        const bytes = await asyncConcat(reader);
        jsonText = bytesToText(bytes);
      } else {
        const bytes = await fs.promises.readFile(
          /** @type {string} */ (srcPath),
        );
        jsonText = bytesToText(bytes);
      }
      await E(agent).storeValue(
        JSON.parse(/** @type {string} */ (jsonText)),
        parsedName,
      );
      return;
    }
    if (representation === 'bigint') {
      // bigint is literal-only, validated above.
      await E(agent).storeValue(
        BigInt(/** @type {string} */ (literal)),
        parsedName,
      );
      return;
    }

    // ----- Representation: blob --> readable-blob (CAS bytes) -----
    if (representation === 'blob') {
      /** @type {import('stream').Readable} */
      let nodeStream;
      if (source === 'stdin') {
        nodeStream = /** @type {import('stream').Readable} */ (
          /** @type {unknown} */ (process.stdin)
        );
      } else if (source === 'path') {
        nodeStream = fs.createReadStream(/** @type {string} */ (srcPath));
      } else {
        // --blob --literal: encode the argv string as UTF-8 bytes.
        const encoder = new TextEncoder();
        const bytes = encoder.encode(/** @type {string} */ (literal));
        // Wrap a single-chunk async iterable so makeReaderRef can stream.
        async function* yieldOnce() {
          yield bytes;
        }
        const readerRef = makeReaderRef(yieldOnce());
        await E(agent).storeBlob(readerRef, parsedName);
        return;
      }
      const reader = makeNodeReader(nodeStream);
      const readerRef = makeReaderRef(reader);
      await E(agent).storeBlob(readerRef, parsedName);
      return;
    }

    // ----- Representation: tree --> readable-tree (CAS, walks a directory) -----
    if (representation === 'tree') {
      // source must be 'path' (validated above)
      const resolvedPath = nodePath.resolve(/** @type {string} */ (srcPath));
      const stat = await fs.promises.stat(resolvedPath);
      if (!stat.isDirectory()) {
        throw new Error(`${resolvedPath} is not a directory`);
      }
      const progress = { files: 0 };
      const localTree = makeLocalTree(resolvedPath, {
        onFile: () => {
          progress.files += 1;
        },
      });
      await E(agent).storeTree(localTree, parsedName);
      console.log(`  stored ${progress.files} files`);
    }
  });
};
