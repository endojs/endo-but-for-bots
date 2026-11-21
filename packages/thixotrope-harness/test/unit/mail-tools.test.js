// @ts-check
// The mail tools (guest/session/tools/mail.js; designs/m9-interfaces.md
// 3.2, 4.1, 11, D-M9-14, D-M9-17, D-M9-23): `listMessages`, `send`,
// `reply`, `dismiss` over a fake Outbox from the real guard, a stand-in
// inbox part and the real label map. Every refusal the session can make
// is made before the Outbox is called; staged arguments are split by the
// exec vat (a fake `ExecScope` from the real guard).
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { textOf } from '../../guest/lib/interfaces.js';
import {
  texts as mailTexts,
  textOf as mailTextOf,
  mailToolNames,
} from '../../guest/lib/guards/session.js';
import { limits } from '../../guest/lib/limits.js';
import { mailToolEntries } from '../../guest/session/tools/mail.js';
/* eslint-enable import/no-relative-packages */
import {
  makeAddress,
  makeContext,
  makeExecVat,
  makeHandle,
  makeInbox,
  makeOutbox,
  makeStaged,
} from './_mail-tool-fakes.js';

/** @param {string} name */
const entry = name => {
  const found = mailToolEntries.find(e => e.name === name);
  if (found === undefined) throw Error(`no ${name}`);
  return found;
};

/**
 * Run a tool with JSON arguments (text, or a StagedText).
 * @param {any} context
 * @param {string} name
 * @param {any} args
 * @param {any} [ports]
 */
const run = (context, name, args, ports = {}) =>
  entry(name).execute(
    harden({
      opId: 't1/r0/c0',
      args:
        typeof args === 'string' || args?.blob ? args : JSON.stringify(args),
      turnId: 't1',
    }),
    ports,
    context,
  );

const ann = makeAddress('Ann');
const bob = makeAddress('Bob');
const operator = makeAddress('Operator');
const notes = makeAddress('Notes object');

/**
 * A context with `ann` and `bob` held, a `notes` object, and a JSON label.
 * @param {object} [options] more `makeContext` options
 */
const setup = (options = {}) => {
  const fake = makeOutbox();
  const made = makeContext({
    outbox: fake.outbox,
    operatorAddress: operator,
    subagents: new Map([['researcher', makeHandle('researcher')]]),
    ...options,
  });
  made.labels.bindObject('ann', ann, 'endowment');
  made.labels.bindObject('bob', bob, 'endowment');
  made.labels.bindObject('notes', notes, 'adopted');
  made.labels.bindJson('config', '{"a":1}');
  return { ...fake, ...made };
};

test('the four entries in mailToolNames order, offered only with an Outbox', t => {
  t.deepEqual(
    mailToolEntries.map(e => e.name),
    [...mailToolNames],
  );
  for (const e of mailToolEntries) {
    t.true(e.available({}, { mail: makeOutbox().outbox }), e.name);
    t.false(e.available({}, {}), e.name);
    t.is(e.describe().name, e.name);
    t.notThrows(() => JSON.parse(e.describe().parameters));
  }
  t.deepEqual(
    mailToolEntries.map(e => e.site),
    ['session', 'guest', 'guest', 'session'],
  );
});

test('send: recipients and attachments by label, the body with @edges, the sent text per recipient', async t => {
  const { context, drafts } = setup();
  const outcome = await run(context, 'send', {
    recipient: ['ann', 'user', 'subagents/researcher'],
    strings: ['See ', ' please.'],
    edgeNames: ['doc'],
    petNames: ['notes'],
  });
  t.is(outcome.status, 'ok');
  t.is(
    outcome.text,
    [
      mailTextOf.sent('ann'),
      mailTextOf.sent('user'),
      mailTextOf.sent('subagents/researcher'),
    ].join('\n'),
  );
  t.is(drafts.length, 1);
  const [draft] = drafts;
  t.is(draft.to[0], ann);
  t.is(draft.to[1], operator);
  t.is(draft.to.length, 3);
  t.is(draft.body, 'See @doc please.');
  t.deepEqual(draft.attachments, [{ label: 'doc', value: notes }]);
  t.false('inReplyTo' in draft);
});

