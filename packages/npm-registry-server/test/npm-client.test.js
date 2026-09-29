// End-to-end check with the stock npm CLI: publish dated development
// versions, then install one through a global registry override from an
// empty cache, including an upstream-only transitive graph; then replay the
// install with upstream unreachable and another empty cache.

import test from '@endo/ses-ava/prepare-endo.js';

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

import { startRegistryServer } from '../src/server.js';
import { digestTarball } from '../src/tarball.js';
import { makeTempDir, makeTgz } from './_fixtures.js';

const run = promisify(execFile);
const TOKEN = 't'.repeat(43);
const VERSION = '0.1.0-dev.20260928231903.g3aa902d';
const TAG = 'dev-2026-09-28';

const hasNpm = await run('npm', ['--version']).then(
  () => true,
  () => false,
);

/** @returns {Promise<number>} */
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {net.AddressInfo} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });

/**
 * A stand-in public registry with a two-package transitive graph:
 * `tiny-upstream` depends on `tiny-leaf`.
 */
const startUpstream = async () => {
  /** @type {Map<string, Uint8Array>} */
  const tarballs = new Map();
  /** @type {Record<string, any>} */
  const packuments = {};
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const add = (name, version, dependencies = {}) => {
    const tgz = makeTgz({
      'package.json': JSON.stringify({
        name,
        version,
        dependencies,
        main: 'index.js',
      }),
      'index.js': `module.exports = ${JSON.stringify(name)};\n`,
    });
    const { integrity, shasum } = digestTarball(tgz);
    tarballs.set(`/${name}/-/${name}-${version}.tgz`, tgz);
    packuments[`/${name}`] = {
      name,
      'dist-tags': { latest: version },
      versions: {
        [version]: {
          name,
          version,
          dependencies,
          dist: {
            integrity,
            shasum,
            tarball: `${origin}/${name}/-/${name}-${version}.tgz`,
          },
        },
      },
    };
  };
  add('tiny-leaf', '1.0.0');
  add('tiny-upstream', '1.2.3', { 'tiny-leaf': '^1.0.0' });
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    requests.push(url);
    const tgz = tarballs.get(url);
    if (tgz) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(tgz);
    } else if (packuments[url]) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(packuments[url]));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not_found"}');
    }
  });
  await new Promise(resolve =>
    server.listen(port, '127.0.0.1', () => resolve(undefined)),
  );
  return { origin, server, requests };
};

/**
 * @param {string} dir
 * @param {Record<string, string>} extra
 */
const npmEnv = (dir, extra = {}) => ({
  PATH: process.env.PATH,
  HOME: dir,
  npm_config_userconfig: path.join(dir, '.npmrc'),
  npm_config_cache: path.join(dir, 'cache'),
  npm_config_update_notifier: 'false',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  ...extra,
});

