// @ts-nocheck
/* eslint-disable import/order, no-await-in-loop */
/* global globalThis, fetch */

import '@endo/init/debug.js';

import http from 'node:http';

import test from 'ava';
import { E } from '@endo/far';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';

import { makeInMemoryFilesystem } from '@endo/endo-fs';
import { makeAssetServer } from '../src/asset-server.js';
import { contentTypeForName, normalizeSegments } from '../src/index.js';

const utf8 = s => new TextEncoder().encode(s);

const getRandomValues = bytes => globalThis.crypto.getRandomValues(bytes);

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
  const server = await makeAssetServer({ http, getRandomValues });
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

test.serial('serves a file at a generated capability path', async t => {
  const fs = await makeSiteFs();
  const server = await startServer(t);

  const { path, url, revoke } = await E(server).serve(fs);
  t.regex(path, /^\/[\w-]+\/$/);
  t.is(await E(revoke).getUrl(), url);

  const res = await fetch(`${url}style.css`);
  t.is(res.status, 200);
  t.is(res.headers.get('content-type'), 'text/css; charset=utf-8');
  t.is(await res.text(), 'body { color: red }');

  const nested = await fetch(`${url}app/main.js`);
  t.is(nested.status, 200);
  t.is(nested.headers.get('content-type'), 'text/javascript; charset=utf-8');
  t.is(await nested.text(), 'export const x = 1;');
});

test.serial('serves the index file for directory paths', async t => {
  const fs = await makeSiteFs();
  const server = await startServer(t);
  const { url } = await E(server).serve(fs);

  const rootRes = await fetch(url);
  t.is(rootRes.status, 200);
  t.is(await rootRes.text(), '<h1>home</h1>');

  const dirRes = await fetch(`${url}app/`);
  t.is(dirRes.status, 200);
  t.is(await dirRes.text(), '<h1>app</h1>');
});

test.serial('subPath rebases the served root', async t => {
  const fs = await makeSiteFs();
  const server = await startServer(t);
  const { url } = await E(server).serve(fs, { subPath: 'app' });

  const res = await fetch(`${url}main.js`);
  t.is(res.status, 200);
  t.is(await res.text(), 'export const x = 1;');
});

test.serial('missing files 404', async t => {
  const fs = await makeSiteFs();
  const server = await startServer(t);
  const { url } = await E(server).serve(fs);

  const res = await fetch(`${url}nope.txt`);
  t.is(res.status, 404);
});

test.serial('unknown / revoked tokens 404', async t => {
  const fs = await makeSiteFs();
  const server = await startServer(t);
  const { origin } = await E(server).getAddress();

  const unknown = await fetch(`${origin}/not-a-real-token/index.html`);
  t.is(unknown.status, 404);

  const { url, revoke } = await E(server).serve(fs);
  t.is(await E(revoke).isRevoked(), false);
  t.is((await fetch(url)).status, 200);

  await E(revoke).revoke();
  t.is(await E(revoke).isRevoked(), true);
  t.is((await fetch(url)).status, 404);
});

test.serial('persists across many requests until revoked', async t => {
  const fs = await makeSiteFs();
  const server = await startServer(t);
  const { url, revoke } = await E(server).serve(fs);

  for (let i = 0; i < 5; i += 1) {
    t.is((await fetch(`${url}style.css`)).status, 200);
  }
  await E(revoke).revoke();
  t.is((await fetch(`${url}style.css`)).status, 404);
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
    t.is((await fetch(a.url)).status, 404);
    t.is((await fetch(b.url)).status, 200);
  },
);

test.serial('rejects path traversal in the request', async t => {
  const fs = await makeSiteFs();
  const server = await startServer(t);
  const { origin, ...rest } = await E(server).getAddress();
  const { path } = await E(server).serve(fs);

  // Encoded traversal should not escape the mount root.
  const res = await fetch(`${origin}${path}..%2f..%2fetc`);
  t.true(res.status === 400 || res.status === 404);
  t.truthy(rest);
});
