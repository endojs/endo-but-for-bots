// @ts-nocheck

// End-to-end against a real Endo daemon: the asset server is the retention
// root for what it serves. A route, and the read-only facet behind it, must
// come back after a daemon restart with nobody publishing again; a revoked
// route must stay gone; and the facets the server hands out must not write.
//
// Daemon tests are serial because each one forks a full daemon process and
// shares the filesystem under `test/tmp`.

// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import path from 'path';
import fs from 'fs';
import os from 'os';
import url from 'url';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { start, stop, restart, purge, makeEndoClient } from '@endo/daemon';

const dirname = url.fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);

const assetServerModuleHref = url.pathToFileURL(
  path.join(dirname, '..', 'src', 'asset-server-module.js'),
).href;
const nodeFsModuleHref = url.pathToFileURL(
  require.resolve('@endo/platform/fs/extended/node-fs-module.js'),
).href;

let testCounter = 0;

// Under the system temporary directory, not `test/tmp`: a Unix-domain socket
// path is bounded (104 bytes on macOS), and a deep checkout overruns it, which
// the daemon reports as EADDRINUSE.
const makeConfig = () => {
  testCounter += 1;
  const tag = String(testCounter).padStart(4, '0');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'efa-'));
  return {
    base,
    statePath: path.join(base, 'state'),
    ephemeralStatePath: path.join(base, 'run'),
    cachePath: path.join(base, 'cache'),
    sockPath:
      process.platform === 'win32'
        ? `\\\\?\\pipe\\endo-fs-asset-${tag}.sock`
        : path.join(base, 'endo.sock'),
    address: '127.0.0.1:0',
    pets: new Map(),
    values: new Map(),
  };
};

const connect = async (t, config) => {
  const { reject: cancel, promise: cancelled } = makePromiseKit();
  cancelled.catch(() => {});
  t.teardown(() => cancel(new Error('test teardown')));
  const { getBootstrap, closed } = await makeEndoClient(
    'client',
    config.sockPath,
    cancelled,
  );
  closed.catch(() => {});
  return E(getBootstrap()).host();
};

const prepareHost = async t => {
  const config = makeConfig();
  await purge(config);
  await start(config);
  t.teardown(async () => {
    await stop(config).catch(() => {});
    fs.rmSync(config.base, { recursive: true, force: true });
  });
  return { host: await connect(t, config), config };
};

/** The server with a host agent of its own, and a name for each facet. */
const provideAssetServer = async host => {
  // The handle and the agent are two names; the agent is the powers.
  await E(host).provideHost('asset-host-handle', { agentName: 'asset-host' });
  await E(host).makeUnconfined('@main', assetServerModuleHref, {
    powersName: 'asset-host',
    resultName: 'asset-root',
    env: { ENDO_FS_ASSET_SERVER_PORT: '0', ENDO_FS_ASSET_SERVER_DURABLE: '1' },
  });
  await E(host).evaluate('@main', 'E(root).admin()', ['root'], ['asset-root'], 'asset-admin');
  await E(host).evaluate(
    '@main',
    'E(root).publisher()',
    ['root'],
    ['asset-root'],
    'asset-publisher',
  );
  return {
    admin: await E(host).lookup(['asset-admin']),
    publisher: await E(host).lookup(['asset-publisher']),
  };
};

const get = async (admin, routePath, file = '') => {
  const { origin } = await E(admin).getAddress();
  const response = await fetch(`${origin}${routePath}${file}`);
  return { status: response.status, text: await response.text() };
};

const siteNames = async host =>
  (await E(await E(host).lookup(['asset-host'])).list()).filter(name =>
    name.startsWith('asset-'),
  );

test.serial('a served mount comes back after a restart by itself, read-only', async t => {
  const { host, config } = await prepareHost(t);
  const siteDir = path.join(config.base, 'site');
  fs.mkdirSync(siteDir, { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'index.html'), '<p>one</p>\n');

  const mount = await E(host).provideMount(siteDir, 'site');
  const { admin, publisher } = await provideAssetServer(host);

  const served = await E(publisher).serve(mount, { label: 'the site' });
  t.regex(served.id, /^[0-9a-f]{32}$/);
  t.deepEqual(await get(admin, served.path), { status: 200, text: '<p>one</p>\n' });

  // The publisher can neither list nor reach the administrator.
  // eslint-disable-next-line no-underscore-dangle
  const publisherMethods = await E(publisher).__getMethodNames__();
  for (const forbidden of ['list', 'getTarget', 'revoke', 'stop', 'admin']) {
    t.false(publisherMethods.includes(forbidden), forbidden);
  }

  // What the server kept is a read-only facet: the administrator can read
  // through it and cannot write through it, though the mount handed over
  // was writable.
  const [listed] = await E(admin).list();
  t.like(listed, { id: served.id, label: 'the site', kind: 'mount', status: 'ready' });
  t.is(listed.path, served.path);
  const facet = await E(admin).getTarget(served.id);
  t.is(await E(await E(facet).lookup('index.html')).text(), '<p>one</p>\n');
  // The daemon's read-only mount answers the mutators and refuses each.
  await t.throwsAsync(E(facet).writeText(['defaced.html'], 'x'), {
    message: /read-only/,
  });
  await t.throwsAsync(E(facet).remove(['index.html']), {
    message: /read-only/,
  });
  t.deepEqual(fs.readdirSync(siteDir), ['index.html']);
  // The administrator has no way to repoint a route.
  // eslint-disable-next-line no-underscore-dangle
  const adminMethods = await E(admin).__getMethodNames__();
  for (const forbidden of ['serve', 'publisher', 'release']) {
    t.false(adminMethods.includes(forbidden), forbidden);
  }

  await restart(config);
  const host2 = await connect(t, config);
  // Nobody serves again: looking the administrator up is only how the test
  // learns the new port.
  const admin2 = await E(host2).lookup(['asset-admin']);
  fs.writeFileSync(path.join(siteDir, 'index.html'), '<p>two</p>\n');
  t.deepEqual(await get(admin2, served.path), { status: 200, text: '<p>two</p>\n' });
  const [restored] = await E(admin2).list();
  t.like(restored, { id: served.id, label: 'the site', status: 'ready' });
  t.is(restored.path, served.path);

  // Removal is the one mutation, and it survives a restart too.
  t.true(await E(admin2).revoke(served.id));
  t.is((await get(admin2, served.path)).status, 404);
  t.deepEqual(await siteNames(host2), []);
  await restart(config);
  const host3 = await connect(t, config);
  const admin3 = await E(host3).lookup(['asset-admin']);
  t.deepEqual(await E(admin3).list(), []);
  t.is((await get(admin3, served.path)).status, 404);
});

