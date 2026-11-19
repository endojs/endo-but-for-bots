// @ts-check
import '../unit/_m1a-prelude.js';
import test from 'ava';
import { E } from '@endo/far';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, waitFor } from './_m1a-slice.js';
import {
  environmentsTemplate,
  startEnvironmentSession,
} from './_environments.js';
import { sliceScript } from '../fixtures/scripts/m1a-slice.js';

takeIntegrationLock(test, 'mail delivered while stopped');
const run = integrationEnabled ? test.serial : test.skip;

run(
  'a stopped session records a package and wakes its mail turn after resume',
  async t => {
    t.timeout(4 * 60_000);
    const state = await startFromTemplate(await environmentsTemplate(), { t });
    const slice = await makeSlice(state);
    const made = await slice.makeBackend(harden(sliceScript));
    const session = await startEnvironmentSession(slice, made.backend);
    await E(session).emergencyStop();
    const mailbox = await E(E(slice.harness).getOperator()).getMail();
    const { results } = await E(mailbox).send(
      harden({ to: [session], body: 'hi', attachments: [] }),
    );
    const { postmark } = results[0];
    t.true(Number.isSafeInteger(postmark));
    t.is((await E(session).getExecutionState()).state, 'stopped');
    t.is(made.log().length, 0, 'the stopped session has opened no round');
    await E(session).resume();
    const reply = await waitFor(
      async () => {
        const { messages } = await E(mailbox).list();
        return messages.find(
          (/** @type {any} */ m) => m.inReplyTo === postmark,
        );
      },
      30_000,
      'the resumed mail turn',
    );
    t.is(reply.body, 'Hello!');
  },
);
