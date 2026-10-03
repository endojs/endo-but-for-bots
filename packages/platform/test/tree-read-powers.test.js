// @ts-check

import '@endo/init/debug.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

import test from 'ava';
import { fc } from '@fast-check/ava';
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
  fs.mkdirSync(path.join(appPath, 'lib'));
  fs.writeFileSync(path.join(appPath, 'lib', 'index.js'), 'export default 3;');
  fs.mkdirSync(path.join(appPath, 'node_modules', '@scope', 'p+q'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(appPath, 'node_modules', '@scope', 'p+q', 'index.js'),
    'export default 4;',
  );
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

// A location outside the root names nothing in the tree, so the compartment
// mapper's climb past the root for a missing optional dependency finds
// nothing rather than failing the capture.
const outsideRoot = [
  'file:///outside',
  'file:///node_modules/missing/package.json',
  'https://example.com/app/main.js',
];

for (const location of outsideRoot) {
  test(`a location outside the root is absent: ${JSON.stringify(location)}`, async t => {
    const { spy, calls } = makeSpyTree(makeLocalTree(makeFixture(t)));
    const powers = makeTreeReadPowers(spy);
    await t.throwsAsync(() => powers.read(location), {
      message: /not under root/,
    });
    t.is(await powers.maybeRead(location), undefined);
    t.is(await powers.canonical(location), location);
    t.deepEqual(calls, []);
  });
}

test('maybeRead returns undefined for a directory, and read refuses it', async t => {
  const powers = makeTreeReadPowers(makeLocalTree(makeFixture(t)));
  // `import './lib'` probes the bare candidate before `lib/index.js`.
  t.is(await powers.maybeRead('file:///app/lib'), undefined);
  t.is(await powers.maybeRead('file:///app/node_modules/dep/'), undefined);
  t.is(
    decoder.decode(
      /** @type {Uint8Array} */ (
        await powers.maybeRead('file:///app/lib/index.js')
      ),
    ),
    'export default 3;',
  );
  await t.throwsAsync(() => powers.read('file:///app/lib'), {
    message: /is not a file/,
  });
});

test('scoped and punctuated package names keep their spelling', async t => {
  const tree = makeLocalTree(makeFixture(t));
  const plain = makeTreeReadPowers(tree);
  const hooked = makeTreeReadPowers(tree, { canonical: segments => segments });
  const locations = [
    'file:///app/node_modules/@scope/p+q/',
    'file:///app/node_modules/@scope/p+q/index.js',
    "file:///app/a$b&c,d;e=f:g@h!i'j(k)l*m/",
  ];
  t.deepEqual(await Promise.all(locations.map(plain.canonical)), locations);
  t.deepEqual(await Promise.all(locations.map(hooked.canonical)), locations);
  t.is(
    decoder.decode(
      await plain.read('file:///app/node_modules/@scope/p+q/index.js'),
    ),
    'export default 4;',
  );
  t.is(
    plain.pathToFileURL('/app/node_modules/@scope/p+q/').href,
    'file:///app/node_modules/@scope/p+q/',
  );
});

test('canonical reads a hook result once, ignoring a map override', async t => {
  const powers = makeTreeReadPowers(makeLocalTree(makeFixture(t)), {
    // Under lockdown `map` is a read-only inherited property, so the override
    // is defined rather than assigned.
    canonical: () =>
      Object.defineProperty(['ok'], 'map', {
        value: () => ['..', 'outside'],
      }),
  });
  t.is(await powers.canonical('file:///app/main.js'), 'file:///app/ok');
  let reads = 0;
  const shifty = makeTreeReadPowers(makeLocalTree(makeFixture(t)), {
    canonical: () => {
      const result = ['ok'];
      Object.defineProperty(result, 0, {
        get: () => {
          reads += 1;
          return reads === 1 ? 'ok' : '..';
        },
      });
      return result;
    },
  });
  t.is(await shifty.canonical('file:///app/main.js'), 'file:///app/ok');
  t.is(reads, 1);
});

test('the root must be normalized', t => {
  const tree = makeLocalTree(makeFixture(t));
  for (const root of [
    'file:///a/../b/',
    'file:///app/./',
    'file:///app/%2e%2e/',
    'file:///my app/',
  ]) {
    t.throws(() => makeTreeReadPowers(tree, { root }), {
      message: /must be normalized/,
    });
  }
});

test('fileURLToPath keeps a trailing slash and decodes an encoded root', t => {
  const tree = makeLocalTree(makeFixture(t));
  const powers = makeTreeReadPowers(tree, { root: 'file:///my%20app/' });
  t.is(powers.fileURLToPath('file:///my%20app/dep/'), '/my app/dep/');
  t.is(powers.fileURLToPath('file:///my%20app/a%20b.js'), '/my app/a b.js');
  t.is(
    powers.pathToFileURL('/my app/a b.js').href,
    'file:///my%20app/a%20b.js',
  );
  t.is(
    powers.fileURLToPath('file:///my%20app/dep/'),
    url.fileURLToPath('file:///my%20app/dep/'),
  );
});

// Fragments a hostile compartment map might compose into a location: plain
// and encoded traversal, separators, NUL, empty segments, and benign names.
const pathFragment = fc.constantFrom(
  '',
  '.',
  '..',
  '%2e',
  '%2E%2e',
  '.%2e',
  '%2f',
  '%2F',
  '%5c',
  '%5C',
  '%00',
  '\\',
  '\0',
  '/',
  'main.js',
  'node_modules',
  'dep',
  'index.js',
  'a%20b.js',
  '..%2f..%2foutside',
);

const isSafeSegment = segment =>
  typeof segment === 'string' &&
  segment !== '' &&
  segment !== '.' &&
  segment !== '..' &&
  !segment.includes('/') &&
  !segment.includes('\\') &&
  !segment.includes('\0');

test('every lookup names only validated segments, for any composed location', async t => {
  const appPath = makeFixture(t);
  await fc.assert(
    fc.asyncProperty(fc.array(pathFragment, { maxLength: 6 }), async parts => {
      const { spy, calls } = makeSpyTree(makeLocalTree(appPath));
      const powers = makeTreeReadPowers(spy);
      const location = `file:///app/${parts.join('/')}`;
      await Promise.allSettled([
        powers.read(location),
        powers.maybeRead(location),
        powers.canonical(location),
      ]);
      for (const [, names] of calls) {
        const segments = Array.isArray(names) ? names.flat() : [names];
        if (!segments.every(isSafeSegment)) {
          return false;
        }
      }
      // A traversal segment anywhere refuses the location before any lookup.
      const raw = parts.join('/').split('/');
      const traverses = raw.some(segment =>
        ['.', '..', '%2e', '%2E%2e', '.%2e'].includes(segment),
      );
      return !traverses || calls.length === 0;
    }),
  );
  t.pass();
});

// Segments drawn from a safe alphabet that exercises every escaping rule.
const safeSegment = fc
  .string({
    unit: fc.constantFrom(
      ...'aZ09-_.~!$&\'()*+,;=:@ %#?[]^`{|}"<>é'.split(''),
      '\t',
    ),
    minLength: 1,
    maxLength: 8,
  })
  .filter(segment => segment !== '.' && segment !== '..');

test('the path codec agrees with Node and canonical is the identity', async t => {
  const tree = makeLocalTree(makeFixture(t));
  const plain = makeTreeReadPowers(tree);
  const hooked = makeTreeReadPowers(tree, { canonical: segments => segments });
  await fc.assert(
    fc.asyncProperty(
      fc.array(safeSegment, { minLength: 1, maxLength: 4 }),
      fc.boolean(),
      async (segments, directory) => {
        const filePath = `/app/${segments.join('/')}${directory ? '/' : ''}`;
        const href = plain.pathToFileURL(filePath).href;
        return (
          href === url.pathToFileURL(filePath).href &&
          plain.fileURLToPath(href) === filePath &&
          (await plain.canonical(href)) === href &&
          (await hooked.canonical(href)) === href
        );
      },
    ),
  );
  t.pass();
});

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
