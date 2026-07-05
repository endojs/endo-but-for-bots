// @ts-nocheck
/* eslint-disable import/order, no-await-in-loop */
/* global globalThis, setTimeout */

import '@endo/init/debug.js';

import http from 'node:http';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';

import { makeInMemoryFilesystem } from '@endo/platform/fs/extended';
import { makeNodeHttpBackend } from '@endo/platform/http/node';
import { makeAssetServer } from '../src/asset-server.js';
import { contentTypeForName, normalizeSegments } from '../src/index.js';

const backend = makeNodeHttpBackend({ http });

const utf8 = s => new TextEncoder().encode(s);

const getRandomValues = bytes => globalThis.crypto.getRandomValues(bytes);

// A node:http GET client with keep-alive disabled (`agent: false`).
// Using the global `fetch` (undici) here pools keep-alive sockets
// against the test server; closing the server in teardown then rejects
// those sockets with a `ClientDestroyedError`, which SES surfaces as a
// fatal unhandled rejection on Node 24. A no-keep-alive client closes
// each socket as soon as the body is read, so `server.close()` is clean.
const httpGet = url =>
  new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false }, res => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => {
        body += chunk;
      });
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: body,
        }),
      );
    });
    req.on('error', reject);
  });

const writeBytes = async (writerRef, bytes) => {
  const writer = iterateBytesWriter(writerRef);
  await writer.next(bytes);
  await writer.return();
};

const ensureDir = async (root, segments) =>
  segments.length === 0 ? root : E(root).materialise(segments, {});

const writeFileAt = async (root, segments, bytes) => {
  const parent = await ensureDir(root, segments.slice(0, -1));
  const name = segments[segments.length - 1];
  const openFile = await E(parent).create(name, {});
  await writeBytes(await E(openFile).write(0n), bytes);
  await E(openFile).close();
};

/** Populate an in-memory Filesystem with a small static site. */
const makeSiteFs = async () => {
  const fs = makeInMemoryFilesystem();
  const root = await E(fs).root();
  await writeFileAt(root, ['index.html'], utf8('<h1>home</h1>'));
  await writeFileAt(root, ['style.css'], utf8('body { color: red }'));
  await writeFileAt(root, ['app', 'main.js'], utf8('export const x = 1;'));
  await writeFileAt(root, ['app', 'index.html'], utf8('<h1>app</h1>'));
  return fs;
};

const startServer = async t => {
  const server = await makeAssetServer({ backend, getRandomValues });
  t.teardown(() => E(server).stop());
  return server;
};

test('contentTypeForName maps extensions', t => {
  t.is(contentTypeForName('index.html'), 'text/html; charset=utf-8');
  t.is(contentTypeForName('main.js'), 'text/javascript; charset=utf-8');
  t.is(contentTypeForName('logo.png'), 'image/png');
  t.is(contentTypeForName('data'), 'application/octet-stream');
  t.is(contentTypeForName('archive.unknown'), 'application/octet-stream');
});

test('normalizeSegments rejects traversal', t => {
  t.deepEqual(normalizeSegments('a/b/c'), ['a', 'b', 'c']);
  t.deepEqual(normalizeSegments(['a/b', 'c']), ['a', 'b', 'c']);
  t.deepEqual(normalizeSegments(''), []);
  t.throws(() => normalizeSegments('a/../b'), { message: /traversal/ });
});

test.serial('serve rejects a cap without a filesystem surface', async t => {
  const fs = await makeSiteFs();
  const server = await startServer(t);

  // The revoke handle is a remotable but exposes no `root()` — serve must
  // fail fast with a clear error, not register a mount that 404s later.
  const { revoke } = await E(server).serve(fs);
  await t.throwsAsync(() => E(server).serve(revoke), {
    message: /root\(\)/,
  });
  await t.throwsAsync(() => E(server).serveAt('nope', revoke), {
    message: /root\(\)/,
  });
});

test.serial('serveAt serves at a stable, chosen path', async t => {
  const fs = await makeSiteFs();
  const server = await startServer(t);

  const { path, url } = await E(server).serveAt('site', fs);
  t.is(path, '/site/');
  t.true(url.endsWith('/site/'));

  const res = await httpGet(`${url}style.css`);
  t.is(res.status, 200);
  t.is(res.text, 'body { color: red }');

  // The index is served for the mount root.
  const rootRes = await httpGet(url);
  t.is(rootRes.status, 200);
  t.is(rootRes.text, '<h1>home</h1>');

  // Re-registering the same path replaces the mount (models a restart
  // re-applying the same config), keeping the URL stable.
  const again = await E(server).serveAt('site', fs);
  t.is(again.path, '/site/');

  // Rejects multi-segment or traversal path tokens.
  await t.throwsAsync(() => E(server).serveAt('a/b', fs));
  await t.throwsAsync(() => E(server).serveAt('..', fs));
});

