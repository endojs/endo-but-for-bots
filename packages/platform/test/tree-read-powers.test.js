// @ts-check

import '@endo/init/debug.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import test from 'ava';
import { E } from '@endo/eventual-send';

import { makeLocalTree } from '../src/fs-node/local-tree.js';
import { makeTreeReadPowers } from '../src/fs/tree-read-powers.js';

const decoder = new TextDecoder();

// A tree with a package, a nested `node_modules` dependency, and a file
// beside the tree root that no location may reach.
const makeFixture = t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-read-powers-'));
  t.teardown(() => fs.rmSync(parent, { recursive: true, force: true }));
  fs.writeFileSync(path.join(parent, 'outside'), 'secret');
  const appPath = path.join(parent, 'app');
  fs.mkdirSync(path.join(appPath, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(appPath, 'package.json'), '{"name":"app"}');
  fs.writeFileSync(path.join(appPath, 'main.js'), 'export default 1;');
  fs.writeFileSync(
    path.join(appPath, 'node_modules', 'dep', 'index.js'),
    'export default 2;',
  );
  fs.writeFileSync(path.join(appPath, 'a b.js'), 'spaced');
  return appPath;
};

// Wrap a tree so the test can see whether any lookup reached it.
const makeSpyTree = tree => {
  const calls = [];
  const spy = harden({
    lookup: name => {
      calls.push(['lookup', name]);
      return E(tree).lookup(name);
    },
    has: (...names) => {
      calls.push(['has', names]);
      return E(tree).has(...names);
    },
    list: (...names) => {
      calls.push(['list', names]);
      return E(tree).list(...names);
    },
  });
  return { spy, calls };
};

test('read returns the bytes of a file under the synthetic root', async t => {
  const powers = makeTreeReadPowers(makeLocalTree(makeFixture(t)));
  t.is(
    decoder.decode(await powers.read('file:///app/package.json')),
    '{"name":"app"}',
  );
  t.is(
    decoder.decode(await powers.read('file:///app/node_modules/dep/index.js')),
    'export default 2;',
  );
  t.is(decoder.decode(await powers.read('file:///app/a%20b.js')), 'spaced');
});

test('a custom root is honored', async t => {
  const powers = makeTreeReadPowers(makeLocalTree(makeFixture(t)), {
    root: 'file:///work/',
  });
  t.is(
    decoder.decode(await powers.read('file:///work/main.js')),
    'export default 1;',
  );
  await t.throwsAsync(() => powers.read('file:///app/main.js'), {
    message: /not under root/,
  });
  t.throws(
    () =>
      makeTreeReadPowers(makeLocalTree(makeFixture(t)), {
        root: 'file:///work',
      }),
    {
      message: /must be a file: URL ending in "\/"/,
    },
  );
});

test('maybeRead returns undefined for a missing entry', async t => {
  const powers = makeTreeReadPowers(makeLocalTree(makeFixture(t)));
  t.is(
    await powers.maybeRead('file:///app/node_modules/missing/package.json'),
    undefined,
  );
  t.is(await powers.maybeRead('file:///app/nope.js'), undefined);
  t.is(
    decoder.decode(
      /** @type {Uint8Array} */ (await powers.maybeRead('file:///app/main.js')),
    ),
    'export default 1;',
  );
});

test('maybeRead returns undefined when an intermediate segment is a file', async t => {
  const powers = makeTreeReadPowers(makeLocalTree(makeFixture(t)));
  t.is(await powers.maybeRead('file:///app/main.js/package.json'), undefined);
  t.is(
    await powers.maybeRead('file:///app/package.json/node_modules/x/y.js'),
    undefined,
  );
});

test('maybeRead returns undefined for an entry removed during the lookup', async t => {
  const appPath = makeFixture(t);
  const tree = makeLocalTree(appPath);
  // The entry is present when asked, then gone when looked up.
  const racing = harden({
    has: (...names) => E(tree).has(...names),
    list: (...names) => E(tree).list(...names),
    lookup: async name => {
      fs.rmSync(path.join(appPath, 'main.js'), { force: true });
      return E(tree).lookup(name);
    },
  });
  const powers = makeTreeReadPowers(racing);
  t.is(await powers.maybeRead('file:///app/main.js'), undefined);
});

test('maybeRead surfaces a lookup error for an entry that is present', async t => {
  const tree = makeLocalTree(makeFixture(t));
  const failing = harden({
    has: (...names) => E(tree).has(...names),
    list: (...names) => E(tree).list(...names),
    lookup: async () => {
      throw Error('backend unavailable');
    },
  });
  const powers = makeTreeReadPowers(failing);
  await t.throwsAsync(() => powers.maybeRead('file:///app/main.js'), {
    message: 'backend unavailable',
  });
});

