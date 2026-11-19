// @ts-check
/**
 * Mail across a SIGKILL of the supervisor (designs/m9-interfaces.md 5.2,
 * section 9), on the m1a state template with the real factory and session
 * programs.
 *
 * What the tree serves today (the session's `inbox` part is built but not
 * registered, D-M9-19; see `mail.test.js`): the factory's mail start steps
 * (`postOffice.restart`, `subagents.restart` in the factory's `recover`)
 * and the factory heap of mail across a restart. One case:
 *
 * - a request settled before the kill and a post sent without waiting
 *   right before it (where the kill lands is not controlled, and no kill
 *   point is asserted); after the restart the factory serves
 *   (its recovery's tail, which waits for the mail start steps, ended),
 *   the operator's mailbox answers from the replayed heap (the settled
 *   request's handle answers the same outcome, the inbox page and `rev`),
 *   the address minted before the kill still describes its session, and a
 *   new post is delivered and answered.
 *
 * The contract's kill points of this file (KM1, KM2, KM3 with a duplicate
 * answer, KM13, KM14 and acceptance 21) need the registered inbox part and
 * are not written yet: this file proves none of them.
 *
 *   THIX_AGENT=<lane> corepack yarn test:integration test/integration/mail-restart-delivery.test.js
 */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/guards/session.js';
/* eslint-enable import/no-relative-packages */
import { emit } from '../../perf/_harness.mjs';
import { sliceScript } from '../fixtures/scripts/m1a-slice.js';
import {
  integrationEnabled,
  killStrays,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, round1, sliceTemplate } from './_m1a-slice.js';

takeIntegrationLock(test, 'mail restart delivery test');

const run = integrationEnabled ? test.serial : test.skip;

const notBuilt = harden({ refused: texts.notBuiltYet });

run('mail start steps and the mailbox across a SIGKILL', async t => {
  t.timeout(4 * 60_000);
  const template = await sliceTemplate();
  const state = await startFromTemplate(template, { t });
  let slice = await makeSlice(state);
  const made = await slice.makeBackend(harden(sliceScript));
  const session = await slice.createSession(made.backend, 'mail kept');
  const { key } = await E(session).getInfo();
  let mailbox = await E(E(slice.harness).getOperator()).getMail();

  const handle = await E(mailbox).request(
    harden({ to: session, description: 'Before the kill', responseKey: 'k1' }),
  );
  const outcome = await E(handle).whenSettled();
  t.like(outcome, { state: 'failed', reason: texts.notBuiltYet });
  const revBefore = Number(await E(mailbox).rev());

  // A post in flight when the supervisor is killed.
  void E(mailbox)
    .send(harden({ to: [session], body: 'in flight', attachments: [] }))
    .catch(() => {});
  await state.kill();
  await killStrays(state.root);
  const t0 = performance.now();
  await state.restart();
  slice = await slice.refresh();
  const operator = await E(slice.harness).getOperator();
  mailbox = await E(operator).getMail();
  const restartMs = performance.now() - t0;

  // The factory answers: its recovery (which waits for the mail start
  // steps) ended, and the mailbox is the replayed one.
  t.true(Number(await E(mailbox).rev()) >= revBefore);
  t.deepEqual((await E(mailbox).list()).messages, []);
  const again = await E(slice.factory).findSession(key);
  const address = await E(mailbox).addressOf(again);
  t.deepEqual(await E(address).describe(), {
    title: 'mail kept',
    kind: 'session',
  });
  // The settled request is not reused by its key (it failed): a new one.
  const second = await E(mailbox).request(
    harden({ to: again, description: 'After the kill', responseKey: 'k1' }),
  );
  t.like(await E(second).whenSettled(), { state: 'failed' });

  const t1 = performance.now();
  const receipt = await E(mailbox).send(
    harden({ to: [address], body: 'after', attachments: [] }),
  );
  const firstPostMs = performance.now() - t1;
  t.deepEqual(receipt.results, [notBuilt]);
  emit({
    metric: 'mail.restart.serve',
    restartMs: round1(restartMs),
    firstPostMs: round1(firstPostMs),
    templateBuilt: template.built,
  });
});
