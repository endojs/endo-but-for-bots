// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import path from 'node:path';
import Database from 'better-sqlite3';

import { makePublishDocument, makeTestRegistry, makeTgz } from './_fixtures.js';
import { defaultArchiveLimits, digestTarball } from '../src/tarball.js';
import { isRegistryHttpError } from '../src/errors.js';

/** @import { UpstreamFetch } from '../src/node-fetch.js' */

const V1 = '1.7.0-dev.20260928101010.gaaaaaaa';
const V2 = '1.7.0-dev.20260928231903.g3aa902d';

test('publish records version, tarball, tree, and date tag atomically', async t => {
  const { registry, grant, cas, store } = makeTestRegistry();
  const document = makePublishDocument({ name: '@endo/patterns', version: V1 });
  const result = await registry.publish(grant, '@endo/patterns', document);
  t.like(result, { version: V1, tag: 'dev-2026-09-28', created: true });

  const packument = await registry.getPackument('@endo/patterns');
  t.deepEqual(packument['dist-tags'], { 'dev-2026-09-28': V1 });
  const { dist } = packument.versions[V1];
  t.is(
    dist.tarball,
    `https://npm.example/@endo%2fpatterns/-/patterns-${V1}.tgz`,
  );
  const tarball = await registry.getTarball(
    '@endo/patterns',
    `patterns-${V1}.tgz`,
  );
  t.is(dist.integrity, digestTarball(tarball.bytes).integrity);
  const row = store.statements.getPackage.get('@endo/patterns', V1);
  t.true(cas.has(row.tree_hash));
  const tree = JSON.parse(new TextDecoder().decode(cas.get(row.tree_hash)));
  t.deepEqual(
    tree.entries.map(([p]) => p),
    ['index.js', 'package.json'],
  );
  t.deepEqual(registry.verifyStore(), []);
});

test('an identical retry is a no-op and different bytes conflict', async t => {
  const { registry, grant } = makeTestRegistry();
  const document = makePublishDocument({ name: '@endo/errors', version: V1 });
  await registry.publish(grant, '@endo/errors', document);
  t.like(await registry.publish(grant, '@endo/errors', document), {
    created: false,
  });
  const changed = makePublishDocument({
    name: '@endo/errors',
    version: V1,
    extraFiles: { 'extra.js': '1' },
  });
  await t.throwsAsync(registry.publish(grant, '@endo/errors', changed), {
    message: /different content/,
  });
});

test('a token rotated after authentication cannot finish a publish', async t => {
  const { registry, grants, grant } = makeTestRegistry();
  grants.putGrant({
    id: 'test-grant',
    subject: 'garden-llm-publisher',
    packages: ['@endo/*', 'solo'],
    expiresAt: Date.now() + 3_600_000,
    token: 'y'.repeat(40),
  });
  const document = makePublishDocument({ name: '@endo/errors', version: V1 });
  await t.throwsAsync(registry.publish(grant, '@endo/errors', document), {
    message: /no longer live/,
  });
});

test('a forged grant record is not a credential', async t => {
  const { registry, grant } = makeTestRegistry();
  if (!grant) throw Error('the fixture grant authenticates');
  const forged = harden({ ...grant, subject: 'someone-else' });
  const document = makePublishDocument({ name: '@endo/errors', version: V1 });
  await t.throwsAsync(registry.publish(forged, '@endo/errors', document), {
    message: /no longer live/,
  });
});

test('date tags advance monotonically', async t => {
  const { registry, grant } = makeTestRegistry();
  await registry.publish(
    grant,
    '@endo/errors',
    makePublishDocument({ name: '@endo/errors', version: V2 }),
  );
  await t.throwsAsync(
    registry.publish(
      grant,
      '@endo/errors',
      makePublishDocument({ name: '@endo/errors', version: V1 }),
    ),
    { message: /newer/ },
  );
  t.deepEqual(registry.setDistTag(grant, '@endo/errors', 'dev-latest', V2), {
    'dev-latest': V2,
  });
});

