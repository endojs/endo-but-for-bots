// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { makeDaemonDatabase } from '../src/manager-database-node.js';

test('secret metadata survives updates without invalidating grants', async t => {
  const statePath = await mkdtemp(path.join(os.tmpdir(), 'endo-secret-db-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));
  const database = makeDaemonDatabase(
    /** @type {import('../src/types.js').Config} */ ({
      statePath,
      ephemeralStatePath: statePath,
      cachePath: statePath,
      sockPath: path.join(statePath, 'endo.sock'),
      registryUrl: 'https://invalid.example',
    }),
  );
  t.teardown(() => database.close());
  const record = harden({
    secretId: 'secret-id',
    backendRef: 'opaque-backend-ref',
    purpose: 'Deploy releases',
    state: /** @type {'active'} */ ('active'),
    generation: 1n,
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
  });
  database.writeSecretRecord(record);
  database.writeSecretGrant('grant-id', record.secretId);
  database.writeSecretRecord(
    harden({ ...record, generation: 2n, updatedAt: 'later' }),
  );

  t.is(database.getSecretIdForGrant('grant-id'), record.secretId);
  t.is(database.getSecretRecord(record.secretId)?.generation, 2n);
  t.is(database.listSecretRecords().length, 1);

  const sqlite = await readFile(path.join(statePath, 'endo.sqlite'));
  t.false(sqlite.includes(new TextEncoder().encode('CANARY-secret-value')));
});
