// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { decodeBase64, encodeBase64 } from '@endo/base64';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';

import { makeSecretManager, secretBlobHelp } from '../src/secret-manager.js';

const canary = 'CANARY-secret-never-persist-or-log';

const makeHarness = () => {
  const records = new Map();
  const grants = new Map();
  const events = [];
  const values = new Map();
  let serial = 0;
  const randomHex256 = async () => `${(serial += 1)}`.padStart(64, '0');
  const persistence = harden({
    getSecretRecord: id => records.get(id),
    writeSecretRecord: record => records.set(record.secretId, record),
    listSecretRecords: () => [...records.values()],
    getSecretIdForGrant: id => grants.get(id),
    writeSecretGrant: (grantId, secretId) => grants.set(grantId, secretId),
    writeSecretAuditEvent: event => events.push(event),
    listSecretAuditEvents: limit => events.slice(-limit).reverse(),
  });
  const backend = harden({
    create: async (_operationId, secretId, bytes) => {
      values.set(secretId, new Uint8Array(bytes));
      return secretId;
    },
    read: async ref => new Uint8Array(values.get(ref)),
    replace: async (_operationId, ref, bytes) => {
      values.set(ref, new Uint8Array(bytes));
    },
    revoke: async (_operationId, ref) => {
      values.delete(ref);
    },
  });
  const bindings = [];
  const makeManager = () =>
    makeSecretManager({ persistence, backend, randomHex256 });
  const makeDirectory = manager =>
    manager.makeHostDirectory({
      bindGrant: async (grantId, name) => bindings.push({ grantId, name }),
    });
  return {
    records,
    grants,
    events,
    values,
    bindings,
    makeManager,
    makeDirectory,
  };
};

test('secret facets remain separated and durable across manager restart', async t => {
  const harness = makeHarness();
  const directory = harness.makeDirectory(harness.makeManager());
  const importer = await E(directory).lookup('create');
  const summary = await E(importer).createBase64(
    'github-release',
    'Publish GitHub releases',
    encodeBase64(new TextEncoder().encode(canary)),
  );

  t.is(summary.description, 'Publish GitHub releases');
  t.deepEqual(
    harness.bindings.map(({ name }) => name),
    ['github-release'],
  );
  const [{ grantId }] = harness.bindings;

  const catalog = await E(directory).lookup('catalog');
  const [entry] = await E(catalog).list();
  t.is(entry.secretId, summary.secretId);
  t.false('__getMethodNames__' in entry.summary);
  t.false(
    // eslint-disable-next-line no-underscore-dangle
    (await E(entry.admin).__getMethodNames__()).includes('readBase64'),
  );

  const restartedDirectory = harness.makeDirectory(harness.makeManager());
  const blob = await E(restartedDirectory).lookup(['use', grantId]);
  t.is(await E(blob).help(), secretBlobHelp);
  t.is(await E(blob).getDescription(), 'Publish GitHub releases');
  t.is(
    new TextDecoder().decode(decodeBase64(await E(blob).readBase64())),
    canary,
  );

  await E(entry.admin).replaceBase64(
    encodeBase64(new TextEncoder().encode('replacement')),
  );
  t.is(
    new TextDecoder().decode(decodeBase64(await E(blob).readBase64())),
    'replacement',
  );
  await E(entry.admin).setDescription('Publish future releases');
  t.is(
    (await E(entry.admin).getSummary()).description,
    'Publish future releases',
  );
  t.deepEqual(
    harness.events
      .filter(({ operation }) => operation === 'set-description')
      .map(({ outcome }) => outcome),
    ['attempted', 'succeeded'],
  );
  t.false(
    harness.events.some(event =>
      Object.values(event).includes('Publish future releases'),
    ),
  );
  await E(entry.admin).revoke();
  await t.throwsAsync(() => E(blob).readBase64(), {
    message: /Secret operation failed/,
  });

  const persisted = JSON.stringify({
    records: [...harness.records.values()].map(record => ({
      ...record,
      generation: String(record.generation),
    })),
    grants: [...harness.grants],
    events: harness.events.map(event => ({
      ...event,
      generation: String(event.generation),
    })),
  });
  t.false(persisted.includes(canary));
  t.false(persisted.includes('replacement'));
});

