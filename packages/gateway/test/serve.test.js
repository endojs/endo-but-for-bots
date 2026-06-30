// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import { E } from '@endo/far';

import {
  makeAppsNameHub,
  makeWebletResolver,
  makeGateway,
  normalizeRequestPath,
} from '../index.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytesOf = text => encoder.encode(text);

/**
 * An in-memory `readable-tree` fake built from a flat `path -> text`
 * map. `lookup` of a file returns a readable with `bytes()`; `lookup`
 * of a directory prefix returns a child tree with no `bytes()`, which
 * is how the resolver distinguishes a file from a directory.
 *
 * @param {Record<string, string>} files
 */
const makeFakeContentTree = files => {
  const keyOf = nameOrPath =>
    Array.isArray(nameOrPath) ? nameOrPath.join('/') : nameOrPath;
  const isDirPrefix = key =>
    Object.keys(files).some(p => p.startsWith(`${key}/`));
  const tree = harden({
    async has(nameOrPath) {
      const key = keyOf(nameOrPath);
      return (
        Object.prototype.hasOwnProperty.call(files, key) || isDirPrefix(key)
      );
    },
    async lookup(nameOrPath) {
      const key = keyOf(nameOrPath);
      if (Object.prototype.hasOwnProperty.call(files, key)) {
        return harden({
          async bytes() {
            return bytesOf(files[key]);
          },
        });
      }
      if (isDirPrefix(key)) {
        // A subdirectory: a readable-tree, not a file. No `bytes()`.
        return tree;
      }
      throw new Error(`no such path: ${key}`);
    },
  });
  return tree;
};

/**
 * An in-memory content resolver fake. `formulas` maps a weblet
 * formula id to its `WebletFormula`; `trees` maps a content-address
 * root to its content tree. Records `fetchContentTree` call counts
 * per root so a test can assert the CAS cache populates only once.
 *
 * @param {object} args
 * @param {Record<string, import('../types.d.ts').WebletFormula>} args.formulas
 * @param {Record<string, ReturnType<typeof makeFakeContentTree>>} args.trees
 */
const makeFakeResolver = ({ formulas, trees }) => {
  /** @type {Record<string, number>} */
  const fetchCounts = {};
  const resolver = harden({
    async resolveWebletFormula(webletFormulaId) {
      const formula = formulas[webletFormulaId];
      if (formula === undefined) {
        throw new Error(`no weblet formula: ${webletFormulaId}`);
      }
      return formula;
    },
    async fetchContentTree(contentRoot) {
      fetchCounts[contentRoot] = (fetchCounts[contentRoot] ?? 0) + 1;
      const tree = trees[contentRoot];
      if (tree === undefined) {
        throw new Error(`no content tree: ${contentRoot}`);
      }
      return tree;
    },
  });
  return { resolver, fetchCounts };
};

test('normalizeRequestPath defaults the root to index.html', t => {
  t.deepEqual(normalizeRequestPath('/'), ['index.html']);
  t.deepEqual(normalizeRequestPath(''), ['index.html']);
  t.deepEqual(normalizeRequestPath('/assets/'), ['assets', 'index.html']);
});

test('normalizeRequestPath splits and collapses segments', t => {
  t.deepEqual(normalizeRequestPath('/assets/app.js'), ['assets', 'app.js']);
  t.deepEqual(normalizeRequestPath('//assets//app.js'), ['assets', 'app.js']);
  t.deepEqual(normalizeRequestPath('/./assets/./app.js'), ['assets', 'app.js']);
});

test('normalizeRequestPath rejects traversal and NUL', t => {
  t.is(normalizeRequestPath('/../secret'), undefined);
  t.is(normalizeRequestPath('/assets/../../etc/passwd'), undefined);
  t.is(normalizeRequestPath('/a\0b'), undefined);
});

test('normalizeRequestPath strips a query and fragment', t => {
  t.deepEqual(normalizeRequestPath('/app.js?v=2'), ['app.js']);
  t.deepEqual(normalizeRequestPath('/app.js#top'), ['app.js']);
});

test('serve returns 200 with bytes and inferred MIME on a hit', async t => {
  const apps = makeAppsNameHub();
  await E(apps).bind('weblet-chat', 'weblet-chat');
  const tree = makeFakeContentTree({
    'index.html': '<!doctype html><title>chat</title>',
  });
  const { resolver } = makeFakeResolver({
    formulas: {
      'weblet-chat': harden({ type: 'weblet', contentRoot: 'root-1' }),
    },
    trees: { 'root-1': tree },
  });
  const serving = makeWebletResolver({ apps, content: resolver });

  const result = await E(serving).serve('weblet-chat', '/');
  t.is(result.status, 200);
  t.is(result.status === 200 && result.mimeType, 'text/html; charset=utf-8');
  t.is(
    result.status === 200 && decoder.decode(result.bytes),
    '<!doctype html><title>chat</title>',
  );
  t.deepEqual(result.status === 200 && result.path, ['index.html']);
});

