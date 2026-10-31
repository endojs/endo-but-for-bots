// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { setTimeout } from 'node:timers';

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { encodeUtf8 } from '@endo/utf8/encode.js';
import { makeInMemoryFilesystem } from '@endo/platform/fs/extended';

import { makeFetch } from '@endo/fetch';
import { makeTimer } from '@endo/fetch/timer.js';

import { make } from '../src/index.js';

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

const makeTestTimer = () =>
  makeTimer({
    setTimeout: (callback, milliseconds) => {
      const handle = setTimeout(callback, milliseconds);
      handle.unref();
      return handle;
    },
  });

/**
 * An `@endo/fetch` base over a fake transport that records every request it
 * carries, so a test can tell what reached the network.
 *
 * @param {string} [body]
 */
const makeBase = (body = 'ok') => {
  /** @type {string[]} */
  const calls = [];
  /** @type {any} */
  const transport = async (url, _options) => {
    calls.push(String(url));
    let done = false;
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      url: String(url),
      body: {
        getReader: () => ({
          read: async () => {
            if (done) return { done: true };
            done = true;
            return { done: false, value: encodeUtf8(body) };
          },
        }),
      },
    };
  };
  return { base: makeFetch({ fetch: transport }), calls };
};

/**
 * Build the powers the plugin resolves by name: the base `Fetch`, a store-root
 * directory, and an optional policy authority. A name the map omits throws, so
 * the plugin's optional lookup degrades gracefully.
 *
 * @param {{ base?: any, policyAuthority?: any, timer?: any }} [options]
 */
const makePowers = async ({
  base,
  policyAuthority,
  timer = makeTestTimer(),
} = {}) => {
  const fs = makeInMemoryFilesystem();
  const root = await E(fs).root();
  const storeRoot = await E(root).makeDirectory('fetch-store');

  const powers = makeTestExo('Powers', {
    /** @param {string} name */
    lookup(name) {
      if (name === 'fetch' && base) return base;
      if (name === 'timer') return timer;
      if (name === 'fetch-store') return storeRoot;
      if (name === 'fetch-policy-authority') {
        if (policyAuthority) return policyAuthority;
        throw Error('no policy authority granted');
      }
      throw Error(`unknown power ${name}`);
    },
  });
  return { powers };
};

test('make() returns a FetchService handing out the two facets', async t => {
  const { base, calls } = makeBase('hi');
  const { powers } = await makePowers({ base });

  const service = await make(powers, undefined, {
    env: { allowedOrigins: `${ALLOWED}, ${OTHER}`, maxResponseBytes: '4096' },
  });

  const client = await E(service).client();
  const control = await E(service).control();
  t.truthy(client);
  t.truthy(control);

  const inspected = control.inspect();
  t.deepEqual([...inspected.allowedOrigins].sort(), [ALLOWED, OTHER].sort());
  t.is(inspected.maxResponseBytes, 4096);

  const response = await client.fetch(ALLOWED_URL);
  t.is(response.status(), 200);
  t.is(await response.text(), 'hi');
  t.deepEqual(calls, [ALLOWED_URL]);
});

test('make() runs strict without a policy authority (unknown origins fail closed)', async t => {
  const { base } = makeBase();
  const { powers } = await makePowers({ base });

  const service = await make(powers, undefined, {
    env: { allowedOrigins: ALLOWED, policyMode: 'tofu-prompt' },
  });
  const client = await E(service).client();

  // No authority was granted, so a prompt-mode decision on an unknown origin
  // fails closed rather than reaching a (missing) authority.
  await t.throwsAsync(() => client.fetch(OTHER_URL), {
    message:
      /requires a policy authority|Policy refuses|not in the allowed-origin/,
  });
});

test('make() resolves a granted policy authority and pins an approved origin', async t => {
  const authority = makeTestExo('PolicyAuthority', {
    decide: _request => harden({ decision: 'allow', decidedBy: 'test' }),
  });
  const { base } = makeBase();
  const { powers } = await makePowers({ base, policyAuthority: authority });

  const service = await make(powers, undefined, {
    env: { policyMode: 'tofu-prompt' },
  });
  const client = await E(service).client();
  const control = await E(service).control();

  const response = await client.fetch(OTHER_URL);
  t.is(response.status(), 200);
  const bindings = control.listBindings();
  t.is(bindings.length, 1);
  t.is(bindings[0].target, OTHER);
  t.is(bindings[0].state, 'Pinned-Allow');
});

test('make() rejects a malformed env limit', async t => {
  const { base } = makeBase();
  const { powers } = await makePowers({ base });
  await t.throwsAsync(
    () => make(powers, undefined, { env: { maxResponseBytes: 'lots' } }),
    { message: /maxResponseBytes must be a positive integer/ },
  );
});
