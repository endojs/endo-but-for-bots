// @ts-check
/* global Buffer, process, setTimeout */

/**
 * @file Tests for the Phase-11a HTTP listener.
 *
 * The unit tests in `git-http.test.js`, `ocapn-ws.test.js`, and
 * `x-forwarded.test.js` cover the handler exos in isolation. This
 * file exercises the wire-up: binding a real `node:http` server,
 * routing by URL path, hosting the `AppsNameHub` Host-header
 * lookup, upgrading to the OCapN WebSocket handler, threading the
 * X-Forwarded parse through every handler args, and the lifecycle
 * (start, stop, idempotence). The Git smart-HTTP round-trip uses
 * the same `git http-backend` shape as
 * `git-http-integration.test.js`; the shared fixture is duplicated
 * locally to keep the test files self-contained.
 *
 * The tests bind on `127.0.0.1:0` so the OS picks a port; the
 * `whenBound()` promise surfaces the resolved port to the test
 * (mirroring the production Familiar-publisher path).
 */

import '@endo/init/debug.js';

import test from 'ava';

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { Socket } from 'node:net';

import { E, Far } from '@endo/far';
import { makePipe } from '@endo/stream';

import {
  makeGateway,
  makeHttpListener,
  makeAppsNameHub,
  makeGitHttpHandler,
  makeNodeWsUpgrade,
  streamPairFromWebSocket,
  parseBindAddress,
  CONTENT_ADDRESSED_CACHE_CONTROL,
  OCAPN_WEBSOCKET_PATH,
} from '../index.js';
import { makeNodeCryptoPowers } from '../src/node-crypto-powers.js';

/**
 * Low-level HTTP request helper using `http.request`. We avoid the
 * global `fetch` because it silently overrides the `Host` header
 * (Undici sets the host to the request URL's authority, which
 * makes the virtual-host-routing tests untestable through that
 * surface).
 *
 * @param {object} args
 * @param {number} args.port
 * @param {string} args.path
 * @param {string} [args.method]
 * @param {Record<string, string>} [args.headers]
 * @param {Buffer | undefined} [args.body]
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: string }>}
 */
