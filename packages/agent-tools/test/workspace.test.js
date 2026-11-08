// @ts-check

// Establish a SES perimeter (provides the `harden` global).
import '@endo/init/debug.js';

import test from 'ava';
import { makePackageManagerKit } from '@endo/exo-package-manager';
import { Far } from '@endo/pass-style';

import {
  makeWorkspaceTools,
  provisionWorkspaceTools,
} from '../src/workspace.js';

/**
 * The provisioning adapter composes its catalog from tool makers' static
 * schemas. Most makers never call the granted cap at construction time, so an
 * inert `Far` remotable is a sufficient stand-in for composition-semantics
 * tests. Package-manager write/execute tools require a minted facet identity;
 * inert or foreign caps fail closed to metadata tools. Live-capability
 * behavior is proved end to end in `git-worked-loop.test.js` and
 * `package-manager-tool.test.js`.
 *
 * @param {string} label
 * @returns {any} an inert stand-in for any workspace grant; typed `any` so a
 *   single `Far` remotable satisfies every distinct capability parameter.
 */
const grant = label => Far(label, {});

/** @param {{ name: string }[]} records */
const nameSet = records => new Set(records.map(record => record.name));

const PM_TOOL_NAMES = harden([
  'detectPackageManager',
  'listPackageScripts',
  'installDependencies',
  'runPackageScript',
]);

/**
 * Real package-manager exo with an inert backend (composition only; methods are
 * never invoked by these tests).
 *
 * @param {{ facet?: 'reader' | 'installer' | 'executor' }} [opts]
 */
const realPackageManager = ({ facet = 'executor' } = {}) => {
  const mount = Far('EndoMount', {
    entry: async segments =>
      Far('EndoMountEntry', {
        segments: async () => segments,
      }),
  });
  const backend = {
    async inspectWorkspace() {
      return harden({
        markers: {},
        scriptNames: [],
        packageName: 'fixture',
        displayPath: '.',
      });
    },
    async install() {
      throw new Error('backend.install not used in composition tests');
    },
    async run() {
      throw new Error('backend.run not used in composition tests');
    },
    async cancel() {
      return false;
    },
  };
  const kit = makePackageManagerKit({
    mount,
    backend,
    lineageOf: () => harden({}),
  });
  return kit[facet];
};

test('no grants compose an empty catalog', t => {
  t.deepEqual(makeWorkspaceTools(), []);
  t.deepEqual(makeWorkspaceTools({}), []);
});

test('a git grant composes versioning plus agent-facing status, and nothing else', t => {
  const names = nameSet(makeWorkspaceTools({ git: grant('Git') }));
  // The JSON-safe git slice…
  for (const method of [
    'log',
    'diff',
    'show',
    'add',
    'checkoutConflict',
    'commit',
    'branches',
    'createBranch',
    'switchBranch',
    'currentBranch',
    'trackingStatus',
  ]) {
    t.true(names.has(method), `git tool "${method}" present`);
  }
  // …plus status's agent-facing untracked-file default.
  t.true(names.has('status'));
  // No other layer's tools are present when only git is granted.
  for (const absent of ['mountReadText', 'push', 'fetch', 'exec']) {
    t.false(names.has(absent), `"${absent}" absent without its grant`);
  }
});

test('a filesystem grant composes the file tools; readOnly drops the write slice', t => {
  const readWrite = nameSet(
    makeWorkspaceTools({ filesystem: grant('Filesystem') }),
  );
  t.deepEqual(
    readWrite,
    new Set(['mountReadText', 'mountList', 'mountStat', 'mountWriteText']),
  );

  const readOnly = nameSet(
    makeWorkspaceTools({ filesystem: grant('Filesystem'), readOnly: true }),
  );
  t.false(readOnly.has('mountWriteText'), 'the write tool is dropped');
  t.true(readOnly.has('mountReadText'));
});

test('a remote grant composes the push tier', t => {
  const names = nameSet(makeWorkspaceTools({ remote: grant('GitRemote') }));
  for (const method of ['inspect', 'fetch', 'pull', 'push']) {
    t.true(names.has(method), `remote tool "${method}" present`);
  }
});

test('a shell grant composes the command tools', t => {
  const names = nameSet(makeWorkspaceTools({ shell: grant('Shell') }));
  t.true(names.has('exec'));
  t.true(names.has('inspect'));
});

test('grants compose into one flat catalog with distinct names', t => {
  // filesystem + git + remote all coexist: every tool name across the three
  // groups is unique, so the catalog is a flat, unambiguous set.
  const catalog = makeWorkspaceTools({
    filesystem: grant('Filesystem'),
    git: grant('Git'),
    remote: grant('GitRemote'),
  });
  t.is(catalog.length, nameSet(catalog).size, 'no name is repeated');
});