test('the package exports makeTreeReadPowers by its own path', async t => {
  const exported = await import('@endo/platform/fs/tree-read-powers');
  t.is(exported.makeTreeReadPowers, makeTreeReadPowers);
});

const escapes = [
  'file:///app/../outside',
  'file:///app/node_modules/../../outside',
  'file:///app/%2e%2e/outside',
  'file:///app/./main.js',
  'file:///app//main.js',
  'file:///app/node_modules%2F..%2F..%2Foutside',
  'file:///app/node_modules%2f..%2f..%2foutside',
  'file:///app/node_modules%5C..%5Coutside',
  'file:///app/main.js%00',
  'file:///app/main.js\u0000',
  'file:///app/node_modules\u0000/dep/index.js',
  'file:///app/node_modules\\..\\..\\outside',
  'file:///outside',
  'https://example.com/app/main.js',
];

for (const location of escapes) {
  test(`segment confinement refuses ${JSON.stringify(location)} before any lookup`, async t => {
    const { spy, calls } = makeSpyTree(makeLocalTree(makeFixture(t)));
    const powers = makeTreeReadPowers(spy);
    await t.throwsAsync(() => powers.read(location));
    await t.throwsAsync(() => powers.maybeRead(location));
    await t.throwsAsync(() => powers.canonical(location));
    t.deepEqual(calls, []);
  });
}

test('canonical defaults to the identity', async t => {
  const powers = makeTreeReadPowers(makeLocalTree(makeFixture(t)));
  t.is(
    await powers.canonical('file:///app/node_modules/dep/'),
    'file:///app/node_modules/dep/',
  );
  t.is(await powers.canonical('file:///app/main.js'), 'file:///app/main.js');
});

test('canonical applies the hook and confines its result', async t => {
  const tree = makeLocalTree(makeFixture(t));
  const powers = makeTreeReadPowers(tree, {
    canonical: segments =>
      segments[0] === 'linked'
        ? ['node_modules', ...segments.slice(1)]
        : segments,
  });
  t.is(
    await powers.canonical('file:///app/linked/dep/'),
    'file:///app/node_modules/dep/',
  );
  const escaping = makeTreeReadPowers(tree, {
    canonical: () => ['..', 'outside'],
  });
  await t.throwsAsync(() => escaping.canonical('file:///app/main.js'), {
    message: /Relative path segment/,
  });
});

test('fileURLToPath and pathToFileURL round-trip under the root', t => {
  const powers = makeTreeReadPowers(makeLocalTree(makeFixture(t)));
  t.is(powers.fileURLToPath('file:///app/a%20b.js'), '/app/a b.js');
  t.is(powers.pathToFileURL('/app/a b.js').href, 'file:///app/a%20b.js');
  t.throws(() => powers.pathToFileURL('/app/../outside'));
  t.throws(() => powers.pathToFileURL('/etc/passwd'));
});

test('the tree root and non-string locations are refused', async t => {
  const { spy, calls } = makeSpyTree(makeLocalTree(makeFixture(t)));
  const powers = makeTreeReadPowers(spy);
  await t.throwsAsync(() => powers.read('file:///app/'), {
    message: /Cannot read the tree root as a file/,
  });
  t.is(await powers.maybeRead('file:///app/'), undefined);
  t.is(await powers.canonical('file:///app/'), 'file:///app/');
  // @ts-expect-error deliberately not a string
  await t.throwsAsync(() => powers.read(42), {
    message: /must be a string/,
  });
  t.deepEqual(calls, []);
});

test('canonical refuses a hook result that is not an array', async t => {
  const powers = makeTreeReadPowers(makeLocalTree(makeFixture(t)), {
    // @ts-expect-error deliberately not an array
    canonical: () => 'node_modules',
  });
  await t.throwsAsync(() => powers.canonical('file:///app/main.js'), {
    message: /canonical hook must return an array of segments/,
  });
});

test('canonical refuses a hook result with a non-string segment', async t => {
  const powers = makeTreeReadPowers(makeLocalTree(makeFixture(t)), {
    // @ts-expect-error deliberately not a string segment
    canonical: () => ['node_modules', 42],
  });
  await t.throwsAsync(() => powers.canonical('file:///app/main.js'), {
    message: /non-string segment/,
  });
});
