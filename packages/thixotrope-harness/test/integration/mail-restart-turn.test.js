// @ts-check
import '../unit/_m1a-prelude.js';
import test from 'ava';
import { E } from '@endo/far';
import {
  integrationEnabled,
  killStrays,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, sliceTemplate, waitFor } from './_m1a-slice.js';
import { sliceScript } from '../fixtures/scripts/m1a-slice.js';

takeIntegrationLock(test, 'interrupted mail turn');
const run = integrationEnabled ? test.serial : test.skip;

run(
  'an interrupted package returns a single error reply after the recipient wakes',
  async t => {
    t.timeout(4 * 60_000);
    const state = await startFromTemplate(await sliceTemplate(), { t });
    let slice = await makeSlice(state);
    const made = await slice.makeBackend(harden(sliceScript));
    const session = await slice.createSession(made.backend, 'Receiver');
    const { key } = await E(session).getInfo();
    const mailbox = await E(E(slice.harness).getOperator()).getMail();
    const receipt = await E(mailbox).send(
      harden({ to: [session], body: 'stall', attachments: [] }),
    );
    const { postmark } = receipt.results[0];
    t.true(Number.isSafeInteger(postmark));
    await waitFor(
      () => made.log().length > 0,
      30_000,
      'the recipient provider round',
    );
    await state.kill();
    await killStrays(state.root);
    await state.restart();
    slice = await slice.refresh();
    const restored = await E(slice.factory).findSession(key);
    await slice.submit(restored, 'hi');
    const mail = await E(E(slice.harness).getOperator()).getMail();
    const replies = await waitFor(
      async () => {
        const { messages } = await E(mail).list();
        const found = messages.filter(
          (/** @type {any} */ m) => m.inReplyTo === postmark,
        );
        return found.length > 0 && found;
      },
      30_000,
      'the interrupted turn reply',
    );
    t.is(replies.length, 1);
    t.regex(replies[0].body, /^Error:/);
  },
);
