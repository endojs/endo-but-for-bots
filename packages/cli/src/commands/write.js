/* global process */

import os from 'os';

import { makeNodeReader } from '@endo/stream-node';
import { concatBytes } from '@endo/bytes/concat.js';
import { bytesToText } from '@endo/bytes/to-string.js';
import { E } from '@endo/eventual-send';

import { withEndoAgent } from '../context.js';
import { parsePetNamePath, mountPathSegments } from '../pet-name.js';

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
 * Write standard input to a file within a mount's confined tree.
 *
 * `name` is a mount pet name and `path` names a file *within* that mount (each
 * `path` argument may carry `/`-separated segments). Stdin is read to
 * completion, decoded as UTF-8 text, and written through the mount's own
 * `writeText`, which creates parent directories as needed and enforces the
 * mount's confinement and read-only settings. This is the CLI counterpart of
 * the mount exo's text write surface; binary (`--blob`) mount-path writes are
 * deferred (see designs/daemon-mount.md § Phase 6).
 *
 * @param {object} args
 * @param {string} args.name - Pet name of the mount.
 * @param {string[]} args.path - In-mount path segments naming the file.
 * @param {string} [args.agentNames]
 */
export const write = async ({ name, path, agentNames }) =>
  withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    const segments = mountPathSegments(path);
    if (segments.length === 0) {
      // Usage error should be reported without a trace.
      // eslint-disable-next-line no-throw-literal
      throw `write requires an in-mount path (endo write <mount> <path...>)`;
    }
    const reader = makeNodeReader(process.stdin);
    const bytes = await asyncConcat(reader);
    let text;
    try {
      // Strict decode: refuse rather than silently substitute U+FFFD, so binary
      // input fails loudly instead of landing a corrupted text file. Binary
      // (`--blob`) mount writes are deferred (see designs/daemon-mount.md § Phase 6).
      text = bytesToText(bytes, { fatal: true });
    } catch {
      // Usage error should be reported without a trace.
      // eslint-disable-next-line no-throw-literal
      throw `write input is not valid UTF-8 text; binary (--blob) mount writes are not yet supported`;
    }
    const mount = await E(agent).lookup(parsePetNamePath(name));
    await E(mount).writeText(segments, text);
  });
