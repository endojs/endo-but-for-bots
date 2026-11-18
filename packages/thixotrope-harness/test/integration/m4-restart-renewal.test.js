// @ts-check
/**
 * M4 acceptance 12 and 15 (part) through the daemon (W4.8;
 * `designs/m4-interfaces.md` 7, 10, 17): SIGKILL during a renewal, against
 * the fake subscription and OAuth servers on 127.0.0.1, from the `m4`
 * template. Each pool has an expired member `k` (renewed at its first
 * round) and a member `o` that serves.
 *
 * - K-5, after the write-ahead intent and before the POST: the pool's
 *   token URL is a TCP listener that accepts the connection and never reads
 *   it, so the refresh token never reaches the token endpoint; the kill
 *   comes when the connection arrives (the intent is written before the
 *   POST starts).
 * - K-6, after the token endpoint processed the refresh and before the
 *   write-back: the fake OAuth server holds its answer; the kill comes when
 *   the request has arrived.
 *
 * The renewal runs at the expired member's first credential use, the
 * catalogue read of a session's creation (`resolveModel`): the kill breaks
 * that creation. After each restart: the token endpoint saw at most one
 * refresh for the
 * token, the member reports `CONSUMED` (event log and accounts view), and a
 * turn succeeds on the other member. Then no token anywhere (15).
 *
 *   corepack yarn test:integration test/integration/m4-restart-renewal.test.js
 */
import '../unit/_m1a-prelude.js';

import { createServer } from 'node:net';
import path from 'node:path';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { m4TextOf } from '../../guest/lib/texts-m4.js';
/* eslint-enable import/no-relative-packages */
import { emit } from '../../perf/_harness.mjs';
import { integrationEnabled, takeIntegrationLock } from '../template/index.js';
import { startFakeSubscriptionServer } from '../fixtures/fake-subscription-server.mjs';
import { startFakeOAuthServer } from '../fixtures/fake-oauth-server.mjs';
import {
  CLAUDE_MODEL,
  TOKEN_PREFIXES,
  assertNoCredential,
  credentialText,
  fakeDefaults,
  killAndRestart,
  listPools,
  makePool,
  makeValueSecret,
  openSession,
  poolLog,
  posts,
  runTurn,
  startM4,
  tokenOf,
} from './_m4.js';

takeIntegrationLock(test, 'm4 restart renewal test');

const run = integrationEnabled ? test.serial : test.skip;

/**
 * A TCP listener that accepts connections and never reads them.
 * @returns {Promise<{ url: string, connections: () => number, close: () => Promise<void> }>}
 */
const startSink = async () => {
  let connections = 0;
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  const server = createServer(socket => {
    connections += 1;
    socket.pause();
    sockets.add(socket);
  });
  await new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  const { port } = /** @type {import('node:net').AddressInfo} */ (
    server.address()
  );
  return {
    url: `http://127.0.0.1:${port}/token`,
    connections: () => connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(() => resolve(undefined)));
    },
  };
};