test('publish refuses production tags, releases, and foreign packages', async t => {
  const { registry, grant } = makeTestRegistry();
  /** @type {Array<[string, any, RegExp]>} */
  const cases = [
    [
      '@endo/errors',
      makePublishDocument({ name: '@endo/errors', version: V1, tag: 'latest' }),
      /exactly the tag "dev-2026-09-28"/,
    ],
    [
      '@endo/errors',
      makePublishDocument({
        name: '@endo/errors',
        version: '1.7.0',
        tag: 'dev-2026-09-28',
      }),
      /not a development coordinate/,
    ],
    [
      '@endo/errors',
      makePublishDocument({
        name: '@endo/errors',
        version: V1,
        tag: 'dev-2026-09-27',
      }),
      /exactly the tag/,
    ],
    [
      'left-pad',
      makePublishDocument({ name: 'left-pad', version: V1 }),
      /does not cover/,
    ],
    [
      '@endo/errors',
      makePublishDocument({
        name: '@endo/errors',
        version: V1,
        extraFiles: { '!package/../escape.js': 'x' },
      }),
      /Invalid tar entry path segment/,
    ],
    [
      '@endo/errors',
      makePublishDocument({
        name: '@endo/errors',
        version: V1,
        extraFiles: { '!other/escape.js': 'x' },
      }),
      /outside/,
    ],
  ];
  for (const [name, document, message] of cases) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(registry.publish(grant, name, document), { message });
  }
  await t.throwsAsync(registry.getPackument('@endo/errors'), {
    message: /not found/,
  });
  t.throws(() => registry.setDistTag(grant, '@endo/errors', 'latest', V1), {
    message: /not a writable/,
  });
  await t.throwsAsync(
    registry.publish(
      undefined,
      '@endo/errors',
      makePublishDocument({ name: '@endo/errors', version: V1 }),
    ),
    { message: /Authentication required/ },
  );
});

test('publish refuses a manifest whose dependencies differ from the tarball', async t => {
  const { registry, grant } = makeTestRegistry();
  const document = makePublishDocument({
    name: '@endo/errors',
    version: V1,
    dependencies: { ses: '^1.0.0' },
  });
  document.versions[V1].dependencies = { ses: '^2.0.0' };
  await t.throwsAsync(registry.publish(grant, '@endo/errors', document), {
    message: /dependencies differ/,
  });
});

