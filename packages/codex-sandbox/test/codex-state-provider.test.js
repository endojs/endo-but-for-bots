// @ts-check
import '@endo/init';

import test from 'ava';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertCodexStateRoot,
  makeCodexStateProvider,
} from '../src/codex-state-provider.js';
import { make as makeStateProviderModule } from '../src/codex-state-provider-module.js';

const makeTmp = async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-state-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('prepare creates an owned 0700 directory and is idempotent', async t => {
  const root = path.join(await makeTmp(t), 'state');
  const provider = makeCodexStateProvider({ stateRoot: root });
  const first = await provider.prepareSessionDirectory('codex-abc');
  t.is(first.directory, path.join(root, 'codex-abc'));
  // eslint-disable-next-line no-bitwise
  t.is((await stat(first.directory)).mode & 0o777, 0o700);
  // The marker lives beside the session directory, never inside it, so a guest
  // that gets the directory cannot delete or rewrite it.
  t.is(
    (await readFile(path.join(root, '.owners', 'codex-abc'), 'utf8')).trim(),
    'codex-abc',
  );
  const second = await provider.prepareSessionDirectory('codex-abc');
  t.deepEqual(second, first);
});

test('locate answers without creating anything', async t => {
  // Codex reads a thread checkpoint before it provisions, and preparing to
  // answer that would leave state behind for a session that never started.
  const root = path.join(await makeTmp(t), 'state');
  const provider = makeCodexStateProvider({ stateRoot: root });
  t.deepEqual(await provider.locateSessionDirectory('codex-abc'), {});
  await t.throwsAsync(stat(root));
  await provider.prepareSessionDirectory('codex-abc');
  t.deepEqual(await provider.locateSessionDirectory('codex-abc'), {
    directory: path.join(root, 'codex-abc'),
  });
});

test('remove takes the directory and its marker, and repeats safely', async t => {
  const root = path.join(await makeTmp(t), 'state');
  const provider = makeCodexStateProvider({ stateRoot: root });
  const { directory } = await provider.prepareSessionDirectory('codex-abc');
  await provider.removeSessionDirectory('codex-abc');
  await t.throwsAsync(stat(directory));
  await t.throwsAsync(stat(path.join(root, '.owners', 'codex-abc')));
  await provider.removeSessionDirectory('codex-abc');
  t.pass();
});

test('a session id that is not a conforming slug is refused', async t => {
  const root = path.join(await makeTmp(t), 'state');
  const provider = makeCodexStateProvider({ stateRoot: root });
  await Promise.all(
    ['../escape', 'Mixed-Case', 'a/b', ''].map(bad =>
      t.throwsAsync(provider.prepareSessionDirectory(bad), {
        message: /Invalid session id/,
      }),
    ),
  );
});

test('the state root must be a normalized absolute non-root path', t => {
  t.is(
    assertCodexStateRoot('/var/lib/endo/codex-state'),
    '/var/lib/endo/codex-state',
  );
  for (const bad of ['relative', '/', '/a/../b', '', undefined]) {
    t.throws(() => assertCodexStateRoot(bad), {
      message: /ENDO_CODEX_STATE_DIR/,
    });
  }
});

test('the formula entry point takes null powers and a configured root', async t => {
  const root = path.join(await makeTmp(t), 'state');
  const provider = await makeStateProviderModule(null, undefined, {
    env: { ENDO_CODEX_STATE_DIR: root },
  });
  t.deepEqual(await provider.locateSessionDirectory('codex-abc'), {});
  await t.throwsAsync(
    makeStateProviderModule(/** @type {any} */ ({}), undefined, {
      env: { ENDO_CODEX_STATE_DIR: root },
    }),
    { message: /requires null powers/ },
  );
  // Configuration is read before powers, so a bad root is reported as such.
  await t.throwsAsync(makeStateProviderModule(null, undefined, { env: {} }), {
    message: /ENDO_CODEX_STATE_DIR/,
  });
});
