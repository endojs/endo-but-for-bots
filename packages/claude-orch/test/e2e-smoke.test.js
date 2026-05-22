// @ts-nocheck
/* global Buffer, setTimeout */
/* eslint-disable import/order */

import '@endo/init';
import test from 'ava';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { start } from '../src/main.js';
import { buildFrame, consumeFrames } from '../src/stdio/mux.js';

/**
 * A no-op network controller for tests: skips nftables/pfctl, returns
 * empty qemuArgs, no per-session cleanup.
 *
 * @returns {import('../protocol.types.js').NetworkController}
 */
const makeStubNetwork = () => ({
  async initialize() {
    // no-op
  },
  async attachSession(_id, _opts) {
    return {
      qemuArgs: [],
      cleanup: async () => {
        // no-op
      },
    };
  },
  async detachSession(_id) {
    // no-op
  },
  async shutdown() {
    // no-op
  },
});

/**
 * In-process stand-in for the broker client used by `start()`.
 *
 * The new broker protocol is subscribe/push: `subscribe(sessionId)`
 * resolves to a handle with `initial` credentials + `onRotate` /
 * `onError` callbacks + `close()`. This stub records every
 * subscription so tests can drive pushes via `broadcastRotation`.
 */
const makeStubBrokerClient = ({ initialCredentials } = {}) => {
  const initial = initialCredentials ?? { apiKey: 'sk-test-12345' };
  /** @type {Array<{ sessionId: string, rotate: (c: any) => void, errored: (m: string) => void, closed: boolean }>} */
  const subs = [];
  return {
    client: {
      async subscribe(sessionId) {
        /** @type {(c: any) => void} */
        let rotateHandler = () => {};
        /** @type {(m: string) => void} */
        let errorHandler = () => {};
        const entry = {
          sessionId,
          rotate: c => rotateHandler(c),
          errored: m => errorHandler(m),
          closed: false,
        };
        subs.push(entry);
        return harden({
          initial,
          onRotate: h => {
            rotateHandler = h;
          },
          onError: h => {
            errorHandler = h;
          },
          async close() {
            entry.closed = true;
          },
        });
      },
    },
    /** Fan a fresh creds payload to every open subscription. */
    broadcastRotation(credentials) {
      for (const s of subs) {
        if (!s.closed) s.rotate(credentials);
      }
    },
    /** Number of subscriptions currently open. */
    openCount: () => subs.filter(s => !s.closed).length,
    subs,
  };
};

/**
 * Mock guest process. In place of QEMU, opens UDS clients to ctl.sock
 * and agent.sock, drives the bootstrap handshake, sends Ready, and
 * listens on stdio.sock for framed bytes from the orchestrator.
 *
 * @param {{
 *   record: import('../protocol.types.js').SessionRecord,
 *   onAttachData?: (payload: Buffer) => void,
 * }} opts
 */
const makeMockGuest = ({ record, onAttachData }) => {
  /** @type {net.Server | null} */
  let stdioServer = null;
  /** @type {net.Socket | null} */
  let stdioConn = null;
  /** @type {net.Socket | null} */
  let agentSocket = null;
  let killed = false;

  const run = async () => {
    // 0) Mock QEMU stdio chardev (server=on per qemu args): bind a UDS
    // server so the orchestrator's stdio mux can connect to it.
    stdioServer = net.createServer(conn => {
      stdioConn = conn;
      let stdioBuf = Buffer.alloc(0);
      conn.on('data', chunk => {
        stdioBuf = consumeFrames(
          Buffer.concat([stdioBuf, chunk]),
          (id, payload) => {
            if (id === 'default0' && onAttachData) {
              onAttachData(Buffer.from(payload));
            }
          },
        );
      });
      conn.on('error', () => {});
      conn.on('close', () => {});
    });
    stdioServer.on('error', () => {});
    await new Promise(r => stdioServer?.listen(record.stdioSocketPath, r));

    // 1) Connect to ctl.sock, send Hello, expect BootConfig.
    const ctl = net.createConnection(record.ctlSocketPath);
    ctl.on('error', () => {});
    await waitConnect(ctl);
    const hello = `${JSON.stringify({
      type: 'hello',
      sessionId: record.id,
      bootNonce: record.bootNonce,
      agentVersion: '0.0.0',
      hostname: 'mock-guest',
    })}\n`;
    ctl.write(hello);
    const ctlReply = await readLine(ctl);
    const bootConfig = JSON.parse(ctlReply);
    if (bootConfig.type !== 'boot_config') {
      throw new Error(`expected boot_config, got ${bootConfig.type}`);
    }
    ctl.end();

    // 2) Connect to agent.sock, send Ready.
    agentSocket = net.createConnection(record.agentSocketPath);
    agentSocket.on('error', () => {});
    await waitConnect(agentSocket);
    agentSocket.write(
      `${JSON.stringify({ type: 'ready', capabilities: ['stdio-mux'] })}\n`,
    );

    // 3) Stay attached for the test's lifetime; respond to terminate.
    let buf = '';
    agentSocket.on('data', chunk => {
      buf += chunk.toString('utf8');
      for (;;) {
        const i = buf.indexOf('\n');
        if (i < 0) break;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const msg = JSON.parse(line);
          agentRx.push(msg);
          if (msg.type === 'terminate') {
            killed = true;
            agentSocket?.end();
          }
        } catch {
          // ignore bad lines
        }
      }
    });
  };

  /** @type {object[]} */
  const agentRx = [];

  return {
    run,
    sendStdout(/** @type {Buffer} */ data) {
      if (stdioConn) stdioConn.write(buildFrame('default0', data));
    },
    stop() {
      killed = true;
      stdioConn?.destroy();
      stdioServer?.close(() => {});
      agentSocket?.destroy();
    },
    get killed() {
      return killed;
    },
    /** All orchestrator → agent messages received over agent.sock. */
    get agentRx() {
      return agentRx;
    },
  };
};

