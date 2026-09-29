// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  tarEndMarker,
  tarFileHeader,
  tarFilePadding,
} from '@endo/tar/writer.js';

import { makeFileCas } from '../src/cas.js';
import { isRegistryHttpError } from '../src/errors.js';
import {
  defaultArchiveLimits,
  digestTarball,
  ingestTarball,
  verifyTarball,
} from '../src/tarball.js';
import { makeTemporaryDirectory, makeTgz } from './_fixtures.js';

/** @import { ExecutionContext } from 'ava' */
/** @import { ArchiveLimits } from '../src/tarball.js' */

const PACKAGE_JSON = JSON.stringify({ name: 'solo', version: '1.0.0' });

/**
 * @param {Uint8Array} tarball
 * @param {Partial<ArchiveLimits>} [limits]
 */
const ingest = (tarball, limits = {}) =>
  ingestTarball(tarball, {
    cas: makeFileCas(path.join(makeTemporaryDirectory(), 'cas')),
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

test('verifyTarball decides by the strongest listed algorithm for every algorithm set', t => {
  // The algorithm domain is finite, so enumerate it exhaustively: each
  // algorithm is absent, listed with the right digest, or listed with a
  // wrong one, in both listing orders. The verdict is always the
  // correctness of the strongest listed digest, whatever the weaker ones say.
  const algorithms = ['sha1', 'sha256', 'sha384', 'sha512'];
  /** @type {Array<Array<'absent' | 'right' | 'wrong'>>} */
  let assignments = [[]];
  for (const _ of algorithms) {
    assignments = assignments.flatMap(assignment =>
      /** @type {const} */ (['absent', 'right', 'wrong']).map(state => [
        ...assignment,
        state,
      ]),
    );
  }
  let cases = 0;
  for (const assignment of assignments) {
    const entries = algorithms.flatMap((algorithm, index) => {
      if (assignment[index] === 'absent') return [];
      return [
        assignment[index] === 'right' ? sri(algorithm) : wrongSri(algorithm),
      ];
    });
    const strongest = assignment.findLast(state => state !== 'absent');
    // eslint-disable-next-line no-continue
    if (strongest === undefined) continue;
    for (const ordered of [entries, [...entries].reverse()]) {
      t.is(
        verifyTarball(bytes, { integrity: ordered.join(' ') }),
        strongest === 'right',
        ordered.join(' '),
      );
      cases += 1;
    }
  }
  t.is(cases, 2 * (3 ** algorithms.length - 1));
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

/**
 * Build a `.tgz` from raw entries, for entry types `makeTgz` cannot write.
 *
 * @param {Array<{ path: string, type?: string, text?: string, link?: string }>} entries
 * @returns {Uint8Array}
 */
const makeRawTgz = entries => {
  /** @type {Uint8Array[]} */
  const parts = [];
  for (const {
    path: archivePath,
    type = '0',
    text = '',
    link = '',
  } of entries) {
    const content = new TextEncoder().encode(text);
    const header = tarFileHeader(archivePath, content.byteLength);
    header[156] = type.charCodeAt(0);
    header.set(new TextEncoder().encode(link), 157);
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.fill(0, 148, 156);
    header.set(
      new TextEncoder().encode(`${checksum.toString(8).padStart(7, '0')}\0`),
      148,
    );
    parts.push(header, content, tarFilePadding(content.byteLength));
  }
  parts.push(tarEndMarker());
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
};

const manifestEntry = { path: 'package/package.json', text: PACKAGE_JSON };

test('ingestTarball accepts directory entries inside the root', async t => {
  await t.notThrowsAsync(
    ingest(
      makeRawTgz([
        { path: 'package/', type: '5' },
        manifestEntry,
        { path: 'package/lib/', type: '5' },
        { path: 'package/lib/a.js', text: '1' },
      ]),
    ),
  );
});

test('ingestTarball refuses a symbolic link', async t => {
  await refused(
    t,
    ingest(
      makeRawTgz([
        manifestEntry,
        { path: 'package/escape', type: '2', link: '/etc/passwd' },
      ]),
    ),
    400,
    /symbolic link|not a valid archive/,
  );
});

test('ingestTarball refuses hard links, devices, and FIFOs', async t => {
  for (const type of ['1', '3', '4', '6']) {
    // eslint-disable-next-line no-await-in-loop
    await refused(
      t,
      ingest(
        makeRawTgz([
          manifestEntry,
          { path: 'package/special', type, link: 'package/package.json' },
        ]),
      ),
      400,
      /not a valid archive/,
    );
  }
});

test('ingestTarball refuses absolute and dot-dot paths', async t => {
  for (const archivePath of [
    '/package/evil.js',
    'package/../evil.js',
    'package/./../../evil.js',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await refused(
      t,
      ingest(makeRawTgz([manifestEntry, { path: archivePath, text: '1' }])),
      400,
      /not a valid archive|outside/,
    );
  }
});

test('ingestTarball refuses entries outside the single root', async t => {
  await refused(
    t,
    ingest(makeRawTgz([manifestEntry, { path: 'other/a.js', text: '1' }])),
    400,
    /is outside "package"\//,
  );
  await refused(
    t,
    ingest(makeRawTgz([{ path: 'package.json', text: PACKAGE_JSON }])),
    400,
    /is outside "package.json"\//,
  );
});

test('ingestTarball refuses a missing or malformed package.json', async t => {
  await refused(
    t,
    ingest(makeTgz({ 'index.js': '1' })),
    400,
    /no root package.json/,
  );
  await refused(
    t,
    ingest(makeTgz({ 'package.json': '{' })),
    400,
    /package.json is not JSON/,
  );
  for (const text of ['[]', 'null', '1']) {
    // eslint-disable-next-line no-await-in-loop
    await refused(
      t,
      ingest(makeTgz({ 'package.json': text })),
      400,
      /package.json is not an object/,
    );
  }
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
