/* global process */

import fs from 'fs';
import os from 'os';

import { E } from '@endo/far';
import { makeNodeReader } from '@endo/stream-node';
import { concatBytes } from '@endo/bytes/concat.js';
import { bytesToText } from '@endo/bytes/to-string.js';
import { parseHashlineText, validateEditPatch } from '@endo/daemon/hashline.js';

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
 * Resolve a `<name-path>` arg into a `(directoryRef, path)` pair.
 *
 * The leading segment is treated as a top-level pet name resolving
 * to a mount; the remaining segments are the path within the mount.
 *
 * DESIGN GAP: the design's name-path resolution rules say
 * "multi-segment paths address a path within a mount" but do not
 * pin down whether the head must be a mount or whether the CLI
 * should walk into nested directories via lookup. This
 * implementation: head segment looks up a mount, tail segments are
 * passed verbatim to the mount's edit method (the mount handles
 * path resolution).
 *
 * @param {object} agent
 * @param {string[]} namePath
 * @returns {Promise<{ directoryRef: object, path: string[] }>}
 */
const resolveTarget = async (agent, namePath) => {
  if (namePath.length === 0) {
    throw new Error('endo edit: name-path must have at least one segment');
  }
  const [head, ...rest] = namePath;
  const directoryRef = await E(agent).lookup(head);
  return { directoryRef, path: rest };
};

/**
 * Render a structured EditResult to stderr in human-readable form.
 *
 * Per design "Error model" exit-code table.
 *
 * @param {object} result
 * @returns {number} exit code
 */
const renderResult = result => {
  if (result.success) {
    process.stderr.write(`ok\nfileHashAfter: ${result.fileHashAfter}\n`);
    return 0;
  }
  const failure = result.failure;
  if (failure === undefined) {
    process.stderr.write('failed (no failure detail)\n');
    return 1;
  }
  switch (failure.reason) {
    case 'patch-syntax':
      process.stderr.write(`patch-syntax: ${failure.message ?? ''}\n`);
      return 1;
    case 'hash-mismatch':
      process.stderr.write('hash-mismatch:\n');
      for (const m of failure.mismatches ?? []) {
        process.stderr.write(
          `  line ${m.line}: expected ${m.hashExpected}, actual ${m.hashActual}\n`,
        );
      }
      return 2;
    case 'file-rev-mismatch':
      process.stderr.write(
        `file-rev-mismatch: actual SHA-256 is ${failure.fileHashActual ?? '<unknown>'}\n`,
      );
      return 3;
    case 'ambiguous-reapply':
      process.stderr.write(`ambiguous-reapply: ${failure.message ?? ''}\n`);
      return 4;
    case 'path-not-found':
      process.stderr.write(`path-not-found: ${failure.message ?? ''}\n`);
      return 5;
    case 'permission-denied':
      process.stderr.write(`permission-denied: ${failure.message ?? ''}\n`);
      return 6;
    default:
      process.stderr.write(`unknown failure reason: ${failure.reason}\n`);
      return 1;
  }
};

/**
 * @param {object} args
 * @param {string} args.name
 * @param {string | undefined} args.agentNames
 * @param {string | undefined} args.patchPath
 * @param {boolean} args.patchStdin
 * @param {string} args.format e.g. 'hashline' or 'hashline-json'
 */
export const edit = async ({
  name,
  agentNames,
  patchPath,
  patchStdin,
  format,
}) => {
  await null;
  // Read the patch from --patch <file> or stdin.
  let patchText;
  if (patchPath !== undefined) {
    patchText = await fs.promises.readFile(patchPath, 'utf-8');
  } else if (patchStdin) {
    const reader = makeNodeReader(process.stdin);
    const bytes = await asyncConcat(reader);
    patchText = bytesToText(bytes);
  } else {
    throw new Error('endo edit: --patch <file> or --patch-stdin is required');
  }

  // Parse the patch into the EditPatch envelope.
  let patch;
  if (format === 'hashline') {
    patch = parseHashlineText(patchText);
  } else if (format === 'hashline-json') {
    patch = validateEditPatch(JSON.parse(patchText));
  } else {
    throw new Error(
      `endo edit: --format ${format} not supported (this build only supports 'hashline' and 'hashline-json')`,
    );
  }

  const namePath = parsePetNamePath(name);

  await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    await null;
    const { directoryRef, path } = await resolveTarget(agent, namePath);
    const result = await E(agent).edit(directoryRef, path, patch);
    const code = renderResult(result);
    if (code !== 0) {
      process.exitCode = code;
    }
  });
};
