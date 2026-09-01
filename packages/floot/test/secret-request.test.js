// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import {
  makeSecretRequestBroker,
  makeSecretRequestKit,
} from '../src/secret-request.js';

const makeGuest = () => {
  /** @type {Map<string, unknown>} */
  const store = new Map();
  return Far('Guest', {
    async has(name) {
      return store.has(name);
    },
    async lookup(name) {
      if (!store.has(name)) throw new Error(`unknown ${name}`);
      return store.get(name);
    },
    async remove(name) {
      store.delete(name);
    },
    async storeValue(value, name) {
      store.set(name, value);
    },
    // eslint-disable-next-line no-underscore-dangle
    async __getMethodNames__() {
      return ['has', 'lookup', 'remove', 'storeValue'];
    },
  });
};

const makeHost = () => {
  /** @type {Array<{ name: unknown, opts: unknown }>} */
  const minted = [];
  /** @type {Array<{ mount: unknown, path: unknown, cap: unknown }>} */
  const written = [];
  /** Names currently bound in the host inventory. */
  const bound = new Set();
  const host = Far('Host', {
    async has(name) {
      return bound.has(name);
    },
    async remove(name) {
      bound.delete(name);
    },
    async provideBearerCredential(name, opts) {
      bound.add(name);
      minted.push({ kind: 'bearer', name, opts });
      return Far('BearerCredential', {
        audience: () => opts.audience,
      });
    },
    async provideBasicCredential(name, opts) {
      bound.add(name);
      minted.push({ kind: 'basic', name, opts });
      return Far('BasicCredential', {
        audience: () => opts.audience,
      });
    },
    async writeSecret(mount, path, cap) {
      written.push({ mount, path, cap });
    },
  });
  return { host, minted, written, bound };
};

test('requestSecret waits for submit and returns a receipt without the bytes', async t => {
  const { host, minted } = makeHost();
  const guest = makeGuest();
  const kit = makeSecretRequestKit({
    host,
    sessionGuest: guest,
    sessionId: 's1',
    randomId: () => 'req-1',
  });

  const pendingP = E(kit.tools.requestSecret).execute({
    label: 'Google service-account JSON',
    petName: 'google-sa',
    audience: 'google-calendar',
  });
  for (let i = 0; i < 20 && !kit.getPending(); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  t.deepEqual(kit.getPending(), {
    id: 'req-1',
    label: 'Google service-account JSON',
    petName: 'google-sa',
    kind: 'bearer',
    audience: 'google-calendar',
  });

  const receipt = await kit.submit('req-1', '-----BEGIN PRIVATE KEY-----');
  t.deepEqual(receipt, {
    petName: 'google-sa',
    kind: 'bearer',
    audience: 'google-calendar',
    byteLength: '-----BEGIN PRIVATE KEY-----'.length,
  });
  t.is(JSON.stringify(receipt).includes('BEGIN PRIVATE'), false);

  const toolResult = await pendingP;
  t.is(toolResult.includes('BEGIN PRIVATE'), false);
  t.regex(toolResult, /google-sa/);

  t.is(minted.length, 1);
  t.is(
    /** @type {any} */ (minted[0].opts).token,
    '-----BEGIN PRIVATE KEY-----',
  );
  const cap = await E(guest).lookup('google-sa');
  t.is(await E(cap).audience(), 'google-calendar');
  t.is(kit.getPending(), null);
});

test('requestSecret preserves opaque bytes exactly', async t => {
  const { host, minted } = makeHost();
  const kit = makeSecretRequestKit({
    host,
    sessionGuest: makeGuest(),
    sessionId: 's1',
    randomId: () => 'req-exact',
  });
  const pendingP = E(kit.tools.requestSecret).execute({
    label: 'opaque file',
    petName: 'opaque-file',
  });
  const value = '  leading\nbody\ntrailing  \n';
  await kit.submit('req-exact', value);
  await pendingP;
  t.is(/** @type {any} */ (minted[0].opts).token, value);
});

test('secret broker supports a policy-specific managed-file acceptor', async t => {
  const broker = makeSecretRequestBroker({ randomId: () => 'req-file' });
  /** @type {unknown} */
  let accepted;
  const pendingP = broker.request(
    {
      label: 'Codex auth.json',
      petName: 'codex-auth',
      kind: 'managed-file',
      audience: 'codex-host',
    },
    async value => {
      accepted = value;
      return {
        petName: 'codex-auth',
        kind: 'managed-file',
        audience: 'codex-host',
        byteLength: new TextEncoder().encode(/** @type {string} */ (value))
          .byteLength,
      };
    },
  );
  const value = '{"tokens":{"refresh_token":"opaque"}}\n';
  const receipt = await broker.submit('req-file', value);
  t.is(accepted, value);
  t.is(await pendingP, receipt);
  t.is(JSON.stringify(receipt).includes('refresh_token'), false);
});

test('cancel rejects the waiting requestSecret tool', async t => {
  const { host } = makeHost();
  const kit = makeSecretRequestKit({
    host,
    sessionGuest: makeGuest(),
    sessionId: 's1',
    randomId: () => 'req-2',
  });
  const pendingP = E(kit.tools.requestSecret).execute({
    label: 'token',
    petName: 'api-token',
  });
  for (let i = 0; i < 20 && !kit.getPending(); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  t.truthy(kit.getPending());
  kit.cancel('req-2');
  await t.throwsAsync(pendingP, { message: /cancelled/ });
  t.is(kit.getPending(), null);
});

test('writeSecret writes through the host without returning bytes', async t => {
  const { host, minted, written } = makeHost();
  const guest = makeGuest();
  const kit = makeSecretRequestKit({
    host,
    sessionGuest: guest,
    sessionId: 's1',
    randomId: () => 'req-3',
  });
  const pendingP = E(kit.tools.requestSecret).execute({
    label: 'token',
    petName: 'api-token',
  });
  await kit.submit('req-3', 'sk-secret');
  await pendingP;

  const mount = Far('Mount', {});
  await E(guest).storeValue(mount, 'workspace');
  const result = await E(kit.tools.writeSecret).execute({
    petName: 'api-token',
    destPetName: 'workspace',
    path: 'secrets/token',
  });
  t.regex(result, /secrets\/token/);
  t.is(result.includes('sk-secret'), false);
  t.is(written.length, 1);
  t.is(written[0].path, 'secrets/token');
  t.is(written[0].mount, mount);
  t.is(minted.length, 1);
});

// Ingested material dies with the daemon process, so re-requesting the same
// secret after a restart is the ORDINARY path, not an edge case. Keying the
// host name on the request id left a dead credential bound for every one of
// those, forever.
test('re-requesting a secret rebinds one host name instead of accumulating', async t => {
  const { host, minted, bound } = makeHost();
  const guest = makeGuest();
  let n = 0;
  const kit = makeSecretRequestKit({
    host,
    sessionGuest: guest,
    sessionId: 's1',
    randomId: () => {
      n += 1;
      return `req-${n}`;
    },
  });

  const ingest = async value => {
    const done = E(kit.tools.requestSecret).execute({
      label: 'Forge token',
      petName: 'forge',
      audience: 'https://git.example',
    });
    for (let i = 0; i < 20 && !kit.getPending(); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await null;
    }
    const pending = kit.getPending();
    await kit.submit(/** @type {any} */ (pending).id, value);
    return done;
  };

  await ingest('first-token');
  await ingest('second-token');

  t.deepEqual(
    minted.map(m => m.name),
    ['floot-secret-s1-forge', 'floot-secret-s1-forge'],
  );
  t.deepEqual([...bound], ['floot-secret-s1-forge']);
});
