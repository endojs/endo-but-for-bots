// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { setTimeout } from 'node:timers';

import { E } from '@endo/eventual-send';
import { encodeUtf8 } from '@endo/utf8/encode.js';
import { makeInMemoryFilesystem } from '@endo/platform/fs/extended';
import { makeTimer } from '@endo/fetch/timer.js';

import { makeFetchStore } from '../src/store.js';
import { makeConfinedFetchService as makeConfinedFetchServiceCore } from '../src/service.js';

/** @import { FetchStoreDirectory } from '../src/types.js' */

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Let the fire-and-forget persistence write-chain settle. */
const flush = () => delay(10);

/** @param {any} powers */
const makeConfinedFetchService = powers => {
  const timer = makeTimer({
    setTimeout: (callback, milliseconds) => {
      const handle = setTimeout(callback, milliseconds);
      handle.unref();
      return handle;
    },
  });
  return makeConfinedFetchServiceCore({
    delay: (milliseconds, cancelled) => timer.delay(milliseconds, cancelled),
    now: () => timer.now(),
    ...powers,
  });
};

const ALLOWED = 'https://api.example.com';
const ALLOWED_URL = `${ALLOWED}/data`;
const OTHER = 'https://other.example.com';
const OTHER_URL = `${OTHER}/data`;

/**
 * A fake `FetchLike` transport that echoes the requested URL and records calls.
 *
 * @param {string} [body]
 */
const makeFakeFetch = (body = 'ok') => {
  /** @type {string[]} */
  const calls = [];
  const fetch = async (url, _options = {}) => {
    calls.push(String(url));
    const bytes = encodeUtf8(body);
    return harden({
      status: 200,
      statusText: 'OK',
      headers: {},
      url: String(url),
      body: harden({
        getReader: () => {
          let done = false;
          return harden({
            read: async () => {
              if (done) return harden({ done: true });
              done = true;
              return harden({ done: false, value: bytes });
            },
            cancel: async () => {
              done = true;
            },
            releaseLock: () => {},
          });
        },
      }),
    });
  };
  return { fetch, calls };
};

/**
 * A store over a fresh in-memory filesystem, plus a `reopen` that builds a new
 * store adapter over the SAME directory - modelling a daemon restart that reads
 * the persisted documents back.
 */
const makeStoreFixture = async () => {
  const fs = makeInMemoryFilesystem();
  const root = await E(fs).root();
  // `Directory.lookup` reports `Directory | File`; the fetch store only ever
  // looks up the documents it wrote, which is what `FetchStoreDirectory`, the
  // structural minimum `makeFetchStore` takes, says.
  const directory = /** @type {FetchStoreDirectory} */ (
    /** @type {unknown} */ (await E(root).makeDirectory('fetch-store'))
  );
  let counter = 0;
  const makeId = async () => `${(counter += 1)}`;
  const open = () => makeFetchStore(directory, makeId);
  // `directory` is exposed so a test can seed a corrupt document directly,
  // modelling a torn write the crash-safe read guards must survive.
  return { open, directory };
};

test('client fetches an allowed origin, denies others, seeds the store', async t => {
  const { open } = await makeStoreFixture();
  const store = await open();
  const { fetch } = makeFakeFetch('hello');

  const { service, client, control } = await makeConfinedFetchService({
    store,
    fetch,
    now: () => 1000,
    allowedOrigins: [ALLOWED],
    maxResponseBytes: 1000,
  });

  t.is(await E(service).client(), client);
  t.is(await E(service).control(), control);

  const response = await client.fetch(ALLOWED_URL);
  t.is(response.status(), 200);
  t.is(await response.text(), 'hello');

  await t.throwsAsync(() => client.fetch(OTHER_URL), {
    message: /not in the allowed-origin list|Policy refuses/,
  });

  // The first-run seed committed before the service resolved.
  const snapshot = await store.readSnapshot();
  const config = snapshot?.policy;
  t.deepEqual(config?.allowedOrigins, [ALLOWED]);
  t.is(config?.maxResponseBytes, 1000);
  t.is(config?.revoked, false);
});

test('reconstitutes identical policy across a restart', async t => {
  const { open } = await makeStoreFixture();
  const { fetch } = makeFakeFetch();

  const first = await makeConfinedFetchService({
    store: await open(),
    fetch,
    now: () => 1000,
    allowedOrigins: [ALLOWED],
    maxResponseBytes: 1000,
  });
  // A control change becomes the authoritative state the store persists.
  await first.control.addAllowedOrigin(OTHER);
  first.control.setMaxResponseBytes(2048);
  await flush();

  // Restart: a fresh service over the same store.
  const second = await makeConfinedFetchService({ store: await open(), fetch });
  const inspected = second.control.inspect();
  t.deepEqual([...inspected.allowedOrigins].sort(), [ALLOWED, OTHER].sort());
  t.is(inspected.maxResponseBytes, 2048);

  // The revived client can reach the origin added before the restart.
  const response = await second.client.fetch(OTHER_URL);
  t.is(response.status(), 200);
});

