// @ts-check
/** Operator mail, package replies and request settlement through the served factory. */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E, Far } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/guards/session.js';
import {
  textOf as postOfficeTextOf,
  texts as postOfficeTexts,
} from '../../guest/lib/guards/factory.js';
import { limits } from '../../guest/lib/limits.js';
import { gatewayTexts } from '../../resources/agent-host/impl/gateway/protocol.js';
/* eslint-enable import/no-relative-packages */
import { emit } from '../../perf/_harness.mjs';
import { sliceScript } from '../fixtures/scripts/m1a-slice.js';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, round1, sliceTemplate, waitFor } from './_m1a-slice.js';
import { serveGateway, useTestWrappingKey } from './_m3-gateway.js';

takeIntegrationLock(test, 'mail test');

const run = integrationEnabled ? test.serial : test.skip;

/** @type {Awaited<ReturnType<typeof startFromTemplate>> | undefined} */
let state;
/** @type {ReturnType<typeof useTestWrappingKey> | undefined} */
let wrappingKey;
/** @type {any} */
let slice;
/** @type {any} */
let mailbox;
/** @type {any[]} */
let sessions = [];

test.after.always(async () => {
  await state?.cleanup();
  wrappingKey?.remove();
});

/**
 * A text function's output as a pattern, with every number as `\d+`.
 * @param {string} sample
 */
const shapeOf = sample =>
  RegExp(
    `^${sample
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\d+/g, '\\d+')}$`,
  );

run('setup: served state, two sessions, the operator mailbox', async t => {
  t.timeout(4 * 60_000);
  const t0 = performance.now();
  wrappingKey = useTestWrappingKey('mail');
  const template = await sliceTemplate();
  // No `t`: the state outlives this test (cleaned up in `after.always`).
  state = await startFromTemplate(template, {
    secretsKeyFile: wrappingKey.file,
  });
  slice = await makeSlice(state);
  const made = await slice.makeBackend(harden(sliceScript));
  sessions = [
    await slice.createSession(made.backend, 'mail A'),
    await slice.createSession(made.backend, 'mail B'),
  ];
  const operator = await E(slice.harness).getOperator();
  mailbox = await E(operator).getMail();
  t.truthy(mailbox);
  emit({
    metric: 'mail.integration.setup',
    templateBuilt: template.built,
    buildMs: template.buildMs,
    startMs: state.timings.totalMs,
    totalMs: round1(performance.now() - t0),
  });
});

run('addresses describe their sessions; the inbox starts empty', async t => {
  const [a, b] = sessions;
  const address = await E(mailbox).addressOf(a);
  t.deepEqual(await E(address).describe(), {
    title: 'mail A',
    kind: 'session',
  });
  t.deepEqual(await E(E(mailbox).addressOf(b)).describe(), {
    title: 'mail B',
    kind: 'session',
  });
  const page = await E(mailbox).list();
  t.deepEqual(page.messages, []);
  t.is(typeof (await E(mailbox).rev()), 'number');
  await t.throwsAsync(() => E(mailbox).addressOf(slice.factory), {
    message: postOfficeTexts.notASession,
  });
});

run(
  'a package reaches each session vat once and its answer returns',
  async t => {
    const [a, b] = sessions;
    const address = await E(mailbox).addressOf(b);
    const t0 = performance.now();
    const receipt = await E(mailbox).send(
      harden({ to: [a, address], body: 'hello', attachments: [] }),
    );
    const ms = performance.now() - t0;
    const marks = receipt.results.map(
      (/** @type {any} */ result) => result.postmark,
    );
    t.true(marks.every(Number.isSafeInteger));
    t.not(marks[0], marks[1]);
    await waitFor(
      async () => {
        const { messages } = await E(mailbox).list();
        return marks.every((/** @type {number} */ mark) =>
          messages.some(
            (/** @type {any} */ m) => m.inReplyTo === mark && m.body === 'ok.',
          ),
        );
      },
      30_000,
      'both package replies',
    );
    // The same recipient named twice is one delivery with one answer each.
    const twice = await E(mailbox).send(
      harden({ to: [a, a], body: 'twice', attachments: [] }),
    );
    t.true(Number.isSafeInteger(twice.results[0].postmark));
    t.deepEqual(twice.results[0], twice.results[1]);
    emit({ metric: 'mail.integration.send2', ms: round1(ms) });
  },
);