test('a revoke racing a backend read fails the release closed', async t => {
  const harness = makeHarness();
  const directory = harness.makeDirectory(harness.makeManager());
  const importer = await E(directory).lookup('create');
  await E(importer).createBase64(
    'race',
    'Exercise the revocation fence',
    encodeBase64(new TextEncoder().encode(canary)),
  );
  const [{ grantId }] = harness.bindings;
  const [record] = harness.records.values();
  const original = harness.values.get(record.backendRef);
  const readStarted = makePromiseKit();
  const releaseRead = makePromiseKit();
  const racingBackend = harden({
    create: async () => record.backendRef,
    read: async () => {
      readStarted.resolve(undefined);
      await releaseRead.promise;
      return new Uint8Array(original);
    },
    replace: async () => {},
    revoke: async () => {},
  });
  let serial = 1000;
  const manager = makeSecretManager({
    persistence: harden({
      getSecretRecord: id => harness.records.get(id),
      writeSecretRecord: next => harness.records.set(next.secretId, next),
      listSecretRecords: () => [...harness.records.values()],
      getSecretIdForGrant: id => harness.grants.get(id),
      writeSecretGrant: (id, secretId) => harness.grants.set(id, secretId),
      writeSecretAuditEvent: event => harness.events.push(event),
      listSecretAuditEvents: limit => harness.events.slice(-limit),
    }),
    backend: racingBackend,
    randomHex256: async () => `${(serial += 1)}`.padStart(64, '0'),
  });
  const racingDirectory = harness.makeDirectory(manager);
  const blob = await E(racingDirectory).lookup(['use', grantId]);
  const read = E(blob).readBase64();
  await readStarted.promise;
  const catalog = await E(racingDirectory).lookup('catalog');
  const [entry] = await E(catalog).list();
  await E(entry.admin).revoke();
  releaseRead.resolve(undefined);
  await t.throwsAsync(() => read, { message: /Secret operation failed/ });
});

test('fixed failures do not reflect secret input', async t => {
  const harness = makeHarness();
  const directory = harness.makeDirectory(harness.makeManager());
  const importer = await E(directory).lookup('create');
  const error = await t.throwsAsync(() =>
    E(importer).createBase64('bad', 'Valid description', canary),
  );
  t.false(error.message.includes(canary));
});

test('replace cannot race revocation into resurrecting a secret', async t => {
  const harness = makeHarness();
  const initialDirectory = harness.makeDirectory(harness.makeManager());
  const importer = await E(initialDirectory).lookup('create');
  await E(importer).createBase64(
    'serialized',
    'Serialize lifecycle mutations',
    encodeBase64(new TextEncoder().encode(canary)),
  );
  const [record] = harness.records.values();
  const replaceStarted = makePromiseKit();
  const releaseReplace = makePromiseKit();
  const backend = harden({
    create: async () => record.backendRef,
    read: async ref => new Uint8Array(harness.values.get(ref)),
    replace: async (_operationId, ref, bytes) => {
      replaceStarted.resolve(undefined);
      await releaseReplace.promise;
      harness.values.set(ref, new Uint8Array(bytes));
    },
    revoke: async (_operationId, ref) => {
      harness.values.delete(ref);
    },
  });
  let serial = 2000;
  const manager = makeSecretManager({
    persistence: harden({
      getSecretRecord: id => harness.records.get(id),
      writeSecretRecord: next => harness.records.set(next.secretId, next),
      listSecretRecords: () => [...harness.records.values()],
      getSecretIdForGrant: id => harness.grants.get(id),
      writeSecretGrant: (id, secretId) => harness.grants.set(id, secretId),
      writeSecretAuditEvent: event => harness.events.push(event),
      listSecretAuditEvents: limit => harness.events.slice(-limit),
    }),
    backend,
    randomHex256: async () => `${(serial += 1)}`.padStart(64, '0'),
  });
  const directory = harness.makeDirectory(manager);
  const catalog = await E(directory).lookup('catalog');
  const [entry] = await E(catalog).list();
  const replacing = E(entry.admin).replaceBase64(
    encodeBase64(new TextEncoder().encode('replacement')),
  );
  await replaceStarted.promise;
  const revoking = E(entry.admin).revoke();
  releaseReplace.resolve(undefined);
  await Promise.all([replacing, revoking]);

  t.is(harness.records.get(record.secretId).state, 'revoked');
  t.false(harness.values.has(record.backendRef));
});
