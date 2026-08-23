import os from 'os';
import url from 'url';
import path from 'path';
import { E } from '@endo/eventual-send';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { makeCliArchive } from '../cli-archive.js';
import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/** @import { ArchiveOptions } from '@endo/compartment-mapper' */

/**
 * `endo archive <application-path>` command.
 *
 * Creates a source-only ZIP archive of the application at `applicationPath`
 * (a directory with a `package.json`) and stores it as a readable blob on the
 * specified agent.
 *
 * @param {object} args
 * @param {string} args.applicationPath - Path to the application
 *   directory (contains `package.json`).
 * @param {string | undefined} args.archiveName - Pet name to give the
 *   stored blob (optional).
 * @param {string[] | undefined} args.agentNames
 * @param {ArchiveOptions} [args.archiveOptions] - Extra options augmenting the
 *   defaults passed to `makeCliArchive`.
 */
export const archiveCommand = async ({
  applicationPath,
  archiveName,
  agentNames,
  archiveOptions = {},
}) => {
  const moduleLocation = url.pathToFileURL(
    path.resolve(process.cwd(), applicationPath),
  ).href;
  const archiveBytes = await makeCliArchive(moduleLocation, archiveOptions);
  assert(archiveName === undefined || typeof archiveName === 'string');
  const archivePath = archiveName && parsePetNamePath(archiveName);
  const readerRef = bytesReaderFromIterator([archiveBytes]);
  process.stdout.write(`${archiveBytes.byteLength} bytes\n`);
  return withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    await E(agent).storeBlob(readerRef, archivePath);
  });
};
