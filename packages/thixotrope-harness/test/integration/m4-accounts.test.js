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
 * - which tools the model is offered on a pool session (an observation:
 *   `accountStatus` is not offered yet, see below);
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

    // The accountStatus tool as the model sees it. Observation only: the
    // session offers the model its tool-table entries (`toolSetFor`: echo,
    // exec), so an adapter tool in `TurnPorts.tools` is neither offered nor
    // executed until the tool table passes adapter tools through (M5's
    // file; reported to the PM). The rendered text itself is W4.5's
    // adapter test; the tool through the ports is W4.6's.
    server.push({ sse: 'claude-text.sse' });
    const before = posts(server).length;
    const plain = await runTurn(m4, session, live, 'tools offered');
    t.is(plain.status.state, 'completed', plain.status.error);
    const offered = (posts(server)[before]?.json?.tools ?? []).map(
      (/** @type {any} */ tl) => tl.name,
    );
    emit({ metric: 'm4.accounts.toolOffered', offered });

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
    t.is(posts(server).length, before + 1, 'no round after the restart');
  },
);
