// @ts-check

// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import { Far } from '@endo/pass-style';

import { discoverCapabilityTools } from '../src/discover.js';

/**
 * A minimal stand-in for a mount capability. Discovery only *constructs* the
 * filesystem tools (it never invokes them), and `mountAsFilesystem` builds its
 * backend lazily, so an inert Far mount is enough to exercise registration.
 */
const makeStubMount = () =>
  Far('StubMount', {
    lookup: async () => undefined,
    list: async () => [],
  });

/** A minimal `Shell` capability slice: `exec` + `inspect`. */
const makeStubShell = () =>
  Far('StubShell', {
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    inspect: async () => ({}),
  });

/** A minimal `Git` capability covering both git tool makers' method sets. */
const makeStubGit = () =>
  Far('StubGit', {
    log: async () => '',
    diff: async () => '',
    show: async () => '',
    commit: async () => '',
    branches: async () => '',
    createBranch: async () => {},
    switchBranch: async () => {},
    currentBranch: async () => '',
    status: async () => [],
    add: async () => {},
    worktree: async () => makeStubMount(),
  });

/**
 * Build a `powers` stub whose `lookup([petName])` resolves the caps present in
 * `grants` and throws (the "not granted" signal) for everything else.
 *
 * @param {Record<string, unknown>} grants
 */
const makePowers = grants =>
  Far('StubPowers', {
    lookup: async (/** @type {string[]} */ namePath) => {
      const [name] = namePath;
      if (Object.prototype.hasOwnProperty.call(grants, name)) {
        return grants[name];
      }
      throw new Error(`Not found: ${name}`);
    },
  });

/** @param {import('../src/types.js').ToolRecord[]} records */
const names = records => records.map(r => r.name);

test('no capabilities granted registers no tools', async t => {
  const records = await discoverCapabilityTools(makePowers({}));
  t.deepEqual(records, []);
});

test('only shell granted registers exactly the shell tools', async t => {
  const records = await discoverCapabilityTools(
    makePowers({ shell: makeStubShell() }),
  );
  t.deepEqual(names(records).sort(), ['exec', 'inspect']);
});

test('only git granted registers the read/branch and mount-bridged tools', async t => {
  const records = await discoverCapabilityTools(
    makePowers({ git: makeStubGit() }),
  );
  const got = new Set(names(records));
  for (const expected of [
    'log',
    'diff',
    'show',
    'commit',
    'branches',
    'createBranch',
    'switchBranch',
    'currentBranch',
    'status',
    'add',
  ]) {
    t.true(got.has(expected), `expected git tool "${expected}"`);
  }
  t.false(got.has('exec'));
  t.false(got.has('mountReadText'));
});

test('only fs granted registers read/list/stat/edit tools', async t => {
  const records = await discoverCapabilityTools(
    makePowers({ fs: makeStubMount() }),
  );
  t.deepEqual(names(records).sort(), [
    'mountList',
    'mountReadText',
    'mountStat',
    'mountWriteText',
  ]);
});

test('readOnly drops the fs edit tool', async t => {
  const records = await discoverCapabilityTools(
    makePowers({ fs: makeStubMount() }),
    { readOnly: true },
  );
  t.false(names(records).includes('mountWriteText'));
  t.deepEqual(names(records).sort(), ['mountList', 'mountReadText', 'mountStat']);
});

test('all capabilities granted registers the union', async t => {
  const records = await discoverCapabilityTools(
    makePowers({
      fs: makeStubMount(),
      shell: makeStubShell(),
      git: makeStubGit(),
    }),
  );
  const got = new Set(names(records));
  for (const expected of [
    'mountReadText',
    'mountWriteText',
    'exec',
    'inspect',
    'status',
    'add',
    'log',
  ]) {
    t.true(got.has(expected), `expected tool "${expected}"`);
  }
});

test('custom pet names are honored', async t => {
  const records = await discoverCapabilityTools(
    makePowers({ 'project-shell': makeStubShell() }),
    { shellName: 'project-shell' },
  );
  t.deepEqual(names(records).sort(), ['exec', 'inspect']);
});