test('upstream read-through rewrites URLs, verifies, and serves stale on error', async t => {
  const tgz = makeTgz({
    'package.json': JSON.stringify({ name: 'left-pad', version: '1.3.0' }),
  });
  const { integrity, shasum } = digestTarball(tgz);
  let online = true;
  const requests = [];
  /** @type {UpstreamFetch} */
  const fakeFetch = async (url, init) => {
    requests.push(String(url));
    if (!online) throw TypeError('fetch failed');
    if (String(url) === 'https://upstream.example/left-pad') {
      return new Response(
        JSON.stringify({
          name: 'left-pad',
          'dist-tags': { latest: '1.3.0', 'dev-2026-09-28': '1.3.0' },
          versions: {
            '1.3.0': {
              name: 'left-pad',
              version: '1.3.0',
              dist: {
                tarball: 'https://evil.example/left-pad.tgz',
                integrity,
                shasum,
              },
            },
          },
        }),
        { status: 200, headers: { etag: '"e1"' } },
      );
    }
    if (
      String(url) === 'https://upstream.example/left-pad/-/left-pad-1.3.0.tgz'
    ) {
      return new Response(/** @type {any} */ (tgz), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  const { registry } = makeTestRegistry({
    upstreamOrigin: 'https://upstream.example',
    fetch: fakeFetch,
    upstreamTtlMs: 0,
  });
  const packument = await registry.getPackument('left-pad', {
    abbreviated: true,
  });
  t.is(
    packument.versions['1.3.0'].dist.tarball,
    'https://npm.example/left-pad/-/left-pad-1.3.0.tgz',
  );
  const served = await registry.getTarball('left-pad', 'left-pad-1.3.0.tgz');
  t.deepEqual(served.bytes, tgz);
  t.false(requests.some(url => url.includes('evil')));

  online = false;
  // Metadata is stale (TTL 0) and upstream is down: the cached rows serve.
  const offline = await registry.getPackument('left-pad');
  t.deepEqual(Object.keys(offline.versions), ['1.3.0']);
  const again = await registry.getTarball('left-pad', 'left-pad-1.3.0.tgz');
  t.deepEqual(again.bytes, tgz);
  await t.throwsAsync(registry.getPackument('never-seen'), {
    message: /unavailable/,
  });
});

test('upstream bytes that fail integrity are never stored', async t => {
  const tgz = makeTgz({
    'package.json': JSON.stringify({ name: 'bad', version: '1.0.0' }),
  });
  const { integrity } = digestTarball(makeTgz({ 'package.json': '{}' }));
  const { registry } = makeTestRegistry({
    upstreamOrigin: 'https://upstream.example',
    fetch: async url =>
      String(url).endsWith('.tgz')
        ? new Response(/** @type {any} */ (tgz))
        : new Response(
            JSON.stringify({
              name: 'bad',
              'dist-tags': { latest: '1.0.0' },
              versions: {
                '1.0.0': { name: 'bad', version: '1.0.0', dist: { integrity } },
              },
            }),
          ),
  });
  await t.throwsAsync(registry.getTarball('bad', 'bad-1.0.0.tgz'), {
    message: /integrity/,
  });
});

test('local published tags are not replaced by upstream metadata', async t => {
  const tgz = makeTgz({
    'package.json': JSON.stringify({ name: '@endo/errors', version: '1.2.0' }),
  });
  const { integrity } = digestTarball(tgz);
  const { registry, grant } = makeTestRegistry({
    upstreamOrigin: 'https://upstream.example',
    upstreamTtlMs: 0,
    fetch: async () =>
      new Response(
        JSON.stringify({
          name: '@endo/errors',
          'dist-tags': { latest: '1.2.0', 'dev-2026-09-28': '1.2.0' },
          versions: {
            '1.2.0': {
              name: '@endo/errors',
              version: '1.2.0',
              dist: { integrity },
            },
          },
        }),
      ),
  });
  await registry.publish(
    grant,
    '@endo/errors',
    makePublishDocument({ name: '@endo/errors', version: V1 }),
  );
  const packument = await registry.getPackument('@endo/errors');
  t.deepEqual(packument['dist-tags'], {
    latest: '1.2.0',
    'dev-2026-09-28': V1,
  });
  t.deepEqual(Object.keys(packument.versions).sort(), ['1.2.0', V1].sort());
});

test('an upstream body interrupted mid-read is a 502, not an internal error', async t => {
  /** @type {UpstreamFetch} */
  const fakeFetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: {
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode('{"name":');
        throw Error('read ECONNRESET');
      },
    },
  });
  const { registry } = makeTestRegistry({
    upstreamOrigin: 'https://upstream.example',
    fetch: fakeFetch,
    upstreamTtlMs: 0,
  });
  const error = await t.throwsAsync(() => registry.getPackument('left-pad'));
  t.true(isRegistryHttpError(error));
  t.is(/** @type {any} */ (error).statusCode, 502);
});

test('upstream metadata cannot plant development versions or dev-* tags', async t => {
  const tgz = makeTgz({
    'package.json': JSON.stringify({ name: '@endo/errors', version: '1.0.0' }),
  });
  const { integrity } = digestTarball(tgz);
  const { registry, grant } = makeTestRegistry({
    upstreamOrigin: 'https://upstream.example',
    fetch: async () =>
      new Response(
        JSON.stringify({
          name: '@endo/errors',
          'dist-tags': {
            latest: '1.0.0',
            'dev-2026-09-28': '1.0.0',
            'dev-latest': V1,
            // Prototype method names are ordinary tag names, and must
            // neither throw under lockdown nor vanish from the packument.
            constructor: '1.0.0',
            hasOwnProperty: '1.0.0',
          },
          versions: {
            '1.0.0': {
              name: '@endo/errors',
              version: '1.0.0',
              dist: { integrity },
            },
            [V1]: { name: '@endo/errors', version: V1, dist: { integrity } },
          },
        }),
      ),
  });
  const packument = await registry.getPackument('@endo/errors');
  t.deepEqual(Object.keys(packument.versions), ['1.0.0']);
  t.deepEqual(packument['dist-tags'], {
    latest: '1.0.0',
    constructor: '1.0.0',
    hasOwnProperty: '1.0.0',
  });
  t.deepEqual(
    await registry.getDistTags('@endo/errors'),
    packument['dist-tags'],
  );
  const result = await registry.publish(
    grant,
    '@endo/errors',
    makePublishDocument({ name: '@endo/errors', version: V1 }),
  );
  t.true(result.created);
});

