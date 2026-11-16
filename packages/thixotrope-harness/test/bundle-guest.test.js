// @ts-check
import test from '@endo/ses-ava/test.js';

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  bundleGuest,
  listGuestPrograms,
  parseBundleArgs,
} from '../scripts/bundle-guest.mjs';
import { harnessRoot, scratch } from './_helpers.js';

const fixtureRoot = path.join(harnessRoot, 'test', 'fixtures', 'guest');
const tinyEntry = path.join(fixtureRoot, 'tiny', 'main.js');

/**
 * Evaluate a bundle in a compartment whose globals are a stand-in prelude.
 * @param {string} source
 * @param {Record<string, unknown>} globals
 */
const evaluateBundle = (source, globals) =>
  new Compartment({ globals: harden(globals), __options__: true }).evaluate(
    source,
  );

test('a guest program bundles into one source whose value is its namespace', async t => {
  const bundle = await bundleGuest(tinyEntry);
  t.is(bundle.guestRoot, fixtureRoot);
  t.deepEqual(bundle.modules, ['tiny/main.js', 'tiny/words.js']);
  t.is(typeof bundle.source, 'string');
  t.is(bundle.bytes, new TextEncoder().encode(bundle.source).length);
  t.regex(bundle.digest, /^[0-9a-f]{64}$/);

  // Stand-ins for the prelude names the fixture reads off globalThis.
  const calls = [];
  const namespace = evaluateBundle(bundle.source, {
    Far: (/** @type {string} */ name, /** @type {object} */ methods) => {
      calls.push(['Far', name]);
      return methods;
    },
    M: { arrayOf: () => 'arrayOf', string: () => 'string' },
    mustMatch: (/** @type {unknown} */ value, /** @type {unknown} */ shape) =>
      calls.push(['mustMatch', shape]),
  });
  t.deepEqual(Object.keys(namespace), ['make']);
  const tiny = namespace.make();
  t.is(tiny.say(['two', 'words']), 'two words');
  t.deepEqual(calls, [
    ['Far', 'Tiny'],
    ['mustMatch', 'arrayOf'],
  ]);
});

test('the bundle carries no copy of @endo/patterns or any other package', async t => {
  const { source, modules } = await bundleGuest(tinyEntry);
  t.true(modules.every(m => !m.includes('node_modules')));
  t.false(source.includes('node_modules'));
  // makeBundle heads each module with "// === <n>. <package> <path> ===".
  const heads = [...source.matchAll(/^\/\/ === \d+\. (\S+) (\S+) ===$/gm)].map(
    ([, pkg, file]) => `${pkg} ${file}`,
  );
  t.deepEqual(heads.sort(), ['guest ./tiny/main.js', 'guest ./tiny/words.js']);
  // Distinctive definitions from @endo/patterns and @endo/pass-style.
  for (const marker of [
    'makeCopySet',
    'getInterfaceGuardPayload',
    'passStyleOf',
  ]) {
    t.false(source.includes(marker), marker);
  }
  // Small: two modules and the bundle runtime.
  t.true(source.length < 10_000, `${source.length}`);
});

test('a guest that imports @endo/patterns does not bundle', async t => {
  const dir = await scratch(t, 'bg');
  await mkdir(path.join(dir, 'bad'));
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'bad-guest', version: '0.0.0', type: 'module' }),
  );
  await writeFile(
    path.join(dir, 'bad', 'main.js'),
    "import { M } from '@endo/patterns';\nexport const shape = M.any();\n",
  );
  await t.throwsAsync(() => bundleGuest(path.join(dir, 'bad', 'main.js')), {
    message: /@endo\/patterns/,
  });
});

test('a guest package that declares dependencies is refused', async t => {
  const dir = await scratch(t, 'bg');
  await mkdir(path.join(dir, 'p'));
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'dep-guest',
      version: '0.0.0',
      type: 'module',
      dependencies: { '@endo/patterns': 'workspace:^' },
    }),
  );
  await writeFile(path.join(dir, 'p', 'main.js'), 'export const x = 1;\n');
  await t.throwsAsync(() => bundleGuest(path.join(dir, 'p', 'main.js')), {
    message: /declares dependencies/,
  });
});

test('a module outside the guest root is refused', async t => {
  const dir = await scratch(t, 'bg');
  await mkdir(path.join(dir, 'g', 'p'), { recursive: true });
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'outer', version: '0.0.0', type: 'module' }),
  );
  await writeFile(
    path.join(dir, 'g', 'package.json'),
    JSON.stringify({ name: 'inner', version: '0.0.0', type: 'module' }),
  );
  await writeFile(path.join(dir, 'outside.js'), 'export const x = 1;\n');
  await writeFile(
    path.join(dir, 'g', 'p', 'main.js'),
    "export { x } from '../../outside.js';\n",
  );
  await t.throwsAsync(
    () =>
      bundleGuest(path.join(dir, 'g', 'p', 'main.js'), {
        guestRoot: path.join(dir, 'g'),
      }),
    { message: /outside/ },
  );
});

test('programs are the directories with a main.js; arguments are checked', async t => {
  const programs = await listGuestPrograms(fixtureRoot);
  t.deepEqual(programs, ['tiny']);
  const parsed = parseBundleArgs(['--out', 'x', 'session', 'exec']);
  t.deepEqual(parsed.programs, ['session', 'exec']);
  t.is(parsed.out, path.resolve('x'));
  t.throws(() => parseBundleArgs(['../evil']), { message: /lower-case/ });
  t.throws(() => parseBundleArgs(['--nope']), { message: /Unknown option/ });
  t.throws(() => parseBundleArgs(['--out']), { message: /needs a directory/ });
});

test('the CLI writes one bundle per program and prints JSON lines', async t => {
  const dir = await scratch(t, 'bc');
  const stdout = await new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      [
        path.join(harnessRoot, 'scripts', 'bundle-guest.mjs'),
        '--guest-root',
        fixtureRoot,
        '--out',
        dir,
      ],
      (error, out) => (error ? reject(error) : resolve(out)),
    ),
  );
  const rows = String(stdout)
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  t.is(rows.length, 1);
  t.is(rows[0].program, 'tiny');
  const written = await readFile(path.join(dir, 'tiny.js'), 'utf8');
  t.is(new TextEncoder().encode(written).length, rows[0].bytes);
});