(hasNpm ? test : test.skip)(
  'npm publishes dated dev versions and installs the full graph through one registry',
  async t => {
    const upstream = await startUpstream();
    const port = await freePort();
    const registryUrl = `http://127.0.0.1:${port}`;
    const stateDir = makeTempDir();
    const logs = [];
    const registry = await startRegistryServer({
      stateDir,
      port,
      publicOrigin: registryUrl,
      upstreamOrigin: upstream.origin,
      upstreamTtlMs: 0,
      openDatabase: file => new Database(file),
      log: entry => logs.push(entry),
    });
    t.teardown(() => registry.close());
    t.teardown(
      () =>
        new Promise(resolve => upstream.server.close(() => resolve(undefined))),
    );
    registry.grants.putGrant({
      id: 'e2e',
      subject: 'garden-llm-publisher',
      packages: ['@endo/*'],
      expiresAt: Date.now() + 3_600_000,
      token: TOKEN,
    });

    // Publisher: two staged packages, one depending on the other at the
    // exact shared prerelease and on an upstream-only package.
    const publisher = makeTempDir();
    fs.writeFileSync(
      path.join(publisher, '.npmrc'),
      `//127.0.0.1:${port}/:_authToken=${TOKEN}\n`,
    );
    const stage = (name, dependencies) => {
      const dir = path.join(publisher, name.replace('/', '-'));
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name,
          version: VERSION,
          main: 'index.js',
          dependencies,
        }),
      );
      fs.writeFileSync(
        path.join(dir, 'index.js'),
        `module.exports = ${JSON.stringify(name)};\n`,
      );
      return dir;
    };
    const leaf = stage('@endo/e2e-leaf', {});
    const top = stage('@endo/e2e-top', {
      '@endo/e2e-leaf': VERSION,
      'tiny-upstream': '^1.2.0',
    });
    const env = npmEnv(publisher);
    for (const dir of [leaf, top]) {
      // eslint-disable-next-line no-await-in-loop
      await run(
        'npm',
        [
          'publish',
          '--registry',
          registryUrl,
          '--tag',
          TAG,
          '--access',
          'public',
        ],
        { cwd: dir, env },
      );
    }
    const { stdout: whoami } = await run(
      'npm',
      ['whoami', '--registry', registryUrl],
      { cwd: publisher, env },
    );
    t.is(whoami.trim(), 'garden-llm-publisher');
    const { stdout: viewed } = await run(
      'npm',
      ['view', `@endo/e2e-top@${TAG}`, 'version', '--registry', registryUrl],
      { cwd: publisher, env },
    );
    t.is(viewed.trim(), VERSION);

    // A plain `npm publish` defaults to `latest` and is refused.
    fs.writeFileSync(
      path.join(leaf, 'package.json'),
      JSON.stringify({
        name: '@endo/e2e-leaf',
        version: '0.1.0-dev.20260928235959.gbbbbbbb',
      }),
    );
    await t.throwsAsync(
      run('npm', ['publish', '--registry', registryUrl], { cwd: leaf, env }),
    );

    // Cold clients: empty home, cache, and project; one global registry.
    const install = async () => {
      const client = makeTempDir();
      fs.writeFileSync(
        path.join(client, 'package.json'),
        '{"name":"client","version":"1.0.0"}',
      );
      await run(
        'npm',
        ['install', `@endo/e2e-top@${TAG}`, '--ignore-scripts'],
        {
          cwd: client,
          env: npmEnv(client, { npm_config_registry: `${registryUrl}/` }),
        },
      );
      const lock = JSON.parse(
        fs.readFileSync(path.join(client, 'package-lock.json'), 'utf8'),
      );
      const resolved = Object.entries(lock.packages)
        .filter(([key]) => key !== '')
        .map(([key, entry]) => [key, entry.resolved, entry.version]);
      return { client, resolved };
    };

    const first = await install();
    t.deepEqual(first.resolved.map(([key]) => key).sort(), [
      'node_modules/@endo/e2e-leaf',
      'node_modules/@endo/e2e-top',
      'node_modules/tiny-leaf',
      'node_modules/tiny-upstream',
    ]);
    for (const [key, resolved] of first.resolved) {
      t.true(resolved.startsWith(`${registryUrl}/`), `${key} ${resolved}`);
    }
    t.true(upstream.requests.includes('/tiny-leaf/-/tiny-leaf-1.0.0.tgz'));
    t.deepEqual(registry.registry.verifyStore(), []);

    // Offline replay: upstream gone, another empty client cache.
    await new Promise(resolve =>
      upstream.server.close(() => resolve(undefined)),
    );
    upstream.server.closeAllConnections();
    const before = upstream.requests.length;
    const second = await install();
    t.is(second.resolved.length, 4);
    t.is(upstream.requests.length, before);
    const { stdout } = await run(
      process.execPath,
      ['-e', "console.log(require('@endo/e2e-top'), require('tiny-leaf'))"],
      { cwd: second.client },
    );
    t.is(stdout.trim(), '@endo/e2e-top tiny-leaf');
    t.false(
      logs.some(entry => Number(entry.status) >= 500),
      JSON.stringify(logs.filter(entry => Number(entry.status) >= 500)),
    );
  },
);
