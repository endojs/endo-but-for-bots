// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { mkdtemp, rm } from 'node:fs/promises';
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
    description: 'Deploy releases',
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

  database.deleteSecret(record.secretId);
  t.is(database.getSecretRecord(record.secretId), undefined);
  t.is(database.getSecretIdForGrant('grant-id'), undefined);
});

test('audit events never carry a redeemable grant identifier', async t => {
  const statePath = await mkdtemp(path.join(os.tmpdir(), 'endo-secret-audit-'));
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

  // A grant identifier is redeemable read authority: `@secrets/use/<grantId>`
  // mints a SecretBlob for whoever presents it. The audit facet is readable by
  // anyone holding `@secrets/audit`, so no audit row may carry one.
  const grantId = 'CANARY-grant-token';
  database.writeSecretRecord(
    harden({
      secretId: 'secret-id',
      backendRef: 'opaque-backend-ref',
      description: 'Deploy releases',
      state: /** @type {'active'} */ ('active'),
      generation: 1n,
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:00.000Z',
    }),
  );
  database.writeSecretGrant(grantId, 'secret-id');
  database.writeSecretAuditEvent(
    harden({
      eventId: 'event-id',
      secretId: 'secret-id',
      operation: /** @type {'read'} */ ('read'),
      outcome: /** @type {'succeeded'} */ ('succeeded'),
      generation: 1n,
      occurredAt: '2026-09-03T00:00:00.000Z',
      operationId: 'operation-id',
    }),
  );

  // The grant row itself legitimately holds the token, so this pins the audit
  // projection specifically rather than scanning the whole database file.
  t.is(database.getSecretIdForGrant(grantId), 'secret-id');

  const [event] = database.listSecretAuditEvents(10);
  t.is(event.eventId, 'event-id');
  t.is(event.generation, 1n);
  t.false('grantId' in event);
  t.false(
    JSON.stringify({ ...event, generation: String(event.generation) }).includes(
      grantId,
    ),
  );
});

test('audit events are ordered by insertion, not by timestamp', async t => {
  const statePath = await mkdtemp(path.join(os.tmpdir(), 'endo-secret-seq-'));
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

  // Same `occurredAt` to the millisecond, and event ids that sort opposite to
  // insertion order: exactly the shape a real attempted/succeeded pair takes,
  // since event ids are random and the clock has millisecond resolution.
  const occurredAt = '2026-09-03T00:00:00.000Z';
  /** @type {Array<{eventId: string, outcome: 'attempted' | 'succeeded'}>} */
  const pair = [
    { eventId: 'zzz-first', outcome: 'attempted' },
    { eventId: 'aaa-second', outcome: 'succeeded' },
  ];
  for (const { eventId, outcome } of pair) {
    database.writeSecretAuditEvent(
      harden({
        eventId,
        secretId: 'secret-id',
        operation: /** @type {'read'} */ ('read'),
        outcome,
        generation: 1n,
        occurredAt,
        operationId: 'operation-id',
      }),
    );
  }

  // Newest first, so the later insertion leads regardless of its event id.
  t.deepEqual(
    database.listSecretAuditEvents(10).map(event => event.eventId),
    ['aaa-second', 'zzz-first'],
  );
});
