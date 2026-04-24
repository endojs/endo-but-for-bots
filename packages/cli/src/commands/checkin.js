/* global process */
import { Buffer } from 'node:buffer';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { E } from '@endo/far';
import { makeLocalTree } from '@endo/platform/fs/node';

import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/**
 * Extract a zip archive to a temporary directory.
 *
 * @param {Uint8Array} zipBytes
 * @returns {Promise<string>} Path to the temporary directory.
 */
const extractZipToTemp = async zipBytes => {
  const { ZipReader } = await import('@endo/zip/reader.js');
  const zipReader = new ZipReader(zipBytes);
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'endo-checkin-'),
  );

  for (const [name, file] of zipReader.files.entries()) {
    // Skip directory entries (names ending with /).
    if (!name.endsWith('/')) {
      const filePath = path.join(tmpDir, ...name.split('/'));
      // eslint-disable-next-line no-await-in-loop
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      // eslint-disable-next-line no-await-in-loop
      await fs.promises.writeFile(filePath, file.content);
    }
  }

  return tmpDir;
};

/**
 * Check in a local directory (or zip archive) as a content-addressed
 * readable-tree.
 *
 * @param {object} options
 * @param {string} options.sourcePath - Local directory or zip file path.
 * @param {string} options.name - Pet name for the root readable-tree.
 * @param {string} [options.agentNames] - Agent to act as.
 * @param {boolean} [options.zip] - Interpret input as a zip archive.
 * @param {boolean} [options.stdin] - Read zip from stdin (requires zip).
 */
export const checkin = async ({
  sourcePath,
  name,
  agentNames,
  zip = false,
  stdin = false,
}) => {
  const parsedName = parsePetNamePath(name);

  let resolvedPath;
  let tmpDir;

  if (zip) {
    /** @type {Uint8Array} */
    let zipBytes;
    if (stdin) {
      const chunks = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      zipBytes = Buffer.concat(chunks);
    } else {
      resolvedPath = path.resolve(sourcePath);
      zipBytes = await fs.promises.readFile(resolvedPath);
    }
    tmpDir = await extractZipToTemp(zipBytes);
    resolvedPath = tmpDir;
  } else {
    resolvedPath = path.resolve(sourcePath);
    const fileStat = await fs.promises.stat(resolvedPath);
    if (!fileStat.isDirectory()) {
      throw new Error(`${resolvedPath} is not a directory`);
    }
  }

  try {
    await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
      const progress = { files: 0 };
      const localTree = makeLocalTree(/** @type {string} */ (resolvedPath), {
        onFile: () => {
          progress.files += 1;
        },
      });
      await E(agent).storeTree(localTree, parsedName);
      console.log(`  stored ${progress.files} files`);
    });
  } finally {
    // Clean up temp directory if we extracted a zip.
    if (tmpDir) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  }
};
