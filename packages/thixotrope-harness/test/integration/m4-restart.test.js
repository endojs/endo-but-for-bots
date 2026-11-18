// @ts-check
/**
 * M4 acceptance 4 and 11 through the daemon (W4.8;
 * `designs/m4-interfaces.md` 10, 17), against the fake subscription server
 * on 127.0.0.1, from the `m4` template; one pool of two Claude members
 * (`a`, `b`). Every kill is a SIGKILL of the supervisor and of every
 * process under the state directory at once (the adapter included).
 *
 * 4. A mark survives a SIGKILL restart (after the mark's crank): a new
 *    session's first round skips the marked member; a newer open reading of
 *    the member lifts its dated mark.
 * 11. SIGKILL during a pool round, at K-2 (after a's 429 was answered, b's
 *     request held by the server), K-3 (mid-stream from b) and K-4 (b's
 *     request sent, before its first byte): after the restart the turn is
 *     outcome-unknown, each member attempt reached the server at most once,
 *     and nothing for that round reaches it after the restart.
 *
 * K-2's "none to b": the adapter sends b's request within a millisecond of
 * a's 429, so a kill from outside cannot land reliably between them; the
 * test holds b's request and asserts at most one, as acceptance 11 states.
 *
 *   corepack yarn test:integration test/integration/m4-restart.test.js
 */
import '../unit/_m1a-prelude.js';

import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { E } from '@endo/far';

import { emit } from '../../perf/_harness.mjs';
import { requestId } from './_m1a-slice.js';
import { integrationEnabled, takeIntegrationLock } from '../template/index.js';
import {
  exhaustedEntry,
  startFakeSubscriptionServer,
} from '../fixtures/fake-subscription-server.mjs';
import {
  CLAUDE_MODEL,
  credentialText,
  fakeDefaults,
  killAndRestart,
  listPools,
  makePool,
  makeValueSecret,
  openSession,
  posts,
  runTurn,
  settledState,
  startM4,
  tokenOf,
  waitFor,
} from './_m4.js';

takeIntegrationLock(test, 'm4 restart test');

const run = integrationEnabled ? test.serial : test.skip;

const DAY = 86_400_000;

/**
 * A usage answer: the long window used `used` percent, resetting at `at`.
 * @param {number} used
 * @param {number} at ms
 */
const usage = (used, at) => ({
  seven_day: { utilization: used, resets_at: new Date(at).toISOString() },
});

