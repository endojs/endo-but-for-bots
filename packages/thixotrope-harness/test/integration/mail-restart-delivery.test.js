// @ts-check
/** Reconnect to the same mailbox and request after a supervisor SIGKILL. */
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
  t.like(outcome, { state: 'rejected', reason: texts.unansweredRequest });
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

  const again = await E(slice.factory).findSession(key);
  const address = await E(mailbox).addressOf(again);
  t.deepEqual(await E(address).describe(), {
    title: 'mail kept',
    kind: 'session',
  });
  // The settled request remains available by its response key.
  const second = await E(mailbox).request(
    harden({ to: again, description: 'After the kill', responseKey: 'k1' }),
  );
  t.like(await E(second).whenSettled(), { state: 'rejected' });

  const t1 = performance.now();
  const receipt = await E(mailbox).send(
    harden({ to: [address], body: 'after', attachments: [] }),
  );
  const firstPostMs = performance.now() - t1;
  t.true(Number.isSafeInteger(receipt.results[0].postmark));
  emit({
    metric: 'mail.restart.serve',
    restartMs: round1(restartMs),
    firstPostMs: round1(firstPostMs),
    templateBuilt: template.built,
  });
});
