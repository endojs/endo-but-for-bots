/* global process */

import os from 'os';
import { E } from '@endo/eventual-send';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { withEndoAgent } from '../context.js';
import { parsePetNamePath, mountPathSegments } from '../pet-name.js';

/**
 * Dump a blob to stdout.
 *
 * With no `path`, `name` is a pet-name path resolving to a readable blob in the
 * capability graph (the classic behavior). With one or more `path` arguments,
 * `name` is instead a mount and `path` is a path *within* that mount's confined
 * tree: the file is resolved through the mount's own `lookup` and streamed.
 * Each `path` argument may itself carry `/`-separated segments.
 *
 * @param {object} args
 * @param {string} args.name - Pet name of the blob, or of the mount when
 * `path` is given.
 * @param {string[]} [args.path] - In-mount path segments; when present,
 * selects the mount-scoped read.
 * @param {string} [args.agentNames]
 */
export const cat = async ({ name, path = [], agentNames }) =>
  withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    const segments = mountPathSegments(path);
    let readable;
    if (segments.length > 0) {
      const mount = await E(agent).lookup(parsePetNamePath(name));
      readable = await E(mount).lookup(segments);
    } else {
      readable = await E(agent).lookup(parsePetNamePath(name));
    }
    const reader = iterateBytesReader(readable);
    for await (const chunk of reader) {
      process.stdout.write(chunk);
    }
  });
