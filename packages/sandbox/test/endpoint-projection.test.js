// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { bytesWriterFromIterator } from '@endo/exo-stream/bytes-writer-from-iterator.js';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { M } from '@endo/patterns';

import { spawn as nodeSpawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import {
  connect as netConnect,
  createServer as createNetServer,
} from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleExecArgv, makeBwrapDriver } from '../src/drivers/bwrap.js';
import { makeSandboxFactory } from '../src/factory.js';
import {
  assertProjectableNetwork,
  DEFAULT_PROJECTED_ORIGIN_ENV,
  DEFAULT_PROJECTED_PORT,
  normalizeProjectionOptions,
  projectedOrigin,
} from '../src/net/endpoint-projection.js';
import { parseForwarderArgv } from '../src/net/forward-endpoint.js';

const StubMountInterface = M.interface('Mount', {
  help: M.call().returns(M.string()),
  hostPath: M.call().returns(M.string()),
});

const DialerInterface = M.interface('EndpointDialer', {
  connect: M.callWhen().returns(M.any()),
  help: M.call().returns(M.string()),
});

// ---------------------------------------------------------------------------
// Contract: what a projection refuses
// ---------------------------------------------------------------------------

test('a projection is refused for every profile that shares a network namespace', t => {
  for (const profile of ['private', 'host-loopback', 'host-lan', 'host-net']) {
    t.throws(() => assertProjectableNetwork(profile), {
      message: /cannot carry a single-endpoint projection/,
    });
  }
  t.notThrows(() => assertProjectableNetwork('none'));
});

test('projection options are bounded, and the loopback address is not a choice', t => {
  const defaults = normalizeProjectionOptions();
  t.deepEqual(defaults, {
    host: '127.0.0.1',
    port: DEFAULT_PROJECTED_PORT,
    envName: DEFAULT_PROJECTED_ORIGIN_ENV,
  });
  t.is(normalizeProjectionOptions({ port: 9000 }).port, 9000);
  // Below the privileged-port line the forwarder holds no capability to bind.
  t.throws(() => normalizeProjectionOptions({ port: 80 }), {
    message: /port must be an integer/,
  });
  t.throws(() => normalizeProjectionOptions({ port: 70_000 }), {
    message: /port must be an integer/,
  });
  t.throws(() => normalizeProjectionOptions({ envName: 'not a name' }), {
    message: /envName must match/,
  });
  t.is(
    projectedOrigin({ host: '127.0.0.1', port: 8080 }),
    'http://127.0.0.1:8080',
  );
});

// ---------------------------------------------------------------------------
// Contract: the exec line a projection produces
// ---------------------------------------------------------------------------

const SLICE_ARGV = harden(['--unshare-all', '--die-with-parent']);

test('without a projection the exec line is the slice invocation unchanged', t => {
  const plain = assembleExecArgv({
    sliceArgv: SLICE_ARGV,
    prlimitArgv: [],
    argv: ['/bin/echo', 'hi'],
    projection: null,
    nodePath: '/usr/bin/node',
    forwarderPath: '/pkg/forward-endpoint.js',
  });
  t.is(plain.program, 'bwrap');
  t.deepEqual(plain.argv, [
    '--unshare-all',
    '--die-with-parent',
    '--',
    '/bin/echo',
    'hi',
  ]);
  t.false(plain.argv.includes('--share-net'));
});

