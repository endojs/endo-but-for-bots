// @ts-check
// The typed-request tools (guest/session/tools/requests.js;
// designs/m9-interfaces.md 3.2, 4.5, 11, D-M9-17; R3-34, R3-217):
// `resolveRequest`, `rejectRequest`, `submitForm` over fake RequestTickets
// from the real guard and a stand-in inbox part. Message numbers are
// decimal strings or integers; a form's values are read with a closed spec
// from its fields, defaults applied, kinds checked, decimals sent as digit
// strings; the inbox marks the request settled before the ticket is called.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { textOf } from '../../guest/lib/interfaces.js';
import {
  mailTexts,
  mailTextOf,
  requestToolNames,
} from '../../guest/lib/guards/mail.js';
import { mailLimits } from '../../guest/lib/mail-limits.js';
import { requestToolEntries } from '../../guest/session/tools/requests.js';
/* eslint-enable import/no-relative-packages */
import {
  makeAddress,
  makeContext,
  makeInbox,
  makeOutbox,
  makeTicket,
} from './_mail-tool-fakes.js';

/**
 * @param {any} context
 * @param {string} name
 * @param {any} args
 */
const run = (context, name, args) => {
  const found = requestToolEntries.find(e => e.name === name);
  if (found === undefined) throw Error(`no ${name}`);
  return found.execute(
    harden({
      opId: 't1/r0/c0',
      args: typeof args === 'string' ? args : JSON.stringify(args),
      turnId: 't1',
    }),
    {},
    context,
  );
};

const from = makeAddress('Workflow');

const fields = harden([
  { name: 'title', kind: 'string', description: 'A title' },
  { name: 'count', kind: 'integer' },
  { name: 'amount', kind: 'decimal' },
  { name: 'urgent', kind: 'boolean', default: 'false' },
]);

const setup = () => {
  const request = makeTicket('request');
  const form = makeTicket('form');
  const fakeInbox = makeInbox([
    {
      number: 1,
      type: 'request',
      from,
      ticket: request.ticket,
      settled: false,
      state: 'waiting',
    },
    {
      number: 2,
      type: 'form',
      from,
      ticket: form.ticket,
      fields,
      settled: false,
      state: 'waiting',
    },
    { number: 3, type: 'package', from, state: 'kept' },
    { number: 4, type: 'request', from, state: 'kept', imported: true },
  ]);
  const { context } = makeContext({
    outbox: makeOutbox().outbox,
    inbox: fakeInbox.inbox,
  });
  return { context, request, form, fakeInbox };
};

test('the three entries in requestToolNames order, guest site, offered only with an Outbox', t => {
  t.deepEqual(
    requestToolEntries.map(e => e.name),
    [...requestToolNames],
  );
  for (const e of requestToolEntries) {
    t.is(e.site, 'guest');
    t.true(e.available({}, { mail: makeOutbox().outbox }));
    t.false(e.available({}, {}));
    t.notThrows(() => JSON.parse(e.describe().parameters));
  }
});

test('resolveRequest answers the ticket with the JSON text; the inbox settles first', async t => {
  const { context, request, fakeInbox } = setup();
  const outcome = await run(
    context,
    'resolveRequest',
    '{"messageNumber":"1","value":{"ok":[1,2]}}',
  );
  t.deepEqual(outcome, { status: 'ok', text: mailTexts.requestAnswered });
  t.deepEqual(request.calls, [['answer', { json: '{"ok":[1,2]}' }]]);
  t.deepEqual(fakeInbox.log, [
    ['settleRequest', 1],
    ['settled', 1, true],
  ]);
  // Settled already: the ticket is called again and its refusal forwarded.
  request.state.closed = true;
  const again = await run(context, 'resolveRequest', {
    messageNumber: 1,
    value: 2,
  });
  t.deepEqual(again, { status: 'failed', text: 'closed ticket' });
});

test('a ticket that refuses the answer leaves the request open to retry', async t => {
  const { context, request, fakeInbox } = setup();
  request.state.closed = true;
  const refused = await run(context, 'resolveRequest', {
    messageNumber: 1,
    value: 1,
  });
  t.deepEqual(refused, { status: 'failed', text: 'closed ticket' });
  t.deepEqual(fakeInbox.log, [
    ['settleRequest', 1],
    ['settled', 1, false],
  ]);
  request.state.closed = false;
  const retried = await run(context, 'resolveRequest', {
    messageNumber: 1,
    value: 2,
  });
  t.deepEqual(retried, { status: 'ok', text: mailTexts.requestAnswered });
  t.deepEqual(fakeInbox.log.slice(2), [
    ['settleRequest', 1],
    ['settled', 1, true],
  ]);
});

