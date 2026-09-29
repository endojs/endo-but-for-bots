// @ts-check
// Status-code contract of the npm HTTP adapter, exercised over a real
// loopback socket against an in-memory test registry.

import test from '@endo/ses-ava/prepare-endo.js';

import { Buffer } from 'node:buffer';
import http from 'node:http';

import { makeRequestHandler } from '../src/http.js';
import { makePublishDocument, makeTestRegistry } from './_fixtures.js';

/** @import { ExecutionContext } from 'ava' */
/** @import { AddressInfo } from 'node:net' */
/** @import { RequestLog } from '../src/http.js' */

const VERSION = '1.7.0-dev.20260928101010.gaaaaaaa';
const TAG = 'dev-2026-09-28';

/**
 * @typedef {object} RequestOptions
 * @property {string} [method]
 * @property {Record<string, string>} [headers]
 * @property {string} [body]
 */

/**
 * A one-shot request over `node:http` without connection pooling. The
 * tests run under SES lockdown, where Node's built-in `fetch` (undici)
 * raises unhandled override-mistake rejections when pooled connections
 * are destroyed at teardown.
 *
 * @param {number} port
 * @param {string} pathname
 * @param {RequestOptions} [init]
 */
const requestOver = (port, pathname, { method = 'GET', headers, body } = {}) =>
  new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers,
        agent: false,
      },
      response => {
        /** @type {Buffer[]} */
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode ?? 0,
            headers: {
              get: (/** @type {string} */ name) => {
                const value = response.headers[name.toLowerCase()];
                return value === undefined ? null : String(value);
              },
            },
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });

/**
 * @param {ExecutionContext} t
 * @param {{ maxBodyBytes?: number }} [options]
 */
const serve = async (t, options = {}) => {
  const fixture = makeTestRegistry();
  /** @type {RequestLog[]} */
  const logs = [];
  const handler = makeRequestHandler({
    registry: fixture.registry,
    grants: fixture.grants,
    log: entry => logs.push(entry),
    ...options,
  });
  const server = http.createServer((request, response) => {
    handler(request, response);
  });
  await new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  t.teardown(() => server.close());
  const { port } = /** @type {AddressInfo} */ (server.address());
  const auth = { authorization: `Bearer ${fixture.token}` };
  /**
   * @param {string} pathname
   * @param {RequestOptions} [init]
   */
  const request = (pathname, init) => requestOver(port, pathname, init);
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
  const put = (/** @type {RequestOptions} */ init) =>
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
  // Tag names from the URL never reach the prototype chain.
  const inheritedStatuses = await Promise.all(
    ['__proto__', 'constructor', 'toString'].map(async inherited => {
      const reply = await request(
        `/-/package/@endo%2fpatterns/dist-tags/${inherited}`,
      );
      return reply.status;
    }),
  );
  t.deepEqual(inheritedStatuses, [404, 404, 404]);
  // A malformed percent-escape is the client's error, not the server's.
  t.is(
    (await request('/-/package/@endo%2fpatterns/dist-tags/%E0')).status,
    400,
  );
  t.is((await request('/@endo%2fpatterns/%E0%A4%A')).status, 400);
  t.is((await request('/@endo%2fpatterns/-/%E0')).status, 400);

  const setTag = (
    /** @type {string} */ tag,
    /** @type {RequestOptions} */ init,
  ) =>
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
