// @ts-check
/**
 * M4 acceptance 7 through the daemon (W4.8; `designs/m4-interfaces.md` 6,
 * 17), against the fake subscription server on 127.0.0.1, from the `m4`
 * template:
 *
 * - `Accounts.forSession` shows each member with its provenance: a member
 *   with a declared profile is `declared`, one with nothing `unavailable`;
 *   the rate-limit headers of a served round make it `observed`;
 * - `refresh` reads the providers now and updates the view: one batch per
 *   refresh on a watcher (R4-85: pushed, not polled);
 * - the model's part (XC, D-M4-9 as amended): the model is offered
 *   `accountStatus` on a pool session, calls it, and the next round carries
 *   the rendered text (the pool, its members with their provenance) as a
 *   tool result that is not an error;
 * - after a restart the readings are `remembered`, before any round
 *   (`Accounts.forBackend` of a pool this incarnation has not used yet).
 *
 *   corepack yarn test:integration test/integration/m4-accounts.test.js
 */
import '../unit/_m1a-prelude.js';

import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { E } from '@endo/far';

import { emit } from '../../perf/_harness.mjs';
import { integrationEnabled, takeIntegrationLock } from '../template/index.js';
import {
  claudeEvents,
  readingHeaders,
  startFakeSubscriptionServer,
} from '../fixtures/fake-subscription-server.mjs';
import {
  CLAUDE_MODEL,
  credentialText,
  fakeDefaults,
  makeValueSecret,
  openSession,
  posts,
  runTurn,
  startM4,
  tokenOf,
} from './_m4.js';

takeIntegrationLock(test, 'm4 accounts test');

const run = integrationEnabled ? test.serial : test.skip;

/**
 * @param {any} pool PoolAccounts
 * @param {string} label
 */
const memberOf = (pool, label) =>
  pool.members.find((/** @type {any} */ m) => m.label === label);