test('a service revoked before restart revives revoked', async t => {
  const { open } = await makeStoreFixture();
  const { fetch } = makeFakeFetch();

  const first = await makeConfinedFetchService({
    store: await open(),
    fetch,
    now: () => 1000,
    allowedOrigins: [ALLOWED],
  });
  first.control.revoke();
  await flush();

  const second = await makeConfinedFetchService({ store: await open(), fetch });
  t.true(second.control.isRevoked());
  await t.throwsAsync(() => second.client.fetch(ALLOWED_URL), {
    message: /revoked/,
  });
});

test('a trust-on-first-bind pin survives a restart and stays revocable', async t => {
  const { open } = await makeStoreFixture();
  const { fetch } = makeFakeFetch();

  const first = await makeConfinedFetchService({
    store: await open(),
    fetch,
    now: () => 1000,
    policyMode: 'tofu-auto',
  });
  // tofu-auto pins a first-seen origin as allow at request time.
  const response = await first.client.fetch(OTHER_URL);
  t.is(response.status(), 200);
  const firstBindings = first.control.listBindings();
  t.is(firstBindings.length, 1);
  t.is(firstBindings[0].target, OTHER);
  t.is(firstBindings[0].state, 'Pinned-Allow');
  await flush();

  // Restart: the pin is reconstituted from policy.json.
  const second = await makeConfinedFetchService({ store: await open(), fetch });
  const revivedBindings = second.control.listBindings();
  t.is(revivedBindings.length, 1);
  t.is(revivedBindings[0].target, OTHER);
  t.is(revivedBindings[0].state, 'Pinned-Allow');
  // The pin is honoured without a fresh decision.
  const revived = await second.client.fetch(OTHER_URL);
  t.is(revived.status(), 200);

  // It remains revocable through the control facet, and the revocation is
  // durable across a further restart.
  await second.control.revokeBinding(OTHER);
  await t.throwsAsync(() => second.client.fetch(OTHER_URL), {
    message: /Policy refuses|not in the allowed-origin/,
  });

  // No settling delay: the acknowledged revocation is already durable.
  const third = await makeConfinedFetchService({ store: await open(), fetch });
  const thirdBindings = third.control.listBindings();
  t.is(thirdBindings.length, 1);
  t.is(thirdBindings[0].state, 'Revoked');
  await t.throwsAsync(() => third.client.fetch(OTHER_URL), {
    message: /Policy refuses|not in the allowed-origin/,
  });
});

test('the persisted store outranks a conflicting env on restart', async t => {
  const { open } = await makeStoreFixture();
  const { fetch } = makeFakeFetch();

  // First provisioning: env seeds allowedOrigins=[ALLOWED], maxResponseBytes=1000.
  await makeConfinedFetchService({
    store: await open(),
    fetch,
    now: () => 1000,
    allowedOrigins: [ALLOWED],
    maxResponseBytes: 1000,
  });

  // Restart with a CONFLICTING env: a different allowlist and a different byte
  // cap. The store - not env - is authoritative across restarts, so the
  // persisted values must win. This pins the ordering, not mere durability:
  // preferring env reddens exactly this assertion, whereas the sibling
  // reconstitution test (which restarts with no env) would stay green.
  const second = await makeConfinedFetchService({
    store: await open(),
    fetch,
    now: () => 2000,
    allowedOrigins: [OTHER],
    maxResponseBytes: 4096,
  });
  const inspected = second.control.inspect();
  t.deepEqual([...inspected.allowedOrigins], [ALLOWED]);
  t.is(inspected.maxResponseBytes, 1000);

  // The revived client honours the persisted allowlist, not the env one.
  const response = await second.client.fetch(ALLOWED_URL);
  t.is(response.status(), 200);
  await t.throwsAsync(() => second.client.fetch(OTHER_URL), {
    message: /not in the allowed-origin list|Policy refuses/,
  });
});

test('a corrupt policy.json refuses revival rather than reseeding from env', async t => {
  const { open, directory } = await makeStoreFixture();
  const { fetch } = makeFakeFetch();

  const first = await makeConfinedFetchService({
    store: await open(),
    fetch,
    allowedOrigins: [ALLOWED],
  });
  await first.control.revoke();

  // A damaged document must not be mistaken for first provisioning, which
  // would restore the permissive env allowlist to a revoked service.
  await E(directory).write('policy.json', 'not-json');
  const store = await open();
  await t.throwsAsync(
    () =>
      makeConfinedFetchService({
        store,
        fetch,
        allowedOrigins: [ALLOWED, OTHER],
        policyMode: 'tofu-auto',
      }),
    { message: /JSON|Unexpected token/ },
  );
});

