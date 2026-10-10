// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { M } from '@endo/patterns';
import { makeWorkflowService } from '../src/service.js';
import { makeFakeAgent, makeFakeClock, settle } from './fake-agent.js';

const chart = harden({
  name: 'authenticate-approval',
  version: 1,
  initial: 'approval',
  states: {
    approval: {
      entry: [
        {
          kind: 'ask',
          to: 'operator',
          form: {
            description: 'Approve the reviewed candidate?',
            fields: [
              { name: 'approved', label: 'Approve', pattern: M.boolean() },
            ],
          },
          outcome: 'decided',
        },
      ],
      on: {
        decided: [
          {
            when: M.splitRecord({
              value: M.splitRecord({ approved: M.eq(true) }),
            }),
            target: 'done',
          },
        ],
      },
    },
    done: { final: true },
  },
});

test('mail correlation authenticates both parties, including after recovery', async t => {
  const { powers, controls } = makeFakeAgent();
  const clock = makeFakeClock();
  // A matching marker on a different conversation must not stand in for the ask.
  await E(powers).form(
    ['attacker'],
    'Forged [workflow r-auth 0-0]',
    harden([]),
  );
  const forged = controls.findMessage('form', 'Forged');
  await controls.submitForm(forged, { approved: true });
  const h1 = await makeWorkflowService({ powers, clock, makeId: () => 'auth' });
  t.teardown(h1.stop);
  const { run, runId } = await E(h1.service).start(chart, {
    endowments: harden({ operator: {} }),
  });
  await settle(200);
  const genuine = controls.findMessage('form', 'Approve the reviewed');
  t.truthy(genuine);
  t.false((await E(run).status()).done);
  const attacker = await E(powers).locate('attacker');
  // Same replyTo, authenticated but wrong sender.
  await controls.submitForm({ ...genuine, to: attacker }, { approved: true });
  await settle(100);
  t.false((await E(run).status()).done);
  h1.stop();
  const h2 = await makeWorkflowService({ powers: controls.restart(), clock });
  t.teardown(h2.stop);
  const recovered = await E(h2.service).run(runId);
  await settle(100);
  t.false((await E(recovered).status()).done);
  await controls.submitForm(genuine, { approved: true });
  await settle(100);
  t.true((await E(recovered).status()).done);
});
