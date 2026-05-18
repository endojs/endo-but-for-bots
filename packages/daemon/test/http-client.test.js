// @ts-nocheck
/* global process */

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import baseTest from 'ava';
import url from 'url';
import path from 'path';
import http from 'node:http';
import { E } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { start, stop, purge, makeEndoClient } from '../index.js';

const test = baseTest;

const dirname = url.fileURLToPath(new URL('..', import.meta.url)).toString();

// ── Local HTTP server helper ────────────────────────────────────────

/**
 * Start a local HTTP server bound to 127.0.0.1 on an OS-assigned port.
 * The server replies with the requested URL path (so tests can
 * distinguish the response) and a fixed `X-Test-Header` for header
 * round-trip assertions.
 *
 * @returns {Promise<{ origin: string, teardown: () => Promise<void> }>}
 */
const startLocalServer = async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'x-test-header': 'echo',
    });
    res.end(`reply:${req.url}`);
  });

  const { promise: listening, resolve: resolveListening } = makePromiseKit();
  server.listen(0, '127.0.0.1', () => {
    resolveListening(undefined);
  });
  await listening;

  const addr = /** @type {import('net').AddressInfo} */ (server.address());
  const origin = `http://127.0.0.1:${addr.port}`;

  const teardown = async () => {
    const { promise: closed, resolve: resolveClosed } = makePromiseKit();
    server.close(() => resolveClosed(undefined));
    await closed;
  };

  return { origin, teardown };
};

// ── Daemon helpers ──────────────────────────────────────────────────

let configPathId = 0;
const MAX_UNIX_SOCKET_PATH = 90;
const SOCKET_PATH_OVERHEAD =
  path.join(dirname, 'tmp').length + 1 + 'endo.sock'.length + 8;
const MAX_CONFIG_DIR_LENGTH = Math.max(
  8,
  MAX_UNIX_SOCKET_PATH - SOCKET_PATH_OVERHEAD,
);

/**
 * @param {string} testTitle
 * @param {number} configNumber
 */
const getConfigDirectoryName = (testTitle, configNumber) => {
  const defaultPath = testTitle.replace(/\s/giu, '-').replace(/[^\w-]/giu, '');
  const basePath =
    defaultPath.length <= MAX_CONFIG_DIR_LENGTH
      ? defaultPath
      : defaultPath.slice(0, MAX_CONFIG_DIR_LENGTH);
  const testId = String(configPathId).padStart(4, '0');
  const configId = String(configNumber).padStart(2, '0');
  const configSubDirectory = `${basePath}#${testId}-${configId}`;
  configPathId += 1;
  return configSubDirectory;
};

/** @param  {...string} root */
const makeConfig = (...root) => ({
  statePath: path.join(dirname, ...root, 'state'),
  ephemeralStatePath: path.join(dirname, ...root, 'run'),
  cachePath: path.join(dirname, ...root, 'cache'),
  sockPath:
    process.platform === 'win32'
      ? String.raw`\\?\pipe\endo-${root.join('-')}-test.sock`
      : path.join(dirname, ...root, 'endo.sock'),
  address: '127.0.0.1:0',
  pets: new Map(),
  values: new Map(),
  gcEnabled: true,
});

/**
 * @param {ReturnType<typeof makeConfig>} config
 * @param {Promise<void>} cancelled
 */
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

/** @param {import('ava').ExecutionContext<any>} t */
const prepareConfig = async t => {
  const { reject: cancel, promise: cancelled } = makePromiseKit();
  cancelled.catch(() => {});
  const config = makeConfig(
    'tmp',
    getConfigDirectoryName(t.title, t.context.configs.length),
  );
  await purge(config);
  await start(config);
  t.context.configs.push({ cancel, cancelled, config });
  return { cancel, cancelled, config };
};

/** @param {import('ava').ExecutionContext<any>} t */
const prepareHost = async t => {
  const { cancel, cancelled, config } = await prepareConfig(t);
  const { host } = await makeHost(config, cancelled);
  return { cancel, cancelled, config, host };
};

test.beforeEach(t => {
  t.context = { configs: [] };
});

test.afterEach.always(async t => {
  const configs =
    /** @type {{ cancel: Function, cancelled: Promise<void>, config: ReturnType<typeof makeConfig> }[]} */ (
      t.context.configs
    );
  await Promise.allSettled(configs.map(({ config }) => stop(config)));
  for (const { cancel, cancelled } of configs) {
    cancelled.catch(() => {});
    cancel(Error('teardown'));
  }
});

// ── Tests ───────────────────────────────────────────────────────────

