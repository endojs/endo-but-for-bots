// @ts-check
/**
 * M4 acceptance 10 and 15 (part) through the daemon (W4.8;
 * `designs/m4-interfaces.md` 7, 17), against the fake subscription and
 * OAuth servers on 127.0.0.1, from the `m4` template:
 *
 * 10. An expired access token is renewed once (one refresh POST, at its
 *     first use: the catalogue read of the session's creation) and the
 *     round succeeds; a 401 gets one renewal and one retry, then the member
 *     is marked unusable and the next member serves; a renewal that loses
 *     the generation race re-reads and adopts the newer value.
 * 15. After a clean stop no token (the test's, and every token the OAuth
 *     server minted) is under the state directory, in the event log or in
 *     the supervisor's stderr.
 *
 * The race of acceptance 10 is run as section 7 states it for a value
 * "replaced by the operator": the OAuth answer is held while the operator
 * replaces the credential (a sealed box), so the renewal's conditioned
 * write-back fails `GENERATION_CONFLICT` and the flight re-reads. Two
 * Secrets stores of one state directory in two processes are not a
 * supported configuration (the adapter is the store's only writer); W4.4's
 * adapter test covers two stores in one process.
 *
 *   corepack yarn test:integration test/integration/m4-renewal.test.js
 */
import '../unit/_m1a-prelude.js';

import path from 'node:path';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { sealTo } from '../../resources/agent-host/impl/secrets/seal.js';
/* eslint-enable import/no-relative-packages */
import { integrationEnabled, takeIntegrationLock } from '../template/index.js';
import { startFakeSubscriptionServer } from '../fixtures/fake-subscription-server.mjs';
import { startFakeOAuthServer } from '../fixtures/fake-oauth-server.mjs';
import {
  CLAUDE_MODEL,
  TOKEN_PREFIXES,
  assertNoCredential,
  credentialText,
  fakeDefaults,
  makePool,
  makeValueSecret,
  openSession,
  poolLog,
  posts,
  runTurn,
  startM4,
  tokenOf,
} from './_m4.js';

takeIntegrationLock(test, 'm4 renewal test');

const run = integrationEnabled ? test.serial : test.skip;