const waitConnect = sock =>
  new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });

const readLine = sock =>
  new Promise((resolve, reject) => {
    let buf = '';
    const onData = chunk => {
      buf += chunk.toString('utf8');
      const i = buf.indexOf('\n');
      if (i >= 0) {
        sock.off('data', onData);
        resolve(buf.slice(0, i));
      }
    };
    sock.on('data', onData);
    sock.once('error', reject);
  });

/**
 * @param {() => boolean} pred
 * @param {number} deadlineMs
 */
const waitFor = async (pred, deadlineMs) => {
  const begin = Date.now();
  while (!pred()) {
    const elapsed = /** @type {number} */ (Date.now() - begin);
    if (elapsed > deadlineMs) throw new Error('waitFor timeout');
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, 10));
  }
};

const httpRequest = (socketPath, method, urlPath, body) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        method,
        path: urlPath,
        headers: payload
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            }
          : undefined,
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode,
            body: text ? JSON.parse(text) : null,
          });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

test('e2e: full lifecycle createSession → markReady → attach → terminate', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'orch-e2e-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));

  const apiSock = path.join(dir, 'api.sock');
  const sessionsDir = path.join(dir, 'sessions');

  /** @type {ReturnType<typeof makeMockGuest> | null} */
  let mockGuest = null;
  const guestRx = [];

  // Mock VM "spawner" that, in place of QEMU, bootstraps the mock guest
  // against the orchestrator's per-session UDS endpoints.
  const mockSpawn = ({ record }) => {
    const guest = makeMockGuest({
      record,
      onAttachData: payload => guestRx.push(payload),
    });
    mockGuest = guest;
    // Defer a tick so the orchestrator has time to bind its listeners.
    setTimeout(() => guest.run().catch(() => {}), 5);
    const child = /** @type {any} */ ({ pid: 99999, killed: false });
    let resolveExit;
    const exitCode = new Promise(r => {
      resolveExit = r;
    });
    return {
      child,
      exitCode,
      kill: () => {
        guest.stop();
        resolveExit?.(0);
      },
    };
  };

  const orch = await start({
    config: {
      socketPath: apiSock,
      imageDir: '/unused',
      sessionDir: sessionsDir,
      brokerSocketPath: '/unused',
      defaults: { arch: 'x86_64', vcpus: 2, memMB: 2048 },
      bootDeadlineMs: 10000,
      heartbeatTimeoutMs: 60000,
    },
    networkController: makeStubNetwork(),
    brokerClient: /** @type {any} */ (makeStubBrokerClient().client),
    spawnVm: mockSpawn,
  });
  t.teardown(() => orch.stop());

  // 1) Create session via HTTP.
  const create = await httpRequest(apiSock, 'POST', '/v1/sessions', {
    network: 'none',
    attachMode: 'stream',
  });
  t.is(create.status, 200);
  const session = create.body;
  t.truthy(session.id);
  t.truthy(session.fsSocketPath);
  t.truthy(session.attachSocketPath);

  // 2) Caller pretends to bind fs.sock (test doesn't exercise 9P).
  // 3) Mark ready — kicks off VM spawn, bootstrap handshake, agent link,
  // and stdio mux.
  const ready = await httpRequest(
    apiSock,
    'POST',
    `/v1/sessions/${session.id}/ready`,
  );
  t.is(ready.status, 204);

  // 4) Caller connects to attach socket and writes a prompt.
  const caller = net.createConnection(session.attachSocketPath);
  caller.on('error', () => {});
  await waitConnect(caller);
  caller.write('hello from caller');

  // 5) Mock guest receives the framed payload.
  await waitFor(
    () => Buffer.concat(guestRx).toString('utf8').includes('hello from caller'),
    3000,
  );

  // 6) Mock guest sends data back; caller receives it.
  /** @type {Buffer[]} */
  const callerRx = [];
  caller.on('data', chunk => callerRx.push(chunk));
  mockGuest?.sendStdout(Buffer.from('hello from guest'));
  await waitFor(
    () => Buffer.concat(callerRx).toString('utf8').includes('hello from guest'),
    3000,
  );
  t.pass();

  // 7) Terminate the session.
  caller.destroy();
  const term = await httpRequest(
    apiSock,
    'DELETE',
    `/v1/sessions/${session.id}`,
  );
  t.is(term.status, 204);
  t.true(mockGuest?.killed ?? false);
});

