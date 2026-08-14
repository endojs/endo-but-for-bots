// @ts-nocheck

// Cross-backend parity test for the daemon's pet-store SQLite
// store.  Verifies that an `<statePath>/endo.sqlite` file written
// by one supervisor (Node `better-sqlite3` or Rust+XS via
// `endor-sqlite.js`) survives a full daemon shutdown and a
// restart under the *other* supervisor — both directions.
//
// The test is gated by the presence of the `endor` binary at the
// path advertised through `ENDO_BIN` (or the workspace's default
// release build location).  Without it, we can't run the Rust+XS
// supervisor and the parity test reduces to a Node-only restart
// — uninteresting, so we skip.

// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import url from 'url';
import path from 'path';
import fs from 'fs';
import { E } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { start, stop, purge, makeEndoClient } from '../index.js';

const dirname = url.fileURLToPath(new URL('..', import.meta.url)).toString();

const endorBin =
  process.env.ENDO_BIN || path.resolve(dirname, '../../target/release/endor');
const hasEndor = fs.existsSync(endorBin);

const testIfEndor = hasEndor ? test.serial : test.serial.skip;

const makeConfig = (...root) => ({
  statePath: path.join(dirname, ...root, 'state'),
  ephemeralStatePath: path.join(dirname, ...root, 'run'),
  cachePath: path.join(dirname, ...root, 'cache'),
  sockPath: path.join(dirname, ...root, 'endo.sock'),
  address: '127.0.0.1:0',
  pets: new Map(),
  values: new Map(),
  gcEnabled: false,
});

/**
 * Run `body(host)` against a fresh daemon-client connection, then
 * close the connection cleanly so the next `start` can reuse the
 * same socket path.
 */
const withHost = async (config, body) => {
  const { reject: cancel, promise: cancelled } = makePromiseKit();
  cancelled.catch(() => {});
  const { getBootstrap, closed } = await makeEndoClient(
    'parity-client',
    config.sockPath,
    cancelled,
  );
  closed.catch(() => {});
  const bootstrap = getBootstrap();
  const host = E(bootstrap).host();
  try {
    return await body(host);
  } finally {
    cancel(Error('done'));
  }
};

const startNode = async config => {
  delete process.env.ENDO_BIN;
  delete process.env.ENDO_DEFAULT_PLATFORM;
  delete process.env.ENDO_NODE_WORKER_BIN;
  await start(config);
};

const startRustXs = async config => {
  process.env.ENDO_BIN = endorBin;
  delete process.env.ENDO_DEFAULT_PLATFORM;
  delete process.env.ENDO_NODE_WORKER_BIN;
  await start(config);
};

/**
 * Pet-store entries written by `host.storeValue(petName)` are the
 * cleanest cross-supervisor surface to read back: they live in
 * the `pet_store_entry` table by name and pet-store-typed.
 * `host.list()` returns the names visible to the active host
 * (both pinned and ephemeral); a value stored by name then
 * looked up after restart proves the on-disk pet-store row was
 * read by the new supervisor.
 */
const storeAndList = async host => {
  // Three values, just enough to detect ordering / decoding bugs.
  await E(host).storeValue('alpha-value', 'parity-alpha');
  await E(host).storeValue(42, 'parity-beta');
  await E(host).storeValue(
    { nested: ['array', 'of', 'strings'] },
    'parity-gamma',
  );
  const names = await E(host).list();
  return names.filter(n => n.startsWith('parity-')).sort();
};

const expectedNames = ['parity-alpha', 'parity-beta', 'parity-gamma'];

testIfEndor('SQLite parity — Rust+XS writes, Node reads', async t => {
  const config = makeConfig('tmp', 'sqlite-parity-rxs-then-node');
  await purge(config);

  // Phase 1: Rust+XS supervisor.
  await startRustXs(config);
  const writtenNames = await withHost(config, storeAndList);
  await stop(config).catch(() => {});

  t.deepEqual(
    writtenNames,
    expectedNames,
    'XS-side write recorded all three names',
  );

  // Phase 2: Node supervisor on the same statePath.  No purge.
  await startNode(config);
  try {
    const seenNames = await withHost(config, async host => {
      const names = await E(host).list();
      return names.filter(n => n.startsWith('parity-')).sort();
    });
    t.deepEqual(
      seenNames,
      expectedNames,
      'Node supervisor read XS-written rows',
    );

    // And the values themselves round-trip:
    await withHost(config, async host => {
      t.is(await E(host).lookup(['parity-alpha']), 'alpha-value');
      t.is(await E(host).lookup(['parity-beta']), 42);
      t.deepEqual(await E(host).lookup(['parity-gamma']), {
        nested: ['array', 'of', 'strings'],
      });
    });
  } finally {
    await stop(config).catch(() => {});
  }
});

testIfEndor('SQLite parity — Node writes, Rust+XS reads', async t => {
  const config = makeConfig('tmp', 'sqlite-parity-node-then-rxs');
  await purge(config);

  // Phase 1: Node supervisor.
  await startNode(config);
  const writtenNames = await withHost(config, storeAndList);
  await stop(config).catch(() => {});

  t.deepEqual(
    writtenNames,
    expectedNames,
    'Node-side write recorded all three names',
  );

  // Phase 2: Rust+XS supervisor on the same statePath.  No purge.
  await startRustXs(config);
  try {
    const seenNames = await withHost(config, async host => {
      const names = await E(host).list();
      return names.filter(n => n.startsWith('parity-')).sort();
    });
    t.deepEqual(
      seenNames,
      expectedNames,
      'Rust+XS supervisor read Node-written rows',
    );

    await withHost(config, async host => {
      t.is(await E(host).lookup(['parity-alpha']), 'alpha-value');
      t.is(await E(host).lookup(['parity-beta']), 42);
      t.deepEqual(await E(host).lookup(['parity-gamma']), {
        nested: ['array', 'of', 'strings'],
      });
    });
  } finally {
    await stop(config).catch(() => {});
  }
});

testIfEndor('SQLite parity — rename survives backend swap', async t => {
  const config = makeConfig('tmp', 'sqlite-parity-rename');
  await purge(config);

  await startRustXs(config);
  await withHost(config, async host => {
    await E(host).storeValue('rename-me-original', 'rename-source');
  });
  await stop(config).catch(() => {});

  await startNode(config);
  await withHost(config, async host => {
    await E(host).move(['rename-source'], ['rename-target']);
    const names = await E(host).list();
    t.false(names.includes('rename-source'));
    t.true(names.includes('rename-target'));
  });
  await stop(config).catch(() => {});

  await startRustXs(config);
  try {
    await withHost(config, async host => {
      const names = await E(host).list();
      t.false(names.includes('rename-source'));
      t.true(names.includes('rename-target'));
      t.is(await E(host).lookup(['rename-target']), 'rename-me-original');
    });
  } finally {
    await stop(config).catch(() => {});
  }
});
