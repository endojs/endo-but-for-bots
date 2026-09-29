// @ts-check

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { q } from '@endo/errors';
import { readTarEntries, tarPathSegments } from '@endo/tar/reader.js';
import { RegistryHttpError, isRegistryHttpError } from './errors.js';

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

/** Hash algorithms accepted in an integrity string, weakest first. */
const SRI_ALGORITHMS = harden(['sha1', 'sha256', 'sha384', 'sha512']);
const SRI_ENTRY =
  /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+={0,2})(?:\?\S*)?$/u;

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
 * Whether bytes satisfy an SRI string or, lacking one, a legacy SHA-1
 * `shasum`. Only the hashes of the strongest listed algorithm are compared,
 * so a matching weak hash cannot vouch for a mismatched strong one.
 *
 * This follows npm's `ssri`, not W3C SRI: `sha1` is ranked (lowest), and an
 * integrity string with no usable entry fails closed. W3C SRI does not
 * recognize `sha1` and treats metadata that does not parse as a match
 * ("Do bytes match metadataList", step 3), which is the wrong default for
 * a registry.
 *
 * @param {Uint8Array} bytes
 * @param {{ integrity?: string, shasum?: string }} expected
 * @returns {boolean}
 */
export const verifyTarball = (bytes, { integrity, shasum }) => {
  if (typeof integrity === 'string' && integrity.length > 0) {
    const matches = integrity
      .split(/\s+/u)
      .map(entry => SRI_ENTRY.exec(entry))
      .filter(match => match !== null);
    // A reduce, not a spread into `Math.max`: the entry count comes from
    // upstream metadata, and engines bound the arguments of a spread call.
    const strongest = matches.reduce(
      (best, match) => Math.max(best, SRI_ALGORITHMS.indexOf(match[1])),
      -1,
    );
    return matches.some(
      match =>
        SRI_ALGORITHMS.indexOf(match[1]) === strongest &&
        createHash(match[1]).update(bytes).digest('base64') === match[2],
    );
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
 * @property {readonly string[]} paths The file paths in the tree, relative
 *   to the archive's root directory.
 */

/**
 * Retain an npm tarball byte-for-byte and extract its immutable package
 * tree into the CAS.
 *
 * npm archives hold one top-level directory (`package/` for packed
 * tarballs, occasionally another name); the tree is rooted inside it. The
 * extraction is pure data parsing: no entry is written to a real path and
 * no lifecycle script runs. Absolute paths, `.`/`..` segments, duplicate
 * paths, entries outside the single root, symbolic links, hard links, and
 * every other non-file/non-directory entry type are refused.
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

  /** @type {Map<string, Uint8Array>} */
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
      files.set(relative, bytes);
    }
  } catch (error) {
    if (isRegistryHttpError(error)) {
      throw error;
    }
    throw refuse(
      `Tarball is not a valid archive: ${/** @type {Error} */ (error).message}`,
    );
  }

  const manifestBytes = files.get('package.json');
  if (!manifestBytes) {
    throw refuse('Tarball has no root package.json');
  }
  const manifestText = new TextDecoder().decode(manifestBytes);
  /** @type {Record<string, any>} */
  let packageJson;
  try {
    packageJson = JSON.parse(manifestText);
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

  // Storage failures past this point are the server's, not the archive's,
  // so they propagate as internal errors rather than as a refusal.
  const entries = [...files.entries()]
    .map(
      ([path, bytes]) =>
        /** @type {[string, number, string]} */ ([
          path,
          bytes.byteLength,
          cas.put(bytes),
        ]),
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const treeHash = cas.put(
    new TextEncoder().encode(
      JSON.stringify({ type: 'npm-package-tree/v1', entries }),
    ),
  );
  const tarballHash = cas.put(tarball);
  return harden({
    tarballHash,
    treeHash,
    packageJson,
    paths: [...files.keys()],
  });
};
harden(ingestTarball);
