// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { installPublisherGrant } from '../src/config.js';
import { openRegistry } from '../src/server.js';
import { makeTempDir, makeTestRegistry } from './_fixtures.js';

const TOKEN = 'p'.repeat(40);

test('installPublisherGrant records an acceptable grant', t => {
  const { grants } = makeTestRegistry();
  /** @type {string[]} */
  const reports = [];
  const recorded = installPublisherGrant(
    grants,
    {
      id: 'fresh',
      subject: 'publisher',
      packages: ['solo'],
      expiresAt: Date.now() + 60_000,
      token: TOKEN,
    },
    line => reports.push(line),
  );
  t.true(recorded);
  t.deepEqual(reports, []);
  t.is(grants.authenticate(TOKEN)?.subject, 'publisher');
});

test('installPublisherGrant reports, not throws, a refused grant', t => {
  const { grants } = makeTestRegistry();
  const grant = {
    id: 'stale',
    subject: 'publisher',
    packages: ['solo'],
    expiresAt: Date.now() + 60_000,
    token: TOKEN,
  };
  grants.putGrant(grant);
  grants.revokeGrant('stale');
  /** @type {string[]} */
  const reports = [];
  const recorded = installPublisherGrant(grants, grant, line =>
    reports.push(line),
  );
  t.false(recorded);
  t.is(reports.length, 1);
  const entry = JSON.parse(reports[0]);
  t.is(entry.event, 'publisher-grant-refused');
  t.is(entry.id, 'stale');
  t.regex(entry.reason, /is revoked/);
  t.is(grants.authenticate(TOKEN), undefined);
});

test('the server entry point keeps serving when its grant is refused', async t => {
  const stateDir = makeTempDir();
  const setup = openRegistry({
    stateDir,
    publicOrigin: 'https://npm.example',
    openDatabase: file => new Database(file),
  });
  const grant = {
    id: 'revoked-in-secret',
    subject: 'publisher',
    packages: ['solo'],
    expiresAt: Date.now() + 60_000,
    token: TOKEN,
  };
  setup.grants.putGrant(grant);
  setup.grants.revokeGrant(grant.id);
  setup.store.checkpoint();
  /** @type {any} */ (setup.database).close();

  const bin = fileURLToPath(
    new URL('../bin/npm-registry-server.js', import.meta.url),
  );
  const child = spawn(process.execPath, [bin], {
    env: {
      ...process.env,
      REGISTRY_STATE_DIR: stateDir,
      PUBLIC_REGISTRY_URL: 'https://npm.example',
      UPSTREAM_REGISTRY_URL: '',
      PORT: '0',
      REGISTRY_PUBLISHER_GRANT_ID: grant.id,
      REGISTRY_PUBLISHER_TOKEN: TOKEN,
      REGISTRY_PUBLISHER_PACKAGES: 'solo',
      REGISTRY_PUBLISHER_EXPIRES: new Date(grant.expiresAt).toISOString(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.teardown(() => child.kill('SIGKILL'));
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const listening = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.includes('"event":"listening"')) resolve(undefined);
    });
    child.once('exit', code =>
      reject(Error(`server exited ${code} before listening: ${stderr}`)),
    );
  });
  await listening;
  const refused = stderr
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .find(entry => entry?.event === 'publisher-grant-refused');
  t.truthy(refused, stderr);
  t.is(refused.id, grant.id);
  child.kill('SIGTERM');
  const [code] = await once(child, 'exit');
  t.is(code, 0);
});