test('a projection nests the slice inside a namespace holder and shares its net', t => {
  const projection = harden({
    socketPath: '/run/endo/projection-1.sock',
    host: '127.0.0.1',
    port: 8080,
    envName: 'ENDO_PROJECTED_ORIGIN',
    origin: 'http://127.0.0.1:8080',
  });
  const { program, argv } = assembleExecArgv({
    sliceArgv: SLICE_ARGV,
    prlimitArgv: [],
    argv: ['/bin/echo', 'hi'],
    projection,
    nodePath: '/usr/bin/node',
    forwarderPath: '/pkg/forward-endpoint.js',
  });
  t.is(program, 'bwrap');

  // The outer invocation owns a fresh, empty network namespace.
  t.true(argv.includes('--unshare-net'));
  const forwarderAt = argv.indexOf('/pkg/forward-endpoint.js');
  t.true(forwarderAt > 0);
  t.is(argv[forwarderAt - 1], '/usr/bin/node');

  // The slice's own invocation shares that namespace rather than unsharing a
  // second one, and learns its endpoint through the environment.
  const innerAt = argv.lastIndexOf('bwrap');
  t.true(innerAt > forwarderAt);
  const innerArgv = argv.slice(innerAt);
  t.true(innerArgv.includes('--share-net'));
  t.true(innerArgv.indexOf('--share-net') > innerArgv.indexOf('--unshare-all'));
  const envAt = innerArgv.indexOf('ENDO_PROJECTED_ORIGIN');
  t.is(innerArgv[envAt - 1], '--setenv');
  t.is(innerArgv[envAt + 1], 'http://127.0.0.1:8080');
  t.deepEqual(innerArgv.slice(-2), ['/bin/echo', 'hi']);

  // The daemon-side socket pathname reaches the forwarder and stops there: it
  // is never an argument of, nor an environment variable of, the slice.
  t.true(argv.includes('/run/endo/projection-1.sock'));
  t.false(innerArgv.includes('/run/endo/projection-1.sock'));
  t.false(
    argv.slice(innerAt).join(' ').includes('/run/endo/projection-1.sock'),
    'the slice invocation carries no daemon-side pathname',
  );
});

test('resource caps still wrap the slice, inside the namespace holder', t => {
  const projection = harden({
    socketPath: '/run/endo/p.sock',
    host: '127.0.0.1',
    port: 8080,
    envName: 'ENDO_PROJECTED_ORIGIN',
    origin: 'http://127.0.0.1:8080',
  });
  const { argv } = assembleExecArgv({
    sliceArgv: SLICE_ARGV,
    prlimitArgv: ['prlimit', '--nofile=64'],
    argv: ['/bin/true'],
    projection,
    nodePath: '/usr/bin/node',
    forwarderPath: '/pkg/forward-endpoint.js',
  });
  const prlimitAt = argv.indexOf('prlimit');
  const forwarderAt = argv.indexOf('/pkg/forward-endpoint.js');
  t.true(prlimitAt > forwarderAt, 'prlimit wraps the slice, not the forwarder');
  t.is(argv[prlimitAt + 2], 'bwrap');
});

test('the forwarder refuses an argv that would leave it without an endpoint', t => {
  const parsed = parseForwarderArgv([
    '--socket',
    '/run/p.sock',
    '--port',
    '8080',
    '--',
    'bwrap',
    '--version',
  ]);
  t.is(parsed.socketPath, '/run/p.sock');
  t.is(parsed.port, 8080);
  t.is(parsed.host, '127.0.0.1');
  t.deepEqual(parsed.command, ['bwrap', '--version']);

  t.throws(() => parseForwarderArgv(['--port', '8080', '--', 'x']), {
    message: /--socket is required/,
  });
  t.throws(() => parseForwarderArgv(['--socket', '/run/p.sock', '--', 'x']), {
    message: /--port must be a positive integer/,
  });
  t.throws(
    () => parseForwarderArgv(['--socket', '/run/p.sock', '--port', '8080']),
    {
      message: /a command must follow/,
    },
  );
  t.throws(() => parseForwarderArgv(['--bogus', 'x', '--', 'y']), {
    message: /unknown flag/,
  });
});

// ---------------------------------------------------------------------------
// End to end, against a real bubblewrap
// ---------------------------------------------------------------------------

/**
 * Both halves of the daemon-side seam a projection needs, backed by real Unix
 * sockets. The daemon supplies these through its host-tool powers; the shapes
 * are the same.
 *
 * @param {string} dir
 * @returns {any}
 */
