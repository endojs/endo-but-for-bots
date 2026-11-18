// @ts-check
/**
 * M4 acceptance 2, 3 and 15 (part) through the daemon (W4.8;
 * `designs/m4-interfaces.md` 5.1, 5.2, 17), against the fake subscription
 * server on 127.0.0.1, from the `m4` template:
 *
 * 2. `auto` picks the member whose long window resets soonest; ties by the
 *    larger used fraction, then declaration order; a session stays on its
 *    member within `cacheLifetimeMs` (3 s here) and moves after it.
 * 3. A 429 with exhaustion headers marks the member and the same request
 *    goes to the next member once; all exhausted fails "Provider
 *    subscriptions exhausted" with the first reset time; no provider body in
 *    any recorded reason.
 * 15. After a clean stop, no token value under the state directory, in the
 *    pool's event log or in the supervisor's stderr.
 *
 * Readings come from on-demand usage reads (`Accounts.refresh`), one plan
 * entry per member (`match.credential`).
 *
 *   corepack yarn test:integration test/integration/m4-pools.test.js
 */
import '../unit/_m1a-prelude.js';

import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { m4TextOf } from '../../guest/lib/texts-m4.js';
/* eslint-enable import/no-relative-packages */
import { integrationEnabled, takeIntegrationLock } from '../template/index.js';
import {
  BODY_MARKER,
  exhaustedEntry,
  startFakeSubscriptionServer,
} from '../fixtures/fake-subscription-server.mjs';
import {
  CLAUDE_MODEL,
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

takeIntegrationLock(test, 'm4 pools test');

const run = integrationEnabled ? test.serial : test.skip;

const DAY = 86_400_000;

/**
 * A usage answer: the long window used `used` percent, resetting at `at`.
 * @param {number} used
 * @param {number} at ms
 */
const usage = (used, at) => ({
  five_hour: {
    utilization: 5,
    resets_at: new Date(Date.now() + 3_600_000).toISOString(),
  },
  seven_day: { utilization: used, resets_at: new Date(at).toISOString() },
});

run(
  'acceptance 2, 3, 15: auto selection, stickiness, hand-over on exhaustion, all exhausted',
  async t => {
    t.timeout(4 * 60_000);
    const m4 = await startM4(t, 'pools');
    const tokens = { a: tokenOf('a'), b: tokenOf('b'), c: tokenOf('c') };
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
        `pool member ${tag}`,
        credentialText('claude', { accessToken }),
      );
      members.push({ label: `member ${tag}`, credential: secret });
    }
    const logPath = path.join(m4.state.root, 'pool-a.log');
    const { backend } = await makePool(m4, {
      kind: 'claude-pool',
      label: 'Claude pool',
      members,
      baseUrl: server.url,
      logPath,
      extra: { cacheLifetimeMs: 3000 },
    });
    const accounts = await E(m4.subs).accounts();
    const { session, live } = await openSession(m4, backend, {
      modelId: CLAUDE_MODEL,
    });

    /**
     * Usage readings for the three members, read now.
     * @param {Record<string, [number, number]>} byTag used, reset at
     */
    const readings = async byTag => {
      for (const [tag, [used, at]] of Object.entries(byTag))
        server.push({
          match: { method: 'GET', path: '/api/oauth/usage', credential: tag },
          body: usage(used, at),
        });
      await E(accounts).refresh(backend);
    };
    const servedBy = () => posts(server).at(-1)?.credential;

    // 2a. Soonest long reset wins; b and c tie on the reset, c used more.
    const soon = Date.now() + DAY;
    await readings({ a: [10, soon + 2 * DAY], b: [50, soon], c: [80, soon] });
    server.push({ sse: 'claude-text.sse' });
    const first = await runTurn(m4, session, live, 'first');
    t.is(first.status.state, 'completed', first.status.error);
    t.is(servedBy(), 'c', 'soonest reset, then the larger used fraction');

    // 2b. Sticky within the cache lifetime though b is now better.
    await readings({
      a: [10, soon + 2 * DAY],
      b: [50, soon - DAY / 2],
      c: [80, soon],
    });
    server.push({ sse: 'claude-text.sse' });
    await runTurn(m4, session, live, 'sticky');
    t.is(servedBy(), 'c', 'the session stays on its member');
    // ... and moves once the lifetime (3 s) has passed.
    await delay(3500);
    server.push({ sse: 'claude-text.sse' });
    await runTurn(m4, session, live, 'moved');
    t.is(servedBy(), 'b', 'after the cache lifetime the best member serves');

    // 2c. All equal: declaration order (a fresh session has no member).
    await readings({ a: [30, soon], b: [30, soon], c: [30, soon] });
    const other = await openSession(m4, backend, { modelId: CLAUDE_MODEL });
    server.push({ sse: 'claude-text.sse' });
    await runTurn(m4, other.session, other.live, 'tie');
    t.is(servedBy(), 'a', 'ties go to declaration order');

    // 3a. A fresh session, a preferred: a is exhausted, so the same
    // request goes once to the next member (b ties c: declaration order).
    await readings({ a: [30, soon - DAY / 2], b: [30, soon], c: [30, soon] });
    const third = await openSession(m4, backend, { modelId: CLAUDE_MODEL });
    const resetA = Math.floor((Date.now() + 2 * DAY) / 1000);
    const before = posts(server).length;
    server.push(
      { ...exhaustedEntry('claude', resetA), match: { credential: 'a' } },
      { sse: 'claude-text.sse', match: { credential: 'b' } },
    );
    const handed = await runTurn(m4, third.session, third.live, 'hand over');
    t.is(handed.status.state, 'completed', handed.status.error);
    const sent = posts(server).slice(before);
    t.deepEqual(
      sent.map(r => r.credential),
      ['a', 'b'],
    );
    t.deepEqual(sent[0].json, sent[1].json, 'the same request, rebuilt');

    // 3b. Every member exhausted: the turn fails with the first reset (a's).
    const resetB = Math.floor((Date.now() + 3 * DAY) / 1000);
    const resetC = Math.floor((Date.now() + 4 * DAY) / 1000);
    const before2 = posts(server).length;
    server.push(
      { ...exhaustedEntry('claude', resetB), match: { credential: 'b' } },
      { ...exhaustedEntry('claude', resetC), match: { credential: 'c' } },
    );
    const failed = await runTurn(
      m4,
      third.session,
      third.live,
      'all exhausted',
    );
    t.is(failed.status.state, 'failed');
    t.is(
      failed.status.error,
      m4TextOf.subscriptionsExhausted(new Date(resetA * 1000).toISOString()),
    );
    t.deepEqual(
      posts(server)
        .slice(before2)
        .map(r => r.credential),
      ['b', 'c'],
      'each unmarked member tried once; a stays marked',
    );
    const page = await E(third.session).getHistoryPage();
    t.false(JSON.stringify(page).includes(BODY_MARKER), 'no body in a reason');
    const log = poolLog(logPath);
    t.false(JSON.stringify(log).includes(BODY_MARKER), 'no body in the log');
    t.is(log.filter(line => line.kind === 'member-exhausted').length, 3);

    // 15. Clean stop, then the grep.
    await m4.state.stop();
    await assertNoCredential(t, m4, Object.values(tokens), {
      files: [logPath],
      control: 'pool member a',
    });
  },
);
