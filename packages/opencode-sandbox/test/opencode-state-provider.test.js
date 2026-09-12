// @ts-check
import '@endo/init';
import test from 'ava';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import {
  makeOpencodeStateProvider,
  makeOpencodeStateStorage,
} from '../src/opencode-state-provider.js';

/** @param {{failMount?: boolean}} [options] */
const makeFakeHost = ({ failMount = false } = {}) => {
  const names = new Map();
  const mounts = new Map();
  const calls = new Set();
  const key = name => JSON.stringify(name);
  const hostAgent = makeExo(
    'FakeHost',
    M.interface('FakeHost', {
      has: M.call().rest(M.any()).returns(M.promise()),
      makeDirectory: M.call(M.any()).returns(M.promise()),
      provideMount: M.call(M.string(), M.any()).returns(M.promise()),
      remove: M.call().rest(M.any()).returns(M.promise()),
    }),
    {
      async has(...name) {
        calls.add('has');
        return names.has(key(name));
      },
      async makeDirectory(name) {
        calls.add('makeDirectory');
        names.set(key(name), 'dir');
      },
      async provideMount(directory, name) {
        calls.add('provideMount');
        if (failMount) throw Error('Mount formulation failed');
        mounts.set(key(name), directory);
        names.set(key(name), 'mount');
        return makeExo(
          'FakeMount',
          M.interface('FakeMount', { path: M.call().returns(M.string()) }),
          { path: () => directory },
        );
      },
      async remove(...name) {
        calls.add('remove');
        names.delete(key(name));
        mounts.delete(key(name));
      },
    },
  );
  return harden({ hostAgent, names, mounts, calls });
};

const makeRoot = async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-state-'));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  return root;
};

test('native state preparation and removal need no daemon capabilities', async t => {
  const root = await makeRoot(t);
  const storage = makeOpencodeStateStorage({ stateRoot: root });
  const expected = { directory: path.join(root, 'ses-1') };
  t.deepEqual(await E(storage).prepareSessionDirectory('ses-1'), expected);
  await writeFile(path.join(expected.directory, 'state.db'), 'saved state');
  const revived = makeOpencodeStateStorage({ stateRoot: root });
  t.deepEqual(await E(revived).prepareSessionDirectory('ses-1'), expected);
  t.is(
    await readFile(path.join(expected.directory, 'state.db'), 'utf8'),
    'saved state',
  );
  await E(revived).removeSessionDirectory('ses-1');
  await t.throwsAsync(stat(expected.directory), { code: 'ENOENT' });
  await t.throwsAsync(stat(path.join(root, '.owners', 'ses-1')), {
    code: 'ENOENT',
  });
  await E(revived).removeSessionDirectory('ses-1');
});

test('provider native methods return only placement data and leave daemon names alone', async t => {
  const root = await makeRoot(t);
  const { hostAgent, calls, names } = makeFakeHost();
  const provider = makeOpencodeStateProvider({ hostAgent, stateRoot: root });
  names.set(JSON.stringify(['opencode-state', 'ses-1']), 'existing mount');
  t.deepEqual(await E(provider).prepareSessionDirectory('ses-1'), {
    directory: path.join(root, 'ses-1'),
  });
  await E(provider).removeSessionDirectory('ses-1');
  t.deepEqual([...calls], []);
  t.is(
    names.get(JSON.stringify(['opencode-state', 'ses-1'])),
    'existing mount',
  );
});

test('failed Mount formulation retains prepared native storage for its owner', async t => {
  const root = await makeRoot(t);
  const { hostAgent, calls } = makeFakeHost({ failMount: true });
  const provider = makeOpencodeStateProvider({ hostAgent, stateRoot: root });
  await t.throwsAsync(() => E(provider).provideSessionMount('ses-1'), {
    message: /Mount formulation failed/,
  });
  calls.clear();
  t.deepEqual(await E(provider).prepareSessionDirectory('ses-1'), {
    directory: path.join(root, 'ses-1'),
  });
  t.deepEqual([...calls], []);
  t.is(await readFile(path.join(root, '.owners', 'ses-1'), 'utf8'), 'ses-1\n');
});

test('native cleanup remains at the original provider root', async t => {
  const originalRoot = await makeRoot(t);
  const replacementRoot = await makeRoot(t);
  const original = makeOpencodeStateStorage({ stateRoot: originalRoot });
  const replacement = makeOpencodeStateStorage({ stateRoot: replacementRoot });
  await E(original).prepareSessionDirectory('ses-1');
  const replacementPlan = await E(replacement).prepareSessionDirectory('ses-1');
  await E(original).removeSessionDirectory('ses-1');
  t.true((await stat(replacementPlan.directory)).isDirectory());
});

test('native removal rejects symlinked ownership directories', async t => {
  const root = await makeRoot(t);
  const outside = await makeRoot(t);
  const storage = makeOpencodeStateStorage({ stateRoot: root });
  await E(storage).prepareSessionDirectory('ses-1');
  await rm(path.join(root, '.owners'), { recursive: true });
  await writeFile(path.join(outside, 'ses-1'), 'ses-1\n');
  await symlink(outside, path.join(root, '.owners'));
  await t.throwsAsync(() => E(storage).removeSessionDirectory('ses-1'), {
    message: /Ownership directory must not be a symlink/,
  });
  t.true((await stat(path.join(root, 'ses-1'))).isDirectory());
  t.is(await readFile(path.join(outside, 'ses-1'), 'utf8'), 'ses-1\n');
});