run(
  'an unanswered request is rejected and its key recovers the same handle',
  async t => {
    const [a] = sessions;
    const handle = await E(mailbox).request(
      harden({ to: a, description: 'Which colour?', responseKey: 'colour' }),
    );
    const settled = await E(handle).whenSettled();
    t.like(settled, { state: 'rejected', reason: texts.unansweredRequest });
    t.like(await E(handle).describe(), { state: 'rejected' });
    // A settled rejection is idempotent under its response key.
    const again = await E(mailbox).request(
      harden({ to: a, description: 'Which colour?', responseKey: 'colour' }),
    );
    t.is(again, handle);
    t.like(await E(again).whenSettled(), { state: 'rejected' });
  },
);

run('a recipient the post office did not mint is refused uncalled', async t => {
  let calls = 0;
  const stranger = Far('Stranger', {
    describe: () => {
      calls += 1;
      return harden({ title: 'forged', kind: 'session' });
    },
  });
  const receipt = await E(mailbox).send(
    harden({ to: [stranger, slice.factory], body: 'hi', attachments: [] }),
  );
  t.deepEqual(receipt.results, [
    { refused: postOfficeTexts.notAnAddress },
    { refused: postOfficeTexts.notAnAddress },
  ]);
  t.is(calls, 0, 'the stranger received no call');
  await t.throwsAsync(
    () => E(mailbox).request(harden({ to: stranger, description: 'x' })),
    { message: postOfficeTexts.notAnAddress },
  );
  t.is(calls, 0);
});

run('a form of 32 maximal fields is refused at the mailbox', async t => {
  const [a] = sessions;
  const fields = Array.from({ length: limits.formFields }, (_, i) =>
    harden({
      name: `f${i}`.padEnd(limits.formFieldNameUnits, 'x'),
      kind: 'string',
      description: 'd'.repeat(limits.formFieldDescriptionUnits),
      default: JSON.stringify('v'.repeat(limits.formDefaultUnits - 2)),
    }),
  );
  await t.throwsAsync(
    () =>
      E(mailbox).form(harden({ to: a, description: 'Fill this in', fields })),
    { message: shapeOf(postOfficeTextOf.envelopeTooLarge(1, 1)) },
  );
});

run('a deleted session: mail to its address answers recipientLost', async t => {
  const made = await slice.makeBackend(harden(sliceScript));
  const doomed = await slice.createSession(made.backend, 'mail doomed');
  const address = await E(mailbox).addressOf(doomed);
  await E(slice.factory).deleteSession(doomed);
  const receipt = await E(mailbox).send(
    harden({ to: [address], body: 'anyone?', attachments: [] }),
  );
  t.deepEqual(receipt.results, [
    { refused: postOfficeTextOf.recipientLost('mail doomed') },
  ]);
  // The address is still recognised and still describes the row.
  t.like(await E(address).describe(), { title: 'mail doomed' });
});

run(
  'gateway: getMail().send with an attachment; an unexpected field is refused',
  async t => {
    if (state === undefined) throw Error('setup failed');
    const made = await slice.makeBackend(harden(sliceScript));
    // The page reaches the backend through its own factory (a control-client
    // presence would be a page-made object to the gateway).
    await E(slice.harness).configure(harden({ backends: [made.backend] }));
    const gateway = await serveGateway(state, {
      secretsKeyFile: wrappingKey?.file,
    });
    const { powers } = await gateway.connect();
    const factory = await E(powers.operator).getFactory();
    const [preset] = await E(factory).listPresets();
    const [backend] = await E(factory).listBackends();
    const session = await E(factory).createSession(
      harden({ title: 'mail page', preset, backend, at: Date.now() }),
    );
    const pageMail = await E(powers.operator).getMail();
    const receipt = await E(pageMail).send(
      harden({
        to: [session],
        body: 'with an attachment',
        attachments: [harden({ label: 'preset', value: preset })],
      }),
    );
    t.true(Number.isSafeInteger(receipt.results[0].postmark));
    await t.throwsAsync(
      () =>
        E(pageMail).send(
          harden({
            to: [session],
            body: 'x',
            attachments: [],
            inventedDraftKey: true,
          }),
        ),
      { message: gatewayTexts.unexpectedField },
    );
    // Still served after the refusal.
    t.true(
      Number.isSafeInteger(
        (
          await E(pageMail).send(
            harden({ to: [session], body: 'again', attachments: [] }),
          )
        ).results[0].postmark,
      ),
    );
  },
);