const makeStubProjectionPowers = dir => {
  let next = 0;
  /** @type {string[]} */
  const paths = [];
  return harden({
    /** @param {string} label */
    provideSocketPath: async label => {
      next += 1;
      const path = join(dir, `${label}-${next}.sock`);
      paths.push(path);
      return path;
    },
    /** @param {{ path: string, cancelled: Promise<never> }} opts */
    serveSocketPath: async ({ path, cancelled }) => {
      /** @type {Array<(result: IteratorResult<any>) => void>} */
      const waiters = [];
      /** @type {any[]} */
      const buffered = [];
      /** @type {Set<import('node:net').Socket>} */
      const live = new Set();
      let done = false;
      /** @param {any} value */
      const deliver = value => {
        const waiter = waiters.shift();
        if (waiter !== undefined) {
          waiter({ value, done: false });
        } else {
          buffered.push(value);
        }
      };
      const server = createNetServer(conn => {
        live.add(conn);
        conn.on('close', () => live.delete(conn));
        const closed = new Promise(resolve => conn.on('close', resolve));
        conn.on('error', () => conn.destroy());
        const reader = (async function* readConn() {
          for await (const chunk of conn) {
            yield new Uint8Array(chunk);
          }
        })();
        const writer = harden({
          /** @param {Uint8Array} chunk */
          next: async chunk =>
            new Promise(resolve => conn.write(chunk, () => resolve(undefined))),
          return: async () => {
            conn.end();
            return undefined;
          },
          throw: async () => {
            conn.destroy();
            return undefined;
          },
        });
        deliver({ reader, writer, closed });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ path }, () => resolve(undefined));
      });
      const close = async () => {
        await null;
        done = true;
        server.close();
        // Hang up on stragglers, matching the daemon's own listener: a peer
        // that never closes must not be able to defer a revocation.
        for (const conn of live) {
          conn.destroy();
        }
        live.clear();
        while (waiters.length > 0) {
          /** @type {any} */ (waiters.shift())({
            value: undefined,
            done: true,
          });
        }
        // The pathname is what reachability rests on; releasing it is the
        // revocation, so wait for the kernel to be done with it.
        await new Promise(resolve => server.once('close', resolve));
      };
      cancelled.catch(() => close());
      const connections = harden({
        [Symbol.asyncIterator]: () =>
          harden({
            next: async () => {
              await null;
              if (buffered.length > 0) {
                return { value: buffered.shift(), done: false };
              }
              if (done) {
                return { value: undefined, done: true };
              }
              return new Promise(resolve => waiters.push(resolve));
            },
            return: async () => {
              done = true;
              return { value: undefined, done: true };
            },
          }),
      });
      return harden({ connections, close });
    },
    paths: () => harden([...paths]),
  });
};

/**
 * A dialer capability for one daemon-side TCP listener. This is the only
 * authority a projection carries.
 *
 * @param {number} port
 */
const makeLoopbackDialer = port =>
  /** @type {any} */ (
    makeExo(
      'EndpointDialer',
      DialerInterface,
      /** @type {any} */ ({
        help: () => `dialer for 127.0.0.1:${port}`,
        connect: async () => {
          await null;
          const conn = await new Promise((resolve, reject) => {
            const socket = netConnect(port, '127.0.0.1');
            socket.once('connect', () => resolve(socket));
            socket.once('error', reject);
          });
          const socket = /** @type {import('node:net').Socket} */ (conn);
          socket.on('error', () => socket.destroy());
          // Both ends are passables, so a granted endpoint is free to live in
          // another vat; the projection never assumes it is local.
          const reader = bytesReaderFromIterator(
            (async function* readConn() {
              for await (const chunk of socket) {
                yield new Uint8Array(chunk);
              }
            })(),
          );
          const writer = bytesWriterFromIterator(
            /** @type {any} */ ({
              /** @param {Uint8Array} chunk */
              next: async chunk =>
                new Promise(resolve =>
                  socket.write(chunk, () =>
                    resolve({ done: false, value: undefined }),
                  ),
                ),
              return: async () => {
                socket.end();
                return { done: true, value: undefined };
              },
              [Symbol.asyncIterator]() {
                return this;
              },
            }),
          );
          return harden({ reader, writer });
        },
      }),
    )
  );