test('native removal rejects a symlinked state root', async t => {
  const outside = await makeRoot(t);
  const root = await makeRoot(t);
  const target = makeOpencodeStateStorage({ stateRoot: outside });
  await E(target).prepareSessionDirectory('ses-1');
  const link = path.join(root, 'linked-state');
  await symlink(outside, link);
  const storage = makeOpencodeStateStorage({ stateRoot: link });
  await t.throwsAsync(() => E(storage).removeSessionDirectory('ses-1'), {
    message: /State root must not be a symlink/,
  });
  t.true((await stat(path.join(outside, 'ses-1'))).isDirectory());
});

test('native removal retains a foreign marker when its directory is already absent', async t => {
  const root = await makeRoot(t);
  await mkdir(path.join(root, '.owners'));
  const marker = path.join(root, '.owners', 'ses-1');
  await writeFile(marker, 'someone-else\n');
  const storage = makeOpencodeStateStorage({ stateRoot: root });
  await t.throwsAsync(() => E(storage).removeSessionDirectory('ses-1'), {
    message: /not owned by this session/,
  });
  t.is(await readFile(marker, 'utf8'), 'someone-else\n');
});

test('native removal propagates a failed root observation before checking descendants', async t => {
  const root = await makeRoot(t);
  const file = path.join(root, 'file');
  await writeFile(file, 'not a directory');
  const stateRoot = path.join(file, 'state');
  const storage = makeOpencodeStateStorage({ stateRoot });
  const error = await t.throwsAsync(
    () => E(storage).removeSessionDirectory('ses-1'),
    { code: 'ENOTDIR' },
  );
  // Preserve the error from observing the root, not a later attempt to remove
  // an ownership marker after treating the failed observation as absence.
  t.like(error, { path: stateRoot });
  t.is(await readFile(file, 'utf8'), 'not a directory');
});

test('creates a 0700 session directory with a marker and mints a daemon mount', async t => {
  const root = await makeRoot(t);
  const { hostAgent, names, mounts } = makeFakeHost();
  const provider = makeOpencodeStateProvider({ hostAgent, stateRoot: root });
  await provider.provideSessionMount('ses-1');

  const directory = path.join(root, 'ses-1');
  const info = await stat(directory);
  t.true(info.isDirectory());
  t.is(info.mode % 0o1000, 0o700);
  t.is(mounts.get(JSON.stringify(['opencode-state', 'ses-1'])), directory);
  t.is(names.get(JSON.stringify(['opencode-state'])), 'dir');
});

test('is idempotent and re-mints over a stale name', async t => {
  const root = await makeRoot(t);
  const { hostAgent, mounts } = makeFakeHost();
  const provider = makeOpencodeStateProvider({ hostAgent, stateRoot: root });
  const first = await provider.provideSessionMount('ses-1');
  const second = await provider.provideSessionMount('ses-1');
  t.is(first.path(), second.path());
  t.is(mounts.size, 1);
  t.is(await second.path(), path.join(root, 'ses-1'));
});

test('enforces 0700 on a pre-existing owned directory', async t => {
  const root = await makeRoot(t);
  const directory = path.join(root, 'ses-1');
  await mkdir(directory, { mode: 0o777 });
  await chmod(directory, 0o777);
  await mkdir(path.join(root, '.owners'), { mode: 0o700 });
  await writeFile(path.join(root, '.owners', 'ses-1'), 'ses-1\n');
  const { hostAgent } = makeFakeHost();
  const provider = makeOpencodeStateProvider({ hostAgent, stateRoot: root });
  await provider.provideSessionMount('ses-1');
  t.is((await stat(directory)).mode % 0o1000, 0o700);
  t.is((await stat(path.join(root, '.owners'))).mode % 0o1000, 0o700);
});

test('removeSession unmounts and deletes only the owned session directory', async t => {
  const root = await makeRoot(t);
  const { hostAgent, names } = makeFakeHost();
  const provider = makeOpencodeStateProvider({ hostAgent, stateRoot: root });
  await provider.provideSessionMount('ses-1');
  await mkdir(path.join(root, 'keep'));
  await provider.removeSession('ses-1');
  t.false(names.has(JSON.stringify(['opencode-state', 'ses-1'])));
  await t.throwsAsync(stat(path.join(root, 'ses-1')), { code: 'ENOENT' });
  t.true((await stat(path.join(root, 'keep'))).isDirectory());
  // Idempotent: removing an already-removed session resolves.
  await provider.removeSession('ses-1');
});