test('upstream tags cannot target a local dev build or shadow a version', async t => {
  const tgz = makeTgz({
    'package.json': JSON.stringify({ name: '@endo/errors', version: '1.0.0' }),
  });
  const { integrity } = digestTarball(tgz);
  const { registry, grant } = makeTestRegistry({
    upstreamOrigin: 'https://upstream.example',
    fetch: async () =>
      new Response(
        JSON.stringify({
          name: '@endo/errors',
          'dist-tags': { latest: V1, '2.0.0': '1.0.0', stable: '1.0.0' },
          versions: {
            '1.0.0': {
              name: '@endo/errors',
              version: '1.0.0',
              dist: { integrity },
            },
          },
        }),
      ),
  });
  await registry.publish(
    grant,
    '@endo/errors',
    makePublishDocument({ name: '@endo/errors', version: V1 }),
  );
  const tags = await registry.getDistTags('@endo/errors');
  t.false(Object.hasOwn(tags, 'latest'));
  t.false(Object.hasOwn(tags, '2.0.0'));
  t.is(tags.stable, '1.0.0');
});

test('an upstream packument with null versions is a 502', async t => {
  const { registry } = makeTestRegistry({
    upstreamOrigin: 'https://upstream.example',
    fetch: async () =>
      new Response(JSON.stringify({ name: 'left-pad', versions: null })),
  });
  const error = await t.throwsAsync(() => registry.getPackument('left-pad'));
  t.is(/** @type {any} */ (error).statusCode, 502);
});

test('every refusal after authentication is audited', async t => {
  const { registry, grant, directory } = makeTestRegistry({
    limits: { ...defaultArchiveLimits, maxTarballBytes: 64 },
  });
  // Refused before the transaction: the tarball is over the size limit.
  await t.throwsAsync(
    registry.publish(
      grant,
      '@endo/patterns',
      makePublishDocument({ name: '@endo/patterns', version: V1 }),
    ),
    { message: /size limit/ },
  );
  const {
    registry: tagged,
    grant: taggedGrant,
    directory: taggedDirectory,
  } = makeTestRegistry();
  await tagged.publish(
    taggedGrant,
    '@endo/patterns',
    makePublishDocument({ name: '@endo/patterns', version: V2 }),
  );
  // Refused inside the transaction: the date tag would move backward.
  await t.throwsAsync(
    tagged.publish(
      taggedGrant,
      '@endo/patterns',
      makePublishDocument({ name: '@endo/patterns', version: V1 }),
    ),
    { message: /newer/ },
  );
  // Refused before the transaction: a date tag for another date.
  t.throws(
    () =>
      tagged.setDistTag(taggedGrant, '@endo/patterns', 'dev-2026-09-27', V2),
    { message: /from that date/ },
  );

  const outcomes = (/** @type {string} */ directoryPath) =>
    new Database(path.join(directoryPath, 'db.sqlite'), { readonly: true })
      .prepare(
        "SELECT action, version, tag, outcome, detail FROM audit_events WHERE action != 'grant-issue' ORDER BY seq",
      )
      .all();
  t.like(outcomes(directory), [
    { action: 'publish', version: V1, outcome: 'refused' },
  ]);
  t.like(outcomes(taggedDirectory), [
    { action: 'publish', version: V2, outcome: 'ok' },
    { action: 'publish', version: V1, outcome: 'conflict' },
    {
      action: 'dist-tag',
      version: V2,
      tag: 'dev-2026-09-27',
      outcome: 'refused',
    },
  ]);
});

