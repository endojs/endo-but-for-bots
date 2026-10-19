import os from 'os';

import { makeNodeReader } from '@endo/stream-node';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { E } from '@endo/eventual-send';

import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/**
 * Write standard input to a file within a mount.
 *
 * The mount is named by a pet-name path; the file is named by the remaining
 * path segments, resolved by the mount under its own confinement rules
 * (`..` clamped at the mount root, escaping symlinks rejected).  Missing
 * parent directories are created.  The bytes stream to the daemon, which
 * replaces the target only after the whole input has been read.
 *
 * @param {object} options
 * @param {string} options.mountName - Pet-name path of the mount.
 * @param {string[]} options.filePath - Path segments within the mount.
 * @param {string} [options.agentNames] - Agent to act as.
 */
export const write = async ({ mountName, filePath, agentNames }) => {
  const parsedMountName = parsePetNamePath(mountName);
  const segments = filePath.flatMap(segment => segment.split('/'));
  if (segments.length === 0 || segments.some(segment => segment === '')) {
    // Usage error should be reported without trace.
    // eslint-disable-next-line no-throw-literal
    throw `Expected a non-empty file path within the mount, got ${JSON.stringify(
      filePath.join('/'),
    )}`;
  }

  await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    const mount = E(agent).lookup(parsedMountName);
    const reader = makeNodeReader(process.stdin);
    const readerRef = bytesReaderFromIterator(reader);
    await E(mount).write(segments, readerRef);
  });
};
