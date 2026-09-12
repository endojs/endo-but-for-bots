// @ts-check
import '@endo/init';
import test from 'ava';
import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { makeOpencodeStateProvider } from '../src/opencode-state-provider.js';

const makeFakeHost = () => {
  const names = new Map();
  const mounts = new Map();
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
        return names.has(key(name));
      },
      async makeDirectory(name) {
        names.set(key(name), 'dir');
      },
      async provideMount(directory, name) {
        mounts.set(key(name), directory);
        names.set(key(name), 'mount');
        return makeExo(
          'FakeMount',
          M.interface('FakeMount', { path: M.call().returns(M.string()) }),
          { path: () => directory },
        );
      },
      async remove(...name) {
        names.delete(key(name));
        mounts.delete(key(name));
      },
    },
  );
  return harden({ hostAgent, names, mounts });
};

const makeRoot = async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-state-'));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  return root;
};

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
