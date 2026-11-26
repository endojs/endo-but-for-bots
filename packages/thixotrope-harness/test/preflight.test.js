// @ts-check
// scripts/preflight.mjs: a state directory's pre-start check (Tokyo plan
// 4.2, 5.2). Every check passes on a well-formed synthetic state; each
// defect is reported; nothing in the state or the key directory changes,
// and no key is ever created; decrypt checks print only ok or fail.
import './unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { makeSignInStore } from '../resources/agent-host/impl/gateway/signin.js';
import {
  SECRETS_KEY_VARIABLE,
  findSecretsFiles,
  makeSecretStore,
} from '../resources/agent-host/impl/secrets/store.js';
import { makeWrappingKey } from '../resources/agent-host/impl/secrets/wrapping-key.js';
import { preflight } from '../scripts/preflight.mjs';
import { scratch } from './_helpers.js';

/** @param {string | Buffer} bytes */
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * Every file under `dir` with its size and mtime.
 * @param {string} dir
 * @returns {Record<string, string>}
 */
const snapshot = dir => {
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, String(name));
    const info = statSync(file);
    out[String(name)] = info.isDirectory()
      ? 'dir'
      : `${info.size}:${info.mtimeMs}:${sha256(readFileSync(file))}`;
  }
  return out;
};

/** @param {import('ava').ExecutionContext} t */
const makeState = async t => {
  const root = await scratch(t, 'pf-');
  const state = path.join(root, 'state');
  const release = path.join(root, 'thixotrope');
  const keyFile = path.join(root, 'keys', 'secrets.key');
  mkdirSync(path.join(state, 'heaps'), { recursive: true });
  mkdirSync(path.join(state, 'bundles'));
  mkdirSync(path.join(release, 'dist-ironhorse'), { recursive: true });
  const worker = path.join(root, 'worker');
  writeFileSync(worker, 'worker bytes');
  writeFileSync(path.join(release, 'dist-ironhorse', 'boot.js'), 'boot');
  writeFileSync(path.join(release, 'dist-ironhorse', 'worker-peer.js'), 'peer');
  writeFileSync(path.join(state, 'workspace.json'), '{"version":1}\n');
  writeFileSync(
    path.join(state, 'heaps', 'runtime.json'),
    JSON.stringify({
      format: 2,
      worker: sha256('worker bytes'),
      bootstrap: [sha256('boot'), sha256('peer')],
    }),
  );
  const bundle = '({ make: () => 1 })';
  writeFileSync(path.join(state, 'bundles', `${sha256(bundle)}.cjs`), bundle);
  writeFileSync(
    path.join(state, 'installations.json'),
    JSON.stringify({
      version: 2,
      entries: [
        {
          name: 'clock',
          kind: 'native',
          digest: 'x',
          grants: [],
          allocationKey: 'k',
          durableDigest: sha256(bundle),
          ephemeralDigest: sha256(bundle),
          status: 'ready',
        },
      ],
    }),
  );
  writeFileSync(
    path.join(state, 'harness-serve.json'),
    '{"version":1,"status":"clean","crankBudget":"1","floor":"1"}\n',
  );
  const env = {
    [SECRETS_KEY_VARIABLE]: keyFile,
    THIXOTROPE_IRONHORSE_WORKER: worker,
  };
  // Seal the three files under the key (the first run creates the key).
  const files = findSecretsFiles({ stateDir: state, env });
  const store = makeSecretStore({
    file: files.file,
    auditFile: files.auditFile,
    wrappingKey: makeWrappingKey({ keyFile, stateDir: state }),
  });
  await store.create('k1', 'L', 'd');
  await store.replace('k1', 'not a real value');
  store.close();
  await makeSignInStore({ stateDir: state, env }).ensure();
  const run = () =>
    preflight({ statePath: state, env, thixotropeRoot: release });
  return { root, state, release, keyFile, worker, env, run };
};

/** @param {Awaited<ReturnType<typeof preflight>>} results */
const statusOf = results =>
  Object.fromEntries(results.map(({ check, status }) => [check, status]));

test('a well-formed state passes every check and is left unchanged', async t => {
  const s = await makeState(t);
  const before = snapshot(s.root);
  const results = await s.run();
  t.deepEqual(
    results.filter(({ status }) => status !== 'ok'),
    [],
  );
  t.like(statusOf(results), {
    state: 'ok',
    'harness-serve.json': 'ok',
    'workspace.json': 'ok',
    'heaps/runtime.json': 'ok',
    'worker digest': 'ok',
    'boot bundles': 'ok',
    bundles: 'ok',
    key: 'ok',
    'key opens agent-host/secrets.enc': 'ok',
    'key opens agent-host/secrets-audit.log': 'ok',
    'key opens agent-host/gateway/signin.enc': 'ok',
  });
  t.deepEqual(snapshot(s.root), before);
  // Never a value or key bytes in a detail.
  const key = readFileSync(s.keyFile);
  for (const { detail } of results) {
    t.false(detail.includes(key.toString('hex')));
    t.false(detail.includes('not a real value'));
  }
});

test('another key: every sealed file fails to open, and only "fail" is said', async t => {
  const s = await makeState(t);
  writeFileSync(s.keyFile, randomBytes(32), { mode: 0o600 });
  const before = snapshot(s.root);
  const results = await s.run();
  const opens = results.filter(({ check }) => check.startsWith('key opens'));
  t.is(opens.length, 3);
  for (const result of opens)
    t.like(result, { status: 'fail', detail: 'fail' });
  t.deepEqual(snapshot(s.root), before);
});

test('a deleted key with sealed files fails and creates nothing; on a fresh state it warns', async t => {
  const s = await makeState(t);
  rmSync(s.keyFile);
  const before = snapshot(s.root);
  t.like(statusOf(await s.run()), { key: 'fail' });
  t.deepEqual(snapshot(s.root), before, 'no key minted');

  rmSync(path.join(s.state, 'agent-host'), { recursive: true });
  const fresh = snapshot(s.root);
  t.like(statusOf(await s.run()), { key: 'warn' });
  t.deepEqual(snapshot(s.root), fresh, 'still no key minted');
});

test('a changed worker, boot bundle or stored bundle and a missing workspace.json fail', async t => {
  const s = await makeState(t);
  writeFileSync(s.worker, 'another worker');
  writeFileSync(path.join(s.release, 'dist-ironhorse', 'boot.js'), 'other');
  for (const name of readdirSync(path.join(s.state, 'bundles')))
    rmSync(path.join(s.state, 'bundles', name));
  rmSync(path.join(s.state, 'workspace.json'));
  t.like(statusOf(await s.run()), {
    'worker digest': 'fail',
    'boot bundles': 'fail',
    bundles: 'fail',
    'workspace.json': 'fail',
  });
});

test('a state or key under /tmp is a warning', async t => {
  const s = await makeState(t);
  const results = await preflight({
    statePath: s.state,
    env: { ...s.env, [SECRETS_KEY_VARIABLE]: '/tmp/thix-preflight-none.key' },
    thixotropeRoot: s.release,
  });
  t.true(
    results.some(
      ({ check, status, detail }) =>
        check === 'key location' &&
        status === 'warn' &&
        /temporary directory/.test(detail),
    ),
  );
});
