// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { makeFileCas } from '../src/cas.js';
import { isRegistryHttpError } from '../src/errors.js';
import {
  defaultArchiveLimits,
  digestTarball,
  ingestTarball,
  verifyTarball,
} from '../src/tarball.js';
import { makeTempDir, makeTgz } from './_fixtures.js';

/** @import { ExecutionContext } from 'ava' */
/** @import { ArchiveLimits } from '../src/tarball.js' */

const PACKAGE_JSON = JSON.stringify({ name: 'solo', version: '1.0.0' });

/**
 * @param {Uint8Array} tarball
 * @param {Partial<ArchiveLimits>} [limits]
 */
const ingest = (tarball, limits = {}) =>
  ingestTarball(tarball, {
    cas: makeFileCas(path.join(makeTempDir(), 'cas')),
    limits: { ...defaultArchiveLimits, ...limits },
  });

/**
 * @param {ExecutionContext} t
 * @param {Promise<unknown>} promise
 * @param {number} statusCode
 * @param {RegExp} message
 */
const refused = async (t, promise, statusCode, message) => {
  const error = await t.throwsAsync(promise, { message });
  t.true(isRegistryHttpError(error));
  t.is(/** @type {any} */ (error).statusCode, statusCode);
};

const bytes = new TextEncoder().encode('tarball bytes');
/** @param {string} algorithm */
const sri = algorithm =>
  `${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}`;
/** @param {string} algorithm */
const wrongSri = algorithm =>
  `${algorithm}-${createHash(algorithm).update('other').digest('base64')}`;

test('verifyTarball accepts the digests digestTarball computes', t => {
  const digests = digestTarball(bytes);
  t.true(verifyTarball(bytes, digests));
  t.true(verifyTarball(bytes, { shasum: digests.shasum }));
  t.false(verifyTarball(new Uint8Array([1]), digests));
});

test('verifyTarball compares only the strongest listed algorithm', t => {
  t.true(
    verifyTarball(bytes, { integrity: `${wrongSri('sha1')} ${sri('sha512')}` }),
  );
  t.false(
    verifyTarball(bytes, { integrity: `${sri('sha1')} ${wrongSri('sha512')}` }),
  );
  t.false(
    verifyTarball(bytes, {
      integrity: `${sri('sha256')} ${wrongSri('sha384')}`,
    }),
  );
  t.true(verifyTarball(bytes, { integrity: `${sri('sha512')}?opt` }));
});

test('verifyTarball refuses absent, malformed, and unknown digests', t => {
  t.false(verifyTarball(bytes, {}));
  t.false(verifyTarball(bytes, { integrity: '', shasum: '' }));
  t.false(verifyTarball(bytes, { shasum: 'not-hex' }));
  t.false(
    verifyTarball(bytes, { integrity: `sha999-${sri('sha512').slice(7)}` }),
  );
  t.false(verifyTarball(bytes, { integrity: `${sri('sha512')}junk!` }));
  t.false(
    verifyTarball(bytes, {
      integrity: `sha512-${Buffer.from(new Uint8Array(64)).toString('base64')}`,
    }),
  );
});

test('ingestTarball enforces the compressed size limit at its boundary', async t => {
  const tarball = makeTgz({ 'package.json': PACKAGE_JSON });
  await t.notThrowsAsync(
    ingest(tarball, { maxTarballBytes: tarball.byteLength }),
  );
  await refused(
    t,
    ingest(tarball, { maxTarballBytes: tarball.byteLength - 1 }),
    413,
    /compressed size limit/,
  );
});

test('ingestTarball enforces the entry-count limit at its boundary', async t => {
  const tarball = makeTgz({
    'package.json': PACKAGE_JSON,
    'a.js': '',
    'b.js': '',
  });
  await t.notThrowsAsync(ingest(tarball, { maxEntries: 3 }));
  await refused(
    t,
    ingest(tarball, { maxEntries: 2 }),
    400,
    /entry-count limit/,
  );
});

test('ingestTarball enforces the entry path length at its boundary', async t => {
  const tarball = makeTgz({ 'package.json': PACKAGE_JSON, 'abc.js': '' });
  const longest = 'package/package.json'.length;
  await t.notThrowsAsync(ingest(tarball, { maxPathLength: longest }));
  await refused(
    t,
    ingest(tarball, { maxPathLength: longest - 1 }),
    400,
    /path too long/,
  );
});

test('ingestTarball enforces the expanded size limit', async t => {
  const tarball = makeTgz({
    'package.json': PACKAGE_JSON,
    'big.txt': 'x'.repeat(100_000),
  });
  await refused(
    t,
    ingest(tarball, { maxUnpackedBytes: 10_000 }),
    400,
    /expanded size limit/,
  );
});

test('ingestTarball refuses a duplicated path', async t => {
  const tarball = makeTgz({
    'package.json': PACKAGE_JSON,
    '!package/./package.json': PACKAGE_JSON,
  });
  await refused(t, ingest(tarball), 400, /duplicated|not a valid archive/);
});

test('an identical archive always produces the same tree hash', async t => {
  const tarball = makeTgz({
    'package.json': PACKAGE_JSON,
    'a.js': '1',
    'b.js': '2',
  });
  const reordered = makeTgz({
    'b.js': '2',
    'package.json': PACKAGE_JSON,
    'a.js': '1',
  });
  const first = await ingest(tarball);
  const second = await ingest(reordered);
  t.is(first.treeHash, second.treeHash);
  t.not(first.tarballHash, second.tarballHash);
});