run(
  'acceptance 7: provenance, refresh, one batch per change, accountStatus, remembered after a restart',
  async t => {
    t.timeout(4 * 60_000);
    const m4 = await startM4(t, 'accounts');
    const tokens = { obs: tokenOf('obs'), decl: tokenOf('decl') };
    const tags = new Map(Object.entries(tokens).map(([k, v]) => [v, k]));
    const server = await startFakeSubscriptionServer({
      credentialTag: value => tags.get(value) ?? 'other',
      defaults: fakeDefaults,
    });
    t.teardown(() => server.close());

    const obsSecret = await makeValueSecret(
      m4,
      'accounts obs',
      credentialText('claude', { accessToken: tokens.obs }),
    );
    const declSecret = await makeValueSecret(
      m4,
      'accounts decl',
      credentialText('claude', { accessToken: tokens.decl }),
    );
    const obs = await E(m4.subs).makeMember(
      harden({
        provider: 'claude',
        label: 'member obs',
        credential: obsSecret.secret,
      }),
    );
    const decl = await E(m4.subs).makeMember(
      harden({
        provider: 'claude',
        label: 'member decl',
        credential: declSecret.secret,
        declared: {
          plan: 'max',
          windows: [{ name: 'secondary', usedPercent: 10 }],
        },
      }),
    );
    const backend = await E(m4.subs).makePool(
      harden({
        kind: 'claude-pool',
        label: 'Accounts pool',
        members: [obs, decl],
        baseUrl: server.url,
        usageUrl: `${server.url}/api/oauth/usage`,
      }),
    );
    const { session, live } = await openSession(m4, backend, {
      modelId: CLAUDE_MODEL,
    });
    const accounts = await E(m4.subs).accounts();

    // Before any round: declared and unavailable.
    const first = await E(accounts).forSession(session);
    t.is(first.label, 'Accounts pool');
    t.is(first.selection, 'auto');
    t.is(memberOf(first, 'member obs').provenance, 'unavailable');
    t.is(memberOf(first, 'member decl').provenance, 'declared');
    t.is(memberOf(first, 'member decl').plan, 'max');

    // A served round with rate-limit headers: observed.
    const resetSec = Math.floor(Date.now() / 1000) + 86_400;
    server.push({
      sse: 'claude-text.sse',
      headers: readingHeaders('claude', {
        primaryPercent: 20,
        secondaryPercent: 30,
        primaryResetSec: resetSec - 3600,
        secondaryResetSec: resetSec,
      }),
    });
    const turn = await runTurn(m4, session, live, 'observe');
    t.is(turn.status.state, 'completed', turn.status.error);
    const seen = await E(accounts).forSession(session);
    const observed = memberOf(seen, 'member obs');
    t.is(observed.provenance, 'observed');
    t.true(
      observed.windows.some((/** @type {any} */ w) => w.usedPercent === 30),
    );

    // A watcher; one refresh is one batch.
    const subscription = await E(accounts).watch();
    const now = await E(subscription).next();
    const reads = () =>
      server.requests().filter(r => r.path === '/api/oauth/usage').length;
    const readsBefore = reads();
    const refreshed = await E(accounts).refresh(backend);
    t.is(reads() - readsBefore, 2, 'both members read, on demand');
    const batch = await E(subscription).next();
    t.is(batch.rev, now.rev + 1, 'one batch for the refresh');
    t.is(refreshed.rev, batch.rev);
    const afterRefresh = batch.pools.find(
      (/** @type {any} */ p) => p.label === 'Accounts pool',
    );
    t.is(memberOf(afterRefresh, 'member decl').provenance, 'observed');
    t.true(
      memberOf(afterRefresh, 'member decl').windows.some(
        (/** @type {any} */ w) => w.usedPercent === 61,
      ),
      'the usage read (claude-usage.json)',
    );
    await E(subscription).close();

    // The model's part (XC): accountStatus is offered through the session's
    // generic adapter-tool entry, the model calls it, and the next round
    // carries the rendered text as a tool result that is not an error.
    server.push(
      {
        events: claudeEvents({
          toolCalls: [
            { id: 'toolu_account_1', name: 'accountStatus', args: '{}' },
          ],
        }),
      },
      { sse: 'claude-text.sse' },
    );
    const before = posts(server).length;
    const called = await runTurn(m4, session, live, 'tools offered');
    t.is(called.status.state, 'completed', called.status.error);
    const offered = (posts(server)[before]?.json?.tools ?? []).map(
      (/** @type {any} */ tl) => tl.name,
    );
    t.true(offered.includes('accountStatus'), JSON.stringify(offered));
    const answered = posts(server)[before + 1]?.json;
    // The wire names the call by the session's own id (not the provider's),
    // so find the call by its name, then its result by that id.
    /** @type {any[]} */
    const blocks = (answered?.messages ?? []).flatMap((/** @type {any} */ m) =>
      Array.isArray(m.content) ? m.content : [],
    );
    const calls = blocks.filter(
      b => b.type === 'tool_use' && b.name === 'accountStatus',
    );
    t.is(calls.length, 1, 'the call is in the next request');
    const results = blocks.filter(
      b => b.type === 'tool_result' && b.tool_use_id === calls[0]?.id,
    );
    t.is(results.length, 1, 'one result for the call');
    const [result] = results;
    const resultText =
      typeof result.content === 'string'
        ? result.content
        : (result.content ?? []).map((/** @type {any} */ c) => c.text).join('');
    t.not(result.is_error, true, resultText);
    t.true(
      resultText.includes('subscription pool "Accounts pool"'),
      resultText,
    );
    t.true(resultText.includes('Account: member obs (claude)'), resultText);
    t.true(resultText.includes('Account: member decl (claude)'), resultText);
    // Both members were read by the refresh above: each figure says so.
    t.true(resultText.includes('observed: read from the provider'), resultText);
    t.true(resultText.includes('not attributed'), resultText);
    emit({
      metric: 'm4.accounts.toolOffered',
      offered,
      resultUnits: resultText.length,
    });

    // Restart (readings flushed within 5 s): remembered, before any round.
    await delay(6000);
    await m4.state.restart();
    await m4.refresh();
    const accounts2 = await E(m4.subs).accounts();
    const pools = await E(m4.subs).listPools();
    const [samePool] = pools.pools;
    const remembered = await E(accounts2).forBackend(samePool);
    t.truthy(remembered, 'a pool not used since the restart is described');
    t.is(memberOf(remembered, 'member obs').provenance, 'remembered');
    t.is(memberOf(remembered, 'member decl').provenance, 'remembered');
    t.is(posts(server).length, before + 2, 'no round after the restart');
  },
);
