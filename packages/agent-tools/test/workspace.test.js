// @ts-check
// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import {
  makeWorkspaceTools,
  provisionWorkspaceTools,
} from '../src/workspace.js';
import { concatDistinctTools } from '../src/catalog.js';

/**
 * The provisioning adapter composes its catalog purely from the tool makers'
 * static schemas and interface guards — a maker never calls the granted cap at
 * construction time — so an inert exo is a sufficient stand-in for
 * every grant these composition-semantics tests exercise. The live-capability
 * behavior is proved end to end in `git-worked-loop.test.js`.
 *
 * @param {string} label
 * @returns {any} an inert stand-in for any workspace grant; typed `any` so a
 *   single inert exo satisfies every distinct capability parameter.
 */
const makeInertGrant = label => makeExo(label, M.interface(label, {}), {});

const GitFixtureInterface = M.interface('GitFixture', {
  worktree: M.callWhen().returns(M.remotable('Mount')),
});

const InspectInterface = M.interface('InspectFixture', {
  inspect: M.callWhen().returns(M.record()),
});

/** @param {{ name: string }[]} records */
const nameSet = records => new Set(records.map(record => record.name));

test('no grants compose an empty catalog', t => {
  t.deepEqual(makeWorkspaceTools(), []);
  t.deepEqual(makeWorkspaceTools({}), []);
});

test('a git grant composes versioning plus agent-facing status, and nothing else', t => {
  const names = nameSet(makeWorkspaceTools({ git: makeInertGrant('Git') }));
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
  for (const absent of [
    'mountReadText',
    'push',
    'fetchGitRemote',
    'fetchHttp',
    'exec',
  ]) {
    t.false(names.has(absent), `"${absent}" absent without its grant`);
  }
});

test('a filesystem grant composes the file tools; readOnly drops the write slice', t => {
  const readWrite = nameSet(
    makeWorkspaceTools({ filesystem: makeInertGrant('Filesystem') }),
  );
  t.deepEqual(
    readWrite,
    new Set(['mountReadText', 'mountList', 'mountStat', 'mountWriteText']),
  );

  const readOnly = nameSet(
    makeWorkspaceTools({
      filesystem: makeInertGrant('Filesystem'),
      readOnly: true,
    }),
  );
  t.false(readOnly.has('mountWriteText'), 'the write tool is dropped');
  t.true(readOnly.has('mountReadText'));
});

test('a remote grant composes the push tier', t => {
  const names = nameSet(
    makeWorkspaceTools({ remote: makeInertGrant('GitRemote') }),
  );
  for (const method of ['inspectGitRemote', 'fetchGitRemote', 'pull', 'push']) {
    t.true(names.has(method), `remote tool "${method}" present`);
  }
});

test('a shell grant composes the command tools', t => {
  const names = nameSet(makeWorkspaceTools({ shell: makeInertGrant('Shell') }));
  t.true(names.has('exec'));
  t.true(names.has('inspectShell'));
});

test('a read-only workspace rejects a shell grant', t => {
  t.throws(
    () =>
      makeWorkspaceTools({
        readOnly: true,
        shell: makeInertGrant('Shell'),
      }),
    {
      instanceOf: TypeError,
      message:
        'makeWorkspaceTools: readOnly cannot be combined with a shell grant',
    },
  );
});

test('grants compose into one flat catalog with distinct names', t => {
  // filesystem + git + remote all coexist: every tool name across the three
  // groups is unique, so the catalog is a flat, unambiguous set.
  const catalog = makeWorkspaceTools({
    filesystem: makeInertGrant('Filesystem'),
    git: makeInertGrant('Git'),
    remote: makeInertGrant('GitRemote'),
  });
  t.is(catalog.length, nameSet(catalog).size, 'no name is repeated');
});

test('a shell + remote catalog explicitly qualifies both inspect tools', t => {
  const catalog = makeWorkspaceTools({
    shell: makeInertGrant('Shell'),
    remote: makeInertGrant('GitRemote'),
  });
  const names = nameSet(catalog);
  t.is(catalog.length, names.size, 'the combined catalog is unambiguous');
  t.true(names.has('inspectShell'));
  t.true(names.has('inspectGitRemote'));
  t.false(names.has('inspect'));
});

test('an HTTP grant composes qualified confined network tools', t => {
  const names = nameSet(
    makeWorkspaceTools({ http: makeInertGrant('HttpClient') }),
  );
  t.deepEqual(names, new Set(['fetchHttp', 'allowedOrigins']));
});

