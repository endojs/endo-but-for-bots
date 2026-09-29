// @ts-check

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { q } from '@endo/errors';
import { readTarEntries, tarPathSegments } from '@endo/tar/reader.js';
import { RegistryHttpError } from './errors.js';

/** @import { FileCas } from './cas.js' */

/**
 * @typedef {object} ArchiveLimits
 * @property {number} maxTarballBytes Compressed archive ceiling.
 * @property {number} maxUnpackedBytes Expanded archive ceiling.
 * @property {number} maxEntries Entry-count ceiling.
 * @property {number} maxPathLength Per-entry path length ceiling.
 */

/** @type {ArchiveLimits} */
export const defaultArchiveLimits = harden({
  maxTarballBytes: 32 * 1024 * 1024,
  maxUnpackedBytes: 256 * 1024 * 1024,
  maxEntries: 20_000,
  maxPathLength: 1024,
});

/**
 * @typedef {object} Digests
 * @property {string} integrity SHA-512 subresource-integrity string.
 * @property {string} shasum SHA-1 hex, npm's legacy `dist.shasum`.
 */

/**
 * Compute the digests npm clients check, from the bytes the server holds
 * rather than any client-supplied field.
 *
 * @param {Uint8Array} bytes
 * @returns {Digests}
 */
export const digestTarball = bytes => ({
  integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  shasum: createHash('sha1').update(bytes).digest('hex'),
});
harden(digestTarball);

/**
 * Whether bytes satisfy an SRI string (any listed sha512/sha384/sha256/sha1
 * hash matching suffices, as in npm's own check) or, lacking one, a legacy
 * SHA-1 `shasum`.
 *
 * @param {Uint8Array} bytes
 * @param {{ integrity?: string, shasum?: string }} expected
 * @returns {boolean}
 */
export const verifyTarball = (bytes, { integrity, shasum }) => {
  if (typeof integrity === 'string' && integrity.length > 0) {
    return integrity.split(/\s+/u).some(entry => {
      const match = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/=]+)/u.exec(
        entry,
      );
      return (
        match !== null &&
        createHash(match[1]).update(bytes).digest('base64') === match[2]
      );
    });
  }
  if (typeof shasum === 'string' && /^[0-9a-f]{40}$/u.test(shasum)) {
    return createHash('sha1').update(bytes).digest('hex') === shasum;
  }
  return false;
};
harden(verifyTarball);

/**
 * @typedef {object} IngestedTarball
 * @property {string} tarballHash sha256 of the exact `.tgz` blob.
 * @property {string} treeHash sha256 of the tree manifest blob.
 * @property {Record<string, any>} packageJson The archive's root package.json.
 */

/**
 * Retain an npm tarball byte-for-byte and extract its immutable package
 * tree into the CAS.
 *
 * npm archives hold one top-level directory (`package/` for packed
 * tarballs, occasionally another name); the tree is rooted inside it. The
 * extraction is pure data parsing: no entry is written to a real path and
 * no lifecycle script runs. Absolute paths, `.`/`..` segments, duplicate
 * paths, entries outside the single root, symbolic links, and every
 * non-file/non-directory entry type are refused.
 *
 * The tree manifest is canonical JSON, `{ type, entries }` with entries
 * sorted by path as `[path, size, sha256]`, stored as its own blob so an
 * identical archive always produces the same tree hash.
 *
 * @param {Uint8Array} tarball
 * @param {object} options
 * @param {FileCas} options.cas
 * @param {ArchiveLimits} [options.limits]
 * @returns {Promise<IngestedTarball>}
 */
export const ingestTarball = async (
  tarball,
  { cas, limits = defaultArchiveLimits },
) => {
  if (tarball.byteLength > limits.maxTarballBytes) {
    throw RegistryHttpError(413, 'Tarball exceeds the compressed size limit');
  }
  /** @type {Uint8Array} */
  let tar;
  try {
    tar = new Uint8Array(
      gunzipSync(tarball, { maxOutputLength: limits.maxUnpackedBytes }),
    );
  } catch (error) {
    throw RegistryHttpError(
      400,
      `Tarball is not a gzip archive within the expanded size limit: ${/** @type {Error} */ (error).message}`,
    );
  }

  /** @type {Map<string, [string, number, string]>} */
  const files = new Map();
  /** @type {string | undefined} */
  let root;
  let entryCount = 0;

  /** @param {string} reason */
  const refuse = reason => RegistryHttpError(400, reason);

  try {
    for await (const entry of readTarEntries(
      (async function* source() {
        yield tar;
      })(),
    )) {
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        throw refuse('Tarball exceeds the entry-count limit');
      }
      if (entry.path.length > limits.maxPathLength) {
        throw refuse(`Tarball entry path too long ${q(entry.path)}`);
      }
      /** @type {Uint8Array[]} */
      const chunks = [];
      for await (const chunk of entry.content) {
        chunks.push(chunk);
      }
      if (entry.type === 'symlink') {
        throw refuse(`Tarball entry ${q(entry.path)} is a symbolic link`);
      }
      const segments = tarPathSegments(entry.path);
      if (root === undefined) {
        root = segments[0];
      } else if (segments[0] !== root) {
        throw refuse(`Tarball entry ${q(entry.path)} is outside ${q(root)}/`);
      }
      if (entry.type === 'directory') {
        // eslint-disable-next-line no-continue
        continue;
      }
      if (segments.length < 2) {
        throw refuse(`Tarball entry ${q(entry.path)} is outside ${q(root)}/`);
      }
      const relative = segments.slice(1).join('/');
      if (files.has(relative)) {
        throw refuse(`Tarball entry ${q(relative)} is duplicated`);
      }
      const bytes = new Uint8Array(entry.size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      files.set(relative, [relative, entry.size, cas.put(bytes)]);
    }
  } catch (error) {
    if (/** @type {any} */ (error).statusCode) {
      throw error;
    }
    throw refuse(
      `Tarball is not a valid archive: ${/** @type {Error} */ (error).message}`,
    );
  }

  const manifestEntry = files.get('package.json');
  if (!manifestEntry) {
    throw refuse('Tarball has no root package.json');
  }
  /** @type {Record<string, any>} */
  let packageJson;
  try {
    packageJson = JSON.parse(
      new TextDecoder().decode(cas.get(manifestEntry[2])),
    );
  } catch {
    throw refuse('Tarball package.json is not JSON');
  }
  if (
    typeof packageJson !== 'object' ||
    packageJson === null ||
    Array.isArray(packageJson)
  ) {
    throw refuse('Tarball package.json is not an object');
  }

  const entries = [...files.values()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const treeHash = cas.put(
    new TextEncoder().encode(
      JSON.stringify({ type: 'npm-package-tree/v1', entries }),
    ),
  );
  const tarballHash = cas.put(tarball);
  return harden({ tarballHash, treeHash, packageJson });
};
harden(ingestTarball);
