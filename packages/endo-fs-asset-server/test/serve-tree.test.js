// @ts-nocheck
/* eslint-disable no-await-in-loop */

// Phase 1 (designs/gateway-sites-publication.md): the serving core.
// Exercises makeTreeRequestHandler against a fake snapshot that faithfully
// models the real SnapshotTree / SnapshotBlob surface produced by
// E(mount).snapshot() (blobs stream via streamBase64 and expose getInfo; trees
// also expose getInfo) — so no daemon is required and the fake cannot mask the
// serving core's real byte-read and file-vs-directory paths.

import '@endo/init/debug.js';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';

import { makeTreeRequestHandler } from '../src/serve-tree.js';

const utf8 = s => new TextEncoder().encode(s);
const decode = bytes => new TextDecoder().decode(bytes);

// Collect an HttpResponse body (Uint8Array | AsyncIterable<Uint8Array>) to a
// single Uint8Array, mirroring what the platform Node backend would stream.
const collectBody = async body => {
  if (body === undefined) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
};

// A trivial non-cryptographic digest so distinct bytes get distinct ETags in
// tests (the real snapshot supplies a real sha256). Modular arithmetic keeps it
// bitwise-free; the exact value is irrelevant, only that it varies with bytes.
const MOD = 2n ** 64n;
const fakeHash = bytes => {
  let h = 5381n;
  for (const b of bytes) {
    h = (h * 33n + BigInt(b)) % MOD;
  }
  return h.toString(16).padStart(16, '0');
};

// Model the REAL SnapshotBlob surface produced by `E(mount).snapshot()`:
// streamBase64 / text / json / getInfo / sha256 — and deliberately NO `fetch`
// (fetch lives on the live-mount ReadableBlobRange face, not on snapshots). A
// fake that carried `fetch` would mask the serving-core's byte-read path.
const BlobInterface = M.interface(
  'SnapshotBlob',
  {
    streamBase64: M.call(M.any()).returns(M.promise()),
    text: M.call().returns(M.promise()),
    json: M.call().returns(M.promise()),
    getInfo: M.call().returns(M.any()),
    sha256: M.call().returns(M.string()),
    help: M.call().optional(M.string()).returns(M.string()),
  },
  { sloppy: true },
);

// Model the REAL SnapshotTree surface: has / list / lookup / getInfo / sha256.
// A SnapshotTree DOES expose getInfo (returning the manifest's hash/size), so
// the serving core must not use getInfo to tell a file from a directory.
const TreeInterface = M.interface(
  'SnapshotTree',
  {
    lookup: M.call(M.or(M.string(), M.arrayOf(M.string()))).returns(M.any()),
    has: M.call().rest(M.arrayOf(M.string())).returns(M.promise()),
    list: M.call().rest(M.arrayOf(M.string())).returns(M.promise()),
    getInfo: M.call().returns(M.any()),
    sha256: M.call().returns(M.string()),
    help: M.call().optional(M.string()).returns(M.string()),
  },
  { sloppy: true },
);

const makeBlob = bytes =>
  makeExo('SnapshotBlob', BlobInterface, {
    // Drive bytes through streamBase64, exactly as a real SnapshotBlob does.
    // Delegating to a fresh bytesReaderFromIterator makes this a faithful
    // PassableBytesReader responder for iterateBytesReader.
    streamBase64: synHead => {
      async function* one() {
        yield bytes;
      }
      return E(bytesReaderFromIterator(one())).streamBase64(synHead);
    },
    text: async () => decode(bytes),
    json: async () => JSON.parse(decode(bytes)),
    getInfo: () =>
      harden({
        algorithm: 'sha256',
        hash: fakeHash(bytes),
        size: BigInt(bytes.length),
      }),
    sha256: () => fakeHash(bytes),
    help: () => 'fake snapshot blob',
  });

/**
 * Build a fake ReadableTree from a flat `{ 'a/b/c.ext': Uint8Array }` map.
 * A `lookup` of a path that is a strict prefix of some file resolves to a
 * sub-tree (directory); an exact file resolves to a blob; anything else throws.
 *
 * @param {Record<string, Uint8Array>} files
 */