run(
  'acceptance 4, 11: marks survive a SIGKILL; kills at K-2, K-3 and K-4 send no attempt twice',
  async t => {
    t.timeout(4.5 * 60_000);
    const m4 = await startM4(t, 'restart');
    const tokens = { a: tokenOf('a'), b: tokenOf('b') };
    const tags = new Map(Object.entries(tokens).map(([k, v]) => [v, k]));
    const server = await startFakeSubscriptionServer({
      credentialTag: value => tags.get(value) ?? 'other',
      defaults: { 'GET /v1/models': fakeDefaults['GET /v1/models'] },
    });
    t.teardown(() => server.close());
    /** @type {{ label: string, credential: any }[]} */
    const members = [];
    for (const [tag, accessToken] of Object.entries(tokens)) {
      // eslint-disable-next-line no-await-in-loop
      const { secret } = await makeValueSecret(
        m4,
        `restart ${tag}`,
        credentialText('claude', { accessToken }),
      );
      members.push({ label: `member ${tag}`, credential: secret });
    }
    await makePool(m4, {
      kind: 'claude-pool',
      label: 'Restart pool',
      members,
      baseUrl: server.url,
    });
    const pool = async () => (await listPools(m4))[0];
    const credentialsSince = (/** @type {number} */ from) =>
      posts(server)
        .slice(from)
        .map(r => r.credential);

    // ---- 4. a mark survives a SIGKILL restart ----
    const s1 = await openSession(m4, await pool(), { modelId: CLAUDE_MODEL });
    const resetA = Math.floor((Date.now() + 2 * DAY) / 1000);
    server.push(
      { ...exhaustedEntry('claude', resetA), match: { credential: 'a' } },
      { sse: 'claude-text.sse', match: { credential: 'b' } },
    );
    const marked = await runTurn(m4, s1.session, s1.live, 'mark a');
    t.is(marked.status.state, 'completed', marked.status.error);
    // The mark's crank (sendOnly, at once) commits within the turn's own
    // cranks; give it a moment, then kill.
    await delay(1500);
    const k0 = await killAndRestart(m4);
    const s2 = await openSession(m4, await pool(), { modelId: CLAUDE_MODEL });
    let from = posts(server).length;
    server.push({ sse: 'claude-text.sse', match: { credential: 'b' } });
    const skipped = await runTurn(m4, s2.session, s2.live, 'after the kill');
    t.is(skipped.status.state, 'completed', skipped.status.error);
    t.deepEqual(credentialsSince(from), ['b'], 'the marked member is skipped');

    // A newer open reading of a lifts its dated mark: a fresh session goes
    // to a (its long window resets sooner).
    const accounts = await E(m4.subs).accounts();
    const soon = Date.now() + DAY;
    server.push(
      {
        match: { method: 'GET', path: '/api/oauth/usage', credential: 'a' },
        body: usage(10, soon),
      },
      {
        match: { method: 'GET', path: '/api/oauth/usage', credential: 'b' },
        body: usage(10, soon + DAY),
      },
    );
    await E(accounts).refresh(await pool());
    const s3 = await openSession(m4, await pool(), { modelId: CLAUDE_MODEL });
    from = posts(server).length;
    server.push({ sse: 'claude-text.sse', match: { credential: 'a' } });
    const lifted = await runTurn(m4, s3.session, s3.live, 'lifted');
    t.is(lifted.status.state, 'completed', lifted.status.error);
    t.deepEqual(credentialsSince(from), ['a'], 'the mark is lifted');
    emit({ metric: 'm4.restart.k0', ...k0 });

    /**
     * One kill point: a fresh session, the plan, submit, kill when `ready`
     * says so, restart; then the turn's state and what reached the server.
     * @param {string} name
     * @param {any[]} plan
     * @param {(from: number) => boolean} ready
     */
    const killPoint = async (name, plan, ready) => {
      const opened = await openSession(m4, await pool(), {
        modelId: CLAUDE_MODEL,
      });
      const { key } = await E(opened.session).getInfo();
      server.setPlan(plan);
      const start = posts(server).length;
      await E(m4.slice.composer).submit(opened.session, name, requestId());
      await waitFor(() => ready(start), 30_000, `${name}: the kill point`, 5);
      const timings = await killAndRestart(m4);
      const atKill = credentialsSince(start);
      const session = await E(m4.slice.factory).findSession(key);
      const settled = await settledState(session, name);
      await delay(2000);
      const after = credentialsSince(start);
      emit({ metric: `m4.restart.${name}`, sent: atKill, ...timings });
      t.is(settled.state, 'outcome-unknown', `${name}: outcome unknown`);
      t.deepEqual(after, atKill, `${name}: nothing after the restart`);
      for (const tag of ['a', 'b'])
        t.true(
          Number(after.filter(c => c === tag).length) <= 1,
          `${name}: ${tag} at most once`,
        );
      return after;
    };

    // K-2: a answers 429 (exhausted), b's request is held.
    const resetA2 = Math.floor((Date.now() + 2 * DAY) / 1000);
    const k2 = await killPoint(
      'k2',
      [
        { ...exhaustedEntry('claude', resetA2), match: { credential: 'a' } },
        { hang: true, match: { credential: 'b' } },
      ],
      start =>
        posts(server)
          .slice(start)
          .some(r => r.credential === 'a' && r.completed),
    );
    t.true(k2.includes('a'));

    // K-3: mid-stream from b (after its first events).
    await killPoint(
      'k3',
      [
        { ...exhaustedEntry('claude', resetA2), match: { credential: 'a' } },
        { sse: 'claude-text.sse', delayMs: 2000, match: { credential: 'b' } },
      ],
      start =>
        posts(server)
          .slice(start)
          .some(r => r.credential === 'b' && Number(r.events) >= 2),
    );

    // K-4: b's request sent, before its first byte.
    await killPoint(
      'k4',
      [
        { ...exhaustedEntry('claude', resetA2), match: { credential: 'a' } },
        {
          sse: 'claude-text.sse',
          firstByteDelayMs: 60_000,
          match: { credential: 'b' },
        },
      ],
      start =>
        posts(server)
          .slice(start)
          .some(r => r.credential === 'b'),
    );
  },
);
