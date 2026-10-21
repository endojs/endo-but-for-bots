/**
 * Tests for {@link test-bun.mjs}
 *
 * Run with: `yarn exec ava scripts/test-bun.test.mjs` with `bun` on PATH.
 *
 * Each test copies the runner into a temporary repository whose AVA command
 * line is a stub that records its invocation, so the selections are checked
 * without running any real suite.
 *
 * @module
 */

import test from 'ava';
import { spawnSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runnerPath = fileURLToPath(new URL('test-bun.mjs', import.meta.url));

const stubAva = `import { appendFileSync } from 'node:fs';
appendFileSync(
  process.env.TEST_BUN_LOG,
  \`\${JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) })}\\n\`,
);
`;

/**
 * @param {Record<string, object>} packages package.json descriptors keyed by
 * directory name
 */
const makeRepository = async packages => {
  const root = await mkdtemp(join(tmpdir(), 'test-bun-'));
  await mkdir(join(root, 'scripts'));
  await copyFile(runnerPath, join(root, 'scripts', 'test-bun.mjs'));
  await writeFile(join(root, 'scripts', 'ava-bun-preload.mjs'), '');
  await mkdir(join(root, 'node_modules', 'ava', 'entrypoints'), {
    recursive: true,
  });
  await writeFile(
    join(root, 'node_modules', 'ava', 'entrypoints', 'cli.js'),
    stubAva,
  );
  for (const [directory, descriptor] of Object.entries(packages)) {
    await mkdir(join(root, 'packages', directory), { recursive: true });
    await writeFile(
      join(root, 'packages', directory, 'package.json'),
      JSON.stringify(descriptor),
    );
  }
  return root;
};

const defaultPackages = {
  alpha: { name: '@endo/alpha', scripts: { test: 'ava' } },
  beta: { name: '@endo/beta', scripts: { test: 'ava' } },
  'no-suite': { name: '@endo/no-suite', scripts: { test: 'exit 0' } },
  'no-scripts': { name: '@endo/no-scripts' },
  skel: { name: '@endo/skel', scripts: { test: 'ava' } },
};

/**
 * @param {string[]} args
 * @param {Record<string, object>} [packages]
 */
const runBun = async (args, packages = defaultPackages) => {
  const root = await makeRepository(packages);
  const logPath = join(root, 'ava-invocations.jsonl');
  await writeFile(logPath, '');
  const { status, stdout, stderr, error } = spawnSync(
    'bun',
    [join(root, 'scripts', 'test-bun.mjs'), ...args],
    { encoding: 'utf8', env: { ...process.env, TEST_BUN_LOG: logPath } },
  );
  if (error) {
    throw error;
  }
  const invocations = (await readFile(logPath, 'utf8'))
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line));
  return { status, stdout, stderr, invocations };
};

test('runs every requested package', async t => {
  const { status, invocations } = await runBun([
    '--package',
    '@endo/alpha',
    '--package',
    '@endo/beta',
  ]);
  t.is(status, 0);
  t.deepEqual(invocations.map(({ cwd }) => cwd.split(/[/\\]/).at(-1)).sort(), [
    'alpha',
    'beta',
  ]);
});

test('passes selected test files to AVA', async t => {
  const { status, invocations } = await runBun([
    '--file',
    '@endo/alpha:test/one.test.js',
    '--file',
    '@endo/alpha:test/two.test.js',
  ]);
  t.is(status, 0);
  t.is(invocations.length, 1);
  t.deepEqual(invocations[0].argv.slice(-2), [
    'test/one.test.js',
    'test/two.test.js',
  ]);
});

test('fails when a requested package is missing', async t => {
  const { status, stderr, invocations } = await runBun([
    '--package',
    '@endo/alpha',
    '--package',
    '@endo/does-not-exist',
  ]);
  t.is(status, 1);
  t.regex(stderr, /no AVA runs scheduled for: @endo\/does-not-exist/);
  t.deepEqual(invocations, []);
});

test('fails when a requested package has no AVA suite', async t => {
  for (const packageName of ['@endo/no-suite', '@endo/no-scripts']) {
    const { status, stderr, invocations } = await runBun([
      '--package',
      packageName,
    ]);
    t.is(status, 1, packageName);
    t.true(stderr.includes(`no AVA runs scheduled for: ${packageName}`));
    t.deepEqual(invocations, [], packageName);
  }
});

test('fails when a file selection names a missing package', async t => {
  const { status, stderr, invocations } = await runBun([
    '--file',
    '@endo/does-not-exist:test/one.test.js',
  ]);
  t.is(status, 1);
  t.regex(stderr, /no AVA runs scheduled for: @endo\/does-not-exist/);
  t.deepEqual(invocations, []);
});

test('fails when no package has an AVA suite', async t => {
  const { status, stderr, invocations } = await runBun([], {
    'no-suite': defaultPackages['no-suite'],
    skel: defaultPackages.skel,
  });
  t.is(status, 1);
  t.regex(stderr, /no AVA runs scheduled\n/);
  t.deepEqual(invocations, []);
});

for (const [title, args, pattern] of [
  [
    'option-shaped package',
    ['--package', '--fail-fast'],
    /--package requires a value, got --fail-fast/,
  ],
  ['missing package', ['--package'], /--package requires a value/],
  [
    'option-shaped file selection',
    ['--file', '--package'],
    /--file requires a value, got --package/,
  ],
  [
    'option-shaped test file',
    ['--file', '@endo/alpha:--match=nothing'],
    /--file requires a test file, got --match=nothing/,
  ],
  [
    'file selection without a package',
    ['--file', 'test/one.test.js'],
    /--file requires <package>:<test file>/,
  ],
  [
    'file selection without a test file',
    ['--file', '@endo/alpha:'],
    /--file requires <package>:<test file>/,
  ],
  [
    'package selected whole and by file',
    ['--package', '@endo/alpha', '--file', '@endo/alpha:test/one.test.js'],
    /selected both whole and by --file/,
  ],
  ['unknown argument', ['@endo/alpha'], /Unknown argument: @endo\/alpha/],
]) {
  test(`rejects ${title}`, async t => {
    const { status, stderr, invocations } = await runBun(args);
    t.not(status, 0);
    t.regex(stderr, pattern);
    t.deepEqual(invocations, []);
  });
}