test('send carries a held reference and stored JSON in the same package', async t => {
  const { context, drafts } = setup();
  const outcome = await run(context, 'send', {
    recipient: 'bob',
    strings: ['use ', ' with ', ''],
    edgeNames: ['object', 'data'],
    petNames: ['notes', 'config'],
  });
  t.is(outcome.status, 'ok');
  t.is(drafts[0].attachments[0].value, notes);
  t.deepEqual(drafts[0].attachments[1], {
    label: 'data',
    value: { json: '{"a":1}' },
  });
});

test('send refuses an expanded copy package over the frame bound before posting', async t => {
  const { context, labels, drafts } = setup();
  const json = JSON.stringify('a'.repeat(limits.labelValueBytes - 2));
  labels.bindJson('big', json);
  const outcome = await run(context, 'send', {
    recipient: 'bob',
    strings: [],
    edgeNames: ['a', 'b', 'c', 'd'],
    petNames: ['big', 'big', 'big', 'big'],
  });
  t.is(outcome.status, 'failed');
  t.is(outcome.text, mailTexts.frameLimit);
  t.is(drafts.length, 0);
});

test('send: a single recipient string; an edge without a pet name attaches its own label', async t => {
  const { context, drafts } = setup();
  const outcome = await run(context, 'send', {
    recipient: 'bob',
    strings: 'hello',
    edgeNames: ['notes'],
  });
  t.is(outcome.status, 'ok');
  t.is(drafts[0].to[0], bob);
  t.is(drafts[0].body, 'hello@notes');
  t.is(drafts[0].attachments[0].value, notes);
});

test('send: the post office refusals are forwarded; failed only when every recipient refused', async t => {
  const { context, refuse } = setup();
  refuse.set(bob, 'The recipient is not a mail address');
  const some = await run(context, 'send', {
    recipient: ['ann', 'bob'],
    strings: ['x'],
  });
  t.is(some.status, 'ok');
  t.is(
    some.text,
    `${mailTextOf.sent('ann')}\nThe recipient is not a mail address`,
  );
  const all = await run(context, 'send', { recipient: 'bob', strings: ['x'] });
  t.deepEqual(all, {
    status: 'failed',
    text: 'The recipient is not a mail address',
  });
});

test('send: refusals before any post (section 11 probes)', async t => {
  const { context, drafts } = setup();
  const nine = Array.from({ length: 9 }, () => 'ann');
  const cases = [
    [
      { recipient: nine, strings: ['x'] },
      mailTextOf.tooManyRecipients(9, limits.recipientsPerSend),
    ],
    [
      { recipient: 'nobody', strings: ['x'] },
      mailTextOf.unknownRecipient('nobody'),
    ],
    [
      { recipient: 'config', strings: ['x'] },
      mailTextOf.unknownRecipient('config'),
    ],
    [
      { recipient: 'subagents/nobody', strings: ['x'] },
      mailTextOf.unknownRecipient('subagents/nobody'),
    ],
    [
      { recipient: 'ann', strings: ['x'], petNames: ['missing'] },
      textOf.unknownLabel('missing'),
    ],
    [
      {
        recipient: 'ann',
        strings: ['x'],
        edgeNames: ['a', 'a'],
        petNames: ['notes', 'ann'],
      },
      textOf.duplicateAttachment('a'),
    ],
    [
      {
        recipient: 'ann',
        strings: ['x'],
        edgeNames: Array.from({ length: 33 }, (_, i) => `e${i}`),
      },
      textOf.tooManyAttachments(33),
    ],
    [
      { recipient: 'ann', strings: ['x'.repeat(5000), 'y'.repeat(5000)] },
      mailTextOf.bodyTooLong(10_000, limits.inlineBytes),
    ],
  ];
  await null;
  for (const [args, text] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await run(context, 'send', args);
    t.deepEqual(
      outcome,
      { status: 'failed', text },
      JSON.stringify(args).slice(0, 80),
    );
  }
  t.is(drafts.length, 0);
});