test('a structurally invalid policy.json refuses revival', async t => {
  const { open, directory } = await makeStoreFixture();
  const { fetch } = makeFakeFetch();

  for (const document of [
    '{}',
    '[]',
    'null',
    JSON.stringify({ policy: { allowedOrigins: [], revoked: false } }),
    JSON.stringify({
      policy: { allowedOrigins: [], revoked: false },
      bindings: null,
    }),
    JSON.stringify({
      policy: { allowedOrigins: [], revoked: false },
      bindings: {},
    }),
    JSON.stringify({ policy: { allowedOrigins: [] }, bindings: [] }),
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await E(directory).write('policy.json', document);
    // eslint-disable-next-line no-await-in-loop
    const store = await open();
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () =>
        makeConfinedFetchService({
          store,
          fetch,
          allowedOrigins: [ALLOWED],
        }),
      { message: /policy\.json/ },
      document,
    );
  }
});

test('an unreadable store refuses revival; only absence provisions', async t => {
  const { fetch } = makeFakeFetch();
  const failingDirectory = /** @type {FetchStoreDirectory} */ (
    harden({
      lookup: async () => {
        throw Error('EIO: transient backing failure');
      },
      write: async () => {},
      move: async () => {},
    })
  );
  const store = await makeFetchStore(failingDirectory, async () => '1');
  await t.throwsAsync(
    () => makeConfinedFetchService({ store, fetch, allowedOrigins: [ALLOWED] }),
    { message: /EIO/ },
  );
});

test('an authority reduction rejects when its snapshot cannot be written', async t => {
  const { open } = await makeStoreFixture();
  const { fetch } = makeFakeFetch();
  const realStore = await open();
  let failWrites = false;
  const store = harden({
    readSnapshot: () => realStore.readSnapshot(),
    writeSnapshot: async snapshot => {
      if (failWrites) {
        throw Error('ENOSPC: no space left');
      }
      return realStore.writeSnapshot(snapshot);
    },
  });

  const { client, control } = await makeConfinedFetchService({
    store,
    fetch,
    allowedOrigins: [ALLOWED, OTHER],
  });

  failWrites = true;
  await t.throwsAsync(() => control.removeAllowedOrigin(OTHER), {
    message: /ENOSPC/,
  });
  // The reduction still applies in memory.
  await t.throwsAsync(() => client.fetch(OTHER_URL), {
    message: /not in the allowed-origin list|Policy refuses/,
  });

  // Once storage recovers, the next acknowledged mutation commits the whole
  // current snapshot, including the earlier reduction.
  failWrites = false;
  await control.setMaxResponseBytes(2048);
  const revived = await makeConfinedFetchService({
    store: await open(),
    fetch,
  });
  t.deepEqual([...revived.control.inspect().allowedOrigins], [ALLOWED]);
});

test('policy and bindings revive from one generation', async t => {
  const { open } = await makeStoreFixture();
  const { fetch } = makeFakeFetch();

  const first = await makeConfinedFetchService({
    store: await open(),
    fetch,
    policyMode: 'tofu-auto',
  });
  await first.client.fetch(OTHER_URL);
  await first.control.revokeBinding(OTHER);
  await first.control.revoke();

  const second = await makeConfinedFetchService({ store: await open(), fetch });
  t.true(second.control.isRevoked());
  t.like(second.control.listBindings(), [{ target: OTHER, state: 'Revoked' }]);
});

test('the service refuses to start without both endowed time seams', async t => {
  const { open } = await makeStoreFixture();
  const store = await open();
  const { fetch, calls } = makeFakeFetch();

  await t.throwsAsync(
    () =>
      makeConfinedFetchServiceCore(
        /** @type {any} */ ({
          store,
          fetch,
          now: () => 1000,
          allowedOrigins: [ALLOWED],
        }),
      ),
    {
      message: /delay and now seams built from the endowed timer are required/,
    },
  );
  await t.throwsAsync(
    () =>
      makeConfinedFetchServiceCore(
        /** @type {any} */ ({
          store,
          fetch,
          delay: async () => undefined,
          allowedOrigins: [ALLOWED],
        }),
      ),
    {
      message: /delay and now seams built from the endowed timer are required/,
    },
  );

  // The guard fires before provisioning: nothing was seeded or fetched.
  t.is(await store.readSnapshot(), undefined);
  t.is(calls.length, 0);
});