test('install facts come from the tarball, not the publish document', async t => {
  const { registry, grant } = makeTestRegistry();
  const packageJson = {
    name: '@endo/patterns',
    version: V1,
    scripts: { postinstall: 'node setup.js' },
  };
  const document = makePublishDocument({
    name: '@endo/patterns',
    version: V1,
    extraFiles: {
      'package.json': JSON.stringify(packageJson),
      'npm-shrinkwrap.json': '{}',
    },
  });
  /** @type {any} */ (document.versions[V1]).hasInstallScript = false;
  await registry.publish(grant, '@endo/patterns', document);
  const packument = await registry.getPackument('@endo/patterns', {
    abbreviated: true,
  });
  t.is(packument.versions[V1].hasInstallScript, true);
  // eslint-disable-next-line no-underscore-dangle -- npm wire field name
  t.is(packument.versions[V1]._hasShrinkwrap, true);
});

test('publish refuses platform fields that differ from the tarball', async t => {
  const { registry, grant } = makeTestRegistry();
  const document = makePublishDocument({ name: '@endo/patterns', version: V1 });
  /** @type {any} */ (document.versions[V1]).os = ['linux'];
  await t.throwsAsync(registry.publish(grant, '@endo/patterns', document), {
    message: /os differ/,
  });
});

test('publish folds bundledDependencies the way npm publishes it', async t => {
  const { registry, grant } = makeTestRegistry();
  const packageJson = {
    name: '@endo/patterns',
    version: V1,
    dependencies: { a: '^1.0.0' },
    bundledDependencies: true,
  };
  const document = makePublishDocument({
    name: '@endo/patterns',
    version: V1,
    dependencies: { a: '^1.0.0' },
    extraFiles: { 'package.json': JSON.stringify(packageJson) },
  });
  /** @type {any} */ (document.versions[V1]).bundleDependencies = ['a'];
  const result = await registry.publish(grant, '@endo/patterns', document);
  t.true(result.created);
});

test('an upstream failure after a 200 still serves cached rows', async t => {
  const tgz = makeTgz({
    'package.json': JSON.stringify({ name: 'left-pad', version: '1.3.0' }),
  });
  const { integrity } = digestTarball(tgz);
  const good = JSON.stringify({
    name: 'left-pad',
    'dist-tags': { latest: '1.3.0' },
    versions: {
      '1.3.0': { name: 'left-pad', version: '1.3.0', dist: { integrity } },
    },
  });
  /** @type {() => any} */
  let respond = () => new Response(good);
  const { registry } = makeTestRegistry({
    upstreamOrigin: 'https://upstream.example',
    fetch: async () => respond(),
    upstreamTtlMs: 0,
    maxPackumentBytes: 1024,
  });
  await registry.getPackument('left-pad');

  /** @type {Array<[string, () => any]>} */
  const failures = [
    ['not JSON', () => new Response('{"name":')],
    [
      'another name',
      () => new Response(good.replace('"left-pad"', '"right-pad"')),
    ],
    ['oversized', () => new Response('x'.repeat(2048))],
    [
      'interrupted',
      () => ({
        status: 200,
        ok: true,
        headers: { get: () => null },
        body: {
          async *[Symbol.asyncIterator]() {
            yield new TextEncoder().encode('{"name":');
            throw Error('read ECONNRESET');
          },
        },
      }),
    ],
  ];
  for (const [label, failure] of failures) {
    respond = failure;
    // eslint-disable-next-line no-await-in-loop
    const packument = await registry.getPackument('left-pad');
    t.deepEqual(Object.keys(packument.versions), ['1.3.0'], label);
  }
});

test('an upstream body refused by its declared length is released', async t => {
  let destroyed = false;
  /** @type {UpstreamFetch} */
  const fakeFetch = async () => ({
    status: 200,
    ok: true,
    headers: {
      get: name => (name === 'content-length' ? String(2 ** 30) : null),
    },
    body: {
      destroy: () => {
        destroyed = true;
      },
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array(0);
      },
    },
  });
  const { registry } = makeTestRegistry({
    upstreamOrigin: 'https://upstream.example',
    fetch: fakeFetch,
    upstreamTtlMs: 0,
  });
  const error = await t.throwsAsync(() => registry.getPackument('left-pad'), {
    message: /size limit/,
  });
  t.is(/** @type {any} */ (error).statusCode, 502);
  t.true(destroyed);
});