/**
 * @param {string} body
 * @returns {Promise<{ port: number, close: () => Promise<void>, hits: () => number }>}
 */
const startHttpServer = async body => {
  let hits = 0;
  const server = createHttpServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  await new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  const address = server.address();
  const port =
    address !== null && typeof address === 'object' ? address.port : 0;
  return {
    port,
    hits: () => hits,
    close: async () => {
      await new Promise(resolve => server.close(() => resolve(undefined)));
    },
  };
};

/** @returns {Promise<boolean>} */
const probeBwrapUserns = async () => {
  await null;
  return new Promise(resolve => {
    try {
      const proc = nodeSpawn(
        'bwrap',
        [
          '--unshare-net',
          '--unshare-user',
          '--dev-bind',
          '/',
          '/',
          '--',
          '/bin/true',
        ],
        { stdio: 'ignore' },
      );
      proc.once('error', () => resolve(false));
      proc.once('close', code => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
};

/**
 * The probe the slice runs: dial both endpoints and report what happened, as
 * one JSON line on stdout.
 */
const SLICE_PROBE = `
const http = require('node:http');
const get = (port) => new Promise(resolve => {
  const req = http.get({ host: '127.0.0.1', port, path: '/probe' }, res => {
    let body = '';
    res.on('data', d => { body += d; });
    res.on('end', () => resolve({ ok: true, body }));
  });
  req.on('error', e => resolve({ ok: false, code: e.code }));
  req.setTimeout(4000, () => { req.destroy(); resolve({ ok: false, code: 'TIMEOUT' }); });
});
(async () => {
  const projected = new URL(process.env.ENDO_PROJECTED_ORIGIN ?? 'http://127.0.0.1:1');
  const other = Number(process.env.OTHER_PORT);
  process.stdout.write(JSON.stringify({
    origin: process.env.ENDO_PROJECTED_ORIGIN ?? null,
    projected: await get(Number(projected.port)),
    other: await get(other),
  }) + '\\n');
})();
`;

/**
 * @param {any} handle
 * @param {Record<string, string>} env
 */
const runProbe = async (handle, env) => {
  const proc = await E(handle).spawn(['node', '-e', SLICE_PROBE], {
    env,
    timeoutMs: 20_000,
  });
  /** @type {Uint8Array[]} */
  const chunks = [];
  for await (const chunk of iterateBytesReader(await E(proc).stdout())) {
    chunks.push(chunk);
  }
  await E(proc).wait();
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes).trim());
};

let bwrapUsable = false;
test.serial.before(async () => {
  bwrapUsable = await probeBwrapUserns();
});

test.serial(
  'a network: none slice reaches its projected endpoint and no other host listener',
  async t => {
    if (!bwrapUsable) {
      t.pass('bwrap cannot create a user namespace on this host');
      return;
    }
    t.timeout(120_000);

    const dir = mkdtempSync(join(tmpdir(), 'endo-proj-'));
    t.teardown(() => rmSync(dir, { recursive: true, force: true }));

    const granted = await startHttpServer('granted-endpoint');
    t.teardown(() => granted.close());
    const ungranted = await startHttpServer('SHOULD-NOT-BE-REACHABLE');
    t.teardown(() => ungranted.close());

    const projectionPowers = makeStubProjectionPowers(dir);
    const scratchDir = mkdtempSync(join(tmpdir(), 'endo-scratch-'));
    t.teardown(() => rmSync(scratchDir, { recursive: true, force: true }));
    const scratchProvider = harden({
      provideScratchMount: async () =>
        makeExo('Mount', StubMountInterface, {
          help: () => 'stub',
          hostPath: () => scratchDir,
        }),
      provideHostPath: async () => scratchDir,
    });

    const factory = makeSandboxFactory({
      drivers: [makeBwrapDriver({ env: process.env })],
      scratchProvider,
      projectionPowers,
    });
    const handle = await E(factory).make({
      rootfs: { kind: 'host-bind' },
      network: 'none',
      backend: 'bwrap',
    });
    t.teardown(() =>
      E(handle)
        .dispose()
        .catch(() => {}),
    );

    // Before any projection, the slice reaches nothing at all.
    const before = await runProbe(handle, {
      OTHER_PORT: String(ungranted.port),
    });
    t.is(before.origin, null);
    t.false(before.projected.ok);
    t.false(before.other.ok);

    const projection = await E(handle).projectEndpoint(
      makeLoopbackDialer(granted.port),
    );
    t.is(await E(projection).origin(), 'http://127.0.0.1:8080');

    const reached = await runProbe(handle, {
      OTHER_PORT: String(ungranted.port),
    });
    t.is(reached.origin, 'http://127.0.0.1:8080');
    t.true(reached.projected.ok, JSON.stringify(reached.projected));
    t.is(reached.projected.body, 'granted-endpoint');
    t.false(
      reached.other.ok,
      'the second host-loopback listener stays unreachable',
    );
    t.is(ungranted.hits(), 0);

    // A second projection would make "nothing else is reachable" false.
    await t.throwsAsync(
      E(handle).projectEndpoint(makeLoopbackDialer(granted.port)),
      { message: /already has a live projection/ },
    );

    // Revocation closes reachability.
    await E(projection).revoke();
    t.true(await E(projection).isRevoked());
    const afterRevoke = await runProbe(handle, {
      OTHER_PORT: String(ungranted.port),
    });
    t.is(
      afterRevoke.origin,
      null,
      'a later spawn is not told about an endpoint',
    );
    t.false(afterRevoke.projected.ok);

    // And leaves no socket behind.
    for (const path of projectionPowers.paths()) {
      t.false(existsSync(path), `${path} was released`);
    }

    await E(handle).dispose();
  },
);

test.serial(
  'a projection is refused for a slice whose network profile is not none',
  async t => {
    if (!bwrapUsable) {
      t.pass('bwrap cannot create a user namespace on this host');
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'endo-proj-'));
    t.teardown(() => rmSync(dir, { recursive: true, force: true }));
    const scratchDir = mkdtempSync(join(tmpdir(), 'endo-scratch-'));
    t.teardown(() => rmSync(scratchDir, { recursive: true, force: true }));

    const factory = makeSandboxFactory({
      drivers: [makeBwrapDriver({ env: process.env })],
      scratchProvider: harden({
        provideScratchMount: async () =>
          makeExo('Mount', StubMountInterface, {
            help: () => 'stub',
            hostPath: () => scratchDir,
          }),
        provideHostPath: async () => scratchDir,
      }),
      projectionPowers: makeStubProjectionPowers(dir),
    });
    const handle = await E(factory).make({
      rootfs: { kind: 'host-bind' },
      network: 'host-loopback',
      backend: 'bwrap',
    });
    t.teardown(() =>
      E(handle)
        .dispose()
        .catch(() => {}),
    );
    await t.throwsAsync(E(handle).projectEndpoint(makeLoopbackDialer(1)), {
      message: /cannot carry a single-endpoint projection/,
    });
  },
);

test.serial(
  'a factory without projection powers refuses rather than widening the profile',
  async t => {
    if (!bwrapUsable) {
      t.pass('bwrap cannot create a user namespace on this host');
      return;
    }
    const scratchDir = mkdtempSync(join(tmpdir(), 'endo-scratch-'));
    t.teardown(() => rmSync(scratchDir, { recursive: true, force: true }));
    const factory = makeSandboxFactory({
      drivers: [makeBwrapDriver({ env: process.env })],
      scratchProvider: harden({
        provideScratchMount: async () =>
          makeExo('Mount', StubMountInterface, {
            help: () => 'stub',
            hostPath: () => scratchDir,
          }),
        provideHostPath: async () => scratchDir,
      }),
    });
    const handle = await E(factory).make({
      rootfs: { kind: 'host-bind' },
      network: 'none',
      backend: 'bwrap',
    });
    t.teardown(() =>
      E(handle)
        .dispose()
        .catch(() => {}),
    );
    await t.throwsAsync(E(handle).projectEndpoint(makeLoopbackDialer(1)), {
      message: /without endpoint-projection powers/,
    });
  },
);