run(
  'acceptance 12, 15: SIGKILL at K-5 and K-6: at most one refresh, CONSUMED, the other member serves',
  async t => {
    t.timeout(4.5 * 60_000);
    const m4 = await startM4(t, 'restart-renewal');
    const oauth = await startFakeOAuthServer();
    t.teardown(() => oauth.close());
    const sink = await startSink();
    t.teardown(() => sink.close());
    const tokens = {
      k5: tokenOf('k5'),
      o5: tokenOf('o5'),
      k6: tokenOf('k6'),
      o6: tokenOf('o6'),
    };
    const tags = new Map(Object.entries(tokens).map(([k, v]) => [v, k]));
    const server = await startFakeSubscriptionServer({
      credentialTag: value =>
        tags.get(value) ??
        (value.startsWith('fake-access-') ? 'renewed' : 'other'),
      defaults: { 'GET /v1/models': fakeDefaults['GET /v1/models'] },
    });
    t.teardown(() => server.close());

    /**
     * @param {string} tag
     * @param {string} tokenUrl
     */
    const setup = async (tag, tokenUrl) => {
      const issued = oauth.issue();
      const k = await makeValueSecret(
        m4,
        `k${tag}`,
        credentialText('claude', {
          accessToken: tokens[`k${tag}`],
          refreshToken: issued.refreshToken,
          expiresAtMs: Date.now() - 1000,
        }),
      );
      const o = await makeValueSecret(
        m4,
        `o${tag}`,
        credentialText('claude', { accessToken: tokens[`o${tag}`] }),
      );
      const logPath = path.join(m4.state.root, `k${tag}.log`);
      await makePool(m4, {
        kind: 'claude-pool',
        label: `K-${tag} pool`,
        members: [
          { label: `member k${tag}`, credential: k.secret },
          { label: `member o${tag}`, credential: o.secret },
        ],
        baseUrl: server.url,
        tokenUrl,
        logPath,
      });
      return { serial: issued.serial, logPath };
    };
    const k5 = await setup('5', sink.url);
    const k6 = await setup('6', oauth.tokenUrl);

    /**
     * Submit a turn on a fresh session of pool `index`, kill at `ready`,
     * restart; then a turn on a new session of the same pool.
     * @param {number} index
     * @param {string} name
     * @param {() => Promise<void>} ready
     * @param {() => void} [afterKill]
     */
    const killDuringRenewal = async (index, name, ready, afterKill) => {
      // The expired member's first credential use is the catalogue read of
      // a session's creation (`resolveModel`), which renews it: the kill
      // comes during that creation (it never answers).
      const before = posts(server).length;
      const creating = openSession(m4, (await listPools(m4))[index], {
        modelId: CLAUDE_MODEL,
      }).catch(() => undefined);
      await ready();
      const timings = await killAndRestart(m4);
      afterKill?.();
      emit({ metric: `m4.restart.${name}`, ...timings });
      t.is(await creating, undefined, `${name}: the creation broke`);
      t.is(posts(server).length, before, `${name}: no inference request`);
      // The next turn: k is CONSUMED, o serves.
      const pool = (await listPools(m4))[index];
      const next = await openSession(m4, pool, { modelId: CLAUDE_MODEL });
      server.push({ sse: 'claude-text.sse' });
      const served = await runTurn(m4, next.session, next.live, `${name} next`);
      t.is(served.status.state, 'completed', served.status.error);
      t.is(posts(server).at(-1)?.credential, `o${index === 0 ? 5 : 6}`);
      const accounts = await E(m4.subs).accounts();
      const view = await E(accounts).forBackend(pool);
      const k = view.members.find(
        (/** @type {any} */ m) => m.label === `member k${index === 0 ? 5 : 6}`,
      );
      t.like(k, { state: 'unusable', code: 'CONSUMED' });
    };

    // K-5: the intent is written, the POST never reaches the endpoint.
    await killDuringRenewal(0, 'k5', async () => {
      const t0 = Date.now();
      while (sink.connections() === 0) {
        if (Date.now() - t0 > 30_000) throw Error('k5: no token request');
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    });
    t.is(
      oauth.presented(k5.serial),
      0,
      'K-5: the token never reached the endpoint',
    );
    t.true(
      poolLog(k5.logPath).some(
        l => l.reason === m4TextOf.memberFailed('member k5', 'CONSUMED'),
      ),
    );

    // K-6: the endpoint processed the refresh, its answer is held.
    const held = oauth.hold();
    await killDuringRenewal(
      1,
      'k6',
      () => held.arrived,
      () => held.release(),
    );
    t.is(oauth.presented(k6.serial), 1, 'K-6: presented once, never again');
    t.true(
      poolLog(k6.logPath).some(
        l => l.reason === m4TextOf.memberFailed('member k6', 'CONSUMED'),
      ),
    );

    // 15.
    await m4.state.stop();
    await assertNoCredential(t, m4, [...TOKEN_PREFIXES], {
      files: [k5.logPath, k6.logPath],
      control: 'member k5',
    });
  },
);
