// @ts-check
/**
 * M4 acceptance 16 and kill point K-1 through the daemon (W4.8;
 * `designs/m4-interfaces.md` 10, 14, 17), from the `m4` template:
 *
 * - The `subscriptions` provisioning step (H-8), run twice with the same
 *   options, is a no-op the second time (one pool, the same Backend).
 * - A member label bound to another Secret is refused (R8-31) until that
 *   member is retired.
 * - A revoked Secret is never rewritten by provisioning (R8-38): its
 *   generation and state stay as they were.
 * - K-1: SIGKILL right after `makePool` was sent; after the restart
 *   `makePool` again answers a Backend that works, and `listPools` shows
 *   one pool of that label.
 *
 * The step is called directly from `provisionSteps` (`makeProvision` does
 * not pass `subscriptions` options yet: a PM change, see the W4.6 report).
 *
 *   corepack yarn test:integration test/integration/m4-provision.test.js
 */
import '../unit/_m1a-prelude.js';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { m4Texts } from '../../guest/lib/texts-m4.js';
/* eslint-enable import/no-relative-packages */
import { emit } from '../../perf/_harness.mjs';
import { integrationEnabled, takeIntegrationLock } from '../template/index.js';
import { startFakeSubscriptionServer } from '../fixtures/fake-subscription-server.mjs';
import {
  CLAUDE_MODEL,
  credentialText,
  fakeDefaults,
  killAndRestart,
  listPools,
  makeValueSecret,
  openSession,
  runTurn,
  startM4,
  subscriptionsStep,
  tokenOf,
} from './_m4.js';

takeIntegrationLock(test, 'm4 provision test');

const run = integrationEnabled ? test.serial : test.skip;

run(
  'acceptance 16 and K-1: provisioning is idempotent, R8-31 and R8-38 hold, makePool after a SIGKILL',
  async t => {
    t.timeout(4 * 60_000);
    const m4 = await startM4(t, 'provision');
    const server = await startFakeSubscriptionServer({
      defaults: fakeDefaults,
    });
    t.teardown(() => server.close());

    const one = await makeValueSecret(
      m4,
      'provisioned one',
      credentialText('claude', { accessToken: tokenOf('one') }),
    );
    const two = await makeValueSecret(
      m4,
      'provisioned two',
      credentialText('claude', { accessToken: tokenOf('two') }),
    );
    const options = {
      subscriptions: [
        {
          kind: 'claude-pool',
          label: 'Provisioned pool',
          members: [
            {
              label: 'p-one',
              provider: 'claude',
              secretLabel: 'provisioned one',
            },
            {
              label: 'p-two',
              provider: 'claude',
              secretLabel: 'provisioned two',
            },
          ],
          baseUrl: server.url,
        },
      ],
    };
    const step = subscriptionsStep();
    const first = await step.run({
      client: m4.state.client,
      options: /** @type {any} */ (options),
    });
    t.false(first.skipped);
    const second = await step.run({
      client: m4.state.client,
      options: /** @type {any} */ (options),
    });
    t.true(second.skipped, 'the second run changes nothing');
    const pools = await listPools(m4);
    t.is(pools.length, 1);
    const backends = await E(m4.slice.factory).listBackends();
    t.is(backends.filter((/** @type {any} */ b) => b === pools[0]).length, 1);

    // The pool serves.
    const { session, live } = await openSession(m4, pools[0], {
      modelId: CLAUDE_MODEL,
    });
    server.push({ sse: 'claude-text.sse' });
    const served = await runTurn(m4, session, live, 'provisioned');
    t.is(served.status.state, 'completed', served.status.error);

    // R8-31: the label p-one is bound to Secret one.
    const members = (await E(m4.subs).listMembers()).members;
    const infos = await Promise.all(
      members.map((/** @type {any} */ m) => E(m).describe()),
    );
    const pOne = members[infos.findIndex(i => i.label === 'p-one')];
    await t.throwsAsync(
      () =>
        E(m4.subs).makeMember(
          harden({
            provider: 'claude',
            label: 'p-one',
            credential: two.secret,
          }),
        ),
      { message: m4Texts.memberConflict },
    );
    await E(pOne).retire();
    const rebound = await E(m4.subs).makeMember(
      harden({ provider: 'claude', label: 'p-one', credential: two.secret }),
    );
    t.not(rebound, pOne, 'a new member after the retirement');

    // R8-38: a revoked Secret is not rewritten by provisioning.
    await E(one.secret).revoke();
    const revokedBefore = await E(one.secret).describe();
    await step
      .run({ client: m4.state.client, options: /** @type {any} */ (options) })
      .catch(() => undefined);
    const revokedAfter = await E(one.secret).describe();
    t.is(revokedAfter.state, 'revoked');
    t.is(revokedAfter.generation, revokedBefore.generation);

    // K-1: SIGKILL right after makePool was sent; again after the restart.
    const three = await makeValueSecret(
      m4,
      'provisioned three',
      credentialText('claude', { accessToken: tokenOf('three') }),
    );
    const member = await E(m4.subs).makeMember(
      harden({
        provider: 'claude',
        label: 'p-three',
        credential: three.secret,
      }),
    );
    const spec = {
      kind: 'claude-pool',
      label: 'K-1 pool',
      members: [member],
      baseUrl: server.url,
    };
    const sent = E(m4.subs)
      .makePool(harden(spec))
      .catch(() => 'broken');
    const timings = await killAndRestart(m4);
    emit({
      metric: 'm4.restart.k1',
      sentAnswer: String(await sent),
      ...timings,
    });
    const secretsAfter = (await E(m4.secrets).list()).secrets;
    const labels = await Promise.all(
      secretsAfter.map((/** @type {any} */ s) => E(s).describe()),
    );
    const threeAgain =
      secretsAfter[labels.findIndex(i => i.label === 'provisioned three')];
    const memberAgain = await E(m4.subs).makeMember(
      harden({ provider: 'claude', label: 'p-three', credential: threeAgain }),
    );
    const k1 = await E(m4.subs).makePool(
      harden({ ...spec, members: [memberAgain] }),
    );
    const k1Again = await E(m4.subs).makePool(
      harden({ ...spec, members: [memberAgain] }),
    );
    t.is(k1Again, k1, 'idempotent');
    const all = await listPools(m4);
    const described = await Promise.all(
      all.map((/** @type {any} */ p) => E(p).describe()),
    );
    t.is(described.filter(d => d.label === 'K-1 pool').length, 1);
    const k1Session = await openSession(m4, k1, { modelId: CLAUDE_MODEL });
    server.push({ sse: 'claude-text.sse' });
    const k1Turn = await runTurn(m4, k1Session.session, k1Session.live, 'k1');
    t.is(k1Turn.status.state, 'completed', k1Turn.status.error);
  },
);
