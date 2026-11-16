// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import {
  makeBasicCredential,
  makeGitRemoteEndpoint,
  getGitCredentialController,
} from '@endo/exo-git';
import { bindGitCredentialSource } from '@endo/exo-git/src/git-credential.js';
import { makeSecretGitCredentialSource } from '../src/secret-git-credential.js';
import { makeSecretManager } from '../src/secret-manager.js';

const fixture = async () => {
  const records = new Map();
  const grants = new Map();
  const bytes = new Map();
  let serial = 0;
  let bound;
  let readGate;
  const readStarted = makePromiseKit();
  const manager = makeSecretManager({
    randomHex256: async () => String((serial += 1)),
    persistence: {
      getSecretRecord: id => records.get(id),
      writeSecretRecord: row => records.set(row.secretId, row),
      listSecretRecords: () => [...records.values()],
      getSecretIdForGrant: id => grants.get(id),
      writeSecretGrant: (id, secretId) => grants.set(id, secretId),
      deleteSecret: id => records.delete(id),
      writeSecretAuditEvent: () => {},
      listSecretAuditEvents: () => [],
    },
    backend: {
      create: async (_op, id, value) => {
        bytes.set(id, new Uint8Array(value));
        return id;
      },
      read: async id => {
        const copy = new Uint8Array(bytes.get(id));
        readStarted.resolve(undefined);
        await readGate;
        return copy;
      },
      replace: async (_op, id, value) => {
        bytes.set(id, new Uint8Array(value));
      },
      revoke: async (_op, id) => {
        bytes.delete(id);
      },
    },
  });
  /** @type {any} */
  const directory = manager.makeHostDirectory({
    bindGrant: async grantId => {
      bound = grantId;
    },
    listKnownGrantPaths: async () => [
      { grantId: bound, path: ['secrets', 'test'] },
    ],
    removeKnownGrantPaths: async () => {},
  });
  await E(await E(directory).lookup('create')).createBase64(
    'test',
    'Test',
    btoa('first'),
  );
  const secret = await E(directory).lookup(['use', bound]);
  const admin = await E(await E(directory).lookup('catalog')).adminFor(secret);
  const cap = makeBasicCredential({
    audience: 'https://git.example',
    username: 'user',
    password: 'legacy',
  });
  const endpoint = makeGitRemoteEndpoint({
    url: 'https://git.example/repo',
    credential: cap,
  });
  let revoked = false;
  const source = () =>
    makeSecretGitCredentialSource({
      audience: 'https://git.example',
      username: 'user',
      secretSource: manager.sourceForBlob(secret),
      revoked,
      onRevoke: async () => {
        revoked = true;
      },
    });
  return {
    readStarted: readStarted.promise,
    manager,
    secret,
    admin,
    cap,
    endpoint,
    source,
    gate: p => {
      readGate = p;
    },
  };
};

const password = async endpoint => {
  const credential = await endpoint.ensureCredentialUsable();
  if (credential?.kind !== 'basic') throw Error('Expected basic credential');
  return credential.material.password;
};

test('identity-preserving secret migration reaches already-created endpoints; rotation is read per operation', async t => {
  const w = await fixture();
  t.is(await password(w.endpoint), 'legacy');
  bindGitCredentialSource(w.cap, w.source());
  t.is(await password(w.endpoint), 'first');
  const version = w.endpoint.captureCredentialVersion();
  let notifications = 0;
  const unwatch = w.endpoint.watchChange(() => {
    notifications += 1;
  });
  t.teardown(() => unwatch?.());
  await E(w.admin).replaceBase64(btoa('second'));
  t.is(notifications, 1);
  t.throws(() => w.endpoint.assertCredentialUnchanged('push', version), {
    message: /changed/,
  });
  t.is(await password(w.endpoint), 'second');
  await E(w.admin).revoke();
  await t.throwsAsync(w.endpoint.ensureCredentialUsable(), {
    message: /revoked/,
  });
  t.deepEqual(await w.endpoint.credentialHealth(), {
    required: true,
    kind: 'basic',
    audience: 'https://git.example',
    available: false,
    revoked: true,
  });
});
// Each mutation uses a separate owner; sequence deliberately awaits it.
/* eslint-disable no-await-in-loop */
test('rotation or revocation during secret read cannot hand stale material to transport', async t => {
  t.timeout(10_000);
  for (const mutate of ['replaceBase64', 'revoke']) {
    const w = await fixture();
    bindGitCredentialSource(w.cap, w.source());
    const gate = makePromiseKit();
    w.gate(gate.promise);
    const pending = w.endpoint.ensureCredentialUsable();
    await w.readStarted;
    if (mutate === 'replaceBase64') await E(w.admin).replaceBase64(btoa('new'));
    else await E(w.admin).revoke();
    gate.resolve(undefined);
    await t.throwsAsync(pending, { message: /unavailable/ });
  }
});
test('Git controller cannot bypass secret rotation, and local revocation survives source reconstruction', async t => {
  const w = await fixture();
  bindGitCredentialSource(w.cap, w.source());
  const controller = getGitCredentialController(w.cap);
  await t.throwsAsync(
    E(controller).rotate({ username: 'user', password: 'bypass' }),
    { message: /Secrets Manager/ },
  );
  await E(controller).revoke();
  bindGitCredentialSource(w.cap, w.source());
  await t.throwsAsync(w.endpoint.ensureCredentialUsable(), {
    message: /revoked/,
  });
  t.is((await E(w.admin).getSummary()).state, 'active');
});
test('secret adapter rejects foreign read facets without calling them', async t => {
  const w = await fixture();
  t.throws(
    () =>
      w.manager.sourceForBlob({
        readBase64: () => {
          t.fail();
        },
      }),
    { message: /FOREIGN_SECRET/ },
  );
});
