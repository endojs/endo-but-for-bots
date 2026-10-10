// @ts-nocheck

/** @import { DaemonDatabase } from '../src/manager-database.js' */

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
 * @returns {DaemonDatabase}
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

// Migration coverage: a host formula persisted before
// endojs/endo-but-for-bots#671 required the
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

    await stop(config);

    // Simulate a host persisted before endojs/endo-but-for-bots#671 by
    // writing it back with the registry field stripped out.
    let originalRegistryUrl;
    {
      const db = openTestDb(config.statePath);
      try {
        const { formula: formulaBefore } = db.readFormula(hostNumber);
        t.is(formulaBefore.type, 'host');
        t.truthy(
          formulaBefore.registry,
          'a freshly formulated host already carries a registry field',
        );
        const { number: originalRegistryNumber } = parseId(
          formulaBefore.registry,
        );
        const { formula: originalRegistryFormula } = db.readFormula(
          originalRegistryNumber,
        );
        t.is(originalRegistryFormula.type, 'registry');
        originalRegistryUrl = originalRegistryFormula.registryUrl;
        const { registry, ...legacyFormula } = formulaBefore;
        t.truthy(registry);
        db.writeFormula(hostNumber, hostNode, legacyFormula);
      } finally {
        db.close();
      }
    }

    await restart(config);
    const { getBootstrap, closed } = await makeEndoClient(
      'client-migrated',
      config.sockPath,
      cancelled,
    );
    closed.catch(() => {});
    const hostAfter = E(getBootstrap()).host();

    let migratedRegistryId;
    {
      const db = openTestDb(config.statePath);
      try {
        const { formula: migratedFormula } = db.readFormula(hostNumber);
        t.is(migratedFormula.type, 'host');
        t.truthy(migratedFormula.registry, 'migration re-populates registry');
        migratedRegistryId = migratedFormula.registry;
        const { number: migratedRegistryNumber } = parseId(migratedRegistryId);
        const { formula: migratedRegistryFormula } = db.readFormula(
          migratedRegistryNumber,
        );
        t.is(migratedRegistryFormula.type, 'registry');
        t.is(
          migratedRegistryFormula.registryUrl,
          originalRegistryUrl,
          'migration uses the same default registry URL as a fresh host',
        );
      } finally {
        db.close();
      }
    }

    const registryAfter = await E(hostAfter).lookup('@registry');
    t.truthy(registryAfter, '@registry resolves for the migrated host');
    t.is(
      await E(hostAfter).identify('@registry'),
      migratedRegistryId,
      'the migrated registry field backs the @registry special name',
    );

    await restart(config);
    {
      const db = openTestDb(config.statePath);
      try {
        const { formula: restartedFormula } = db.readFormula(hostNumber);
        t.is(restartedFormula.type, 'host');
        t.is(
          restartedFormula.registry,
          migratedRegistryId,
          'a second startup does not replace the migrated registry',
        );
      } finally {
        db.close();
      }
    }
  },
);

// Concurrent-arrival coverage: a single startup can discover more than one host
// formula missing `registry` — a daemon owns its `@agent` host plus any
// `provideHost` children — so the migration maps over N ≥ 2 legacy hosts, not
// exactly one.  Each must receive its OWN distinct registry formula.  This is
// the multi-entry path that makes the migration loop's sequential ordering (over
// `Promise.all`, see manager.js) matter: two siblings entering the formula-graph
// lock concurrently could otherwise interleave.  See
// designs/registry-capability.md § Migration for already-formulated hosts.
test.serial(
  'two host formulas persisted without registry are each migrated on startup',
  async t => {
    const { host, cancelled } = await prepare(t);
    const { config } = contexts[contexts.length - 1];

    // A second, child host under the same daemon, so startup discovers more
    // than one host formula to migrate.
    await E(host).provideHost('child-host');

    await stop(config);

    // Simulate every host persisted before the registry field existed by
    // stripping the field from each host formula on disk.  Enumerate the
    // formulas directly rather than via pet names — a `provideHost` child is
    // reachable through a `handle`, not as a bare host id.
    const hostNumbers = [];
    {
      const db = openTestDb(config.statePath);
      try {
        for (const { number, node } of db.listFormulas()) {
          const { formula } = db.readFormula(number);
          if (formula.type === 'host') {
            t.truthy(
              formula.registry,
              'a freshly formulated host already carries a registry field',
            );
            const { registry, ...legacyFormula } = formula;
            t.truthy(registry);
            db.writeFormula(number, node, legacyFormula);
            hostNumbers.push(number);
          }
        }
      } finally {
        db.close();
      }
    }
    t.true(
      hostNumbers.length >= 2,
      'the daemon persisted at least two host formulas to migrate',
    );

    await restart(config);
    const { getBootstrap, closed } = await makeEndoClient(
      'client-multi-migrated',
      config.sockPath,
      cancelled,
    );
    closed.catch(() => {});
    const hostAfter = E(getBootstrap()).host();

    {
      const db = openTestDb(config.statePath);
      try {
        const registryIds = new Set();
        for (const number of hostNumbers) {
          const { formula: migrated } = db.readFormula(number);
          t.is(migrated.type, 'host');
          t.truthy(
            migrated.registry,
            'each stale host is re-populated with a registry on startup',
          );
          const { number: registryNumber } = parseId(migrated.registry);
          const { formula: registryFormula } = db.readFormula(registryNumber);
          t.is(registryFormula.type, 'registry');
          registryIds.add(migrated.registry);
        }
        t.is(
          registryIds.size,
          hostNumbers.length,
          'each migrated host gets its own distinct registry formula',
        );
      } finally {
        db.close();
      }
    }

    const registryAfter = await E(hostAfter).lookup('@registry');
    t.truthy(
      registryAfter,
      '@registry resolves after a concurrent multi-host migration',
    );
  },
);