test('e2e: broker pushes rotation to subscribed orchestrator (orch → agent relay)', async t => {
  // The broker drives the schedule. The orchestrator opens a
  // subscription per session in markReady, awaits initial creds
  // (used in BootConfig), and relays every subsequent broker push
  // to the agent via `link.send({type: 'rotate_creds', ...})`.
  //
  // No setInterval, no orch-side polling — the orch is just a
  // relay. This test stubs the broker so `broadcastRotation()`
  // simulates the broker's scheduled refresh; the orchestrator
  // should faithfully forward to every active subscription.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'orch-rot-push-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));

  const apiSock = path.join(dir, 'api.sock');
  const sessionsDir = path.join(dir, 'sessions');

  /** @type {Map<string, ReturnType<typeof makeMockGuest>>} */
  const mockGuests = new Map();
  const mockSpawn = ({ record }) => {
    const guest = makeMockGuest({ record });
    mockGuests.set(record.id, guest);
    setTimeout(() => guest.run().catch(() => {}), 5);
    const child = /** @type {any} */ ({
      pid: Math.floor(Math.random() * 99999),
      killed: false,
    });
    let resolveExit;
    const exitCode = new Promise(r => {
      resolveExit = r;
    });
    return {
      child,
      exitCode,
      kill: () => {
        guest.stop();
        resolveExit?.(0);
      },
    };
  };

  // Initial credentials are OAuth-shaped to demonstrate the
  // short-term-only injection model: the BootConfig and every
  // rotation carry only `{accessToken, expiresAt}`, never the
  // long-lived refresh secret that the broker holds.
  const broker = makeStubBrokerClient({
    initialCredentials: {
      oauthToken: {
        accessToken: 'tok-initial',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
  });

  const orch = await start({
    config: {
      socketPath: apiSock,
      imageDir: '/unused',
      sessionDir: sessionsDir,
      brokerSocketPath: '/unused',
      defaults: { arch: 'x86_64', vcpus: 2, memMB: 2048 },
      bootDeadlineMs: 10000,
      heartbeatTimeoutMs: 60000,
    },
    networkController: makeStubNetwork(),
    brokerClient: /** @type {any} */ (broker.client),
    spawnVm: mockSpawn,
  });
  t.teardown(() => orch.stop());

  // Spin up two parallel sessions; each gets its own broker
  // subscription.
  const sessionIds = await Promise.all(
    [0, 1].map(async i => {
      const create = await httpRequest(apiSock, 'POST', '/v1/sessions', {
        network: 'none',
        attachMode: 'none',
      });
      t.is(create.status, 200, `create ${i}`);
      const ready = await httpRequest(
        apiSock,
        'POST',
        `/v1/sessions/${create.body.id}/ready`,
      );
      t.is(ready.status, 204, `ready ${i}`);
      return create.body.id;
    }),
  );

  // Both subscriptions should be open by now.
  t.is(broker.openCount(), 2, 'orch opened a subscription per session');

  // Push a rotation from the "broker". Both subscribers' onRotate
  // handlers fire → orch forwards to each agent.
  broker.broadcastRotation({
    oauthToken: {
      accessToken: 'tok-rotated-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });

  const rotationsFor = sid =>
    (mockGuests.get(sid)?.agentRx ?? []).filter(m => m.type === 'rotate_creds');
  await waitFor(
    () =>
      sessionIds.every(sid =>
        rotationsFor(sid).some(
          m => m.credentials?.oauthToken?.accessToken === 'tok-rotated-1',
        ),
      ),
    3000,
  );

  // Push a second rotation — same fan-out behaviour.
  broker.broadcastRotation({
    oauthToken: {
      accessToken: 'tok-rotated-2',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  await waitFor(
    () =>
      sessionIds.every(sid =>
        rotationsFor(sid).some(
          m => m.credentials?.oauthToken?.accessToken === 'tok-rotated-2',
        ),
      ),
    3000,
  );

  // Terminate one session — its subscription must close.
  await httpRequest(apiSock, 'DELETE', `/v1/sessions/${sessionIds[0]}`);
  await waitFor(() => broker.openCount() === 1, 3000);

  // A subsequent broadcast reaches only the surviving session.
  const beforeFinal = sessionIds.map(sid => rotationsFor(sid).length);
  broker.broadcastRotation({
    oauthToken: {
      accessToken: 'tok-final',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  await waitFor(
    () =>
      rotationsFor(sessionIds[1]).some(
        m => m.credentials?.oauthToken?.accessToken === 'tok-final',
      ),
    3000,
  );
  // sessionIds[0] is terminated; its count must NOT have grown.
  t.is(
    rotationsFor(sessionIds[0]).length,
    beforeFinal[0],
    'terminated session received a rotation after its subscription closed',
  );
});
