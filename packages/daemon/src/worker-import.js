// @ts-check
/// <reference types="ses" />

import { E } from '@endo/eventual-send';
import { Fail, q } from '@endo/errors';

/** @import { RegistryResolution } from './registry.js' */

const textEncoder = new TextEncoder();

/**
 * @param {AsyncIterable<Uint8Array> | AsyncIterator<Uint8Array>} reader
 * @returns {Promise<Uint8Array>}
 */
const bytesFromReader = async reader => {
  /** @type {Uint8Array[]} */
  const chunks = [];
  let length = 0;
  const iterable =
    Symbol.asyncIterator in Object(reader)
      ? /** @type {AsyncIterable<Uint8Array>} */ (reader)
      : harden({
          [Symbol.asyncIterator]: () =>
            /** @type {AsyncIterator<Uint8Array>} */ (reader),
        });
  for await (const chunk of iterable) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/**
 * @param {unknown} blob
 * @returns {Promise<Uint8Array | undefined>}
 */
const maybeReadBlobBytes = async blob => {
  if (blob === undefined) {
    return undefined;
  }
  if (typeof blob === 'object' && blob !== null && 'bytes' in blob) {
    const bytes = await E(/** @type {any} */ (blob)).bytes();
    if (bytes instanceof Uint8Array) {
      return bytes;
    }
  }
  if (typeof blob === 'object' && blob !== null && 'text' in blob) {
    const text = await E(/** @type {any} */ (blob)).text();
    return textEncoder.encode(text);
  }
  if (
    typeof blob === 'object' &&
    blob !== null &&
    'getInfo' in blob &&
    'fetch' in blob
  ) {
    const info = await E(/** @type {any} */ (blob)).getInfo();
    const size = BigInt(info.size ?? info.length ?? 0);
    const reader = await E(/** @type {any} */ (blob)).fetch(0n, size);
    return bytesFromReader(/** @type {any} */ (reader));
  }
  return undefined;
};

/**
 * @param {unknown} tree
 * @param {string[]} path
 * @returns {Promise<Uint8Array | undefined>}
 */
const maybeReadTreeBytes = async (tree, path) => {
  const pathName = path.join('/');
  if (typeof tree === 'object' && tree !== null && 'readBytes' in tree) {
    return E(/** @type {any} */ (tree)).readBytes(pathName);
  }
  if (typeof tree === 'object' && tree !== null && 'maybeReadBytes' in tree) {
    return E(/** @type {any} */ (tree)).maybeReadBytes(pathName);
  }
  if (typeof tree === 'object' && tree !== null && 'maybeReadText' in tree) {
    const text = await E(/** @type {any} */ (tree)).maybeReadText(path);
    if (text !== undefined) {
      return textEncoder.encode(text);
    }
  }
  if (typeof tree === 'object' && tree !== null && 'readText' in tree) {
    try {
      const text = await E(/** @type {any} */ (tree)).readText(path);
      return textEncoder.encode(text);
    } catch {
      return undefined;
    }
  }
  if (typeof tree === 'object' && tree !== null && 'lookup' in tree) {
    try {
      const node = await E(/** @type {any} */ (tree)).lookup(path);
      return maybeReadBlobBytes(node);
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/** @param {string} key */
export const packageLocationForKey = key =>
  new URL(`${key}/`, 'file:///').toString();
harden(packageLocationForKey);

/**
 * @param {string} location
 * @param {Set<string>} packageKeys
 */
const parseSnapshotLocation = (location, packageKeys) => {
  const url = new URL(location);
  url.protocol === 'file:' ||
    Fail`Snapshot location must be a file URL: ${q(location)}`;
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent);
  if (segments.length >= 2 && segments[0].startsWith('@')) {
    const key = `${segments[0]}/${segments[1]}`;
    if (packageKeys.has(key)) {
      return harden({ key, path: segments.slice(2) });
    }
  }
  if (segments.length >= 1 && packageKeys.has(segments[0])) {
    return harden({ key: segments[0], path: segments.slice(1) });
  }
  return harden({ key: undefined, path: segments });
};

/**
 * @param {object} args
 * @param {unknown} args.entryMount
 * @param {unknown} [args.registry]
 * @param {RegistryResolution} args.resolution
 */
export const makeMountReadPowers = ({ entryMount, registry, resolution }) => {
  const packagesByKey = new Map(Object.entries(resolution.packagesByKey));
  const packageKeys = new Set(packagesByKey.keys());

  /** @param {string} location */
  const maybeRead = async location => {
    const { key, path } = parseSnapshotLocation(location, packageKeys);
    if (key === undefined) {
      return maybeReadTreeBytes(entryMount, path);
    }
    const record = packagesByKey.get(key);
    if (record === undefined) {
      return undefined;
    }
    if (path.length === 1 && path[0] === 'package.json') {
      return textEncoder.encode(JSON.stringify(record.packageJson));
    }
    let { treeRef } = record;
    if (treeRef === undefined && registry !== undefined && !record.workspace) {
      const split = key.lastIndexOf('@');
      split > 0 || Fail`Cannot infer package name and version from ${q(key)}`;
      const name = key.slice(0, split);
      const version = key.slice(split + 1);
      treeRef = await E(/** @type {any} */ (registry)).fetch(name, version);
      packagesByKey.set(key, harden({ ...record, treeRef }));
    }
    return maybeReadTreeBytes(treeRef, path);
  };

  /** @param {string} location */
  const read = async location => {
    const bytes = await maybeRead(location);
    if (bytes === undefined) {
      throw Error(`Cannot read snapshot location ${q(location)}`);
    }
    return bytes;
  };

  return harden({
    read,
    maybeRead,
    canonical: async location => location,
  });
};
harden(makeMountReadPowers);
