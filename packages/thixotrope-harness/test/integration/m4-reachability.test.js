// @ts-check
/**
 * M4 acceptance 5, part (b) of the CC-060 workaround through the daemon
 * (W4.8; `designs/m4-interfaces.md` 11, 19), against the fake subscription
 * server on 127.0.0.1, from the `m4` template: a session on a pool backend
 * runs a full turn in which the model calls `accountStatus`. Before and
 * after it, the daemon's `reachability()` report (origin granularity) shows
 * that the session vat and its exec vat hold references only into the
 * factory vat, the agent-host manager vat, the session's own exec vat (and
 * each other), never into the workspace vat (which holds the inventory and
 * so `agentHostAdmin`), another session or another session's exec vat, and
 * that the turn added no new origin.
 *
 * What origin granularity cannot tell apart (every M4 admin object lives in
 * the manager vat, which the session reaches legitimately through its
 * Backend) is part (a), `test/unit/m4-reachability.test.js`. Counting the
 * manager-origin rows a session holds needs the hub's per-row export names
 * (CC-060); the report gives edges, so that count is not asserted here.
 *
 *   corepack yarn test:integration test/integration/m4-reachability.test.js
 */
import '../unit/_m1a-prelude.js';

import test from 'ava';

import { E } from '@endo/far';

import { integrationEnabled, takeIntegrationLock } from '../template/index.js';
import {
  claudeEvents,
  startFakeSubscriptionServer,
} from '../fixtures/fake-subscription-server.mjs';
import {
  CLAUDE_MODEL,
  credentialText,
  fakeDefaults,
  makePool,
  makeValueSecret,
  openSession,
  runTurn,
  startM4,
  tokenOf,
} from './_m4.js';

takeIntegrationLock(test, 'm4 reachability test');

const run = integrationEnabled ? test.serial : test.skip;

run(
  'acceptance 5 (b): session and exec vats hold references only into the expected origins',
  async t => {
    t.timeout(4 * 60_000);
    const m4 = await startM4(t, 'reach');
    const server = await startFakeSubscriptionServer({
      defaults: fakeDefaults,
    });
    t.teardown(() => server.close());
    const { secret } = await makeValueSecret(
      m4,
      'reach member',
      credentialText('claude', { accessToken: tokenOf('reach') }),
    );
    const { backend } = await makePool(m4, {
      kind: 'claude-pool',
      label: 'Reach pool',
      members: [{ label: 'reach member', credential: secret }],
      baseUrl: server.url,
    });
    // Two sessions: the second is the "other session" none may reach.
    const one = await openSession(m4, backend, { modelId: CLAUDE_MODEL });
    const other = await openSession(m4, backend, { modelId: CLAUDE_MODEL });
    const keyOne = (await E(one.session).getInfo()).key;
    const keyOther = (await E(other.session).getInfo()).key;
    const admin = await m4.state.connect();
    t.teardown(() => admin.close());

    const holdings = async () => {
      const report = await admin.call('reachability');
      /** @type {Map<string, string>} */
      const labelOf = new Map(
        report.workers.map((/** @type {any} */ w) => [
          w.workerId,
          w.debugLabel ?? '?',
        ]),
      );
      /** @param {string} id */
      const name = id => labelOf.get(id) ?? id;
      /** @type {Map<string, Set<string>>} */
      const out = new Map();
      for (const { holder, target } of report.references) {
        const from = name(holder);
        out.set(from, new Set([...(out.get(from) ?? []), name(target)]));
      }
      return { out, labels: [...labelOf.values()] };
    };

    const check = async (/** @type {string} */ when) => {
      const { out, labels } = await holdings();
      t.log(`${when}: workers ${labels.join(' | ')}`);
      for (const [holder, targets] of out)
        t.log(`${when}: ${holder} -> ${[...targets].join(', ')}`);
      const sessionLabel = `session ${keyOne}`;
      const forbidden = [
        `session ${keyOther}`,
        ...labels.filter(l => /workspace|^w$/i.test(l)),
      ];
      for (const [holder, targets] of out) {
        if (holder === sessionLabel || /exec/.test(holder)) {
          for (const target of targets)
            t.false(
              forbidden.includes(target),
              `${when}: ${holder} holds into ${target}`,
            );
        }
      }
      return out.get(sessionLabel) ?? new Set();
    };

    const before = await check('before');
    server.push(
      {
        events: claudeEvents({
          toolCalls: [{ id: 'toolu_reach', name: 'accountStatus', args: '{}' }],
          stopReason: 'tool_use',
        }),
      },
      { sse: 'claude-text.sse' },
    );
    const turn = await runTurn(m4, one.session, one.live, 'status');
    t.is(turn.status.state, 'completed', turn.status.error);
    const after = await check('after');
    t.deepEqual(
      [...after].filter(target => !before.has(target)),
      [],
      'the turn with accountStatus adds no origin to the session vat',
    );
  },
);
