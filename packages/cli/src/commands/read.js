/* global process */

import fs from 'fs';
import os from 'os';
import { E } from '@endo/far';

import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/**
 * @param {string} message
 * @returns {never}
 */
const usage = message => {
  // eslint-disable-next-line no-throw-literal
  throw message;
};

/**
 * @param {Record<string, unknown>} axis
 * @param {string[]} keys
 * @param {string} axisName
 */
const pickAtMostOne = (axis, keys, axisName) => {
  const present = keys.filter(k => axis[k] !== undefined);
  if (present.length > 1) {
    usage(
      `Must provide at most one ${axisName} flag, got: ${present
        .map(k => `--${k}`)
        .join(', ')}.`,
    );
  }
  return present[0];
};

/**
 * `endo read` — read a value through a mutable mount path.
 *
 *   representation: --text (default) | --blob
 *   destination:    <mount-name>/<path>
 *
 * Dispatches to `EndoDirectory.readText` (text) or the binary equivalent
 * (blob).  See `designs/cli-store-verb-text-modes.md` § Mount-path writes.
 *
 * @param {object} opts
 * @param {string} opts.target
 * @param {string} [opts.agentNames]
 * @param {boolean} [opts.text]
 * @param {boolean} [opts.blob]
 * @param {string}  [opts.path]
 */
export const read = async ({
  target,
  agentNames,
  text,
  blob,
  path: dstPath,
}) => {
  if (target === undefined) {
    usage('Missing required <mount-name>/<path> argument.');
  }

  const repPresent = pickAtMostOne(
    { text, blob },
    ['text', 'blob'],
    'representation',
  );
  const representation = repPresent ?? 'text';

  if (representation === 'blob') {
    usage(
      '`endo read --blob` is not yet implemented; mount-path reads ' +
        'currently support --text only.',
    );
  }

  const segments = parsePetNamePath(target);
  if (segments.length < 2) {
    usage(
      'Mount-path target must have at least two segments ' +
        '(`<mount-name>/<path>`).',
    );
  }
  const mountName = segments[0];
  const innerPath = segments.slice(1);

  await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    const mount = await E(agent).lookup(mountName);
    const content = await E(mount).readText(innerPath);
    if (dstPath !== undefined) {
      await fs.promises.writeFile(dstPath, content, 'utf8');
      return;
    }
    process.stdout.write(content);
  });
};
