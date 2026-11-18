// @ts-check
/**
 * Retirement on the next turn through the daemon (XB;
 * `designs/m4-interfaces.md` 3.1: `retirePool` and `PoolMember.retire`
 * push `CredentialOps.poolsChanged` to the adapter and return only after
 * its answer (X-FIX), so the retirement is known there before the next
 * turn can be submitted), against the
 * fake subscription server on 127.0.0.1, from the `m4` template:
 *
 * - a Claude pool of two members serves a session from the first member
 *   (declaration order, no readings);
 * - that member is retired (`PoolMember.retire`): the session's next turn,
 *   submitted at once, is served by the other member, although the session
 *   was sticky on the retired one and the adapter's periodic re-read
 *   (`poolStateRefreshMs`, 600 s) is far away;
 * - the pool is retired (`SubscriptionsAdmin.retirePool`): the session's
 *   next turn, submitted at once, fails with `subscriptionTexts.retired` and nothing
 *   reaches the fake server.
 *
 * The first retirement is the manager's first `CredentialOps` use in this
 * adapter incarnation (the push waits for one `ops.credentials()` answer);
 * the second finds it cached. Either way the retirement returns after the
 * adapter answered the push, so the order no longer rests on timing.
 *
 *   corepack yarn test:integration test/integration/m4-retire.test.js
 */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { subscriptionTexts } from '../../guest/lib/subscription-texts.js';
/* eslint-enable import/no-relative-packages */
import { subscriptionDefaults } from '../../config/subscription-defaults.js';
import { emit } from '../../perf/_harness.mjs';
import { integrationEnabled, takeIntegrationLock } from '../template/index.js';
import { startFakeSubscriptionServer } from '../fixtures/fake-subscription-server.mjs';
import {
  CLAUDE_MODEL,
  credentialText,
  fakeDefaults,
  makePool,
  makeValueSecret,
  openSession,
  posts,
  runTurn,
  startM4,
  tokenOf,
} from './_m4.js';

takeIntegrationLock(test, 'm4 retire test');

const run = integrationEnabled ? test.serial : test.skip;

run(
  'XB: a retired member is not chosen at the next turn; a retired pool fails the next turn with the retired text',
  async t => {
    t.timeout(4 * 60_000);
    const m4 = await startM4(t, 'retire');
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
        `retire member ${tag}`,
        credentialText('claude', { accessToken }),
      );
      members.push({ label: `member ${tag}`, credential: secret });
    }
    const { backend, members: made } = await makePool(m4, {
      kind: 'claude-pool',
      label: 'Retire pool',
      members,
      baseUrl: server.url,
    });
    const [memberA] = made;
    const { session, live } = await openSession(m4, backend, {
      modelId: CLAUDE_MODEL,
    });
    const servedBy = () => posts(server).at(-1)?.credential;

    server.push({ sse: 'claude-text.sse' });
    const first = await runTurn(m4, session, live, 'first');
    t.is(first.status.state, 'completed', first.status.error);
    t.is(servedBy(), 'a', 'declaration order: a serves and the session sticks');

    // The member that served is retired; the next turn goes at once.
    t.true(subscriptionDefaults.poolStateRefreshMs >= 600_000);
    const t0 = performance.now();
    await E(memberA).retire();
    const retireMs = performance.now() - t0;
    server.push({ sse: 'claude-text.sse' });
    const t1 = performance.now();
    const second = await runTurn(m4, session, live, 'after member retire');
    const memberTurnMs = performance.now() - t1;
    t.is(second.status.state, 'completed', second.status.error);
    t.is(servedBy(), 'b', 'the retired member is not chosen again');
    t.is(
      posts(server).filter(r => r.credential === 'a').length,
      1,
      'nothing more reached the retired member',
    );

    // The pool is retired; the next turn goes at once and fails.
    const before = posts(server).length;
    const t2 = performance.now();
    await E(m4.subs).retirePool(backend);
    const retirePoolMs = performance.now() - t2;
    const t3 = performance.now();
    const third = await runTurn(m4, session, live, 'after pool retire');
    const poolTurnMs = performance.now() - t3;
    t.is(third.status.state, 'failed');
    t.is(third.status.error, subscriptionTexts.retired);
    t.is(posts(server).length, before, 'nothing sent for the retired pool');

    emit({
      metric: 'm4.retire.nextTurn',
      retireMs: Math.round(retireMs),
      memberTurnMs: Math.round(memberTurnMs),
      retirePoolMs: Math.round(retirePoolMs),
      poolTurnMs: Math.round(poolTurnMs),
      poolStateRefreshMs: subscriptionDefaults.poolStateRefreshMs,
    });
  },
);