const makeTree = files => {
  const at = prefix => {
    const rel = name => (prefix === '' ? name : `${prefix}/${name}`);
    return makeExo('SnapshotTree', TreeInterface, {
      lookup: pathArg => {
        const segs = Array.isArray(pathArg) ? pathArg : pathArg.split('/');
        const key = rel(segs.join('/'));
        if (Object.prototype.hasOwnProperty.call(files, key)) {
          return makeBlob(files[key]);
        }
        // A directory: some file lives under `${key}/`.
        const dirPrefix = `${key}/`;
        if (Object.keys(files).some(f => f.startsWith(dirPrefix))) {
          return at(key);
        }
        throw new Error(`ENOENT: ${key}`);
      },
      has: async (...segs) =>
        Object.prototype.hasOwnProperty.call(files, rel(segs.flat().join('/'))),
      list: async () => harden([]),
      // A real SnapshotTree exposes getInfo/sha256 (the manifest's identity);
      // the serving core must therefore NOT treat getInfo presence as "file".
      getInfo: () => harden({ algorithm: 'sha256', hash: 'tree', size: 0n }),
      sha256: () => 'tree',
      help: () => 'fake snapshot tree',
    });
  };
  return at('');
};

const site = () =>
  makeTree({
    'index.html': utf8('<h1>home</h1>'),
    'style.css': utf8('body { color: red }'),
    'app/main.js': utf8('export const x = 1;'),
    'app/index.html': utf8('<h1>app</h1>'),
    'logo.png': utf8('\x89PNG\r\n\x1a\n'),
  });

const get = (handler, path, headers = []) =>
  E(handler)(harden({ method: 'GET', url: path, headers }));

test('serves a file with inferred content-type', async t => {
  const handler = makeTreeRequestHandler({ tree: site() });
  const res = await get(handler, '/style.css');
  t.is(res.status, 200);
  const ct = res.headers.find(([k]) => k === 'Content-Type')[1];
  t.is(ct, 'text/css; charset=utf-8');
  t.is(decode(await collectBody(res.body)), 'body { color: red }');
});

test('serves nested files', async t => {
  const handler = makeTreeRequestHandler({ tree: site() });
  const res = await get(handler, '/app/main.js');
  t.is(res.status, 200);
  t.is(
    res.headers.find(([k]) => k === 'Content-Type')[1],
    'text/javascript; charset=utf-8',
  );
  t.is(decode(await collectBody(res.body)), 'export const x = 1;');
});

test('root and directory paths select index.html', async t => {
  const handler = makeTreeRequestHandler({ tree: site() });
  const root = await get(handler, '/');
  t.is(root.status, 200);
  t.is(decode(await collectBody(root.body)), '<h1>home</h1>');
  const dir = await get(handler, '/app/');
  t.is(dir.status, 200);
  t.is(
    dir.headers.find(([k]) => k === 'Content-Type')[1],
    'text/html; charset=utf-8',
  );
  t.is(decode(await collectBody(dir.body)), '<h1>app</h1>');
});

test('every response carries the security baseline', async t => {
  const handler = makeTreeRequestHandler({ tree: site() });
  for (const path of ['/style.css', '/nope.txt']) {
    const res = await get(handler, path);
    const h = Object.fromEntries(res.headers);
    t.is(h['X-Content-Type-Options'], 'nosniff');
    t.is(h['Referrer-Policy'], 'no-referrer');
    t.is(h['Cross-Origin-Opener-Policy'], 'same-origin');
    t.is(h['Cross-Origin-Embedder-Policy'], 'require-corp');
    t.is(h['Cross-Origin-Resource-Policy'], 'same-origin');
    t.regex(h['Content-Security-Policy'], /default-src 'self'/);
    t.regex(h['Content-Security-Policy'], /frame-ancestors 'none'/);
  }
});