test('removeSession refuses a directory that lacks the session marker', async t => {
  const root = await makeRoot(t);
  const directory = path.join(root, 'ses-1');
  await mkdir(directory, { mode: 0o700 });
  await mkdir(path.join(root, '.owners'), { mode: 0o700 });
  await writeFile(path.join(root, '.owners', 'ses-1'), 'other-session\n');
  const { hostAgent } = makeFakeHost();
  const provider = makeOpencodeStateProvider({ hostAgent, stateRoot: root });
  await t.throwsAsync(() => provider.removeSession('ses-1'), {
    message: /not owned by this session/,
  });
  t.true((await stat(directory)).isDirectory());
});

test('provideSessionMount refuses a directory owned by another session', async t => {
  const root = await makeRoot(t);
  const directory = path.join(root, 'ses-1');
  await mkdir(directory, { mode: 0o700 });
  await mkdir(path.join(root, '.owners'), { mode: 0o700 });
  await writeFile(path.join(root, '.owners', 'ses-1'), 'other-session\n');
  const { hostAgent } = makeFakeHost();
  const provider = makeOpencodeStateProvider({ hostAgent, stateRoot: root });
  await t.throwsAsync(() => provider.provideSessionMount('ses-1'), {
    message: /not owned by this session/,
  });
});

test('provideSessionMount refuses a pre-existing unowned directory', async t => {
  const root = await makeRoot(t);
  await mkdir(path.join(root, 'ses-1'), { mode: 0o700 });
  const { hostAgent } = makeFakeHost();
  const provider = makeOpencodeStateProvider({ hostAgent, stateRoot: root });
  await t.throwsAsync(() => provider.provideSessionMount('ses-1'), {
    message: /not owned by this session/,
  });
});

test('rejects unbounded or escaping session ids', async t => {
  const root = await makeRoot(t);
  const { hostAgent } = makeFakeHost();
  const provider = makeOpencodeStateProvider({ hostAgent, stateRoot: root });
  await Promise.all(
    ['', '../escape', 'Upper', 'a/b', 'x'.repeat(129)].map(sessionId =>
      t.throwsAsync(() => provider.provideSessionMount(sessionId), {
        message: /Invalid session id/,
      }),
    ),
  );
});

test('requires an absolute state root', t => {
  const { hostAgent } = makeFakeHost();
  t.throws(() => makeOpencodeStateProvider({ hostAgent, stateRoot: 'rel' }), {
    message: /absolute path/,
  });
});

test('refuses a symlinked session directory', async t => {
  const root = await makeRoot(t);
  const outside = await makeRoot(t);
  await symlink(outside, path.join(root, 'ses-1'));
  const { hostAgent } = makeFakeHost();
  const provider = makeOpencodeStateProvider({ hostAgent, stateRoot: root });
  await t.throwsAsync(() => provider.provideSessionMount('ses-1'), {
    message: /Cannot create session state directory|symbolic link/,
  });
});

test('refuses a symlinked ownership directory and leaves its target alone', async t => {
  const root = await makeRoot(t);
  const victim = await makeRoot(t);
  await chmod(victim, 0o755);
  await symlink(victim, path.join(root, '.owners'));
  const { hostAgent } = makeFakeHost();
  const provider = makeOpencodeStateProvider({ hostAgent, stateRoot: root });
  await t.throwsAsync(provider.provideSessionMount('ses-1'), {
    message: /Ownership directory must not be a symlink/,
  });
  t.is((await stat(victim)).mode % 0o1000, 0o755);
});

test('refuses a symlinked ownership marker without touching its target', async t => {
  const root = await makeRoot(t);
  const victimDir = await makeRoot(t);
  const victim = path.join(victimDir, 'victim');
  await writeFile(victim, 'do not overwrite\n');
  await mkdir(path.join(root, '.owners'), { mode: 0o700 });
  await symlink(victim, path.join(root, '.owners', 'ses-1'));
  const { hostAgent } = makeFakeHost();
  const provider = makeOpencodeStateProvider({ hostAgent, stateRoot: root });
  await t.throwsAsync(provider.provideSessionMount('ses-1'), {
    message: /Ownership marker must not be a symlink/,
  });
  t.is(await readFile(victim, 'utf8'), 'do not overwrite\n');
});

test('refuses a symlinked state root', async t => {
  const root = await makeRoot(t);
  const target = await makeRoot(t);
  const link = `${root}-link`;
  await symlink(target, link);
  t.teardown(() => rm(link, { force: true }));
  const { hostAgent } = makeFakeHost();
  const provider = makeOpencodeStateProvider({ hostAgent, stateRoot: link });
  await t.throwsAsync(provider.provideSessionMount('ses-1'), {
    message: /State root must not be a symlink/,
  });
  t.false(await stat(path.join(target, 'ses-1')).catch(() => false));
});

test('concurrent first provisions on a fresh root both succeed', async t => {
  const root = await makeRoot(t);
  const { hostAgent } = makeFakeHost();
  const provider = makeOpencodeStateProvider({ hostAgent, stateRoot: root });
  const results = await Promise.allSettled([
    provider.provideSessionMount('ses-a'),
    provider.provideSessionMount('ses-b'),
  ]);
  t.deepEqual(
    results.map(result => result.status),
    ['fulfilled', 'fulfilled'],
    'the .owners/ create race must not fail a session',
  );
});
