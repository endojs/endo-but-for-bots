// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import {
  installPublisherGrant,
  parseIsoInstant,
  readPublisherGrantEnv,
  readServerEnv,
} from '../src/config.js';
import { openRegistry } from '../src/server.js';
import { makeTemporaryDirectory, makeTestRegistry } from './_fixtures.js';

const TOKEN = 'p'.repeat(40);

const SERVER_ENV = {
  REGISTRY_STATE_DIRECTORY: '/state',
  PUBLIC_REGISTRY_URL: 'https://npm.example',
};

test('readServerEnv distinguishes an empty upstream from an absent one', t => {
  t.is(readServerEnv(SERVER_ENV).upstreamOrigin, 'https://registry.npmjs.org');
  t.is(
    readServerEnv({ ...SERVER_ENV, UPSTREAM_REGISTRY_URL: '' }).upstreamOrigin,
    undefined,
  );
  t.throws(() =>
    readServerEnv({ ...SERVER_ENV, UPSTREAM_REGISTRY_URL: 'http://x.example' }),
  );
  t.throws(() => readServerEnv({ PUBLIC_REGISTRY_URL: 'https://npm.example' }));
});

test('readServerEnv refuses ports and TTLs out of range', t => {
  t.is(readServerEnv(SERVER_ENV).port, 3003);
  t.is(readServerEnv({ ...SERVER_ENV, PORT: '0' }).port, 0);
  t.is(readServerEnv({ ...SERVER_ENV, PORT: '65535' }).port, 65_535);
  for (const PORT of ['abc', '-1', '65536', '1.5']) {
    t.throws(() => readServerEnv({ ...SERVER_ENV, PORT }), undefined, PORT);
  }
  t.is(
    readServerEnv({ ...SERVER_ENV, UPSTREAM_TTL_SECONDS: '2' }).upstreamTtlMs,
    2000,
  );
  t.throws(() => readServerEnv({ ...SERVER_ENV, UPSTREAM_TTL_SECONDS: 'x' }));
});

test('expiry dates must carry an explicit offset', t => {
  t.is(parseIsoInstant('2027-01-01'), Date.UTC(2027, 0, 1));
  t.is(parseIsoInstant('2027-01-01T00:00:00Z'), Date.UTC(2027, 0, 1));
  t.is(parseIsoInstant('2027-01-01T01:00+01:00'), Date.UTC(2027, 0, 1));
  t.is(parseIsoInstant('2028-02-29'), Date.UTC(2028, 1, 29));
  t.is(
    parseIsoInstant('2027-01-01T00:00:00.500Z'),
    Date.UTC(2027, 0, 1, 0, 0, 0, 500),
  );
  t.is(
    parseIsoInstant('2026-12-31T23:59:59-00:30'),
    Date.UTC(2027, 0, 1, 0, 29, 59),
  );
  // No offset means host-local time to `Date.parse`; other formats are
  // engine heuristics.
  for (const text of [
    '2027-01-01T00:00',
    'Jan 1 2027',
    '2027-13-01',
    '2027-02-30',
    '2027-02-29T00:00Z',
    // Milliseconds are exactly three digits, and every time field is
    // bounded here rather than left to `Date.parse`'s rollover.
    '2027-01-01T00:00:00.5Z',
    '2027-01-01T00:00:00.5000Z',
    '2027-01-01T24:00Z',
    '2027-01-01T23:60Z',
    '2027-01-01T23:59:60Z',
    '2027-01-01T00:00+24:00',
    '2027-01-01T00:00+00:60',
    '',
  ]) {
    t.is(parseIsoInstant(text), undefined, text);
  }
});

test('a publisher token without an allowlist fails closed', t => {
  const env = {
    REGISTRY_PUBLISHER_TOKEN: TOKEN,
    REGISTRY_PUBLISHER_EXPIRES: '2027-01-01',
  };
  t.throws(() => readPublisherGrantEnv(env), {
    message: /REGISTRY_PUBLISHER_PACKAGES is required/,
  });
  t.deepEqual(
    readPublisherGrantEnv({
      ...env,
      REGISTRY_PUBLISHER_PACKAGES: ' @endo/* , solo ',
    })?.packages,
    ['@endo/*', 'solo'],
  );
  t.throws(() =>
    readPublisherGrantEnv({
      ...env,
      REGISTRY_PUBLISHER_PACKAGES: 'solo',
      REGISTRY_PUBLISHER_EXPIRES: '2027-01-01T00:00',
    }),
  );
  t.is(readPublisherGrantEnv({}), undefined);
});

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
  const stateDirectory = makeTemporaryDirectory();
  const setup = openRegistry({
    stateDirectory,
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
      REGISTRY_STATE_DIRECTORY: stateDirectory,
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
  const { url } = JSON.parse(
    stdout.split('\n').find(line => line.includes('"event":"listening"')) ??
      '{}',
  );
  const status = await new Promise((resolve, reject) => {
    http
      .get(`${url}/-/ping`, { agent: false }, response => {
        response.resume();
        resolve(response.statusCode);
      })
      .on('error', reject);
  });
  t.is(status, 200, 'reads keep serving');
});
