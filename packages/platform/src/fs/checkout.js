// @ts-check
/* eslint-disable no-await-in-loop */

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';

/** @import { TreeWriter, SnapshotTree } from './types.js' */

/**
 * Recursively walk a ReadableTree (local or remote) and materialize
 * it through a TreeWriter.
 *
 * @param {unknown} tree
 * @param {TreeWriter} writer
 * @param {{ onFile?: () => void }} [options]
 */
export const checkoutTree = async (tree, writer, options = {}) => {
  const { onFile } = options;

  /**
   * @param {unknown} node
   * @param {string[]} pathSegments
   * @param {boolean} kindProtocol
   */
  const walk = async (node, pathSegments, kindProtocol) => {
    await writer.makeDirectory(pathSegments);
    const names = await E(/** @type {SnapshotTree} */ (node)).list();
    for (const name of names) {
      /** @type {any} */
      const child = await E(/** @type {SnapshotTree} */ (node)).lookup(name);
      const childPath = [...pathSegments, name];
      let isTree;
      if (kindProtocol) {
        isTree = (await E(child).kind()) === 'directory';
      } else {
        // Older ReadableTree / ReadableBlob capabilities need method
        // introspection to avoid a noisy missing-method send.
        // eslint-disable-next-line no-underscore-dangle
        const methods = await E(child).__getMethodNames__();
        isTree = methods.includes('kind')
          ? (await E(child).kind()) === 'directory'
          : methods.includes('list');
      }
      if (isTree) {
        await walk(child, childPath, kindProtocol);
      } else {
        // It's a readable-blob. Stream its content through the writer.
        const readable = iterateBytesReader(/** @type {any} */ (child));
        await writer.writeBlob(childPath, readable);
        if (onFile) onFile();
      }
    }
  };

  // Discover the mount protocol once. Its descendants all implement the
  // same discriminator, while older capabilities retain the fallback above.
  // eslint-disable-next-line no-underscore-dangle
  const rootMethods = await E(
    /** @type {{ __getMethodNames__: () => Promise<string[]> }} */ (tree),
  ).__getMethodNames__();
  await walk(tree, [], rootMethods.includes('kind'));
};
harden(checkoutTree);
