/* global process */

import fs from 'fs';
import os from 'os';

import { makeNodeReader } from '@endo/stream-node';
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
 * `endo write` — write a value through a mutable mount path.
 *
 *   representation: --text (default) | --blob | --json
 *   source:         -p <file> | --stdin | --literal <s>
 *   destination:    <mount-name>/<path>
 *
 * Dispatches to `EndoDirectory.writeText` (text/json) or the
 * binary equivalent (blob).  See `designs/cli-store-verb-text-modes.md`
 * § Mount-path writes.
 *
 * @param {object} opts
 * @param {string} opts.target - `<mount-name>/<path>` argument
 * @param {string} [opts.agentNames]
 * @param {boolean} [opts.text]
 * @param {boolean} [opts.blob]
 * @param {boolean} [opts.json]
 * @param {string}  [opts.path]
 * @param {boolean} [opts.stdin]
 * @param {string}  [opts.literal]
 */
export const write = async ({
  target,
  agentNames,
  text,
  blob,
  json,
  path: srcPath,
  stdin,
  literal,
}) => {
  if (target === undefined) {
    usage('Missing required <mount-name>/<path> argument.');
  }

  // Default representation: --text.
  const reps = { text, blob, json };
  const repsKeys = ['text', 'blob', 'json'];
  const presentReps = repsKeys.filter(k => reps[k] !== undefined);
  const representation =
    presentReps.length === 0
      ? 'text'
      : pickAxis(reps, repsKeys, 'representation');

  const source = pickAxis(
    { path: srcPath, stdin, literal },
    ['path', 'stdin', 'literal'],
    'source',
  );

  if (representation === 'blob') {
    usage(
      '`endo write --blob` is not yet implemented; mount-path writes ' +
        'currently support --text and --json only.',
    );
  }

  // Read the input into a UTF-8 string.
  /** @type {string} */
  let content;
  await null;
  if (source === 'literal') {
    content = /** @type {string} */ (literal);
  } else if (source === 'stdin') {
    const reader = makeNodeReader(process.stdin);
    const bytes = await asyncConcat(reader);
    content = bytesToText(bytes);
  } else {
    const bytes = await fs.promises.readFile(/** @type {string} */ (srcPath));
    content = bytesToText(bytes);
  }

  if (representation === 'json') {
    // Validate that the input is parseable JSON before writing; rewrite
    // canonical (no trailing newline) so round-trips are stable.
    content = JSON.stringify(JSON.parse(content));
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
    await E(mount).writeText(innerPath, content);
  });
};
