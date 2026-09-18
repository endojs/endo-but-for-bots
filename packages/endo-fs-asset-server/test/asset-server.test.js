// @ts-nocheck
/* eslint-disable no-await-in-loop */

import '@endo/init/debug.js';

import http from 'node:http';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeInMemoryFilesystem } from '@endo/platform/fs/extended';
import { makeNodeHttpBackend } from '@endo/platform/http/node';
import { makeAssetServer, makeAssetServerKit } from '../src/asset-server.js';
import { contentTypeForName, normalizeSegments } from '../src/index.js';

const backend = makeNodeHttpBackend();

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

const startKit = async (t, options = {}) => {
  const kit = await makeAssetServerKit({ backend, getRandomValues, ...options });
  t.teardown(() => E(kit.admin).stop());
  return kit;
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

test.serial('a capability the server cannot take a read-only facet of is refused, not mounted', async t => {
  // Regression: `serve()` once accepted any non-null cap and returned a URL
  // whose every request 404'd. The server now classifies what it is handed —
  // Filesystem, Mount or Git — takes its own read-only facet, and refuses the
  // rest before anything is retained or a URL minted.
  const { admin, publisher } = await startKit(t);

  const sloppy = (label, methods) =>
    makeExo(
      label,
      M.interface(label, {}, { defaultGuards: 'passable' }),
      methods,
    );

  // Neither a Filesystem, a Mount nor a Git workspace.
  await t.throwsAsync(
    () => E(publisher).serve(sloppy('Thing', { lookup: () => undefined })),
    { message: /Filesystem, Mount or Git capability/ },
  );
  // A Git workspace whose read-only facet cannot be taken.
  await t.throwsAsync(() =>
    E(publisher).serve(
      sloppy('Git', {
        worktree: () => undefined,
        status: () => harden({}),
        commit: () => '',
      }),
    ),
  );
  // A Filesystem whose root() does not answer.
  await t.throwsAsync(() =>
    E(publisher).serve(
      sloppy('Filesystem', {
        root: () => {
          throw Error('no root');
        },
        statfs: () => harden({}),
      }),
    ),
  );

  // Nothing was registered or retained for any of them.
  t.deepEqual(await E(admin).list(), []);
  const { url } = await E(publisher).serve(await makeSiteFs());
  t.is((await httpGet(url)).status, 200);
});

/** A store shared by successive servers, the way a durable one is. */
const makeSharedStore = () => {
  const facets = new Map();
  const records = new Map();
  const broken = new Set();
  const failRelease = { count: 0 };
  return {
    facets,
    records,
    failRelease,
    breakTarget: id => broken.add(id),
    mendTarget: id => broken.delete(id),
    store: harden({
      retain: async (id, target) => {
        facets.set(id, target);
        return target;
      },
      record: async record => {
        records.set(record.id, record);
      },
      load: async () => [...records.values()],
      recall: async id => {
        if (broken.has(id) || !facets.has(id)) throw Error('target is gone');
        return facets.get(id);
      },
      release: async id => {
        if (failRelease.count > 0) {
          failRelease.count -= 1;
          throw Error('store is unreachable');
        }
        const had = facets.delete(id);
        return records.delete(id) || had;
      },
    }),
  };
};

test.serial('routes are restored from the store by the next server, with nobody serving again', async t => {
  const shared = makeSharedStore();
  const first = await makeAssetServerKit({
    backend,
    getRandomValues,
    store: shared.store,
  });
  const kept = await E(first.publisher).serve(await makeSiteFs(), {
    label: 'kept',
  });
  const dropped = await E(first.publisher).serve(await makeSiteFs());
  await E(dropped.revoke).revoke();
  t.true(await E(dropped.revoke).isRevoked());
  // Stopping releases nothing.
  await E(first.admin).stop();
  t.is(shared.records.size, 1);

  const second = await startKit(t, { store: shared.store });
  const { origin } = await E(second.admin).getAddress();
  t.is((await httpGet(`${origin}${kept.path}`)).text, '<h1>home</h1>');
  t.is((await httpGet(`${origin}${dropped.path}`)).status, 404);
  const [listed] = await E(second.admin).list();
  t.like(listed, { id: kept.id, path: kept.path, label: 'kept', status: 'ready' });
  t.is((await E(second.admin).list()).length, 1);
});

test.serial('a route whose target cannot be revived is kept, answers 503, and recovers', async t => {
  const shared = makeSharedStore();
  const first = await makeAssetServerKit({
    backend,
    getRandomValues,
    store: shared.store,
  });
  const served = await E(first.publisher).serve(await makeSiteFs());
  await E(first.admin).stop();

  shared.breakTarget(served.id);
  let clock = 1000;
  const second = await startKit(t, { store: shared.store, now: () => clock });
  const { origin } = await E(second.admin).getAddress();
  const unavailable = await httpGet(`${origin}${served.path}`);
  t.is(unavailable.status, 503);
  t.is(unavailable.headers['retry-after'], '5');
  t.like((await E(second.admin).list())[0], {
    id: served.id,
    status: 'unavailable',
    error: 'target is gone',
  });
  // Only a revocation ends a route: the record is still there.
  t.is(shared.records.size, 1);

  // A failure is remembered for as long as the Retry-After it was answered
  // with, so a dead target does not cost a store lookup per request...
  shared.mendTarget(served.id);
  t.is((await httpGet(`${origin}${served.path}`)).status, 503);
  // ...and no longer.
  clock += 5001;
  t.is((await httpGet(`${origin}${served.path}`)).status, 200);
  t.like((await E(second.admin).list())[0], { status: 'ready' });
});

test.serial('the administrator lists and removes; the publisher serves and releases its own', async t => {
  const { root, admin, publisher } = await startKit(t);
  // eslint-disable-next-line no-underscore-dangle
  const adminMethods = await E(admin).__getMethodNames__();
  // eslint-disable-next-line no-underscore-dangle
  const publisherMethods = await E(publisher).__getMethodNames__();
  for (const name of ['serve', 'publisher', 'release']) {
    t.false(adminMethods.includes(name), `an administrator cannot ${name}`);
  }
  for (const name of ['list', 'getTarget', 'revoke', 'stop', 'admin']) {
    t.false(publisherMethods.includes(name), name);
  }
  t.is(await E(root).admin(), admin);
  t.is(await E(root).publisher(), publisher);

  const one = await E(publisher).serve(await makeSiteFs(), { label: 'one' });
  const two = await E(publisher).serve(await makeSiteFs(), { label: 'two' });
  t.deepEqual(
    (await E(admin).list()).map(item => item.label).sort(),
    ['one', 'two'],
  );

  // The administrator reaches the retained facet, and it does not write.
  const facet = await E(admin).getTarget(one.id);
  const facetRoot = await E(facet).root();
  await t.throwsAsync(E(facetRoot).create('defaced.html', {}));
  await t.throwsAsync(E(admin).getTarget('f'.repeat(32)), {
    message: /no served item/,
  });

  t.true(await E(admin).revoke(one.id));
  t.false(await E(admin).revoke(one.id), 'idempotent');
  t.is((await httpGet(one.url)).status, 404);
  t.is(await E(publisher).describe(one.id), undefined);
  t.like(await E(publisher).describe(two.id), { url: two.url, label: 'two' });
  t.false('error' in (await E(publisher).describe(two.id)));
  t.true(await E(publisher).release(two.id));
  t.is((await httpGet(two.url)).status, 404);
  t.deepEqual(await E(admin).list(), []);
});

test.serial('serve validates its options before it retains anything', async t => {
  const shared = makeSharedStore();
  const { publisher } = await startKit(t, { store: shared.store });
  const fs = await makeSiteFs();
  await t.throwsAsync(E(publisher).serve(fs, { index: '' }));
  await t.throwsAsync(E(publisher).serve(fs, { subPath: '../up' }));
  await t.throwsAsync(E(publisher).serve(fs, { label: 'x'.repeat(257) }));
  t.is(shared.facets.size, 0);
  t.is(shared.records.size, 0);
});

test.serial('a release that fails can be repeated, and a revoked URL does not come back', async t => {
  const shared = makeSharedStore();
  const first = await makeAssetServerKit({
    backend,
    getRandomValues,
    store: shared.store,
  });
  const served = await E(first.publisher).serve(await makeSiteFs());

  shared.failRelease.count = 1;
  await t.throwsAsync(E(first.admin).revoke(served.id), {
    message: /unreachable/,
  });
  // It stopped serving at once, and the record is still in the store...
  t.is((await httpGet(served.url)).status, 404);
  t.is(shared.records.size, 1);
  t.false(await E(served.revoke).isRevoked() && shared.records.size === 0);
  // ...so the release is repeated until it holds, though this incarnation
  // no longer knows the id.
  t.true(await E(first.admin).revoke(served.id));
  t.is(shared.records.size, 0);
  await E(first.admin).stop();

  const second = await startKit(t, { store: shared.store });
  const { origin } = await E(second.admin).getAddress();
  t.is((await httpGet(`${origin}${served.path}`)).status, 404);
  t.deepEqual(await E(second.admin).list(), []);
});

test.serial('a stopped server still lists and releases what the next one would serve', async t => {
  const shared = makeSharedStore();
  const first = await makeAssetServerKit({
    backend,
    getRandomValues,
    store: shared.store,
  });
  const served = await E(first.publisher).serve(await makeSiteFs());
  await E(first.admin).stop();

  t.is((await E(first.admin).list()).length, 1);
  await t.throwsAsync(E(first.publisher).serve(await makeSiteFs()), {
    message: /stopped/,
  });
  t.true(await E(first.publisher).release(served.id));
  t.is(shared.records.size, 0);

  const second = await startKit(t, { store: shared.store });
  t.deepEqual(await E(second.admin).list(), []);
});

test.serial('routes are in place before the listener answers', async t => {
  // A store slow to load must delay the listener, not leave a window in
  // which a valid URL is told 404.
  const shared = makeSharedStore();
  const first = await makeAssetServerKit({
    backend,
    getRandomValues,
    store: shared.store,
  });
  const served = await E(first.publisher).serve(await makeSiteFs());
  const { port } = await E(first.admin).getAddress();
  await E(first.admin).stop();

  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const slow = harden({
    ...shared.store,
    load: async () => {
      await gate;
      return shared.store.load();
    },
  });
  const starting = makeAssetServerKit({
    backend,
    getRandomValues,
    port,
    store: slow,
  });
  const early = await httpGet(`http://127.0.0.1:${port}${served.path}`).catch(
    error => error.code,
  );
  t.is(early, 'ECONNREFUSED');
  release();
  const second = await starting;
  t.teardown(() => E(second.admin).stop());
  t.is(
    (await httpGet(`http://127.0.0.1:${port}${served.path}`)).status,
    200,
  );
});

test.serial('a store that cannot be read fails the server with nothing bound', async t => {
  const broken = harden({
    ...makeSharedStore().store,
    load: async () => {
      throw Error('pet store is unreachable');
    },
  });
  const probe = await startKit(t);
  const { port } = await E(probe.admin).getAddress();
  await E(probe.admin).stop();
  await t.throwsAsync(
    makeAssetServerKit({ backend, getRandomValues, port, store: broken }),
    { message: /unreachable/ },
  );
  // The port is free: the next attempt binds it.
  const retry = await startKit(t, { port });
  t.is((await E(retry.admin).getAddress()).port, port);
});

test.serial('serve by a caller-chosen id is idempotent, so a recorded id is never lost', async t => {
  const { admin, publisher } = await startKit(t);
  const id = 'ab'.repeat(16);
  const fs = await makeSiteFs();
  const first = await E(publisher).serve(fs, { id, label: 'mine' });
  const again = await E(publisher).serve(fs, { id, label: 'ignored' });
  t.is(first.id, id);
  t.is(again.url, first.url);
  t.is((await E(admin).list()).length, 1);
  await t.throwsAsync(E(publisher).serve(fs, { id: 'not-an-id' }));
  await E(again.revoke).revoke();
  t.is((await httpGet(first.url)).status, 404);
});

test.serial('an unreadable record is listed and removable, not hidden', async t => {
  const shared = makeSharedStore();
  const id = 'cd'.repeat(16);
  const store = harden({
    ...shared.store,
    load: async () => [{ id, unreadable: 'lookup failed' }],
    release: async released => {
      t.is(released, id);
      return true;
    },
  });
  const { admin, publisher } = await startKit(t, { store });
  t.deepEqual(await E(admin).list(), [
    { id, status: 'unreadable', error: 'lookup failed' },
  ]);
  t.is(await E(publisher).describe(id), undefined);
  t.true(await E(admin).revoke(id));
  t.deepEqual(await E(admin).list(), []);
});

test.serial('the repository beside a published worktree is not served', async t => {
  const { publisher } = await startKit(t);
  const fs = makeInMemoryFilesystem();
  const root = await E(fs).root();
  await writeFileAt(root, ['index.html'], utf8('<h1>home</h1>'));
  await writeFileAt(root, ['.git', 'config'], utf8('[core]'));
  const { url } = await E(publisher).serve(fs);
  t.is((await httpGet(url)).status, 200);
  t.is((await httpGet(`${url}.git/config`)).status, 404);
  t.is((await httpGet(`${url}sub/.git/config`)).status, 404);
});

test.serial('two serves of one id are one route, and a release waits for the serve it is for', async t => {
  const { admin, publisher } = await startKit(t);
  const id = 'ef'.repeat(16);
  const fs = await makeSiteFs();
  const [one, two] = await Promise.all([
    E(publisher).serve(fs, { id }),
    E(publisher).serve(fs, { id }),
  ]);
  t.is(one.url, two.url);
  t.is((await E(admin).list()).length, 1);

  const other = '12'.repeat(16);
  const serving = E(publisher).serve(fs, { id: other });
  const releasing = E(publisher).release(other);
  const served = await serving;
  t.true(await releasing, 'the release saw the route the serve made');
  t.is((await httpGet(served.url)).status, 404);
  t.is((await E(admin).list()).length, 1);
});

test.serial('check() asks the target now, where describe() reports the last failure', async t => {
  const shared = makeSharedStore();
  const first = await makeAssetServerKit({
    backend,
    getRandomValues,
    store: shared.store,
  });
  const served = await E(first.publisher).serve(await makeSiteFs());
  await E(first.admin).stop();

  shared.breakTarget(served.id);
  const clock = 1000;
  const second = await startKit(t, { store: shared.store, now: () => clock });
  const { origin } = await E(second.admin).getAddress();
  t.is((await httpGet(`${origin}${served.path}`)).status, 503);
  shared.mendTarget(served.id);
  // Still inside the backoff, and nothing has asked again.
  t.like(await E(second.publisher).describe(served.id), { status: 'unavailable' });
  t.like(await E(second.publisher).check(served.id), { status: 'ready' });
  t.is(await E(second.publisher).check('0'.repeat(32)), undefined);
});
