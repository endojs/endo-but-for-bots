// @ts-check
// Status-code contract of the npm HTTP adapter, exercised over a real
// loopback socket against an in-memory test registry.

import test from '@endo/ses-ava/prepare-endo.js';

import http from 'node:http';

import { makeRequestHandler } from '../src/http.js';
import { makePublishDocument, makeTestRegistry } from './_fixtures.js';

const VERSION = '1.7.0-dev.20260928101010.gaaaaaaa';
const TAG = 'dev-2026-09-28';

/**
 * @param {import('ava').ExecutionContext} t
 * @param {{ maxBodyBytes?: number }} [options]
 */
const serve = async (t, options = {}) => {
  const fixture = makeTestRegistry();
  /** @type {import('../src/http.js').RequestLog[]} */
  const logs = [];
  const handler = makeRequestHandler({
    registry: fixture.registry,
    grants: fixture.grants,
    log: entry => logs.push(entry),
    ...options,
  });
  const server = http.createServer((req, res) => {
    handler(req, res);
  });
  await new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  t.teardown(() => server.close());
  const { port } = /** @type {import('node:net').AddressInfo} */ (
    server.address()
  );
  const origin = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${fixture.token}` };
  /**
   * @param {string} pathname
   * @param {RequestInit} [init]
   */
  const request = (pathname, init) => fetch(`${origin}${pathname}`, init);
  return { ...fixture, logs, request, auth };
};

test('ping and whoami', async t => {
  const { request, auth, logs, token } = await serve(t);
  t.is((await request('/-/ping')).status, 200);
  t.is((await request('/-/whoami')).status, 401);
  t.is(
    (
      await request('/-/whoami', {
        headers: { authorization: `Basic ${token}` },
      })
    ).status,
    401,
    'only bearer credentials are accepted',
  );
  const whoami = await request('/-/whoami', { headers: auth });
  t.deepEqual(await whoami.json(), { username: 'garden-llm-publisher' });
  t.false(JSON.stringify(logs).includes(token), 'bearer is never logged');
  t.like(logs.at(-1), { path: '/-/whoami', status: 200 });
  t.is(logs.at(-1)?.subject, 'garden-llm-publisher');
});

test('unsupported and malformed routes', async t => {
  const { request } = await serve(t);
  t.is((await request('/')).status, 404);
  t.is((await request('/-/v1/search')).status, 404);
  t.is((await request('/-/package/solo/access')).status, 404);
  t.is((await request('/@endo')).status, 404, 'bare scope is not a package');
  t.is((await request('/solo/1.0.0/extra')).status, 404);
  t.is((await request('/solo/1.0.0', { method: 'PUT' })).status, 405);
  t.is((await request('/solo', { method: 'DELETE' })).status, 405);
  t.is(
    (await request('/-/package/solo/dist-tags/x', { method: 'DELETE' })).status,
    405,
  );
});

test('publish over HTTP: auth, body limits, and conditional reads', async t => {
  const { request, auth } = await serve(t, { maxBodyBytes: 64 * 1024 });
  const document = makePublishDocument({
    name: '@endo/patterns',
    version: VERSION,
  });
  const body = JSON.stringify(document);
  const put = (/** @type {RequestInit} */ init) =>
    request('/@endo%2fpatterns', { method: 'PUT', ...init });

  t.is((await put({ body })).status, 401);
  t.is(
    (await put({ body: '{', headers: { ...auth } })).status,
    400,
    'non-JSON body',
  );
  t.is(
    (await put({ body: 'x'.repeat(65 * 1024), headers: { ...auth } })).status,
    413,
  );
  const created = await put({
    body,
    headers: { ...auth, 'content-type': 'application/json' },
  });
  t.is(created.status, 201);
  t.like(await created.json(), { ok: true, id: '@endo/patterns' });
  t.is((await put({ body, headers: auth })).status, 200, 'identical retry');

  const packument = await request('/@endo/patterns');
  t.is(packument.status, 200);
  const etag = packument.headers.get('etag');
  t.truthy(etag);
  t.is(
    (
      await request('/@endo%2fpatterns', {
        headers: { 'if-none-match': etag ?? '' },
      })
    ).status,
    304,
  );
  const abbreviated = await request('/@endo%2fpatterns', {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  });
  t.is(
    abbreviated.headers.get('content-type'),
    'application/vnd.npm.install-v1+json',
  );
  const head = await request('/@endo%2fpatterns', { method: 'HEAD' });
  t.is(head.status, 200);
  t.is(await head.text(), '');

  const manifest = await request(`/@endo%2fpatterns/${VERSION}`);
  t.like(await manifest.json(), { name: '@endo/patterns', version: VERSION });

  const tarballPath = `/@endo%2fpatterns/-/patterns-${VERSION}.tgz`;
  const tarball = await request(tarballPath);
  t.is(tarball.status, 200);
  t.is(
    tarball.headers.get('cache-control'),
    'public, max-age=31536000, immutable',
  );
  const tarballEtag = tarball.headers.get('etag') ?? '';
  t.is(
    (await request(tarballPath, { headers: { 'if-none-match': tarballEtag } }))
      .status,
    304,
  );
  const tarballHead = await request(tarballPath, { method: 'HEAD' });
  t.is(tarballHead.status, 200);
  t.is(await tarballHead.text(), '');
});

test('dist-tags over HTTP', async t => {
  const { request, auth, registry, grant } = await serve(t);
  await registry.publish(
    grant,
    '@endo/patterns',
    makePublishDocument({ name: '@endo/patterns', version: VERSION }),
  );
  const tags = await request('/-/package/@endo%2fpatterns/dist-tags');
  t.deepEqual(await tags.json(), { [TAG]: VERSION });
  const one = await request(`/-/package/@endo%2fpatterns/dist-tags/${TAG}`);
  t.is(await one.json(), VERSION);
  t.is(
    (await request('/-/package/@endo%2fpatterns/dist-tags/nope')).status,
    404,
  );

  const setTag = (/** @type {string} */ tag, /** @type {RequestInit} */ init) =>
    request(`/-/package/@endo%2fpatterns/dist-tags/${tag}`, {
      method: 'PUT',
      body: JSON.stringify(VERSION),
      ...init,
    });
  t.is((await setTag('dev-latest', {})).status, 401);
  t.is((await setTag('latest', { headers: auth })).status, 403);
  t.is(
    (
      await setTag('dev-latest', {
        headers: auth,
        body: '"x"'.padEnd(5000, ' '),
      })
    ).status,
    413,
  );
  const set = await setTag('dev-latest', { headers: auth });
  t.is(set.status, 201);
  t.deepEqual(await set.json(), { ok: true, 'dev-latest': VERSION });
});