test('send: an edge label over the attachment label bound is refused by the Outbox guard', async t => {
  const { context, drafts } = setup();
  const outcome = await run(context, 'send', {
    recipient: 'ann',
    strings: ['x'],
    edgeNames: ['e'.repeat(limits.endowmentLabelUnits + 1)],
    petNames: ['notes'],
  });
  t.is(outcome.status, 'failed');
  t.is(drafts.length, 0);
});

test('send: argument shape refused by the closed parser (unknown key, wrong kinds)', async t => {
  const { context, drafts } = setup();
  const unknown = await run(context, 'send', {
    recipient: 'ann',
    strings: ['x'],
    method: 'evil',
  });
  t.is(
    unknown.text,
    textOf.unexpectedArgument('method', 'send', [
      'recipient',
      'strings',
      'edgeNames',
      'petNames',
    ]),
  );
  const numbers = await run(context, 'send', {
    recipient: 'ann',
    strings: [1],
  });
  t.is(numbers.status, 'failed');
  t.regex(numbers.text, /argument "strings" must be a string or an array/);
  const many = await run(context, 'send', {
    recipient: 'ann',
    strings: Array.from({ length: limits.mailParts + 1 }, () => 'x'),
  });
  t.regex(many.text, /at most 64 strings/);
  const none = await run(context, 'send', { recipient: [], strings: ['x'] });
  t.is(none.status, 'failed');
  const flood = `{${Array.from({ length: 10_000 }, (_, i) => `"k${i}":1`).join(',')}}`;
  const flooded = await run(context, 'send', flood);
  t.regex(flooded.text, /Unexpected argument "k0" for send/);
  // Escapes in the strings are decoded; a quote inside a string does not end it.
  const escaped = await run(
    context,
    'send',
    '{"recipient":"ann","strings":["a \\"q\\" \\u00e9", "\\\\"]}',
  );
  t.is(escaped.status, 'ok');
  t.is(drafts.at(-1).body, 'a "q" é\\');
});

test('reply: to the sender of the message, in reply to its postmark', async t => {
  const fakeInbox = makeInbox([
    { number: 3, type: 'package', from: bob, postmark: 77, state: 'kept' },
    {
      number: 4,
      type: 'reply',
      from: ann,
      postmark: 78,
      state: 'kept',
      imported: true,
    },
  ]);
  const { context, drafts } = setup({ inbox: fakeInbox.inbox });
  const outcome = await run(context, 'reply', {
    messageNumber: 3,
    strings: ['done'],
    edgeNames: ['doc'],
    petNames: ['notes'],
  });
  t.deepEqual(outcome, { status: 'ok', text: mailTextOf.replied(3) });
  t.is(drafts[0].to[0], bob);
  t.is(drafts[0].inReplyTo, 77);
  t.is(drafts[0].body, 'done@doc');
  t.deepEqual(
    await run(context, 'reply', { messageNumber: 9, strings: ['x'] }),
    {
      status: 'failed',
      text: mailTexts.noSuchMessage,
    },
  );
  t.deepEqual(
    await run(context, 'reply', { messageNumber: 4, strings: ['x'] }),
    {
      status: 'failed',
      text: mailTexts.imported,
    },
  );
  t.is(drafts.length, 1);
});

test('dismiss and listMessages read the inbox part', async t => {
  const fakeInbox = makeInbox([
    {
      number: 1,
      type: 'package',
      state: 'waiting',
      body: makeStaged(9000, 'big'),
    },
    { number: 2, type: 'reply', state: 'kept' },
    { number: 3, type: 'reply', state: 'kept', imported: true },
  ]);
  const { context } = setup({ inbox: fakeInbox.inbox });
  const listed = await run(context, 'listMessages', '');
  t.is(listed.status, 'ok');
  const row = { from: 'Bob', text: 'hi', edgeNames: [] };
  t.deepEqual(JSON.parse(listed.text), [
    { number: 3, type: 'reply', state: 'kept', ...row },
    { number: 2, type: 'reply', state: 'kept', ...row },
    { number: 1, type: 'package', state: 'waiting', ...row, text: 'big' },
  ]);
  t.deepEqual(fakeInbox.log, [['views', limits.listMessagesPage]]);
  t.deepEqual(await run(context, 'dismiss', { messageNumber: 2 }), {
    status: 'ok',
    text: mailTextOf.dismissed(2),
  });
  // An imported message may be dismissed (D-M9-21).
  t.is((await run(context, 'dismiss', { messageNumber: 3 })).status, 'ok');
  const waiting = await run(context, 'dismiss', { messageNumber: 1 });
  t.deepEqual(waiting, {
    status: 'failed',
    text: 'Message #1 has not been handled',
  });
  t.is(
    (await run(context, 'dismiss', { messageNumber: 2 })).text,
    mailTexts.noSuchMessage,
  );
  t.is((await run(context, 'listMessages', { x: 1 })).status, 'failed');
});

