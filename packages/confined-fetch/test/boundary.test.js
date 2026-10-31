// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { setTimeout } from 'node:timers';

import { E } from '@endo/eventual-send';
import { getMethodNames } from '@endo/eventual-send/utils.js';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { encodeUtf8 } from '@endo/utf8/encode.js';
import { makeInMemoryFilesystem } from '@endo/platform/fs/extended';
import { makeFetch } from '@endo/fetch';
import { makeCancelKit } from '@endo/cancel';
import { toAbortSignal } from '@endo/cancel/to-abort';

import { make } from '../src/index.js';
import { makeConfinedFetchService } from '../src/service.js';
import { makeFetchStore } from '../src/store.js';
import { makeTransportFromBase } from '../src/transport.js';

/**
 * @param {string} name
 * @param {Record<string, (...args: any[]) => any>} methods
 */
const makeTestExo = (name, methods) =>
  makeExo(name, M.interface(name, {}, { defaultGuards: 'passable' }), methods);

const ALLOWED = 'https://api.example.com';
const ALLOWED_URL = `${ALLOWED}/data`;
const OTHER = 'https://other.example.com';
const OTHER_URL = `${OTHER}/data`;

/** Let the fire-and-forget persistence write-chain settle. */
const flush = () => new Promise(resolve => setTimeout(resolve, 10));

/**
 * An `@endo/fetch` base over a scripted fake transport. `respond(url)` returns
 * `{ status, headers, chunks }`; the base records each request and whether
 * its body reader was cancelled and its abort signal fired.
 *
 * @param {(url: string) => { status?: number, headers?: Record<string, string>, chunks?: string[] }} [respond]
 */
const makeBase = (respond = () => ({ chunks: ['ok'] })) => {
  /** @type {Array<{ url: string, signal: AbortSignal }>} */
  const calls = [];
  const state = { cancelled: false };
  /** @type {any} */
  const transport = async (url, options) => {
    calls.push({ url: String(url), signal: options.signal });
    const { status = 200, headers = {}, chunks = [] } = respond(String(url));
    const encoded = chunks.map(chunk => encodeUtf8(chunk));
    return {
      status,
      statusText: '',
      headers,
      url: String(url),
      body: {
        getReader: () => ({
          read: async () =>
            encoded.length > 0
              ? { done: false, value: encoded.shift() }
              : { done: true },
          cancel: async () => {
            state.cancelled = true;
          },
        }),
      },
    };
  };
  return { base: makeFetch({ fetch: transport }), calls, state };
};

/**
 * Powers over one in-memory store directory. Calling `makePowers` again with
 * the same `storeRoot` models a restart in which the integration re-endows the
 * same base and directory.
 *
 * @param {{ base?: any, storeRoot?: any, policyAuthority?: any }} options
 */
const makePowers = async ({ base, storeRoot, policyAuthority }) => {
  let directory = storeRoot;
  if (directory === undefined) {
    const root = await E(makeInMemoryFilesystem()).root();
    directory = await E(root).makeDirectory('fetch-store');
  }
  const powers = makeTestExo('Powers', {
    /** @param {string} name */
    lookup(name) {
      if (name === 'fetch' && base) return base;
      if (name === 'fetch-store') return directory;
      if (name === 'fetch-policy-authority' && policyAuthority) {
        return policyAuthority;
      }
      throw Error(`unknown power ${name}`);
    },
  });
  return { powers, storeRoot: directory };
};

test('make() rejects without an endowed base Fetch', async t => {
  const { powers } = await makePowers({});
  await t.throwsAsync(
    () => make(powers, undefined, { env: { allowedOrigins: ALLOWED } }),
    { message: /unknown power fetch/ },
  );
});

test('the service core never falls back to an ambient fetch', async t => {
  const root = await E(makeInMemoryFilesystem()).root();
  const directory = await E(root).makeDirectory('fetch-store');
  const store = await makeFetchStore(
    /** @type {any} */ (directory),
    async () => 'temporary',
  );
  await t.throwsAsync(
    () =>
      makeConfinedFetchService(
        /** @type {any} */ ({ store, allowedOrigins: [ALLOWED] }),
      ),
    { message: /fetch transport built from the endowed base is required/ },
  );
});

/** @param {any} remotable */
const publicMethodNames = remotable =>
  [...getMethodNames(remotable)]
    .filter(name => typeof name === 'string' && !name.startsWith('__'))
    .sort();

test('a guest holding client() holds only the HttpClient surface', async t => {
  const { base } = makeBase();
  const { powers } = await makePowers({ base });
  const service = await make(powers, undefined, {
    env: { allowedOrigins: ALLOWED },
  });
  const client = await E(service).client();
  t.deepEqual(publicMethodNames(client), ['allowedOrigins', 'fetch', 'help']);
  t.deepEqual(publicMethodNames(service), ['client', 'control', 'help']);
});

test('a disallowed origin never reaches the base', async t => {
  const { base, calls } = makeBase();
  const { powers } = await makePowers({ base });
  const service = await make(powers, undefined, {
    env: { allowedOrigins: ALLOWED },
  });
  const client = await E(service).client();

  await t.throwsAsync(() => E(client).fetch(OTHER_URL), {
    message: /not in the allowed-origin list|Policy refuses/,
  });
  t.deepEqual(calls, []);

  const response = await E(client).fetch(ALLOWED_URL);
  t.is(await E(response).text(), 'ok');
  t.deepEqual(
    calls.map(call => call.url),
    [ALLOWED_URL],
  );
});

