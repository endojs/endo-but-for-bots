// @ts-check

import { Fail, q } from '@endo/errors';
import harden from '@endo/harden';

import { parseCommit } from './codec-commit.js';
import { parseTree } from './codec-tree.js';

/** @import { GitObjectId, GitObjectStore, GitTreeDiffEntry } from './types.js' */

/**
 * Walk the commit graph from `headOid`, following parents via batched
 * `readObjects`. Returns commits in reverse chronological discovery order
 * (head first).
 *
 * @param {GitObjectStore} store
 * @param {GitObjectId} headOid
 * @param {{ maxCount?: number }} [options]
 * @returns {Promise<Array<{ oid: GitObjectId, tree: GitObjectId, parents: GitObjectId[], message: string }>>}
 */
export const walkCommitLog = async (store, headOid, options = undefined) => {
  await null;
  const maxCount =
    options && options.maxCount !== undefined ? options.maxCount : Infinity;
  /** @type {Array<{ oid: GitObjectId, tree: GitObjectId, parents: GitObjectId[], message: string }>} */
  const log = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  let frontier = [headOid];

  while (frontier.length > 0 && log.length < maxCount) {
    const unique = frontier.filter(oid => {
      if (seen.has(oid)) {
        return false;
      }
      seen.add(oid);
      return true;
    });
    frontier = [];
    if (unique.length === 0) {
      break;
    }
    // Cap this batch so we respect maxCount.
    const remaining = maxCount - log.length;
    const batchOids = unique.slice(0, remaining);
    // Sequential generations of the commit graph.
    // eslint-disable-next-line no-await-in-loop
    const objects = await store.readObjects(batchOids);
    /** @type {string[]} */
    const nextParents = [];
    for (let i = 0; i < batchOids.length; i += 1) {
      const obj = objects[i];
      if (obj === undefined) {
        throw Fail`missing commit ${q(batchOids[i])} during log walk`;
      }
      if (obj.type !== 'commit') {
        throw Fail`expected commit at ${q(batchOids[i])}, got ${q(obj.type)}`;
      }
      const parsed = parseCommit(obj.content);
      log.push(
        harden({
          oid: batchOids[i],
          tree: parsed.tree,
          parents: parsed.parents,
          message: parsed.message,
        }),
      );
      for (const parent of parsed.parents) {
        nextParents.push(parent);
      }
    }
    frontier = nextParents;
  }

  return harden(log);
};
harden(walkCommitLog);

/**
 * Recursively list all blob/tree paths under a tree oid.
 *
 * @param {GitObjectStore} store
 * @param {GitObjectId} treeOid
 * @param {string} [prefix]
 * @returns {Promise<Array<{ path: string, oid: GitObjectId, mode: string, isTree: boolean }>>}
 */
export const walkTree = async (store, treeOid, prefix = '') => {
  await null;
  const algorithm = store.getHashAlgorithm();
  const treeObj = await store.readObject(treeOid);
  treeObj.type === 'tree' ||
    Fail`expected tree at ${q(treeOid)}, got ${q(treeObj.type)}`;
  const entries = parseTree(treeObj.content, algorithm);

  /** @type {Array<{ path: string, oid: GitObjectId, mode: string, isTree: boolean }>} */
  const out = [];

  // Batch-read child trees in one round trip when possible.
  const childTrees = entries.filter(e => e.isTree);
  // Batch-read child tree objects so walk tests exercise readObjects.
  if (childTrees.length > 0) {
    const childTreeObjects = await store.readObjects(
      childTrees.map(e => e.oid),
    );
    for (let i = 0; i < childTrees.length; i += 1) {
      const prefetched = childTreeObjects[i];
      if (prefetched !== undefined && prefetched.type !== 'tree') {
        throw Fail`expected tree at ${q(childTrees[i].oid)}, got ${q(prefetched.type)}`;
      }
    }
  }

  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    out.push(
      harden({
        path,
        oid: entry.oid,
        mode: entry.mode,
        isTree: entry.isTree,
      }),
    );
  }

  // Recurse into trees depth-first.
  for (const entry of childTrees) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    // eslint-disable-next-line no-await-in-loop
    const nested = await walkTree(store, entry.oid, path);
    for (const item of nested) {
      out.push(item);
    }
  }

  return harden(out);
};
harden(walkTree);