test('staged arguments: too long refused before splitArgs; split strings become the body', async t => {
  const body = makeStaged(900_000, 'long text');
  const { execVat, inspects } = makeExecVat(() =>
    harden({
      status: 'split',
      split: {
        json: '{"recipient":"ann","strings":["\\u0000s0"],"edgeNames":["doc"],"petNames":["notes"]}',
        staged: [body],
      },
    }),
  );
  const { context, drafts } = setup({ execVat });
  const writers = makeAddress('writers stand-in');
  const ports = harden({ writers });

  const tooLong = await run(
    context,
    'send',
    makeStaged(limits.mailBodyUnits + 1),
    ports,
  );
  t.deepEqual(tooLong, {
    status: 'failed',
    text: mailTextOf.bodyTooLong(
      limits.mailBodyUnits + 1,
      limits.mailBodyUnits,
    ),
  });
  t.is(inspects.length, 0);

  const args = makeStaged(900_100);
  const outcome = await run(context, 'send', args, ports);
  t.deepEqual(outcome, { status: 'ok', text: mailTextOf.sent('ann') });
  t.is(inspects.length, 1);
  t.is(inspects[0].op, 'splitArgs');
  t.is(inspects[0].args, args);
  t.is(drafts[0].body, body);
  t.is(drafts[0].attachments[0].label, 'doc');
});

test('staged arguments: a staged label or a staged piece among others is refused; no exec vat refuses', async t => {
  const piece = makeStaged(2000);
  /** @type {string} */
  let json = '';
  const { execVat } = makeExecVat(() =>
    harden({ status: 'split', split: { json, staged: [piece] } }),
  );
  const { context, drafts } = setup({ execVat });
  const ports = harden({ writers: makeAddress('writers stand-in') });
  const args = makeStaged(10_000);

  json = '{"recipient":"\\u0000s0","strings":["x"]}';
  await null;
  t.deepEqual(await run(context, 'send', args, ports), {
    status: 'failed',
    text: textOf.argumentsTooLarge('recipient', 2000, limits.inlineBytes),
  });
  json = '{"recipient":"ann","strings":["intro ", "\\u0000s0"]}';
  t.deepEqual(await run(context, 'send', args, ports), {
    status: 'failed',
    text: mailTextOf.bodyTooLong(2006, limits.inlineBytes),
  });
  json = '{"recipient":"ann","strings":["\\u0000s1"]}';
  t.is((await run(context, 'send', args, ports)).status, 'failed');

  const bare = setup();
  t.deepEqual(await run(bare.context, 'send', args, ports), {
    status: 'failed',
    text: textOf.argumentsTooLarge('send', 10_000, limits.inlineBytes),
  });
  t.is(drafts.length + bare.drafts.length, 0);
});

test('a failed split answers its outcome; a broken Outbox is a failed result', async t => {
  const { execVat } = makeExecVat(() =>
    harden({ status: 'failed', text: 'exec said no' }),
  );
  const { context } = setup({ execVat });
  const ports = harden({ writers: makeAddress('writers stand-in') });
  await null;
  t.deepEqual(await run(context, 'send', makeStaged(9000), ports), {
    status: 'failed',
    text: 'exec said no',
  });
  const broken = makeContext({
    outbox: makeAddress('not an outbox'),
    operatorAddress: operator,
  });
  const outcome = await run(broken.context, 'send', {
    recipient: 'user',
    strings: ['x'],
  });
  t.is(outcome.status, 'failed');
});