test.serial(
  'http mk registers controller + client under two pet names',
  async t => {
    const { host } = await prepareHost(t);
    const { origin, teardown } = await startLocalServer();
    t.teardown(teardown);

    await E(host).makeHttpClient('test-control', 'test-client', [origin]);

    const names = await E(host).list();
    t.true(
      names.includes('test-control'),
      'controller pet name should be listed',
    );
    t.true(names.includes('test-client'), 'client pet name should be listed');

    // Both pet names resolve to live values via lookup().
    const control = await E(host).lookup('test-control');
    const client = await E(host).lookup('test-client');
    t.truthy(control, 'controller is reachable by pet name');
    t.truthy(client, 'client is reachable by pet name');
  },
);

test.serial(
  'controller bears the policy; client uses it (invariant)',
  async t => {
    const { host } = await prepareHost(t);
    const { origin, teardown } = await startLocalServer();
    t.teardown(teardown);

    await E(host).makeHttpClient('control', 'client', [origin]);

    const control = await E(host).lookup('control');
    const client = await E(host).lookup('client');

    // Controller exposes inspect() with the live policy.
    const policy = await E(control).inspect();
    t.deepEqual(
      [...policy.allowedOrigins],
      [origin],
      'controller.inspect() returns the host-curated allowlist',
    );

    // Client does NOT expose policy mutation surface in Phase 1.
    // eslint-disable-next-line no-underscore-dangle
    const clientMethods = await E(client).__getMethodNames__();
    t.false(
      clientMethods.includes('inspect'),
      'client must not expose controller.inspect()',
    );
    t.false(
      clientMethods.includes('setAllowedOrigins'),
      'client must not expose policy mutators',
    );
    t.true(
      clientMethods.includes('request'),
      'client must expose the use-the-policy request() method',
    );
    t.true(
      clientMethods.includes('allowedOrigins'),
      'client must expose allowedOrigins()',
    );
  },
);

test.serial('client request to allowed origin succeeds', async t => {
  const { host } = await prepareHost(t);
  const { origin, teardown } = await startLocalServer();
  t.teardown(teardown);

  await E(host).makeHttpClient('control', 'client', [origin]);
  const client = await E(host).lookup('client');

  const response = await E(client).request({ url: `${origin}/hello` });
  t.is(response.status, 200);
  t.true(response.ok);
  t.is(response.body, 'reply:/hello');
  t.is(response.headers['x-test-header'], 'echo');
});

test.serial(
  'client request to disallowed origin throws structured error',
  async t => {
    const { host } = await prepareHost(t);
    // Two distinct local servers; only one is on the allowlist.
    const allowed = await startLocalServer();
    const disallowed = await startLocalServer();
    t.teardown(allowed.teardown);
    t.teardown(disallowed.teardown);

    await E(host).makeHttpClient('control', 'client', [allowed.origin]);
    const client = await E(host).lookup('client');

    await t.throwsAsync(
      E(client).request({ url: `${disallowed.origin}/blocked` }),
      {
        message: /not in the allowlist/,
      },
    );
  },
);

test.serial(
  'allowedOrigins() reads through the controller, reflecting the live policy',
  async t => {
    const { host } = await prepareHost(t);
    const { origin, teardown } = await startLocalServer();
    t.teardown(teardown);

    await E(host).makeHttpClient('control', 'client', [origin]);
    const client = await E(host).lookup('client');

    const origins = await E(client).allowedOrigins();
    t.deepEqual([...origins], [origin]);
  },
);

test.serial(
  'mk rejects non-URL origin entries at configuration time',
  async t => {
    const { host } = await prepareHost(t);

    await t.throwsAsync(E(host).makeHttpClient('c', 'cl', ['not-a-url']), {
      message: /does not parse as a URL/,
    });
  },
);

test.serial(
  'mk rejects origin entries with scheme outside http: / https:',
  async t => {
    const { host } = await prepareHost(t);

    await t.throwsAsync(
      E(host).makeHttpClient('c', 'cl', ['file:///etc/passwd']),
      { message: /must use http: or https:/ },
    );
  },
);

test.serial('mk rejects an empty allowlist', async t => {
  const { host } = await prepareHost(t);

  await t.throwsAsync(E(host).makeHttpClient('c', 'cl', []), {
    message: /At least one allowed origin/,
  });
});

test.serial('mk rejects identical controller and client names', async t => {
  const { host } = await prepareHost(t);
  const { origin, teardown } = await startLocalServer();
  t.teardown(teardown);

  await t.throwsAsync(E(host).makeHttpClient('same', 'same', [origin]), {
    message: /must differ/,
  });
});
