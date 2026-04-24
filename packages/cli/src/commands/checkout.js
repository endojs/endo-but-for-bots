/* global process */
import fs from 'fs';
import path from 'path';
import os from 'os';

import { E } from '@endo/far';
import { checkoutTree } from '@endo/platform/fs/lite';
import { makeTreeWriter } from '@endo/platform/fs/node';

import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/**
 * Walk a readable-tree and write entries into a ZipWriter.
 *
 * @param {object} zipWriter - A ZipWriter instance.
 * @param {object} tree - A readable-tree remotable.
 * @param {string} prefix - Path prefix for zip entry names.
 * @param {{ files: number }} progress - Progress counter.
 */
const addTreeToZip = async (zipWriter, tree, prefix, progress) => {
  const { makeRefReader } = await import('@endo/platform/fs/lite');
  const names = await E(tree).list();
  for (const name of names) {
    const child = await E(tree).lookup(name);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    // eslint-disable-next-line no-underscore-dangle
    const methods = await E(child).__getMethodNames__();
    const isTree = methods.includes('list');
    if (isTree) {
      // eslint-disable-next-line no-await-in-loop
      await addTreeToZip(zipWriter, child, entryPath, progress);
    } else {
      const readerRef = E(child).streamBase64();
      const reader = makeRefReader(/** @type {any} */ (readerRef));
      const chunks = [];
      // eslint-disable-next-line no-await-in-loop
      for await (const chunk of reader) {
        chunks.push(chunk);
      }
      const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
      const content = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.length;
      }
      zipWriter.write(entryPath, content);
      progress.files += 1;
    }
  }
};

/**
 * Check out a readable-tree from the daemon to a local directory or
 * zip archive.
 *
 * @param {object} options
 * @param {string} options.treeName - Pet name of the readable-tree.
 * @param {string} [options.destPath] - Local path to write to.
 * @param {string} [options.agentNames] - Agent to act as.
 * @param {boolean} [options.zip] - Produce a zip archive.
 * @param {boolean} [options.useStdout] - Write zip to stdout.
 */
export const checkout = async ({
  treeName,
  destPath,
  agentNames,
  zip = false,
  useStdout = false,
}) => {
  const parsedName = parsePetNamePath(treeName);

  if (!zip) {
    const resolvedPath = path.resolve(/** @type {string} */ (destPath));

    // Refuse to overwrite existing paths.
    try {
      await fs.promises.access(resolvedPath);
      throw new Error(`${resolvedPath} already exists`);
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') {
        throw e;
      }
    }

    await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
      const tree = await E(agent).lookup(parsedName);
      const progress = { files: 0 };
      const writer = makeTreeWriter(resolvedPath);
      await checkoutTree(tree, writer, {
        onFile: () => {
          progress.files += 1;
        },
      });
      console.log(`  checked out ${progress.files} files`);
    });
  } else {
    const { ZipWriter } = await import('@endo/zip/writer.js');
    await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
      const tree = await E(agent).lookup(parsedName);
      const progress = { files: 0 };
      const zipWriter = new ZipWriter();
      await addTreeToZip(zipWriter, tree, '', progress);
      const zipBytes = zipWriter.snapshot();

      if (useStdout) {
        process.stdout.write(Buffer.from(zipBytes));
      } else {
        const resolvedPath = path.resolve(/** @type {string} */ (destPath));
        await fs.promises.writeFile(resolvedPath, zipBytes);
        console.log(`  checked out ${progress.files} files to ${resolvedPath}`);
      }
    });
  }
};