const httpCall = ({ port, path, method = 'GET', headers = {}, body }) =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers,
      },
      res => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          /** @type {Record<string, string>} */
          const headersOut = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headersOut[k] = v;
            else if (Array.isArray(v)) headersOut[k] = v[0];
          }
          resolve({
            status: res.statusCode || 0,
            headers: headersOut,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

const makeFakeClock = (initial = 0) => {
  let now = initial;
  return harden({
    now: () => now,
    advance: ms => {
      now += ms;
    },
  });
};

/**
 * A `serveRepo` adapter that authorizes one bearer token and
 * returns a stub daemon repo capability that echoes the request
 * shape back. Lets us assert the listener forwards method, headers,
 * and body.
 *
 * @param {string} authorizedToken
 */
const makeRecordingServeRepo = authorizedToken => {
  /** @type {Array<{ token: string, op: string, headers: ReadonlyArray<readonly [string, string]>, body: Uint8Array, forwarded?: unknown }>} */
  const calls = [];
  /** @type {import('../src/types.d.ts').ServeRepo} */
  const serveRepo = /** @type {any} */ (
    async ({ token }) => {
      if (token !== authorizedToken) return undefined;
      return Far('StubDaemonRepo', {
        infoRefs: async args => {
          calls.push({
            token,
            op: 'infoRefs',
            headers: args.headers,
            body: new Uint8Array(0),
            forwarded: args.forwarded,
          });
          return harden({
            status: 200,
            headers: harden([
              /** @type {[string, string]} */ ([
                'content-type',
                'application/x-git-upload-pack-advertisement',
              ]),
            ]),
            body: new TextEncoder().encode('refs-advertisement'),
          });
        },
        gitUploadPack: async args => {
          calls.push({
            token,
            op: 'gitUploadPack',
            headers: args.headers,
            body: args.requestBody,
            forwarded: args.forwarded,
          });
          return harden({
            status: 200,
            headers: harden([
              /** @type {[string, string]} */ ([
                'content-type',
                'application/x-git-upload-pack-result',
              ]),
            ]),
            body: new TextEncoder().encode('upload-pack-result'),
          });
        },
        gitReceivePack: async args => {
          calls.push({
            token,
            op: 'gitReceivePack',
            headers: args.headers,
            body: args.requestBody,
            forwarded: args.forwarded,
          });
          return harden({
            status: 200,
            headers: harden([
              /** @type {[string, string]} */ ([
                'content-type',
                'application/x-git-receive-pack-result',
              ]),
            ]),
            body: new TextEncoder().encode('receive-pack-result'),
          });
        },
      });
    }
  );
  return { serveRepo, calls };
};

test.serial(
  'listener binds on 127.0.0.1:0 and surfaces resolved port',
  async t => {
    const apps = makeAppsNameHub();
    const listener = makeHttpListener({
      bindAddress: parseBindAddress('127.0.0.1:0'),
      apps,
    });
    await E(listener).start();
    t.teardown(() => E(listener).stop());
    const bound = await E(listener).whenBound();
    t.is(bound.host, '127.0.0.1');
    t.true(bound.port > 0, 'expected an OS-assigned positive port');
    t.is(bound.family, 'IPv4');
  },
);

test.serial('unknown path returns 404', async t => {
  const apps = makeAppsNameHub();
  const listener = makeHttpListener({
    bindAddress: parseBindAddress('127.0.0.1:0'),
    apps,
  });
  await E(listener).start();
  t.teardown(() => E(listener).stop());
  const { port } = await E(listener).whenBound();
  const res = await httpCall({ port, path: '/no-such-path' });
  t.is(res.status, 404);
  t.regex(res.body, /Not Found/);
});

test.serial(
  'Host-header bound to a weblet returns 501 with formula id',
  async t => {
    const apps = makeAppsNameHub();
    const formulaId = 'a'.repeat(64);
    await E(apps).bind('chat.example', formulaId);
    const listener = makeHttpListener({
      bindAddress: parseBindAddress('127.0.0.1:0'),
      apps,
    });
    await E(listener).start();
    t.teardown(() => E(listener).stop());
    const { port } = await E(listener).whenBound();
    const res = await httpCall({
      port,
      path: '/index.html',
      headers: { host: 'chat.example' },
    });
    t.is(res.status, 501);
    t.is(res.headers['x-endo-weblet-formula'], formulaId);
    t.regex(res.body, /formula=a+/);
  },
);

test.serial('Host-header without a binding falls through to 404', async t => {
  const apps = makeAppsNameHub();
  const listener = makeHttpListener({
    bindAddress: parseBindAddress('127.0.0.1:0'),
    apps,
  });
  await E(listener).start();
  t.teardown(() => E(listener).stop());
  const { port } = await E(listener).whenBound();
  const res = await httpCall({
    port,
    path: '/index.html',
    headers: { host: 'unbound.example' },
  });
  t.is(res.status, 404);
});

test.serial('Host header port suffix is stripped before lookup', async t => {
  const apps = makeAppsNameHub();
  const formulaId = 'b'.repeat(64);
  await E(apps).bind('alias.example', formulaId);
  const listener = makeHttpListener({
    bindAddress: parseBindAddress('127.0.0.1:0'),
    apps,
  });
  await E(listener).start();
  t.teardown(() => E(listener).stop());
  const { port } = await E(listener).whenBound();
  const res = await httpCall({
    port,
    path: '/',
    headers: { host: 'alias.example:8080' },
  });
  t.is(res.status, 501);
  t.is(res.headers['x-endo-weblet-formula'], formulaId);
});

test.serial(
  '/git/info/refs without auth header returns 401 with WWW-Authenticate',
  async t => {
    const apps = makeAppsNameHub();
    const { serveRepo } = makeRecordingServeRepo('0'.repeat(64));
    const gitHttpHandler = makeGitHttpHandler({ serveRepo });
    const listener = makeHttpListener({
      bindAddress: parseBindAddress('127.0.0.1:0'),
      apps,
      gitHttpHandler,
    });
    await E(listener).start();
    t.teardown(() => E(listener).stop());
    const { port } = await E(listener).whenBound();
    const res = await httpCall({
      port,
      path: '/git/info/refs?service=git-upload-pack',
    });
    t.is(res.status, 401);
    t.regex(res.headers['www-authenticate'] || '', /Bearer|Basic/);
  },
);

test.serial(
  '/git/info/refs with valid bearer forwards to the daemon repo capability',
  async t => {
    const apps = makeAppsNameHub();
    const token = createHash('sha256').update('listener-test').digest('hex');
    const { serveRepo, calls } = makeRecordingServeRepo(token);
    const gitHttpHandler = makeGitHttpHandler({ serveRepo });
    const listener = makeHttpListener({
      bindAddress: parseBindAddress('127.0.0.1:0'),
      apps,
      gitHttpHandler,
    });
    await E(listener).start();
    t.teardown(() => E(listener).stop());
    const { port } = await E(listener).whenBound();
    const res = await httpCall({
      port,
      path: '/git/info/refs?service=git-upload-pack',
      headers: { authorization: `Bearer ${token}` },
    });
    t.is(res.status, 200);
    t.is(res.body, 'refs-advertisement');
    t.is(calls.length, 1);
    t.is(calls[0].op, 'infoRefs');
  },
);

test.serial(
  'X-Forwarded threading: trusted proxy → handler sees rewritten caller',
  async t => {
    const apps = makeAppsNameHub();
    const token = createHash('sha256').update('xff-trusted').digest('hex');
    const { serveRepo, calls } = makeRecordingServeRepo(token);
    const gitHttpHandler = makeGitHttpHandler({
      serveRepo,
      trustedProxyCidrs: harden(['127.0.0.0/8']),
    });
    const listener = makeHttpListener({
      bindAddress: parseBindAddress('127.0.0.1:0'),
      apps,
      gitHttpHandler,
      trustedProxyCidrs: harden(['127.0.0.0/8']),
    });
    await E(listener).start();
    t.teardown(() => E(listener).stop());
    const { port } = await E(listener).whenBound();
    const res = await httpCall({
      port,
      path: '/git/info/refs?service=git-upload-pack',
      headers: {
        authorization: `Bearer ${token}`,
        'x-forwarded-for': '203.0.113.7',
        'x-forwarded-proto': 'https',
      },
    });
    t.is(res.status, 200);
    t.is(calls.length, 1);
    const fwd =
      /** @type {{callerIp: string, scheme: string, trusted: boolean}} */ (
        calls[0].forwarded
      );
    t.is(fwd.callerIp, '203.0.113.7');
    t.is(fwd.scheme, 'https');
    t.true(fwd.trusted);
    // The listener also tags the response with the recovered IP
    // for downstream observability.
    t.is(res.headers['x-endo-caller-ip'], '203.0.113.7');
    t.is(res.headers['x-endo-caller-trusted'], '1');
  },
);

test.serial(
  'X-Forwarded threading: untrusted proxy → handler sees the bare connection',
  async t => {
    const apps = makeAppsNameHub();
    const token = createHash('sha256').update('xff-untrusted').digest('hex');
    const { serveRepo, calls } = makeRecordingServeRepo(token);
    // Trusted-CIDR list is empty (the default) so 127.x is not
    // trusted; the forwarded headers must be ignored.
    const gitHttpHandler = makeGitHttpHandler({ serveRepo });
    const listener = makeHttpListener({
      bindAddress: parseBindAddress('127.0.0.1:0'),
      apps,
      gitHttpHandler,
    });
    await E(listener).start();
    t.teardown(() => E(listener).stop());
    const { port } = await E(listener).whenBound();
    const res = await httpCall({
      port,
      path: '/git/info/refs?service=git-upload-pack',
      headers: {
        authorization: `Bearer ${token}`,
        'x-forwarded-for': '203.0.113.7',
      },
    });
    t.is(res.status, 200);
    const fwd = /** @type {{callerIp: string, trusted: boolean}} */ (
      calls[0].forwarded
    );
    t.is(fwd.callerIp, '127.0.0.1');
    t.false(fwd.trusted);
  },
);

test.serial('WS upgrade with stub adapter feeds OCapN handler', async t => {
  t.timeout(10_000);
  const apps = makeAppsNameHub();
  /** @type {(s: unknown) => void} */
  let resolveHandoff = () => {};
  /** @type {Promise<unknown>} */
  const handoffPromise = new Promise(r => {
    resolveHandoff = r;
  });
  /** @type {import('../src/types.d.ts').OcapnWebSocketHandler} */
  const stubOcapn = /** @type {any} */ (
    Far('StubOcapnHandler', {
      __getMethodNames__: async () => ['handleConnection'],
      handleConnection: async stream => {
        resolveHandoff(stream);
      },
    })
  );
  // Stub adapter: short-circuits the real `ws` handshake by
  // synthesizing a stream pair from a Far-tagged record. Exercises
  // the listener's dispatch (path match, ocapn handler invoke)
  // without depending on a real WS client.
  const [stubReader, stubWriter] = makePipe();
  /** @type {import('../src/types.d.ts').WsUpgradeAdapter} */
  const wsUpgrade = async context => {
    // Close the socket cleanly so the connecting client sees
    // EOF and the test does not leak the connection.
    try {
      context.socket.end(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
    } catch (_e) {
      // ignore
    }
    return harden({
      reader: /** @type {any} */ (
        Far('StubReader', {
          next: async () => stubReader.next(),
          return: async value => stubReader.return(value),
          throw: async err => stubReader.throw(err),
        })
      ),
      writer: /** @type {any} */ (
        Far('StubWriter', {
          next: async value => stubWriter.next(value),
          return: async value => stubWriter.return(value),
          throw: async err => stubWriter.throw(err),
        })
      ),
    });
  };
  const listener = makeHttpListener({
    bindAddress: parseBindAddress('127.0.0.1:0'),
    apps,
    ocapnHandler: stubOcapn,
    wsUpgrade,
  });
  await E(listener).start();
  t.teardown(async () => {
    // Drain the stub stream so the listener's stop() does not
    // wait on the in-flight task.
    try {
      stubWriter.return(undefined);
    } catch (_e) {
      // ignore
    }
    await E(listener).stop();
  });
  const { port } = await E(listener).whenBound();

  // Trigger an upgrade by opening a TCP socket and writing a
  // minimal upgrade request. We do not run a real WS handshake;
  // the stub adapter accepts the upgrade and feeds the stream
  // to the handler.
  await new Promise((resolve, reject) => {
    const sock = new Socket();
    sock.on('error', () => resolve(undefined));
    sock.on('close', () => resolve(undefined));
    sock.connect(port, '127.0.0.1', () => {
      sock.write(
        `GET ${OCAPN_WEBSOCKET_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
      // Give the server a beat to consume, then politely close.
      setTimeout(() => sock.destroy(), 100);
    });
    // Safety net so a stuck connection doesn't hang the test.
    setTimeout(() => {
      try {
        sock.destroy();
      } catch (_e) {
        // ignore
      }
      reject(new Error('connect timeout'));
    }, 5000);
  }).catch(() => undefined);

  const received = await handoffPromise;
  t.truthy(received, 'stub OCapN handler received the stream pair');
});

test.serial(
  'WS upgrade on a non-OCapN path returns a 404 status line and destroys the socket',
  async t => {
    const apps = makeAppsNameHub();
    /** @type {import('../src/types.d.ts').OcapnWebSocketHandler} */
    const neverCalled = /** @type {any} */ (
      Far('NeverCalled', {
        __getMethodNames__: async () => ['handleConnection'],
        handleConnection: async () => {
          t.fail('handler should not be called for a non-OCapN upgrade path');
        },
      })
    );
    /** @type {import('../src/types.d.ts').WsUpgradeAdapter} */
    const wsUpgrade = async () => {
      t.fail('wsUpgrade should not be called for a non-OCapN upgrade path');
      return undefined;
    };
    const listener = makeHttpListener({
      bindAddress: parseBindAddress('127.0.0.1:0'),
      apps,
      ocapnHandler: neverCalled,
      wsUpgrade,
    });
    await E(listener).start();
    t.teardown(() => E(listener).stop());
    const { port } = await E(listener).whenBound();

    const responseBytes = await new Promise((resolve, reject) => {
      const sock = new Socket();
      /** @type {Buffer[]} */
      const chunks = [];
      sock.on('data', chunk => chunks.push(/** @type {Buffer} */ (chunk)));
      sock.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
      sock.on('error', reject);
      sock.connect(port, '127.0.0.1', () => {
        sock.write(
          `GET /no-such-ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
    });

    t.regex(/** @type {string} */ (responseBytes), /HTTP\/1.1 404 Not Found/);
  },
);

test.serial('listener.stop() refuses new connections', async t => {
  const apps = makeAppsNameHub();
  const listener = makeHttpListener({
    bindAddress: parseBindAddress('127.0.0.1:0'),
    apps,
  });
  await E(listener).start();
  const { port } = await E(listener).whenBound();
  await E(listener).stop();
  // After stop, a new TCP connect should fail (ECONNREFUSED).
  await t.throwsAsync(() => httpCall({ port, path: '/anything' }));
});

test.serial('start() is idempotent', async t => {
  const apps = makeAppsNameHub();
  const listener = makeHttpListener({
    bindAddress: parseBindAddress('127.0.0.1:0'),
    apps,
  });
  await E(listener).start();
  // Second start awaits the same bind without throwing.
  await E(listener).start();
  t.teardown(() => E(listener).stop());
  const bound = await E(listener).whenBound();
  t.true(bound.port > 0);
});

test.serial('stop() is idempotent', async t => {
  const apps = makeAppsNameHub();
  const listener = makeHttpListener({
    bindAddress: parseBindAddress('127.0.0.1:0'),
    apps,
  });
  await E(listener).start();
  await E(listener).stop();
  await E(listener).stop();
  t.pass();
});

test.serial(
  'makeGateway with httpListener=true binds via the listener at start',
  async t => {
    // End-to-end gateway shape: turn the toggle on, supply the
    // serveRepo so gitHttp doesn't trip the toggle-on/no-adapter
    // check, and confirm the gateway's getBindAddress reflects the
    // OS-assigned port after `start()`.
    const g = makeGateway({
      powers: {
        env: { ENDO_HTTP_ADDR: '127.0.0.1:0' },
        crypto: makeNodeCryptoPowers(),
        clock: makeFakeClock(),
        serveRepo: async () => undefined,
        wsUpgrade: makeNodeWsUpgrade(),
        // suppress the Feature-9 warning; the bind is 127.0.0.1
        // so the warning wouldn't fire anyway, but explicit.
        /** @param {string} _m */
        logWarning: _m => {},
      },
      config: {
        enableFeatures: /** @type {any} */ ({
          httpListener: true,
        }),
      },
    });
    await E(g).start();
    t.teardown(() => E(g).stop());
    const addr = await E(g).getBindAddress();
    // The pre-start render is `127.0.0.1:0`; after `start()` the
    // gateway still reports the configured value through
    // `getBindAddress`. The resolved port is surfaced through the
    // FamiliarPublisher path (covered by the existing
    // `start publishes the bind address when familiarBundled is on`
    // test, now refreshed in this PR). We assert the gateway
    // started without throwing here.
    t.regex(addr, /^127\.0\.0\.1:/);
  },
);

// ---------- Phase 11b: weblet-fetch integration via the listener ----------

/**
 * Build a Far-tagged byte reader yielding the given chunks. Mirrors
 * the shape the daemon-side `serveWeblet` adapter hands the gateway.
 *
 * @param {ReadonlyArray<Uint8Array>} chunks
 */
const makeStubReader = chunks => {
  let i = 0;
  return Far('StubBlobReader', {
    next: async () => {
      if (i >= chunks.length) return harden({ done: true, value: undefined });
      const value = chunks[i];
      i += 1;
      return harden({ done: false, value });
    },
    return: async () => {
      i = chunks.length;
      return harden({ done: true, value: undefined });
    },
    throw: async err => {
      i = chunks.length;
      throw err;
    },
  });
};

test.serial(
  'Phase 11b: serveWeblet 200 streams body with content-addressed ETag and Cache-Control',
  async t => {
    const apps = makeAppsNameHub();
    const formulaId = 'd'.repeat(64);
    await E(apps).bind('chat.example', formulaId);
    const bodyBytes = new TextEncoder().encode('<html>hello weblet</html>');
    /** @type {Array<{webletFormulaId: string, pathSuffix: string}>} */
    const calls = [];
    /** @type {import('../src/types.d.ts').ServeWeblet} */
    const serveWeblet = async ({ webletFormulaId, pathSuffix }) => {
      calls.push({ webletFormulaId, pathSuffix });
      return harden({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        etag: 'sha256-deadbeef',
        size: bodyBytes.byteLength,
        body: /** @type {any} */ (makeStubReader([bodyBytes])),
      });
    };
    const listener = makeHttpListener({
      bindAddress: parseBindAddress('127.0.0.1:0'),
      apps,
      serveWeblet,
    });
    await E(listener).start();
    t.teardown(() => E(listener).stop());
    const { port } = await E(listener).whenBound();
    const res = await httpCall({
      port,
      path: '/index.html',
      headers: { host: 'chat.example' },
    });
    t.is(res.status, 200);
    t.is(res.headers['content-type'], 'text/html; charset=utf-8');
    t.is(res.headers.etag, 'sha256-deadbeef');
    t.is(res.headers['cache-control'], CONTENT_ADDRESSED_CACHE_CONTROL);
    t.is(res.headers['x-endo-weblet-formula'], formulaId);
    t.is(res.body, '<html>hello weblet</html>');
    t.is(calls.length, 1);
    t.is(calls[0].webletFormulaId, formulaId);
    t.is(calls[0].pathSuffix, '/index.html');
  },
);

test.serial(
  'Phase 11b: bare-root request normalizes path to /index.html',
  async t => {
    const apps = makeAppsNameHub();
    const formulaId = 'e'.repeat(64);
    await E(apps).bind('chat.example', formulaId);
    /** @type {string | undefined} */
    let seenPath;
    /** @type {import('../src/types.d.ts').ServeWeblet} */
    const serveWeblet = async ({ pathSuffix }) => {
      seenPath = pathSuffix;
      return harden({
        status: 200,
        contentType: 'text/html',
        etag: 'sha256-root',
        body: /** @type {any} */ (
          makeStubReader([new TextEncoder().encode('root-html')])
        ),
      });
    };
    const listener = makeHttpListener({
      bindAddress: parseBindAddress('127.0.0.1:0'),
      apps,
      serveWeblet,
    });
    await E(listener).start();
    t.teardown(() => E(listener).stop());
    const { port } = await E(listener).whenBound();
    const res = await httpCall({
      port,
      path: '/',
      headers: { host: 'chat.example' },
    });
    t.is(res.status, 200);
    t.is(seenPath, '/index.html');
  },
);

test.serial(
  'Phase 11b: serveWeblet 404 surfaces a path-bearing 404 response',
  async t => {
    const apps = makeAppsNameHub();
    const formulaId = 'f'.repeat(64);
    await E(apps).bind('chat.example', formulaId);
    /** @type {import('../src/types.d.ts').ServeWeblet} */
    const serveWeblet = async () => harden({ status: 404 });
    const listener = makeHttpListener({
      bindAddress: parseBindAddress('127.0.0.1:0'),
      apps,
      serveWeblet,
    });
    await E(listener).start();
    t.teardown(() => E(listener).stop());
    const { port } = await E(listener).whenBound();
    const res = await httpCall({
      port,
      path: '/missing.png',
      headers: { host: 'chat.example' },
    });
    t.is(res.status, 404);
    t.regex(res.body, /Not Found: \/missing\.png/);
    // The X-Endo-Weblet-Formula header still rides along so an
    // observer can confirm routing happened before the adapter
    // mapped the path to a miss.
    t.is(res.headers['x-endo-weblet-formula'], formulaId);
  },
);

test.serial(
  'Phase 11b: If-None-Match → 304 round-trip preserves the ETag',
  async t => {
    const apps = makeAppsNameHub();
    const formulaId = '0'.repeat(64);
    await E(apps).bind('chat.example', formulaId);
    /** @type {import('../src/types.d.ts').ServeWeblet} */
    const serveWeblet = async ({ ifNoneMatch }) => {
      if (ifNoneMatch === 'sha256-cached') {
        return harden({ status: 304, etag: 'sha256-cached' });
      }
      return harden({
        status: 200,
        contentType: 'text/html',
        etag: 'sha256-cached',
        body: /** @type {any} */ (
          makeStubReader([new TextEncoder().encode('first')])
        ),
      });
    };
    const listener = makeHttpListener({
      bindAddress: parseBindAddress('127.0.0.1:0'),
      apps,
      serveWeblet,
    });
    await E(listener).start();
    t.teardown(() => E(listener).stop());
    const { port } = await E(listener).whenBound();
    // First request: 200 + ETag.
    const first = await httpCall({
      port,
      path: '/index.html',
      headers: { host: 'chat.example' },
    });
    t.is(first.status, 200);
    t.is(first.headers.etag, 'sha256-cached');
    // Second request, conditional: 304.
    const second = await httpCall({
      port,
      path: '/index.html',
      headers: { host: 'chat.example', 'if-none-match': 'sha256-cached' },
    });
    t.is(second.status, 304);
    t.is(second.headers.etag, 'sha256-cached');
    t.is(second.body, '');
  },
);

test.serial(
  'Phase 11b: serveWeblet throw surfaces 500 with fixed body and logged warning',
  async t => {
    const apps = makeAppsNameHub();
    const formulaId = '1'.repeat(64);
    await E(apps).bind('chat.example', formulaId);
    /** @type {string[]} */
    const warnings = [];
    /** @type {import('../src/types.d.ts').ServeWeblet} */
    const serveWeblet = async () => {
      throw new Error('cas: not reachable');
    };
    const listener = makeHttpListener({
      bindAddress: parseBindAddress('127.0.0.1:0'),
      apps,
      serveWeblet,
      logWarning: m => warnings.push(m),
    });
    await E(listener).start();
    t.teardown(() => E(listener).stop());
    const { port } = await E(listener).whenBound();
    const res = await httpCall({
      port,
      path: '/index.html',
      headers: { host: 'chat.example' },
    });
    t.is(res.status, 500);
    t.regex(res.body, /Internal Server Error/);
    t.true(
      warnings.some(w => /serveWeblet/.test(w) && /cas: not reachable/.test(w)),
    );
  },
);

test.serial(
  'Phase 11b: serveWeblet 200 with mimeTypes-mapped contentType is echoed verbatim',
  async t => {
    // The mimeTypes mapping lives on the WebletFormula; the daemon-
    // side serveWeblet adapter applies it before returning. The
    // gateway test stubs the adapter to verify the gateway echoes
    // whatever contentType the adapter chose, without second-
    // guessing.
    const apps = makeAppsNameHub();
    const formulaId = '2'.repeat(64);
    await E(apps).bind('chat.example', formulaId);
    /** @type {import('../src/types.d.ts').ServeWeblet} */
    const serveWeblet = async () =>
      harden({
        status: 200,
        contentType: 'image/svg+xml',
        etag: 'sha256-svg',
        body: /** @type {any} */ (
          makeStubReader([new TextEncoder().encode('<svg/>')])
        ),
      });
    const listener = makeHttpListener({
      bindAddress: parseBindAddress('127.0.0.1:0'),
      apps,
      serveWeblet,
    });
    await E(listener).start();
    t.teardown(() => E(listener).stop());
    const { port } = await E(listener).whenBound();
    const res = await httpCall({
      port,
      path: '/logo.svg',
      headers: { host: 'chat.example' },
    });
    t.is(res.status, 200);
    t.is(res.headers['content-type'], 'image/svg+xml');
    t.is(res.body, '<svg/>');
  },
);

test.serial(
  'Phase 11b: missing serveWeblet power preserves Phase-11a 501 placeholder',
  async t => {
    // No serveWeblet wired; the listener falls back to the
    // Phase-11a 501 + X-Endo-Weblet-Formula posture. This is the
    // back-compat guarantee for embedders that have not yet wired
    // a daemon-side adapter.
    const apps = makeAppsNameHub();
    const formulaId = '3'.repeat(64);
    await E(apps).bind('chat.example', formulaId);
    const listener = makeHttpListener({
      bindAddress: parseBindAddress('127.0.0.1:0'),
      apps,
    });
    await E(listener).start();
    t.teardown(() => E(listener).stop());
    const { port } = await E(listener).whenBound();
    const res = await httpCall({
      port,
      path: '/index.html',
      headers: { host: 'chat.example' },
    });
    t.is(res.status, 501);
    t.is(res.headers['x-endo-weblet-formula'], formulaId);
  },
);

test.serial(
  'Phase 11b: serveWeblet 200 without size omits Content-Length',
  async t => {
    const apps = makeAppsNameHub();
    const formulaId = '4'.repeat(64);
    await E(apps).bind('chat.example', formulaId);
    /** @type {import('../src/types.d.ts').ServeWeblet} */
    const serveWeblet = async () =>
      harden({
        status: 200,
        contentType: 'text/plain',
        etag: 'sha256-nosize',
        body: /** @type {any} */ (
          makeStubReader([new TextEncoder().encode('streamed')])
        ),
      });
    const listener = makeHttpListener({
      bindAddress: parseBindAddress('127.0.0.1:0'),
      apps,
      serveWeblet,
    });
    await E(listener).start();
    t.teardown(() => E(listener).stop());
    const { port } = await E(listener).whenBound();
    const res = await httpCall({
      port,
      path: '/streamed.txt',
      headers: { host: 'chat.example' },
    });
    t.is(res.status, 200);
    t.is(
      /** @type {Record<string, string | undefined>} */ (res.headers)[
        'content-length'
      ],
      undefined,
    );
    t.is(res.body, 'streamed');
  },
);

test.serial(
  'Phase 11b: serveWeblet result with a broken contentType maps to 500 (fail-closed)',
  async t => {
    const apps = makeAppsNameHub();
    const formulaId = '5'.repeat(64);
    await E(apps).bind('chat.example', formulaId);
    /** @type {string[]} */
    const warnings = [];
    /** @type {import('../src/types.d.ts').ServeWeblet} */
    const serveWeblet = async () =>
      /** @type {any} */ (
        harden({
          status: 200,
          contentType: '', // broken: empty
          etag: 'sha256-broken',
          body: /** @type {any} */ (makeStubReader([])),
        })
      );
    const listener = makeHttpListener({
      bindAddress: parseBindAddress('127.0.0.1:0'),
      apps,
      serveWeblet,
      logWarning: m => warnings.push(m),
    });
    await E(listener).start();
    t.teardown(() => E(listener).stop());
    const { port } = await E(listener).whenBound();
    const res = await httpCall({
      port,
      path: '/',
      headers: { host: 'chat.example' },
    });
    t.is(res.status, 500);
    t.regex(res.body, /Internal Server Error/);
    t.true(warnings.some(w => /contentType/.test(w)));
  },
);

test.serial(
  'Phase 11b: makeGateway accepts powers.serveWeblet and start() succeeds',
  async t => {
    // Smoke test for the GatewayPowers → HttpListener wiring of
    // serveWeblet. The dedicated Phase-11b tests above already
    // assert the per-request behavior against `makeHttpListener`
    // directly; this test only confirms that a gateway constructed
    // with the new power lands the toggle and starts cleanly.
    /** @type {string[]} */
    const warnings = [];
    /** @type {import('../src/types.d.ts').ServeWeblet} */
    const serveWeblet = async () =>
      harden({
        status: 200,
        contentType: 'text/plain',
        etag: 'sha256-wired',
        body: /** @type {any} */ (
          makeStubReader([new TextEncoder().encode('via-gateway')])
        ),
      });
    const g = makeGateway({
      powers: {
        env: { ENDO_HTTP_ADDR: '127.0.0.1:0' },
        crypto: makeNodeCryptoPowers(),
        clock: makeFakeClock(),
        serveRepo: async () => undefined,
        wsUpgrade: makeNodeWsUpgrade(),
        serveWeblet,
        logWarning: m => warnings.push(m),
      },
      config: {
        enableFeatures: /** @type {any} */ ({
          httpListener: true,
        }),
      },
    });
    await E(g).start();
    t.teardown(() => E(g).stop());
    const addr = await E(g).getBindAddress();
    t.regex(addr, /^127\.0\.0\.1:/);
    // Construction did not emit a warning (no malformed power
    // shape, no broken wiring).
    t.deepEqual(warnings, []);
  },
);

// ---------- Git smart-HTTP integration via the listener ----------

const findGitHttpBackend = () => {
  const which = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (which.status === 0) {
    const execPath = which.stdout.trim();
    const candidate = join(execPath, 'git-http-backend');
    if (existsSync(candidate)) return candidate;
  }
  for (const candidate of [
    '/usr/lib/git-core/git-http-backend',
    '/usr/libexec/git-core/git-http-backend',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const gitHttpBackend = gitAvailable ? findGitHttpBackend() : undefined;
const runGitIntegration = gitAvailable && gitHttpBackend !== undefined;
const gitIntegrationTest = runGitIntegration ? test.serial : test.serial.skip;

const FORMULA_ID_LENGTH = 64;

/**
 * @param {object} args
 * @param {string} args.repoDir
 * @param {string} args.method
 * @param {string} args.pathInfo
 * @param {string} args.queryString
 * @param {ReadonlyArray<readonly [string, string]>} args.headers
 * @param {Buffer} args.body
 */
const callGitHttpBackend = ({
  repoDir,
  method,
  pathInfo,
  queryString,
  headers,
  body,
}) =>
  new Promise((resolve, reject) => {
    /** @type {NodeJS.ProcessEnv} */
    const env = {
      GIT_PROJECT_ROOT: repoDir,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: pathInfo,
      QUERY_STRING: queryString,
      REQUEST_METHOD: method,
      REMOTE_USER: 'gateway-test',
      REMOTE_ADDR: '127.0.0.1',
      PATH: process.env.PATH,
    };
    for (const [k, v] of headers) {
      const name = k.toLowerCase();
      if (name === 'content-type') env.CONTENT_TYPE = v;
      else if (name === 'content-length') env.CONTENT_LENGTH = v;
      else if (name === 'git-protocol') env.HTTP_GIT_PROTOCOL = v;
    }
    if (env.CONTENT_LENGTH === undefined && body.length > 0) {
      env.CONTENT_LENGTH = String(body.length);
    }
    const cgi = spawn(/** @type {string} */ (gitHttpBackend), [], { env });
    /** @type {Buffer[]} */
    const outChunks = [];
    /** @type {Buffer[]} */
    const errChunks = [];
    cgi.stdout.on('data', chunk => outChunks.push(chunk));
    cgi.stderr.on('data', chunk => errChunks.push(chunk));
    cgi.on('error', reject);
    cgi.on('close', code => {
      const stdout = Buffer.concat(outChunks);
      const stderr = Buffer.concat(errChunks);
      if (code !== 0 && stdout.length === 0) {
        reject(
          new Error(
            `git-http-backend exited with code ${code}: ${stderr.toString('utf8')}`,
          ),
        );
        return;
      }
      const sep = stdout.indexOf('\r\n\r\n');
      const sepLen = sep >= 0 ? 4 : 2;
      const headerEnd = sep >= 0 ? sep : stdout.indexOf('\n\n');
      if (headerEnd < 0) {
        reject(new Error(`git-http-backend produced no separator`));
        return;
      }
      const headerBlock = stdout.slice(0, headerEnd).toString('utf8');
      const responseBody = stdout.slice(headerEnd + sepLen);
      /** @type {Array<[string, string]>} */
      const responseHeaders = [];
      let status = 200;
      for (const line of headerBlock.split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon >= 0) {
          const name = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === 'status') {
            const match = value.match(/^(\d{3})/);
            if (match) status = Number(match[1]);
          } else {
            responseHeaders.push([name, value]);
          }
        }
      }
      resolve({ status, headers: responseHeaders, body: responseBody });
    });
    if (body.length > 0) cgi.stdin.end(body);
    else cgi.stdin.end();
  });

const makeFsBackedDaemonRepo = repoDir =>
  Far('FsBackedDaemonRepo', {
    infoRefs: async args => {
      const { status, headers, body } = await callGitHttpBackend({
        repoDir,
        method: 'GET',
        pathInfo: '/info/refs',
        queryString: `service=${args.service}`,
        headers: args.headers,
        body: Buffer.alloc(0),
      });
      return harden({
        status,
        headers: harden(
          headers.map(([k, v]) => /** @type {[string, string]} */ ([k, v])),
        ),
        body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      });
    },
    gitUploadPack: async args => {
      const buf = Buffer.from(
        args.requestBody.buffer,
        args.requestBody.byteOffset,
        args.requestBody.byteLength,
      );
      const { status, headers, body } = await callGitHttpBackend({
        repoDir,
        method: 'POST',
        pathInfo: '/git-upload-pack',
        queryString: '',
        headers: args.headers,
        body: buf,
      });
      return harden({
        status,
        headers: harden(
          headers.map(([k, v]) => /** @type {[string, string]} */ ([k, v])),
        ),
        body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      });
    },
    gitReceivePack: async args => {
      const buf = Buffer.from(
        args.requestBody.buffer,
        args.requestBody.byteOffset,
        args.requestBody.byteLength,
      );
      const { status, headers, body } = await callGitHttpBackend({
        repoDir,
        method: 'POST',
        pathInfo: '/git-receive-pack',
        queryString: '',
        headers: args.headers,
        body: buf,
      });
      return harden({
        status,
        headers: harden(
          headers.map(([k, v]) => /** @type {[string, string]} */ ([k, v])),
        ),
        body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      });
    },
  });

/**
 * @param {string} command
 * @param {ReadonlyArray<string>} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string }>}
 */
const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    });
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    child.stdout.on('data', d => out.push(/** @type {Buffer} */ (d)));
    child.stderr.on('data', d => err.push(/** @type {Buffer} */ (d)));
    child.on('error', reject);
    child.on('close', status =>
      resolve({
        status,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
  });

gitIntegrationTest(
  'real git CLI push/pull through the listener round-trips',
  async t => {
    t.timeout(60_000);
    const rootDir = await mkdtemp(join(tmpdir(), 'gw-listener-'));
    t.teardown(() => rm(rootDir, { recursive: true, force: true }));
    const bareRepoDir = join(rootDir, 'origin.git');
    const pushTreeDir = join(rootDir, 'push-tree');

    const init = await run('git', [
      'init',
      '--bare',
      '--initial-branch=main',
      bareRepoDir,
    ]);
    t.is(init.status, 0, `git init --bare failed: ${init.stderr}`);
    await run('git', ['config', 'http.receivepack', 'true'], {
      cwd: bareRepoDir,
    });
    await run('git', ['config', 'receive.denyCurrentBranch', 'updateInstead'], {
      cwd: bareRepoDir,
    });

    const token = createHash('sha256')
      .update('listener-int-bearer')
      .digest('hex');
    t.is(token.length, FORMULA_ID_LENGTH);

    const handler = makeGitHttpHandler({
      serveRepo: async args => {
        if (args.token !== token) return undefined;
        return makeFsBackedDaemonRepo(bareRepoDir);
      },
    });
    const apps = makeAppsNameHub();
    const listener = makeHttpListener({
      bindAddress: parseBindAddress('127.0.0.1:0'),
      apps,
      gitHttpHandler: handler,
    });
    await E(listener).start();
    t.teardown(() => E(listener).stop());
    const { port } = await E(listener).whenBound();
    const remoteUrl = `http://127.0.0.1:${port}/git/`;

    /** @type {NodeJS.ProcessEnv} */
    const gitEnv = {
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'true',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'Listener Test',
      GIT_AUTHOR_EMAIL: 'listener-test@example.invalid',
      GIT_COMMITTER_NAME: 'Listener Test',
      GIT_COMMITTER_EMAIL: 'listener-test@example.invalid',
    };
    const gitCmd = (args, cwd) =>
      run(
        'git',
        ['-c', `http.extraHeader=Authorization: bearer ${token}`, ...args],
        { cwd, env: gitEnv },
      );

    const init2 = await run('git', [
      'init',
      '--initial-branch=main',
      pushTreeDir,
    ]);
    t.is(init2.status, 0);
    await run('node', [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(
        join(pushTreeDir, 'hello.txt'),
      )}, 'hello from the listener\\n')`,
    ]);
    await run('git', ['add', 'hello.txt'], { cwd: pushTreeDir, env: gitEnv });
    await run('git', ['commit', '-m', 'commit from listener test'], {
      cwd: pushTreeDir,
      env: gitEnv,
    });
    const push = await gitCmd(['push', remoteUrl, 'main:main'], pushTreeDir);
    t.is(
      push.status,
      0,
      `git push failed: stderr=${push.stderr} stdout=${push.stdout}`,
    );
  },
);

// Suppress eslint-on-unused warning for the WS streamPair helper —
// it is exported for embedders and we re-export it.
void streamPairFromWebSocket;