test('resolveRequest and rejectRequest refusals before any ticket call', async t => {
  const { context, request } = setup();
  const cases = [
    [{ messageNumber: 'one', value: 1 }, mailTexts.expectedDecimal],
    [{ messageNumber: '1.5', value: 1 }, mailTexts.expectedDecimal],
    [{ messageNumber: '9', value: 1 }, mailTexts.noSuchMessage],
    [{ messageNumber: 3, value: 1 }, mailTexts.expectedRequest],
    [{ messageNumber: '2', value: 1 }, mailTexts.expectedRequest],
    [{ messageNumber: '4', value: 1 }, mailTexts.imported],
    [
      { messageNumber: '1', value: 'x'.repeat(mailLimits.requestAnswerBytes) },
      mailTextOf.answerTooLarge(
        mailLimits.requestAnswerBytes + 2,
        mailLimits.requestAnswerBytes,
      ),
    ],
    [
      { messageNumber: '1' },
      textOf.argumentsNotJson('argument "value" is required'),
    ],
  ];
  await null;
  for (const [args, text] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await run(context, 'resolveRequest', args);
    t.deepEqual(
      outcome,
      { status: 'failed', text },
      JSON.stringify(args).slice(0, 60),
    );
  }
  t.deepEqual(
    await run(context, 'rejectRequest', { messageNumber: '4', reason: 'no' }),
    { status: 'failed', text: mailTexts.imported },
  );
  t.deepEqual(request.calls, []);
});

test('rejectRequest answers the ticket with the reason', async t => {
  const { context, request } = setup();
  const outcome = await run(context, 'rejectRequest', {
    messageNumber: 1,
    reason: 'out of scope',
  });
  t.deepEqual(outcome, { status: 'ok', text: mailTexts.requestRejected });
  t.deepEqual(request.calls, [['answer', { rejected: 'out of scope' }]]);
});

test('submitForm: kinds checked, defaults applied, decimals as digit strings', async t => {
  const { context, form } = setup();
  const outcome = await run(context, 'submitForm', {
    messageNumber: '2',
    values: { title: 'Q3 "plan"', count: 3, amount: '00120' },
  });
  t.deepEqual(outcome, { status: 'ok', text: mailTexts.formSubmitted });
  t.deepEqual(form.calls, [
    [
      'submit',
      [
        { name: 'title', json: '"Q3 \\"plan\\""' },
        { name: 'count', json: '3' },
        { name: 'amount', json: '"00120"' },
        { name: 'urgent', json: 'false' },
      ],
    ],
  ]);
  const numeric = await run(context, 'submitForm', {
    messageNumber: 2,
    values: { title: 't', count: -4, amount: 7, urgent: true },
  });
  t.is(numeric.status, 'ok');
  t.deepEqual(form.calls[1][1].slice(1), [
    { name: 'count', json: '-4' },
    { name: 'amount', json: '"7"' },
    { name: 'urgent', json: 'true' },
  ]);
});

test('submitForm refusals: kind, missing, unknown field, not a form', async t => {
  const { context, form } = setup();
  const base = { title: 't', count: 1, amount: '1' };
  const cases = [
    [{ ...base, count: '1' }, mailTextOf.formFieldKind('count', 'integer')],
    [{ ...base, count: 1.5 }, mailTextOf.formFieldKind('count', 'integer')],
    [{ ...base, title: 3 }, mailTextOf.formFieldKind('title', 'string')],
    [{ ...base, amount: '1.5' }, mailTextOf.formFieldKind('amount', 'decimal')],
    [{ ...base, urgent: 'yes' }, mailTextOf.formFieldKind('urgent', 'boolean')],
    [{ title: 't', count: 1 }, mailTextOf.formFieldMissing('amount')],
    [
      { ...base, extra: 1 },
      textOf.unexpectedArgument('extra', 'submitForm', [
        'title',
        'count',
        'amount',
        'urgent',
      ]),
    ],
  ];
  await null;
  for (const [values, text] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await run(context, 'submitForm', {
      messageNumber: '2',
      values,
    });
    t.deepEqual(outcome, { status: 'failed', text }, JSON.stringify(values));
  }
  t.deepEqual(
    await run(context, 'submitForm', { messageNumber: '1', values: {} }),
    { status: 'failed', text: mailTexts.expectedForm },
  );
  t.deepEqual(form.calls, []);
});