test('missing file 404s', async t => {
  const handler = makeTreeRequestHandler({ tree: site() });
  t.is((await get(handler, '/nope.txt')).status, 404);
  t.is((await get(handler, '/app/missing/deep.js')).status, 404);
});

test('a directory whose index is itself a directory 404s', async t => {
  const handler = makeTreeRequestHandler({
    tree: makeTree({ 'empty/index.html/keep.txt': utf8('x') }),
  });
  // `/empty/` -> directory -> lookup index.html -> resolves to a sub-tree,
  // which isBlob() rejects (no streamBase64) -> 404, before any getInfo.
  t.is((await get(handler, '/empty/')).status, 404);
});

test('traversal cannot escape the tree; encoded dot-dot and bad encoding 400', async t => {
  const handler = makeTreeRequestHandler({ tree: site() });
  // Literal `..` (and percent-encoded `%2e%2e`) are resolved away as
  // dot-segments by URL normalization before they reach the handler, so they
  // cannot climb above the root — they resolve to a non-existent in-tree path
  // and 404.
  t.is((await get(handler, '/../etc/passwd')).status, 404);
  t.is((await get(handler, '/a/%2e%2e/b')).status, 404);
  // Encoded *slashes* hide a `..` from URL normalization; after the handler
  // percent-decodes, normalizeSegments sees the traversal segment and rejects
  // it. This is the defense-in-depth the URL layer alone would miss.
  t.is((await get(handler, '/a%2f..%2fb')).status, 400);
  // A malformed percent-encoding fails to decode.
  t.is((await get(handler, '/%ZZ')).status, 400);
});

test('only GET and HEAD are allowed', async t => {
  const handler = makeTreeRequestHandler({ tree: site() });
  const res = await E(handler)(
    harden({ method: 'POST', url: '/style.css', headers: [] }),
  );
  t.is(res.status, 405);
  t.is(res.headers.find(([k]) => k === 'Allow')[1], 'GET, HEAD');
});

test('HEAD returns headers without a body', async t => {
  const handler = makeTreeRequestHandler({ tree: site() });
  const res = await E(handler)(
    harden({ method: 'HEAD', url: '/style.css', headers: [] }),
  );
  t.is(res.status, 200);
  t.is(res.headers.find(([k]) => k === 'Content-Length')[1], '19');
  t.is(res.body, undefined);
});

test('ETag drives a 304 on If-None-Match', async t => {
  const handler = makeTreeRequestHandler({ tree: site() });
  const first = await get(handler, '/style.css');
  const etag = first.headers.find(([k]) => k === 'ETag')[1];
  t.truthy(etag);
  const second = await get(handler, '/style.css', [['If-None-Match', etag]]);
  t.is(second.status, 304);
  t.is(second.body, undefined); // 304 carries no body
  // A stale ETag re-serves.
  const third = await get(handler, '/style.css', [
    ['If-None-Match', '"stale"'],
  ]);
  t.is(third.status, 200);
});

test('a custom index name is honored', async t => {
  const handler = makeTreeRequestHandler({
    tree: makeTree({ 'main.html': utf8('<h1>hi</h1>') }),
    index: 'main.html',
  });
  const res = await get(handler, '/');
  t.is(res.status, 200);
  t.is(decode(await collectBody(res.body)), '<h1>hi</h1>');
});

test('streams a blob larger than the 100 KB base64 frame cap', async t => {
  // The fake emits the whole payload in one streamBase64 frame, so a payload
  // over ~100 KB exercises readBlobBody's stringLengthLimit lift; a regression
  // that dropped it would reject this with a string-length-cap error.
  const big = new Uint8Array(200_000);
  for (let i = 0; i < big.length; i += 1) {
    big[i] = i % 256;
  }
  const handler = makeTreeRequestHandler({
    tree: makeTree({ 'big.bin': big }),
  });
  const res = await get(handler, '/big.bin');
  t.is(res.status, 200);
  t.is(res.headers.find(([k]) => k === 'Content-Length')[1], '200000');
  const body = await collectBody(res.body);
  t.is(body.length, big.length);
  t.deepEqual(body, big);
});