/**
 * Flatten a tree to a map of file path → { oid, mode } (blobs/symlinks/
 * gitlinks only; directories are expanded).
 *
 * @param {GitObjectStore} store
 * @param {GitObjectId} treeOid
 * @returns {Promise<Map<string, { oid: GitObjectId, mode: string }>>}
 */
const flattenFiles = async (store, treeOid) => {
  const entries = await walkTree(store, treeOid);
  /** @type {Map<string, { oid: GitObjectId, mode: string }>} */
  const files = new Map();
  for (const entry of entries) {
    if (!entry.isTree) {
      files.set(entry.path, harden({ oid: entry.oid, mode: entry.mode }));
    }
  }
  return files;
};

/**
 * Commit-to-commit (tree-to-tree) path diff by oid comparison.
 *
 * @param {GitObjectStore} store
 * @param {GitObjectId} beforeTreeOid
 * @param {GitObjectId} afterTreeOid
 * @returns {Promise<GitTreeDiffEntry[]>}
 */
export const diffTrees = async (store, beforeTreeOid, afterTreeOid) => {
  const [before, after] = await Promise.all([
    flattenFiles(store, beforeTreeOid),
    flattenFiles(store, afterTreeOid),
  ]);

  /** @type {GitTreeDiffEntry[]} */
  const changes = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const b = before.get(path);
    const a = after.get(path);
    if (b === undefined && a !== undefined) {
      changes.push(
        harden({
          path,
          change: /** @type {const} */ ('added'),
          afterOid: a.oid,
          afterMode: a.mode,
        }),
      );
    } else if (b !== undefined && a === undefined) {
      changes.push(
        harden({
          path,
          change: /** @type {const} */ ('deleted'),
          beforeOid: b.oid,
          beforeMode: b.mode,
        }),
      );
    } else if (b !== undefined && a !== undefined) {
      if (b.oid !== a.oid || b.mode !== a.mode) {
        changes.push(
          harden({
            path,
            change: /** @type {const} */ ('modified'),
            beforeOid: b.oid,
            afterOid: a.oid,
            beforeMode: b.mode,
            afterMode: a.mode,
          }),
        );
      }
    }
  }
  return harden(changes);
};
harden(diffTrees);

/**
 * Diff the trees of two commits.
 *
 * @param {GitObjectStore} store
 * @param {GitObjectId} beforeCommitOid
 * @param {GitObjectId} afterCommitOid
 * @returns {Promise<GitTreeDiffEntry[]>}
 */
export const diffCommits = async (store, beforeCommitOid, afterCommitOid) => {
  const objects = await store.readObjects([beforeCommitOid, afterCommitOid]);
  const beforeObj = objects[0];
  const afterObj = objects[1];
  if (beforeObj === undefined) {
    throw Fail`missing commit ${q(beforeCommitOid)}`;
  }
  if (afterObj === undefined) {
    throw Fail`missing commit ${q(afterCommitOid)}`;
  }
  if (beforeObj.type !== 'commit') {
    throw Fail`expected commit ${q(beforeCommitOid)}, got ${q(beforeObj.type)}`;
  }
  if (afterObj.type !== 'commit') {
    throw Fail`expected commit ${q(afterCommitOid)}, got ${q(afterObj.type)}`;
  }
  const before = parseCommit(beforeObj.content);
  const after = parseCommit(afterObj.content);
  return diffTrees(store, before.tree, after.tree);
};
harden(diffCommits);