test('a shell + remote catalog fails closed on the shared "inspect" name', t => {
  // Both makeShellTool and makeGitRemoteTool emit a bounds-legibility `inspect`
  // tool. A flat catalog with two identically-named tools is ambiguous the
  // moment a harness dispatches by name, so composition rejects it rather than
  // silently shadowing one. (Surfaced by the worked-loop composition; the fix
  // is to reconcile the two makers' `inspect` naming — see the PR follow-ups.)
  const error = t.throws(() =>
    makeWorkspaceTools({ shell: grant('Shell'), remote: grant('GitRemote') }),
  );
  t.regex(error.message, /name collision/);
  t.regex(error.message, /inspect/);
  t.regex(error.message, /shell/);
  t.regex(error.message, /gitRemote/);
});

test('provisionWorkspaceTools passes an explicit filesystem straight through', async t => {
  // With an explicit `filesystem` and no `git`, the async provisioner performs
  // no derivation and returns the same catalog as the synchronous maker.
  await null;
  const catalog = await provisionWorkspaceTools({
    filesystem: grant('Filesystem'),
  });
  t.deepEqual(
    nameSet(catalog),
    new Set(['mountReadText', 'mountList', 'mountStat', 'mountWriteText']),
  );
});

test('provisionWorkspaceTools with no grants derives nothing', async t => {
  const catalog = await provisionWorkspaceTools();
  t.deepEqual(catalog, []);
});

test('no packageManager grant omits package-manager tools', t => {
  const names = nameSet(
    makeWorkspaceTools({
      filesystem: grant('Filesystem'),
      git: grant('Git'),
      shell: grant('Shell'),
    }),
  );
  for (const name of PM_TOOL_NAMES) {
    t.false(names.has(name), `"${name}" absent without packageManager grant`);
  }
});

test('a foreign packageManager grant fails closed to metadata tools', t => {
  const names = nameSet(
    makeWorkspaceTools({ packageManager: grant('PackageManager') }),
  );
  t.deepEqual(names, new Set(['detectPackageManager', 'listPackageScripts']));
  for (const absent of [
    'mountReadText',
    'log',
    'status',
    'push',
    'exec',
    'inspect',
  ]) {
    t.false(names.has(absent), `"${absent}" absent without its grant`);
  }
});

test('packageManager + filesystem compose a flat catalog without collisions', t => {
  const catalog = makeWorkspaceTools({
    filesystem: grant('Filesystem'),
    packageManager: realPackageManager({ facet: 'installer' }),
  });
  t.is(catalog.length, nameSet(catalog).size, 'no name is repeated');
  const names = nameSet(catalog);
  t.true(names.has('mountReadText'));
  t.true(names.has('detectPackageManager'));
  t.true(names.has('installDependencies'));
  t.false(names.has('log'), 'git tools absent without git grant');
});

test('packageManager + git + filesystem compose without name collisions', t => {
  const catalog = makeWorkspaceTools({
    filesystem: grant('Filesystem'),
    git: grant('Git'),
    packageManager: realPackageManager({ facet: 'executor' }),
  });
  t.is(catalog.length, nameSet(catalog).size, 'no name is repeated');
  const names = nameSet(catalog);
  t.true(names.has('commit'));
  t.true(names.has('status'));
  t.true(names.has('mountList'));
  t.true(names.has('runPackageScript'));
});

test('reader packageManager grant emits only detect/list tools', t => {
  const names = nameSet(
    makeWorkspaceTools({
      packageManager: realPackageManager({ facet: 'reader' }),
    }),
  );
  t.deepEqual(names, new Set(['detectPackageManager', 'listPackageScripts']));
  t.false(names.has('installDependencies'));
  t.false(names.has('runPackageScript'));
});

test('safe-installer packageManager grant emits install but not run', t => {
  const names = nameSet(
    makeWorkspaceTools({
      packageManager: realPackageManager({ facet: 'installer' }),
    }),
  );
  t.deepEqual(
    names,
    new Set([
      'detectPackageManager',
      'listPackageScripts',
      'installDependencies',
    ]),
  );
  t.false(names.has('runPackageScript'));
});

test('executor packageManager grant emits install/run tools', t => {
  const names = nameSet(
    makeWorkspaceTools({
      packageManager: realPackageManager({ facet: 'executor' }),
    }),
  );
  t.deepEqual(names, new Set(PM_TOOL_NAMES));
});

test('provisionWorkspaceTools forwards packageManager grant', async t => {
  await null;
  const catalog = await provisionWorkspaceTools({
    packageManager: realPackageManager({ facet: 'installer' }),
  });
  const names = nameSet(catalog);
  for (const name of [
    'detectPackageManager',
    'listPackageScripts',
    'installDependencies',
  ]) {
    t.true(names.has(name), `provisioned catalog includes "${name}"`);
  }
  t.false(names.has('runPackageScript'));
  t.false(names.has('mountReadText'), 'no filesystem derivation without git');
});