test.serial('a Filesystem and a Git workspace are retained too; a derived view is refused', async t => {
  const { host, config } = await prepareHost(t);
  const fsDir = path.join(config.base, 'fs-site');
  const gitDir = path.join(config.base, 'git-site');
  for (const dir of [fsDir, gitDir]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), `<p>${path.basename(dir)}</p>\n`);
  }
  await E(host).makeUnconfined('@node', nodeFsModuleHref, {
    powersName: '@none',
    env: { ENDO_FS_ROOT: fsDir, ENDO_FS_READ_ONLY: '1' },
    resultName: 'fs-site',
  });
  execFileSync('git', ['init', '-q', gitDir]);
  const gitMount = await E(host).provideMount(gitDir, 'git-mount');
  const git = await E(host).provideGit(gitMount, 'git-site');

  const { admin, publisher } = await provideAssetServer(host);
  const fsServed = await E(publisher).serve(await E(host).lookup(['fs-site']));
  const gitServed = await E(publisher).serve(git);
  t.is((await get(admin, fsServed.path)).text, '<p>fs-site</p>\n');
  t.is((await get(admin, gitServed.path)).text, '<p>git-site</p>\n');

  // A view of a mount has no formula: it would serve until the restart and
  // then stop, so it is refused and nothing is left behind for it.
  const before = await siteNames(host);
  await t.throwsAsync(E(publisher).serve(await E(gitMount).readOnly()));
  t.deepEqual(await siteNames(host), before);
  t.is((await E(admin).list()).length, 2);

  // The publisher releases by the id it was given, and only by that.
  t.false(await E(publisher).release('0'.repeat(32)));
  t.like(await E(publisher).describe(fsServed.id), { path: fsServed.path });

  await restart(config);
  const host2 = await connect(t, config);
  const admin2 = await E(host2).lookup(['asset-admin']);
  t.is((await get(admin2, fsServed.path)).text, '<p>fs-site</p>\n');
  t.is((await get(admin2, gitServed.path)).text, '<p>git-site</p>\n');
  const publisher2 = await E(host2).lookup(['asset-publisher']);
  t.true(await E(publisher2).release(gitServed.id));
  t.is((await get(admin2, gitServed.path)).status, 404);
  t.is((await get(admin2, fsServed.path)).status, 200);
});

test.serial('a mount keeps its deny list when it is served, and a crash leaves nothing retained', async t => {
  const { host, config } = await prepareHost(t);
  const siteDir = path.join(config.base, 'site');
  fs.mkdirSync(path.join(siteDir, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'index.html'), '<p>site</p>\n');
  fs.writeFileSync(path.join(siteDir, 'secrets', 'key.pem'), 'PRIVATE\n');
  const mount = await E(host).provideMount(siteDir, 'site', {
    deniedSegments: ['secrets'],
  });
  const { admin, publisher } = await provideAssetServer(host);
  const served = await E(publisher).serve(mount);
  t.is((await get(admin, served.path)).status, 200);
  // The server derives its own read-only mount; that must not shed the
  // parent's restrictions.
  t.is((await get(admin, served.path, 'secrets/key.pem')).status, 404);

  // What a crash between retaining a target and recording its route leaves:
  // a target name with no record. The next incarnation discards it.
  const agent = await E(host).lookup(['asset-host']);
  const orphan = `asset-target-${'e'.repeat(32)}`;
  await E(agent).provideSubMount(mount, [], orphan, { readOnly: true });
  t.true((await siteNames(host)).includes(orphan));
  await restart(config);
  const host2 = await connect(t, config);
  const admin2 = await E(host2).lookup(['asset-admin']);
  t.is((await get(admin2, served.path)).status, 200);
  t.false((await siteNames(host2)).includes(orphan));
  t.is((await siteNames(host2)).length, 2);
});

test.serial('default powers are an in-memory server; insisting on durable refuses them', async t => {
  // What the pre-durable deployments have pinned: the module made with no
  // powersName. It must still come up (a setup migrating away from it has to
  // be able to look it up and stop it), and must not pretend to be durable.
  const { host } = await prepareHost(t);
  await E(host).makeUnconfined('@main', assetServerModuleHref, {
    resultName: 'legacy',
    env: { ENDO_FS_ASSET_SERVER_PORT: '0' },
  });
  const legacy = await E(host).lookup(['legacy']);
  const admin = await E(legacy).admin();
  t.deepEqual(await E(admin).list(), []);
  await E(admin).stop();

  await t.throwsAsync(
    E(host).makeUnconfined('@main', assetServerModuleHref, {
      resultName: 'insisted',
      env: {
        ENDO_FS_ASSET_SERVER_PORT: '0',
        ENDO_FS_ASSET_SERVER_DURABLE: '1',
      },
    }),
    { message: /needs a host agent/ },
  );
});