run(
  'acceptance 10, 15: renewal once on expiry, one renewal after a 401, a lost race re-reads',
  async t => {
    t.timeout(4 * 60_000);
    const m4 = await startM4(t, 'renewal');
    const oauth = await startFakeOAuthServer();
    t.teardown(() => oauth.close());
    const tokens = {
      e: tokenOf('e'),
      x: tokenOf('x'),
      y: tokenOf('y'),
      z: tokenOf('z'),
      w: tokenOf('w'),
      z2: tokenOf('z2'),
    };
    const tags = new Map(Object.entries(tokens).map(([k, v]) => [v, k]));
    const server = await startFakeSubscriptionServer({
      credentialTag: value =>
        tags.get(value) ??
        (value.startsWith('fake-access-') ? 'renewed' : 'other'),
      defaults: { 'GET /v1/models': fakeDefaults['GET /v1/models'] },
    });
    t.teardown(() => server.close());
    const refreshes = () =>
      oauth.requests().filter(r => r.grant === 'refresh_token');

    /**
     * @param {string} tag
     * @param {{ expired?: boolean, refresh?: boolean }} [options]
     */
    const member = async (tag, { expired = false, refresh = true } = {}) => {
      const issued = oauth.issue();
      const made = await makeValueSecret(
        m4,
        `renewal ${tag}`,
        credentialText('claude', {
          accessToken: tokens[tag],
          ...(refresh ? { refreshToken: issued.refreshToken } : {}),
          expiresAtMs: expired ? Date.now() - 1000 : Date.now() + 3_600_000,
        }),
      );
      return {
        label: `member ${tag}`,
        credential: made.secret,
        serial: issued.serial,
      };
    };
    /**
     * @param {string} label
     * @param {any[]} members
     */
    const pool = async (label, members) => {
      const logPath = path.join(m4.state.root, `${label}.log`);
      const made = await makePool(m4, {
        kind: 'claude-pool',
        label,
        members,
        baseUrl: server.url,
        tokenUrl: oauth.tokenUrl,
        logPath,
      });
      return { ...made, logPath };
    };

    // ---- expired: renewed once, the round succeeds ----
    const e = await member('e', { expired: true });
    const expired = await pool('expired', [e]);
    const s1 = await openSession(m4, expired.backend, {
      modelId: CLAUDE_MODEL,
    });
    server.push({ sse: 'claude-text.sse' }, { sse: 'claude-text.sse' });
    const r1 = await runTurn(m4, s1.session, s1.live, 'expired');
    t.is(r1.status.state, 'completed', r1.status.error);
    t.is(refreshes().length, 1, 'one refresh POST');
    t.is(oauth.presented(e.serial), 1);
    t.is(posts(server).at(-1)?.credential, 'renewed');
    await runTurn(m4, s1.session, s1.live, 'expired again');
    t.is(refreshes().length, 1, 'the renewed token is used, not renewed again');

    // ---- 401: one renewal, one retry, then the next member ----
    const x = await member('x');
    const y = await member('y');
    const rejecting = await pool('rejecting', [x, y]);
    const s2 = await openSession(m4, rejecting.backend, {
      modelId: CLAUDE_MODEL,
    });
    const before = posts(server).length;
    server.push(
      { status: 401, match: { credential: 'x' } },
      { status: 401, match: { credential: 'renewed' } },
      { sse: 'claude-text.sse', match: { credential: 'y' } },
    );
    const r2 = await runTurn(m4, s2.session, s2.live, 'rejected');
    t.is(r2.status.state, 'completed', r2.status.error);
    t.deepEqual(
      posts(server)
        .slice(before)
        .map(r => r.credential),
      ['x', 'renewed', 'y'],
    );
    t.is(refreshes().length, 2, 'one renewal for the 401');
    t.is(oauth.presented(x.serial), 1);
    const failed = poolLog(rejecting.logPath).filter(
      l => l.kind === 'member-failed',
    );
    t.is(failed.length, 1);
    t.regex(failed[0].reason, /"member x".*"REJECTED"/);

    // ---- a lost race: the operator's value wins, the flight re-reads ----
    // The member's first credential use renews it: here the catalogue read
    // of the session's creation (`resolveModel` reads each member's model
    // list with its credential), so the race is run around the creation.
    const z = await member('z', { expired: true });
    const w = await member('w');
    const racing = await pool('racing', [z, w]);
    const raceFrom = server.requests().length;
    const held = oauth.hold();
    const creating = openSession(m4, racing.backend, { modelId: CLAUDE_MODEL });
    const first = await Promise.race([
      held.arrived.then(() => 'arrived'),
      creating.then(
        () => 'created',
        error => `refused: ${error}`,
      ),
    ]);
    t.is(first, 'arrived', 'the renewal reached the token endpoint');
    await E(m4.writer).replace(
      z.credential,
      sealTo(
        m4.publicKey,
        credentialText('claude', { accessToken: tokens.z2 }),
      ),
    );
    held.release();
    const s3 = await creating;
    server.push({ sse: 'claude-text.sse' });
    const r3 = await runTurn(m4, s3.session, s3.live, 'race');
    t.is(r3.status.state, 'completed', r3.status.error);
    t.is(posts(server).at(-1)?.credential, 'z2', "the operator's value serves");
    t.is(oauth.presented(z.serial), 1);
    t.is(
      server
        .requests()
        .slice(raceFrom)
        .filter(r => r.path === '/v1/models' && r.credential === 'renewed')
        .length,
      0,
      "the renewed answer lost: the catalogue read used the operator's value",
    );
    t.deepEqual(
      poolLog(racing.logPath).filter(l => l.kind === 'member-failed'),
      [],
    );

    // ---- 15 ----
    await m4.state.stop();
    await assertNoCredential(t, m4, [...TOKEN_PREFIXES], {
      files: [expired.logPath, rejecting.logPath, racing.logPath],
      control: 'renewal e',
    });
  },
);
