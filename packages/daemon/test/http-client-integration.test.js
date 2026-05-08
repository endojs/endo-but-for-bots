// @ts-nocheck
/* global process */

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import url from 'url';
import path from 'path';
import crypto from 'crypto';
import { E } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { start, stop, purge, makeEndoClient } from '../index.js';

/**
 * @import {EReturn} from '@endo/eventual-send';
 */

void crypto;

const { raw } = String;

const dirname = url.fileURLToPath(new URL('..', import.meta.url)).toString();

/** @type {Map<string, number>} */
const testNumbers = new Map();

const getConfigDirectoryName = (testTitle, testConfigIndex) => {
  const munged = testTitle.match(/\w+/gu)?.join('-') || '';
  if (!testNumbers.has(testTitle)) testNumbers.set(testTitle, testNumbers.size);
  const testNumber = testNumbers.get(testTitle);
  const nnnn = String(testNumber).padStart(4, '0');
  const letter = (testConfigIndex + 10).toString(36);
  return `${munged.slice(0, 24)}~${nnnn}${letter}`;
};

const makeConfig = (...root) => ({
  statePath: path.join(dirname, ...root, 'state'),
  ephemeralStatePath: path.join(dirname, ...root, 'run'),
  cachePath: path.join(dirname, ...root, 'cache'),
  sockPath:
    process.platform === 'win32'
      ? raw`\\?\pipe\endo-${root.join('-')}-http-client.sock`
      : path.join(dirname, ...root, 'endo.sock'),
  address: '127.0.0.1:0',
  pets: new Map(),
  values: new Map(),
});

const prepareConfig = async (t, { gcEnabled = false } = {}) => {
  const { reject: cancel, promise: cancelled } = makePromiseKit();
  cancelled.catch(() => {});
  const config = {
    ...makeConfig('tmp', getConfigDirectoryName(t.title, t.context.length)),
    gcEnabled,
  };
  await purge(config);
  await start(config);
  const contextObj = { cancel, cancelled, config };
  t.context.push(contextObj);
  return { ...contextObj };
};

const makeHost = async (config, cancelled) => {
  const { getBootstrap, closed } = await makeEndoClient(
    'client',
    config.sockPath,
    cancelled,
  );
  closed.catch(() => {});
  const bootstrap = getBootstrap();
  return { host: E(bootstrap).host() };
};

const prepareHost = async t => {
  const { cancel, cancelled, config } = await prepareConfig(t);
  const { host } = await makeHost(config, cancelled);
  return { cancel, cancelled, config, host };
};

test.beforeEach(t => {
  t.context = [];
});

test.afterEach.always(async t => {
  /** @type {EReturn<typeof prepareConfig>[]} */
  const configs = t.context;
  await Promise.allSettled(configs.map(({ config }) => stop(config)));
  for (const { cancel, cancelled } of configs) {
    cancelled.catch(() => {});
    cancel(Error('teardown'));
  }
});

test.serial(
  'integration: makeHttpClient enforces origin allowlist end-to-end',
  async t => {
    t.timeout(45_000);
    const { host } = await prepareHost(t);

    await E(host).makeHttpClient('api', ['https://api.example.com'], {
      maxRequestsPerMinute: 5,
      maxResponseBytes: 1024,
    });
    const kit = await E(host).lookup('api');
    t.truthy(kit);
    const client = kit.client;

    const origins = await E(client).allowedOrigins();
    t.deepEqual(origins, ['https://api.example.com']);

    // Disallowed origin must reject without ever issuing a fetch.
    await t.throwsAsync(
      () => E(client).fetch('https://evil.example.com/exfil'),
      { message: /not in the allowlist/ },
      'cross-origin requests must throw with the allowlist message',
    );
  },
);
