/* global process */

import fs from 'fs';
import nodePath from 'path';
import os from 'os';
import { E } from '@endo/far';
import { makeRefReader } from '@endo/daemon';
import { checkoutTree } from '@endo/platform/fs/lite';
import { makeTreeWriter } from '@endo/platform/fs/node';
import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/**
 * Throw a usage error without a trace.
 *
 * @param {string} message
 * @returns {never}
 */
const usage = message => {
  // eslint-disable-next-line no-throw-literal
  throw message;
};

/**
 * Pick exactly one truthy value from a small set; default to a given key.
 *
 * @param {Record<string, unknown>} axis
 * @param {string[]} keys
 * @param {string} axisName
 * @param {string} fallback
 */
const pickAxis = (axis, keys, axisName, fallback) => {
  const present = keys.filter(k => axis[k] !== undefined);
  if (present.length > 1) {
    usage(
      `Must provide at most one ${axisName} flag, got: ${present
        .map(k => `--${k}`)
        .join(', ')}.`,
    );
  }
  return present[0] ?? fallback;
};

/**
 * Format a passable value for human-readable display.
 * Mirrors the `endo show` formatter.
 *
 * @param {unknown} value
 */
const formatValue = value => {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      console.log(`${i}. ${value[i]}`);
    }
    return;
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      console.log('{}');
      return;
    }
    const maxKey = Math.max(...entries.map(([k]) => k.length));
    for (const [k, v] of entries) {
      console.log(`${k.padEnd(maxKey)}  ${v}`);
    }
    return;
  }
  console.log(value);
};

/**
 * `endo cat` — unified read verb mirroring `endo store`'s axes.
 *
 *   representation: --blob (default) | --text | --json | --tree
 *   sink:           --stdout (default) | -p <file> | --show
 *
 * See `designs/cli-store-verb-text-modes.md`.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} [opts.agentNames]
 * @param {boolean} [opts.blob]
 * @param {boolean} [opts.text]
 * @param {boolean} [opts.json]
 * @param {boolean} [opts.tree]
 * @param {string}  [opts.path]    - filesystem path (sink `-p <file>`)
 * @param {boolean} [opts.stdout]  - sink: stdout (default)
 * @param {boolean} [opts.show]    - sink: pretty-print a passable value
 */
export const cat = async ({
  name,
  agentNames,
  blob,
  text,
  json,
  tree,
  path: dstPath,
  stdout,
  show,
}) => {
  const representation = pickAxis(
    { blob, text, json, tree },
    ['blob', 'text', 'json', 'tree'],
    'representation',
    'blob',
  );
  const sink = pickAxis(
    { path: dstPath, stdout, show },
    ['path', 'stdout', 'show'],
    'sink',
    'stdout',
  );

  if (representation === 'tree' && sink !== 'path') {
    usage('`endo cat --tree` requires `-p <dir>` (a destination directory).');
  }

  const namePath = parsePetNamePath(name);

  await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    const target = await E(agent).lookup(namePath);

    // ----- Representation: tree (readable-tree) -----
    if (representation === 'tree') {
      const resolvedPath = nodePath.resolve(/** @type {string} */ (dstPath));
      try {
        await fs.promises.access(resolvedPath);
        throw new Error(`${resolvedPath} already exists`);
      } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') {
          throw e;
        }
      }
      const progress = { files: 0 };
      const writer = makeTreeWriter(resolvedPath);
      await checkoutTree(target, writer, {
        onFile: () => {
          progress.files += 1;
        },
      });
      console.log(`  checked out ${progress.files} files`);
      return;
    }

    // ----- Representation: blob (readable-blob bytes) -----
    if (representation === 'blob') {
      const readerRef = E(target).streamBase64();
      const reader = makeRefReader(readerRef);
      if (sink === 'path') {
        const out = fs.createWriteStream(/** @type {string} */ (dstPath));
        await new Promise((resolve, reject) => {
          out.on('error', reject);
          out.on('finish', resolve);
          (async () => {
            await null;
            try {
              for await (const chunk of reader) {
                if (!out.write(chunk)) {
                  await new Promise(r => out.once('drain', r));
                }
              }
              out.end();
            } catch (err) {
              out.destroy(/** @type {Error} */ (err));
            }
          })();
        });
        return;
      }
      if (sink === 'show') {
        usage(
          '`endo cat --blob --show` is not supported; --show is for passable values, use --text or --json.',
        );
      }
      // default sink: stdout
      for await (const chunk of reader) {
        process.stdout.write(chunk);
      }
      return;
    }

    // ----- Representation: text or json (passable values) -----
    // `target` is the resolved primitive value (string for --text, structured for --json).
    if (representation === 'text') {
      if (typeof target !== 'string') {
        throw new Error(
          `Value at ${name} is not a string; got ${typeof target}.`,
        );
      }
      if (sink === 'show') {
        formatValue(target);
        return;
      }
      if (sink === 'path') {
        await fs.promises.writeFile(
          /** @type {string} */ (dstPath),
          target,
          'utf8',
        );
        return;
      }
      // default sink: stdout
      process.stdout.write(target);
      return;
    }
    if (representation === 'json') {
      if (sink === 'show') {
        formatValue(target);
        return;
      }
      const serialized = JSON.stringify(target);
      if (sink === 'path') {
        await fs.promises.writeFile(
          /** @type {string} */ (dstPath),
          serialized,
          'utf8',
        );
        return;
      }
      process.stdout.write(serialized);
    }
  });
};