test('HTTP and GitRemote fetch tools are qualified in one catalog', t => {
  const catalog = makeWorkspaceTools({
    http: makeInertGrant('HttpClient'),
    remote: makeInertGrant('GitRemote'),
  });
  const names = nameSet(catalog);
  t.is(catalog.length, names.size, 'the combined catalog is unambiguous');
  t.true(names.has('fetchHttp'));
  t.true(names.has('fetchGitRemote'));
  t.false(names.has('fetch'));
});

test('the catalog fails closed when two groups emit the same tool name', t => {
  /** @param {string} name */
  const record = name =>
    /** @type {any} */ (harden({ name, invoke: async () => undefined }));
  t.throws(
    () =>
      concatDistinctTools([
        { group: 'first', records: [record('inspect')] },
        { group: 'second', records: [record('inspect')] },
      ]),
    {
      message:
        /agent-tool catalog name collision: "inspect" is emitted by both the "first" and "second" tool groups/,
    },
  );
});

test('a group names table disambiguates an otherwise colliding tool', t => {
  /** @param {string} name */
  const record = name =>
    /** @type {any} */ (harden({ name, invoke: async () => undefined }));
  const catalog = concatDistinctTools([
    { group: 'first', records: [record('inspect')] },
    {
      group: 'second',
      records: [record('inspect')],
      names: new Map([['inspect', 'inspectSecond']]),
    },
  ]);
  t.deepEqual(
    catalog.map(({ name }) => name),
    ['inspect', 'inspectSecond'],
  );
});

test('provisionWorkspaceTools passes an explicit filesystem straight through', async t => {
  // With an explicit `filesystem` and no `git`, the async provisioner performs
  // no derivation and returns the same catalog as the synchronous maker.
  await null;
  const catalog = await provisionWorkspaceTools({
    filesystem: makeInertGrant('Filesystem'),
  });
  t.deepEqual(
    nameSet(catalog),
    new Set(['mountReadText', 'mountList', 'mountStat', 'mountWriteText']),
  );
});

test('all workspace grants compose without a collision', t => {
  const catalog = makeWorkspaceTools({
    filesystem: makeInertGrant('Filesystem'),
    git: makeInertGrant('Git'),
    remote: makeInertGrant('GitRemote'),
    shell: makeInertGrant('Shell'),
    http: makeInertGrant('HttpClient'),
  });
  const names = nameSet(catalog);
  t.is(catalog.length, names.size, 'no name is repeated');
  for (const name of [
    'mountReadText',
    'commit',
    'push',
    'exec',
    'fetchGitRemote',
    'fetchHttp',
  ]) {
    t.true(names.has(name), `"${name}" present`);
  }
});

test('provisionWorkspaceTools carries HTTP with a Git-derived filesystem', async t => {
  await null;
  /** @type {any} a `Git` stand-in whose `worktree` derives the filesystem. */
  const git = makeExo('GitFixture', GitFixtureInterface, {
    worktree: () => makeInertGrant('Mount'),
  });
  const catalog = await provisionWorkspaceTools({
    git,
    http: makeInertGrant('HttpClient'),
  });
  const names = nameSet(catalog);
  t.true(names.has('fetchHttp'));
  t.true(names.has('mountReadText'));
  t.true(names.has('commit'));
});

test('provisionWorkspaceTools with no grants derives nothing', async t => {
  const catalog = await provisionWorkspaceTools();
  t.deepEqual(catalog, []);
});

test('each qualified inspect name reaches its own capability', async t => {
  await null;
  const tools = makeWorkspaceTools({
    // Partial stand-ins: only the `inspect` method these calls reach.
    remote: /** @type {any} */ (
      makeExo('GitRemote', InspectInterface, {
        inspect: () => harden({ from: 'remote' }),
      })
    ),
    shell: /** @type {any} */ (
      makeExo('Shell', InspectInterface, {
        inspect: () => harden({ from: 'shell' }),
      })
    ),
  });
  const byName = new Map(tools.map(record => [record.name, record]));
  const inspectShell = byName.get('inspectShell');
  const inspectGitRemote = byName.get('inspectGitRemote');
  if (inspectShell === undefined || inspectGitRemote === undefined) {
    t.fail('both qualified inspect tools are present');
    return;
  }
  t.deepEqual(await inspectShell.invoke({}), { from: 'shell' });
  t.deepEqual(await inspectGitRemote.invoke({}), { from: 'remote' });
});
