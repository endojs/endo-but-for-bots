// @ts-nocheck

// Integration test: the `@registry` special name is populated on every host
// (mirroring `@node`), so `E(host).lookup('@registry')` returns the host's
// EndoRegistry capability without the caller branching on its presence.  See
// designs/registry-capability.md § Host special name.
//
// The socket path lives under a short os.tmpdir() directory to stay within
// the ~104-char unix-domain-socket limit regardless of the checkout path.

// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import os from 'os';
import path from 'path';
import fsp from 'fs/promises';
import { E } from '@endo/eventual-send';
import { makeCancelKit } from '@endo/cancel';
import { start, stop, restart, purge, makeEndoClient } from '../index.js';
import { makeDaemonDatabase } from '../src/manager-database-node.js';
import { parseId } from '../src/formula-identifier.js';

const contexts = [];

test.afterEach.always(async () => {
  while (contexts.length > 0) {
    const { cancel, config, root } = contexts.pop();
    // eslint-disable-next-line no-await-in-loop
    await stop(config).catch(() => {});
    cancel(new Error('test teardown'));
    // eslint-disable-next-line no-await-in-loop
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * Open a read/write handle to the daemon's SQLite database for test
 * inspection and mutation, mirroring `openTestDb` in endo.test.js.
 *
 * @param {string} statePath
 * @returns {import('../src/manager-database.js').DaemonDatabase}
 */
const openTestDb = statePath =>
  makeDaemonDatabase({
    statePath,
    ephemeralStatePath: '',
    cachePath: '',
    sockPath: '',
  });

const prepare = async t => {
  const { cancel, cancelled } = makeCancelKit();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'endo-reg-'));
  const config = {
    statePath: path.join(root, 'state'),
    ephemeralStatePath: path.join(root, 'run'),
    cachePath: path.join(root, 'cache'),
    sockPath: path.join(root, 'endo.sock'),
    address: '127.0.0.1:0',
    pets: new Map(),
    values: new Map(),
  };
  await purge(config);
  await start(config);
  contexts.push({ cancel, config, root });

  const { getBootstrap, closed } = await makeEndoClient(
    'client',
    config.sockPath,
    cancelled,
  );
  closed.catch(() => {});
  const host = E(getBootstrap()).host();
  return { host, cancelled };
};

test.serial('E(host).lookup("@registry") resolves an EndoRegistry', async t => {
  const { host } = await prepare(t);
  const registry = await E(host).lookup('@registry');
  t.truthy(registry, '@registry is populated on the host');
  const help = await E(registry).help();
  t.true(
    typeof help === 'string' && help.includes('EndoRegistry'),
    'the registry reports its help',
  );
});

test.serial(
  '@registry lookup(name, version) is undefined before any fetch',
  async t => {
    const { host } = await prepare(t);
    const registry = await E(host).lookup('@registry');
    const missing = await E(registry).lookup('ses', '1.0.0');
    t.is(missing, undefined, 'an unfetched package is absent from the table');
    const listed = await E(registry).list();
    t.deepEqual(listed, [], 'the registry table starts empty');
  },
);

test.serial(
  '@registry survives a fresh client connection (formula is persisted)',
  async t => {
    const { host, cancelled } = await prepare(t);
    const first = await E(host).lookup('@registry');
    t.truthy(first);
    // A second client over the same daemon still sees the slot; the host
    // formula carries the required registry field.
    const { getBootstrap, closed } = await makeEndoClient(
      'client-2',
      contexts[contexts.length - 1].config.sockPath,
      cancelled,
    );
    closed.catch(() => {});
    const host2 = E(getBootstrap()).host();
    const again = await E(host2).lookup('@registry');
    t.truthy(again, '@registry resolves for a second client');
  },
);

// Migration coverage: a host formula persisted before #671 required the
// `registry` field lacks it entirely.  On startup, `seedFormulaGraphFromPersistence`
// (packages/daemon/src/manager.js) upgrades it in place with a fresh
// daemon-default registry formula so the daemon starts successfully and
// `@registry` resolves, rather than failing fast the way a genuinely
// malformed host formula would.  See designs/registry-capability.md §
// Migration for already-formulated hosts.
test.serial(
  'a host formula persisted without registry is migrated on startup and resolves @registry',
  async t => {
    const { host, cancelled } = await prepare(t);
    const { config } = contexts[contexts.length - 1];

    const hostId = await E(host).identify('@agent');
    const { number: hostNumber, node: hostNode } = parseId(hostId);

    const { formula: formulaBefore } = openTestDb(config.statePath).readFormula(
      hostNumber,
    );
    t.is(formulaBefore.type, 'host');
    t.truthy(
      formulaBefore.registry,
      'a freshly formulated host already carries a registry field',
    );

    await stop(config);

    // Simulate a pre-#671 persisted host formula by writing it back
    // with the registry field stripped out.
    const { registry: _registry, ...legacyFormula } = formulaBefore;
    openTestDb(config.statePath).writeFormula(
      hostNumber,
      hostNode,
      legacyFormula,
    );

    await restart(config);
    const { getBootstrap, closed } = await makeEndoClient(
      'client-migrated',
      config.sockPath,
      cancelled,
    );
    closed.catch(() => {});
    const hostAfter = E(getBootstrap()).host();

    const { formula: migratedFormula } = openTestDb(
      config.statePath,
    ).readFormula(hostNumber);
    t.is(migratedFormula.type, 'host');
    t.truthy(migratedFormula.registry, 'migration re-populates registry');

    const registryAfter = await E(hostAfter).lookup('@registry');
    t.truthy(registryAfter, '@registry resolves for the migrated host');
    t.is(
      await E(hostAfter).identify('@registry'),
      migratedFormula.registry,
      'the migrated registry field backs the @registry special name',
    );
  },
);