test('serve populates the CAS cache once across repeated requests', async t => {
  const apps = makeAppsNameHub();
  await E(apps).bind('weblet-chat', 'weblet-chat');
  const tree = makeFakeContentTree({
    'index.html': 'home',
    'app.js': 'console.log(1)',
  });
  const { resolver, fetchCounts } = makeFakeResolver({
    formulas: {
      'weblet-chat': harden({ type: 'weblet', contentRoot: 'root-1' }),
    },
    trees: { 'root-1': tree },
  });
  const serving = makeWebletResolver({ apps, content: resolver });

  const first = await E(serving).serve('weblet-chat', '/index.html');
  t.is(first.status, 200);
  // Cache miss populated the tree exactly once.
  t.is(fetchCounts['root-1'], 1);

  const second = await E(serving).serve('weblet-chat', '/app.js');
  t.is(second.status, 200);
  // Second request for the same root is a cache hit; no refetch.
  t.is(fetchCounts['root-1'], 1);
});

test('serve concurrent requests for one root fetch the tree once', async t => {
  const apps = makeAppsNameHub();
  await E(apps).bind('weblet-chat', 'weblet-chat');
  const tree = makeFakeContentTree({ 'index.html': 'home' });
  const { resolver, fetchCounts } = makeFakeResolver({
    formulas: {
      'weblet-chat': harden({ type: 'weblet', contentRoot: 'root-1' }),
    },
    trees: { 'root-1': tree },
  });
  const serving = makeWebletResolver({ apps, content: resolver });

  const [a, b] = await Promise.all([
    E(serving).serve('weblet-chat', '/'),
    E(serving).serve('weblet-chat', '/'),
  ]);
  t.is(a.status, 200);
  t.is(b.status, 200);
  t.is(fetchCounts['root-1'], 1);
});

test('serve applies a MIME override and otherwise infers', async t => {
  const apps = makeAppsNameHub();
  await E(apps).bind('weblet-data', 'weblet-data');
  const tree = makeFakeContentTree({
    'index.html': '<html>',
    'data.bin': 'opaque',
    'feed.xml': '<rss/>',
  });
  const { resolver } = makeFakeResolver({
    formulas: {
      'weblet-data': harden({
        type: 'weblet',
        contentRoot: 'root-data',
        // Override the default for `bin` and re-map `xml`.
        mimeTypes: harden({
          bin: 'application/x-thing',
          xml: 'application/rss+xml',
        }),
      }),
    },
    trees: { 'root-data': tree },
  });
  const serving = makeWebletResolver({ apps, content: resolver });

  const html = await E(serving).serve('weblet-data', '/index.html');
  // No override for html: inferred from the built-in table.
  t.is(html.status === 200 && html.mimeType, 'text/html; charset=utf-8');

  const bin = await E(serving).serve('weblet-data', '/data.bin');
  // Override beats the default octet-stream.
  t.is(bin.status === 200 && bin.mimeType, 'application/x-thing');

  const xml = await E(serving).serve('weblet-data', '/feed.xml');
  // Override beats the built-in `application/xml` inference.
  t.is(xml.status === 200 && xml.mimeType, 'application/rss+xml');
});

test('serve returns 404 unknown-host for an unbound Host', async t => {
  const apps = makeAppsNameHub();
  // Bound vs unbound: one host is registered, the other is not.
  await E(apps).bind('weblet-known', 'weblet-known');
  const tree = makeFakeContentTree({ 'index.html': 'home' });
  const { resolver } = makeFakeResolver({
    formulas: {
      'weblet-known': harden({ type: 'weblet', contentRoot: 'root-1' }),
    },
    trees: { 'root-1': tree },
  });
  const serving = makeWebletResolver({ apps, content: resolver });

  const bound = await E(serving).serve('weblet-known', '/');
  t.is(bound.status, 200);

  const unbound = await E(serving).serve('weblet-unknown', '/');
  t.is(unbound.status, 404);
  t.is(unbound.status === 404 && unbound.reason, 'unknown-host');
});

test('serve returns 404 not-found for a missing file with no SSR handler', async t => {
  const apps = makeAppsNameHub();
  await E(apps).bind('weblet-chat', 'weblet-chat');
  const tree = makeFakeContentTree({ 'index.html': 'home' });
  const { resolver } = makeFakeResolver({
    formulas: {
      'weblet-chat': harden({ type: 'weblet', contentRoot: 'root-1' }),
    },
    trees: { 'root-1': tree },
  });
  const serving = makeWebletResolver({ apps, content: resolver });

  const result = await E(serving).serve('weblet-chat', '/missing.html');
  t.is(result.status, 404);
  t.is(result.status === 404 && result.reason, 'not-found');
});

