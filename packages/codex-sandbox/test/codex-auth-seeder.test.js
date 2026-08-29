// @ts-check
import '@endo/init';

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import test from 'ava';

import { make } from '../src/codex-auth-seeder.js';

test('seeds auth exactly once with private mode', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-auth-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const seeder = make(undefined, undefined, {
    env: { CODEX_HOME_DIR: dir },
  });
  const json = '{"tokens":{"access_token":"secret"}}';

  const receipt = await seeder.seed(json);
  t.deepEqual(receipt, {
    kind: 'codexAuth',
    audience: 'codex-host',
    byteLength: new TextEncoder().encode(json).byteLength,
  });
  t.is(await readFile(path.join(dir, 'auth.json'), 'utf8'), json);
  t.is((await stat(path.join(dir, 'auth.json'))).mode % 0o1000, 0o600);

  await t.throwsAsync(() => seeder.seed('{"replacement":true}'), {
    message: /already seeded/,
  });
  t.is(await readFile(path.join(dir, 'auth.json'), 'utf8'), json);
});

test('rejects invalid auth JSON without creating a file', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-auth-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const seeder = make(undefined, undefined, {
    env: { CODEX_HOME_DIR: dir },
  });

  await t.throwsAsync(() => seeder.seed('not json'), {
    message: /valid JSON/,
  });
  t.deepEqual(await seeder.status(), { seeded: false, byteLength: 0 });
});
