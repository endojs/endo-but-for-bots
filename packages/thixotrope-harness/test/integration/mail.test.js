// @ts-check
/**
 * Mail through a real daemon (designs/m9-interfaces.md 3.1, 4.1, 4.5, 8.1),
 * on the m1a state template with the real factory and session programs:
 * the operator's mailbox (`Operator.getMail()`), the post office in the
 * factory vat, and deliveries into real session vats.
 *
 * What the tree serves today: the factory's half of mail (post office,
 * operator mailbox, subagent tree) is wired; the session's `inbox` and
 * `subagents` runtime parts and their tool entries are built but not
 * registered (the session program would be over its limit with them,
 * m9-interfaces.md D-M9-19), so `SessionInternal.deliverMail` answers the
 * not-built text. This file proves the delivery path up to that answer:
 *
 * - addresses: `addressOf(session)` describes the session; the operator
 *   reaches a session by its Session object or its address;
 * - a package reaches the session vat's `deliverMail` (two recipients, one
 *   answer each), and the vat's answer comes back in the receipt;
 * - a request whose delivery is refused settles its handle `failed`, and
 *   its `responseKey` is free again (R3-216);
 * - a recipient the post office did not mint is refused without a call
 *   (acceptance 6, the stranger counts calls); a daemon object that is not
 *   an address likewise;
 * - a form of 32 maximal fields is refused at the mailbox with
 *   `envelopeTooLarge` (acceptance 13, probe "a form of 32 maximal
 *   fields");
 * - a deleted session's address answers `recipientLost` (acceptance 18);
 * - the gateway: a signed-in CapTP client calls `getMail().send` with an
 *   attachment, and a draft with an unexpected field is refused before
 *   decode (acceptance 17).
 *
 * Acceptance items that need the registered parts (1-3, 5-7 in full, 8-10,
 * 12-14, 18's blob release) are listed in milestones.md under M9's outcome.
 *
 *   THIX_AGENT=<lane> corepack yarn test:integration test/integration/mail.test.js
 */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E, Far } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/guards/session.js';
import {
  postOfficeTextOf,
  postOfficeTexts,
} from '../../guest/lib/guards/post-office.js';
import { mailLimits } from '../../guest/lib/mail-limits.js';
import { gatewayTexts } from '../../resources/agent-host/impl/gateway/protocol.js';
/* eslint-enable import/no-relative-packages */
import { emit } from '../../perf/_harness.mjs';
import { sliceScript } from '../fixtures/scripts/m1a-slice.js';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, round1, sliceTemplate } from './_m1a-slice.js';
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

/** The not-built answer a session vat without its inbox part gives. */
const notBuilt = harden({ refused: texts.notBuiltYet });

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
    // One answer per recipient, each the session vat's own: the inbox part
    // is not registered in the session program yet.
    t.deepEqual(receipt.results, [notBuilt, notBuilt]);
    // The same recipient named twice is one delivery with one answer each.
    const twice = await E(mailbox).send(
      harden({ to: [a, a], body: 'twice', attachments: [] }),
    );
    t.deepEqual(twice.results, [notBuilt, notBuilt]);
    emit({ metric: 'mail.integration.send2', ms: round1(ms) });
  },
);

run('a refused request fails its handle and frees its responseKey', async t => {
  const [a] = sessions;
  const handle = await E(mailbox).request(
    harden({ to: a, description: 'Which colour?', responseKey: 'colour' }),
  );
  const settled = await E(handle).whenSettled();
  t.like(settled, { state: 'failed', reason: texts.notBuiltYet });
  t.like(await E(handle).describe(), { state: 'failed' });
  // R3-216: a failed request does not hold its key; a new one is made.
  const again = await E(mailbox).request(
    harden({ to: a, description: 'Which colour?', responseKey: 'colour' }),
  );
  t.not(again, handle);
  t.like(await E(again).whenSettled(), { state: 'failed' });
});

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
  const fields = Array.from({ length: mailLimits.formFields }, (_, i) =>
    harden({
      name: `f${i}`.padEnd(mailLimits.formFieldNameUnits, 'x'),
      kind: 'string',
      description: 'd'.repeat(mailLimits.formFieldDescriptionUnits),
      default: JSON.stringify('v'.repeat(mailLimits.formDefaultUnits - 2)),
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
    t.deepEqual(receipt.results, [notBuilt]);
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
    t.deepEqual(
      (
        await E(pageMail).send(
          harden({ to: [session], body: 'again', attachments: [] }),
        )
      ).results,
      [notBuilt],
    );
  },
);