test('serve returns 404 not-found for a directory path', async t => {
  const apps = makeAppsNameHub();
  await E(apps).bind('weblet-chat', 'weblet-chat');
  const tree = makeFakeContentTree({ 'assets/app.js': 'x' });
  const { resolver } = makeFakeResolver({
    formulas: {
      'weblet-chat': harden({ type: 'weblet', contentRoot: 'root-1' }),
    },
    trees: { 'root-1': tree },
  });
  const serving = makeWebletResolver({ apps, content: resolver });

  // `/assets` resolves to a subtree, not a file: no bytes to serve.
  const result = await E(serving).serve('weblet-chat', '/assets');
  t.is(result.status, 404);
  t.is(result.status === 404 && result.reason, 'not-found');
});

test('serve returns 404 invalid-path for traversal', async t => {
  const apps = makeAppsNameHub();
  await E(apps).bind('weblet-chat', 'weblet-chat');
  const tree = makeFakeContentTree({ 'index.html': 'home' });
  const { resolver } = makeFakeResolver({
    formulas: {
      'weblet-chat': harden({ type: 'weblet', contentRoot: 'root-1' }),
    },
    trees: { 'root-1': tree },
  });
  const serving = makeWebletResolver({ apps, content: resolver });

  const result = await E(serving).serve('weblet-chat', '/../../etc/passwd');
  t.is(result.status, 404);
  t.is(result.status === 404 && result.reason, 'invalid-path');
});

test('serve returns the 501 SSR seam on a static miss when ssrHandler is set', async t => {
  const apps = makeAppsNameHub();
  await E(apps).bind('weblet-app', 'weblet-app');
  const tree = makeFakeContentTree({ 'index.html': 'home' });
  const { resolver } = makeFakeResolver({
    formulas: {
      'weblet-app': harden({
        type: 'weblet',
        contentRoot: 'root-1',
        ssrHandler: 'ssr-handler-id',
      }),
    },
    trees: { 'root-1': tree },
  });
  const serving = makeWebletResolver({ apps, content: resolver });

  // A static hit still serves from the tree even when an SSR
  // handler is declared (static-CAS-first).
  const hit = await E(serving).serve('weblet-app', '/');
  t.is(hit.status, 200);

  // A static miss falls through to the SSR seam (not yet wired).
  const miss = await E(serving).serve('weblet-app', '/dynamic/route');
  t.is(miss.status, 501);
  t.is(miss.status === 501 && miss.reason, 'ssr-not-wired');
  t.is(miss.status === 501 && miss.ssrHandler, 'ssr-handler-id');
});

test('serve rejects a formula that is not a weblet', async t => {
  const apps = makeAppsNameHub();
  await E(apps).bind('not-a-weblet', 'not-a-weblet');
  const { resolver } = makeFakeResolver({
    formulas: {
      // @ts-expect-error intentional: a non-weblet formula shape.
      'not-a-weblet': harden({ type: 'readable-blob', contentRoot: 'root-1' }),
    },
    trees: {},
  });
  const serving = makeWebletResolver({ apps, content: resolver });

  await t.throwsAsync(() => E(serving).serve('not-a-weblet', '/'), {
    message: /type 'weblet'/,
  });
});

test('makeWebletResolver requires both apps and content', t => {
  const apps = makeAppsNameHub();
  t.throws(
    // @ts-expect-error intentional: missing content
    () => makeWebletResolver({ apps }),
    { message: /requires both/ },
  );
});

test('makeGateway exposes a weblet resolver only when powers.content is wired', async t => {
  await null; // safe-await-separator (Jessie discipline).
  const plain = makeGateway();
  t.is(await E(plain).getWebletResolver(), undefined);

  const apps = makeAppsNameHub();
  const tree = makeFakeContentTree({ 'index.html': 'home' });
  const { resolver } = makeFakeResolver({
    formulas: {
      'weblet-chat': harden({ type: 'weblet', contentRoot: 'root-1' }),
    },
    trees: { 'root-1': tree },
  });
  const gateway = makeGateway({ powers: { content: resolver } });
  const serving = await E(gateway).getWebletResolver();
  if (!serving) {
    t.fail('expected a weblet resolver when powers.content is wired');
    return;
  }
  // The gateway's own @apps table drives the route.
  const gatewayApps = await E(gateway).getApps();
  await E(gatewayApps).bind('weblet-chat', 'weblet-chat');
  const result = await E(serving).serve('weblet-chat', '/');
  t.is(result.status, 200);
  t.is(result.status === 200 && decoder.decode(result.bytes), 'home');
  // `apps` is a separate hub here, unused: assert the wiring used the
  // gateway's own.
  t.false(await E(apps).has('weblet-chat'));
});