test('a redirect to a disallowed origin through the base is refused', async t => {
  const { base } = makeBase(() => ({
    status: 302,
    headers: { Location: OTHER_URL },
  }));
  const { powers } = await makePowers({ base });
  const service = await make(powers, undefined, {
    env: { allowedOrigins: ALLOWED },
  });
  const client = await E(service).client();
  await t.throwsAsync(() => E(client).fetch(ALLOWED_URL), {
    message: /Redirect target is not in the allowed-origin list/,
  });
});

test('the byte cap truncates the base stream and cancels its reader', async t => {
  const { base, state } = makeBase(() => ({
    chunks: ['abcd', 'efgh', 'ijkl'],
  }));
  const { powers } = await makePowers({ base });
  const service = await make(powers, undefined, {
    env: { allowedOrigins: ALLOWED, maxResponseBytes: '6' },
  });
  const client = await E(service).client();
  const response = await E(client).fetch(ALLOWED_URL);
  t.is(await E(response).text(), 'abcdef');
  t.true(await E(response).truncated());
  await flush();
  t.true(state.cancelled);
});

test('revocation stops requests before they reach the base, and survives restart', async t => {
  const { base, calls } = makeBase();
  const first = await makePowers({ base });
  const service = await make(first.powers, undefined, {
    env: { allowedOrigins: ALLOWED },
  });
  await E(E(service).control()).revoke();
  const client = await E(service).client();
  await t.throwsAsync(() => E(client).fetch(ALLOWED_URL), {
    message: /revoked/,
  });
  await flush();

  const second = await makePowers({ base, storeRoot: first.storeRoot });
  const revived = await make(second.powers, undefined, {
    env: { allowedOrigins: ALLOWED },
  });
  await t.throwsAsync(() => E(E(revived).client()).fetch(ALLOWED_URL), {
    message: /revoked/,
  });
  t.deepEqual(calls, []);
});

test('a request-time pin survives a re-endowed restart', async t => {
  const { base, calls } = makeBase();
  const authority = makeTestExo('PolicyAuthority', {
    decide: () => harden({ decision: 'allow', decidedBy: 'test' }),
  });
  const first = await makePowers({ base, policyAuthority: authority });
  const service = await make(first.powers, undefined, {
    env: { policyMode: 'tofu-prompt' },
  });
  const pinned = await E(E(service).client()).fetch(OTHER_URL);
  t.is(await E(pinned).status(), 200);
  await flush();

  // The restarted service has no authority, so only the persisted pin can
  // admit the origin.
  const second = await makePowers({ base, storeRoot: first.storeRoot });
  const revived = await make(second.powers, undefined, {});
  const response = await E(E(revived).client()).fetch(OTHER_URL);
  t.is(await E(response).status(), 200);
  t.deepEqual(
    calls.map(call => call.url),
    [OTHER_URL, OTHER_URL],
  );
});

test('an aborted request settles the base cancellation', async t => {
  /** @type {(value?: unknown) => void} */
  let release = () => {};
  const held = new Promise(resolve => {
    release = resolve;
  });
  /** @type {AbortSignal[]} */
  const baseSignals = [];
  /** @type {any} */
  const transport = async (_url, options) => {
    baseSignals.push(options.signal);
    await held;
    return { status: 204, headers: {}, body: null };
  };
  const fetchLike = makeTransportFromBase(makeFetch({ fetch: transport }));
  const { cancelled, cancel } = makeCancelKit();
  const responseP = fetchLike(ALLOWED_URL, {
    redirect: 'manual',
    method: 'GET',
    signal: toAbortSignal(cancelled),
  });
  await flush();
  t.is(baseSignals.length, 1);
  cancel(Error('timed out'));
  await t.throwsAsync(async () => responseP, { message: /timed out/ });
  await flush();
  t.true(baseSignals[0].aborted);
  release();
});

test('a null-body response settles the base cancellation', async t => {
  /** @type {AbortSignal[]} */
  const baseSignals = [];
  /** @type {any} */
  const transport = async (_url, options) => {
    baseSignals.push(options.signal);
    return { status: 204, headers: {}, body: null };
  };
  const fetchLike = makeTransportFromBase(makeFetch({ fetch: transport }));
  const response = await fetchLike(ALLOWED_URL);
  t.is(response.status, 204);
  t.is(response.body, null);
  await flush();
  t.is(baseSignals.length, 1);
  t.true(baseSignals[0].aborted);
});

test('a base stream that fails mid-read settles the base cancellation', async t => {
  /** @type {AbortSignal[]} */
  const baseSignals = [];
  let reads = 0;
  /** @type {any} */
  const transport = async (_url, options) => {
    baseSignals.push(options.signal);
    return {
      status: 200,
      headers: {},
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            if (reads === 1) {
              return { done: false, value: encodeUtf8('partial') };
            }
            throw Error('connection reset');
          },
        }),
      },
    };
  };
  const fetchLike = makeTransportFromBase(makeFetch({ fetch: transport }));
  const response = await fetchLike(ALLOWED_URL, {
    redirect: 'manual',
    method: 'GET',
  });
  const reader = /** @type {any} */ (response.body).getReader();
  const first = await reader.read();
  t.false(first.done);
  await t.throwsAsync(async () => reader.read(), {
    message: /connection reset/,
  });
  await flush();
  t.true(baseSignals[0].aborted);
});