test.serial('serves a file at a generated capability path', async t => {
  const fs = await makeSiteFs();
  const server = await startServer(t);

  const { path, url, revoke } = await E(server).serve(fs);
  t.regex(path, /^\/[\w-]+\/$/);
  t.is(await E(revoke).getUrl(), url);

  const res = await httpGet(`${url}style.css`);
  t.is(res.status, 200);
  t.is(res.headers['content-type'], 'text/css; charset=utf-8');
  t.is(res.text, 'body { color: red }');

  const nested = await httpGet(`${url}app/main.js`);
  t.is(nested.status, 200);
  t.is(nested.headers['content-type'], 'text/javascript; charset=utf-8');
  t.is(nested.text, 'export const x = 1;');
});

test.serial('serves the index file for directory paths', async t => {
  const fs = await makeSiteFs();
  const server = await startServer(t);
  const { url } = await E(server).serve(fs);

  const rootRes = await httpGet(url);
  t.is(rootRes.status, 200);
  // The index response is labelled by the index file name, not the
  // directory name, so directories get text/html (not octet-stream).
  t.is(rootRes.headers['content-type'], 'text/html; charset=utf-8');
  t.is(rootRes.text, '<h1>home</h1>');

  const dirRes = await httpGet(`${url}app/`);
  t.is(dirRes.status, 200);
  t.is(dirRes.headers['content-type'], 'text/html; charset=utf-8');
  t.is(dirRes.text, '<h1>app</h1>');
});

test.serial('responses carry hardening headers', async t => {
  const fs = await makeSiteFs();
  const server = await startServer(t);
  const { url } = await E(server).serve(fs);

  const res = await httpGet(`${url}style.css`);
  t.is(res.status, 200);
  t.is(res.headers['x-content-type-options'], 'nosniff');
  t.is(res.headers['referrer-policy'], 'no-referrer');
});

test.serial('deep missing paths 404 without unhandled rejections', async t => {
  const fs = await makeSiteFs();
  const server = await startServer(t);
  const { url } = await E(server).serve(fs);

  // A missing middle segment rejects intermediate pipelined lookups;
  // under @endo/init/debug an unhandled rejection would fail the run.
  t.is((await httpGet(`${url}app/missing/deeper/x.txt`)).status, 404);
  t.is((await httpGet(`${url}missing/a/b/c`)).status, 404);
  // Let any stray rejection surface before the test ends.
  await new Promise(resolve => setTimeout(resolve, 200));
});

test.serial('a directory with no real index file 404s', async t => {
  const fs = await makeSiteFs();
  const server = await startServer(t);
  // `app` has index.html, but a directory whose index entry is itself a
  // directory must not be served as an empty 200.
  const root = await E(fs).root();
  await E(root).materialise(['empty', 'index.html'], {}); // index.html is a dir
  const { url } = await E(server).serve(fs);

  t.is((await httpGet(`${url}empty/`)).status, 404);
});

test.serial('subPath rebases the served root', async t => {
  const fs = await makeSiteFs();
  const server = await startServer(t);
  const { url } = await E(server).serve(fs, { subPath: 'app' });

  const res = await httpGet(`${url}main.js`);
  t.is(res.status, 200);
  t.is(res.text, 'export const x = 1;');
});

test.serial('missing files 404', async t => {
  const fs = await makeSiteFs();
  const server = await startServer(t);
  const { url } = await E(server).serve(fs);

  const res = await httpGet(`${url}nope.txt`);
  t.is(res.status, 404);
});

test.serial('unknown / revoked tokens 404', async t => {
  const fs = await makeSiteFs();
  const server = await startServer(t);
  const { origin } = await E(server).getAddress();

  const unknown = await httpGet(`${origin}/not-a-real-token/index.html`);
  t.is(unknown.status, 404);

  const { url, revoke } = await E(server).serve(fs);
  t.is(await E(revoke).isRevoked(), false);
  t.is((await httpGet(url)).status, 200);

  await E(revoke).revoke();
  t.is(await E(revoke).isRevoked(), true);
  t.is((await httpGet(url)).status, 404);
});

test.serial('persists across many requests until revoked', async t => {
  const fs = await makeSiteFs();
  const server = await startServer(t);
  const { url, revoke } = await E(server).serve(fs);

  for (let i = 0; i < 5; i += 1) {
    t.is((await httpGet(`${url}style.css`)).status, 200);
  }
  await E(revoke).revoke();
  t.is((await httpGet(`${url}style.css`)).status, 404);
});

test.serial(
  'independent mounts have independent paths and lifetimes',
  async t => {
    const fs = await makeSiteFs();
    const server = await startServer(t);

    const a = await E(server).serve(fs);
    const b = await E(server).serve(fs);
    t.not(a.path, b.path);

    await E(a.revoke).revoke();
    t.is((await httpGet(a.url)).status, 404);
    t.is((await httpGet(b.url)).status, 200);
  },
);

test.serial('rejects path traversal in the request', async t => {
  const fs = await makeSiteFs();
  const server = await startServer(t);
  const { origin } = await E(server).getAddress();
  const { path } = await E(server).serve(fs);

  // Encoded traversal should not escape the mount root.
  const res = await httpGet(`${origin}${path}..%2f..%2fetc`);
  t.true(res.status === 400 || res.status === 404);
});
