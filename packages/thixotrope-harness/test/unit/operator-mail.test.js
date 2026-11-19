// @ts-check
// The operator's mail in Node (designs/m9-interfaces.md D-M9-9, 3.1, 4.2,
// 4.5; acceptance 2, 3, 13).
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { makeMailWorld, settle, stagedText } from './_post-office-fakes.js';

/* eslint-disable import/no-relative-packages */
import { mailLimits } from '../../guest/lib/mail-limits.js';
import { limits } from '../../guest/lib/limits.js';
import { textOf } from '../../guest/lib/guards/base.js';
import { mailTexts, mailTextOf } from '../../guest/lib/guards/mail.js';
import {
  postOfficeTexts,
  postOfficeTextOf,
} from '../../guest/lib/guards/post-office.js';
import { makeOperatorMail } from '../../guest/factory/operator-mail.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

const none = harden([]);

/** @param {{ inboxLimit?: number }} [options] */
const makeOperatorWorld = options => {
  const world = makeMailWorld(options);
  const mail = makeOperatorMail({
    postOffice: world.postOffice,
    admin: world.admin,
    rows: world.rows,
  });
  return { ...world, mail, mailbox: mail.mailbox };
};

test('the operator sends to a Session or an address; the session sees "user"', async t => {
  const world = makeOperatorWorld();
  const a = world.addSession('Alpha');
  const b = world.addSession('Beta');
  const thing = Far('Thing', {});
  const receipt = await E(world.mailbox).send(
    harden({
      to: [a.session, b.address],
      body: 'hello',
      attachments: [{ label: 'thing', value: thing }],
    }),
  );
  t.is(receipt.results.length, 2);
  t.true(receipt.results.every(r => typeof r.postmark === 'number'));
  const [envelope] = a.envelopes;
  t.is(envelope.from, world.postOffice.operatorAddress());
  t.is(envelope.fromTitle, 'user');
  t.is(envelope.type, 'package');
  t.is(envelope.attachments[0].value, thing);
  t.is(b.envelopes.length, 1);
  t.is(await E(world.mailbox).addressOf(a.session), a.address);
  await t.throwsAsync(E(world.mailbox).addressOf(Far('Session', {})), {
    message: postOfficeTexts.notASession,
  });
});

test('mail to the operator is listed, taken, replied to and dismissed; a staged reply is kept as a copy', async t => {
  const world = makeOperatorWorld();
  const a = world.addSession('Alpha');
  const operator = world.postOffice.operatorAddress();
  const thing = Far('Thing', {});
  const rev0 = await E(world.mailbox).rev();
  const body = stagedText(30_000, 'a long report');
  await E(a.outbox).post(
    harden({
      to: [operator],
      body,
      attachments: [{ label: 'report', value: thing }],
    }),
  );
  t.is(world.copies.length, 1, 'the operator keeps a staged copy');
  const page = await E(world.mailbox).list();
  t.is(page.messages.length, 1);
  t.true(page.rev > rev0);
  const [view] = page.messages;
  t.like(view, {
    number: 1,
    type: 'package',
    fromTitle: 'Alpha',
    at: 1_700_000_000_000,
  });
  t.is(view.from, a.address);
  t.is(view.body, world.copies[0].copied);
  t.deepEqual(view.edges, ['report']);
  const message = view.message;
  t.is(await E(message).take('report'), thing);
  await t.throwsAsync(E(message).take('other'), {
    message: postOfficeTexts.noAttachment,
  });
  const reply = await E(message).reply(
    harden({ body: 'thanks', attachments: none }),
  );
  t.true(typeof reply.results[0].postmark === 'number');
  t.like(a.envelopes[0], { type: 'reply', body: 'thanks', fromTitle: 'user' });
  await E(message).dismiss();
  await settle();
  t.deepEqual(world.released, [world.copies[0].copied.blob]);
  t.is((await E(world.mailbox).list()).messages.length, 0);
  // Dismissed twice: nothing more.
  await E(message).dismiss();
  t.is(world.released.length, 1);
});

test('the operator inbox refuses the 257th message (acceptance 13)', async t => {
  const world = makeOperatorWorld();
  const a = world.addSession('Alpha');
  const operator = world.postOffice.operatorAddress();
  for (let i = 0; i < mailLimits.operatorInboxMessages; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await E(a.outbox).post(
      harden({ to: [operator], body: `m${i}`, attachments: none }),
    );
  }
  const full = await E(a.outbox).post(
    harden({ to: [operator], body: 'one too many', attachments: none }),
  );
  t.deepEqual(full.results[0], {
    refused: postOfficeTextOf.operatorInboxFull(
      mailLimits.operatorInboxMessages,
    ),
  });
  t.is(world.mail.status().inbox, mailLimits.operatorInboxMessages);
});

test('inbox pages hold at most operatorPageRows rows and frameBytes, with a cursor', async t => {
  const world = makeOperatorWorld();
  const a = world.addSession('Alpha');
  const operator = world.postOffice.operatorAddress();
  const big = 'x'.repeat(limits.inlineBytes);
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await E(a.outbox).post(
      harden({ to: [operator], body: big, attachments: none }),
    );
  }
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await E(a.outbox).post(
      harden({ to: [operator], body: `m${i}`, attachments: none }),
    );
  }
  /** @type {number[]} */
  const seen = [];
  /** @type {number | undefined} */
  let after;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const page = await E(world.mailbox).list(
      after === undefined ? undefined : harden({ after }),
    );
    t.true(page.messages.length <= mailLimits.operatorPageRows);
    let bytes = 0;
    for (const view of page.messages) bytes += view.body.length;
    t.true(bytes <= limits.frameBytes);
    seen.push(...page.messages.map(view => view.number));
    if (page.next === undefined) break;
    after = page.next;
  }
  t.deepEqual(
    seen,
    Array.from({ length: 46 }, (_, i) => i + 1),
  );
  const two = await E(world.mailbox).list(harden({ after: 10, limit: 2 }));
  t.deepEqual(
    two.messages.map(view => view.number),
    [11, 12],
  );
  t.is(two.next, 12);
});

test('a request is answered once through its ticket; whenSettled answers (acceptance 2)', async t => {
  const world = makeOperatorWorld();
  const a = world.addSession('Alpha');
  const handle = await E(world.mailbox).request(
    harden({ to: a.session, description: 'What is 2 + 2?' }),
  );
  const [envelope] = a.envelopes;
  t.is(envelope.type, 'request');
  t.is(envelope.body, 'What is 2 + 2?');
  const info = await E(handle).describe();
  t.deepEqual(info, {
    kind: 'request',
    state: 'open',
    postmark: envelope.postmark,
  });
  const { ticket } = envelope;
  t.deepEqual(await E(ticket).describe(), { kind: 'request', state: 'open' });
  await t.throwsAsync(E(ticket).submit(harden([])), {
    message: mailTexts.expectedForm,
  });
  const settled = E(handle).whenSettled();
  await E(ticket).answer(harden({ json: '4' }));
  t.deepEqual(await settled, {
    kind: 'request',
    state: 'answered',
    postmark: envelope.postmark,
    json: '4',
  });
  await t.throwsAsync(E(ticket).answer(harden({ json: '5' })), {
    message: postOfficeTexts.requestClosed,
  });
  // The inbox's settle hook rejects an unanswered request the same way.
  const second = await E(world.mailbox).request(
    harden({ to: a.address, description: 'Another' }),
  );
  await E(a.envelopes[1].ticket).answer(
    harden({ rejected: mailTexts.unansweredRequest }),
  );
  t.like(await E(second).whenSettled(), {
    state: 'rejected',
    reason: mailTexts.unansweredRequest,
  });
});

test('a responseKey answers the same handle while open or settled; a failed one is replaced', async t => {
  const world = makeOperatorWorld({ inboxLimit: 1 });
  const a = world.addSession('Alpha');
  const b = world.addSession('Beta');
  const draft = harden({
    to: a.session,
    description: 'Once',
    responseKey: 'k1',
  });
  const first = await E(world.mailbox).request(draft);
  t.is(await E(world.mailbox).request(draft), first);
  t.is(a.envelopes.length, 1);
  // A full inbox: the request fails with the refusal, and a retry with
  // the same key makes a new one.
  await E(world.mailbox).send(
    harden({ to: [b.session], body: 'fill', attachments: none }),
  );
  const failing = harden({
    to: b.session,
    description: 'Full',
    responseKey: 'k2',
  });
  const failed = await E(world.mailbox).request(failing);
  t.like(await E(failed).describe(), {
    state: 'failed',
    reason: 'inbox of Beta is full',
  });
  const retry = await E(world.mailbox).request(failing);
  t.not(retry, failed);
});

test('a request to a lost session fails with requestFailed; to a non-address is refused', async t => {
  const world = makeOperatorWorld();
  const a = world.addSession('Alpha');
  a.state.retired = true;
  const handle = await E(world.mailbox).request(
    harden({ to: a.session, description: 'Hello?' }),
  );
  t.like(await E(handle).whenSettled(), {
    state: 'failed',
    reason: postOfficeTextOf.requestFailed('Alpha'),
  });
  await t.throwsAsync(
    E(world.mailbox).request(
      harden({ to: Far('Stranger', {}), description: 'x' }),
    ),
    { message: postOfficeTexts.notAnAddress },
  );
  await t.throwsAsync(
    E(world.mailbox).request(
      harden({ to: world.postOffice.operatorAddress(), description: 'x' }),
    ),
    { message: postOfficeTexts.notASession },
  );
});

test('a request whose turn text would pass inlineBytes is refused at the mailbox', async t => {
  const world = makeOperatorWorld();
  const a = world.addSession('Alpha');
  // 4,096 units of a three-byte character.
  const description = '€'.repeat(mailLimits.requestDescriptionUnits);
  await t.throwsAsync(
    E(world.mailbox).request(harden({ to: a.session, description })),
    { message: /^The message is \d+ bytes .* the limit is 8192$/ },
  );
  t.is(a.envelopes.length, 0);
});

test('cancel settles the handle and tells the recipient; the ticket is closed', async t => {
  const world = makeOperatorWorld();
  const a = world.addSession('Alpha');
  const handle = await E(world.mailbox).request(
    harden({ to: a.session, description: 'Never mind' }),
  );
  await E(handle).cancel();
  await settle();
  t.deepEqual(a.cancelled, [a.envelopes[0].postmark]);
  t.like(await E(handle).whenSettled(), {
    state: 'cancelled',
    reason: postOfficeTexts.requestCancelled,
  });
  await t.throwsAsync(E(a.envelopes[0].ticket).answer(harden({ json: '1' })), {
    message: postOfficeTexts.requestClosed,
  });
});

test('a form is checked again in the factory and posts a value message (acceptance 3)', async t => {
  const world = makeOperatorWorld();
  const a = world.addSession('Alpha');
  const fields = harden([
    { name: 'city', kind: 'string', description: 'Where' },
    { name: 'count', kind: 'integer', default: '1' },
    { name: 'price', kind: 'decimal' },
    { name: 'urgent', kind: 'boolean', default: 'false' },
  ]);
  const handle = await E(world.mailbox).form(
    harden({ to: a.session, description: 'Order form', fields }),
  );
  const [envelope] = a.envelopes;
  t.is(envelope.type, 'form');
  t.deepEqual(envelope.fields, fields);
  const { ticket } = envelope;
  await t.throwsAsync(E(ticket).answer(harden({ json: '{}' })), {
    message: mailTexts.expectedRequest,
  });
  await t.throwsAsync(
    E(ticket).submit(
      harden([
        { name: 'city', json: '3' },
        { name: 'price', json: '"2"' },
      ]),
    ),
    { message: mailTextOf.formFieldKind('city', 'string') },
  );
  await t.throwsAsync(
    E(ticket).submit(harden([{ name: 'city', json: '"Oslo"' }])),
    { message: mailTextOf.formFieldMissing('price') },
  );
  await t.throwsAsync(
    E(ticket).submit(
      harden([
        { name: 'city', json: '"Oslo"' },
        { name: 'price', json: '"2.50"' },
        { name: 'colour', json: '"red"' },
      ]),
    ),
    {
      message: textOf.unexpectedArgument('colour', 'submitForm', [
        'city',
        'count',
        'price',
        'urgent',
      ]),
    },
  );
  await t.throwsAsync(
    E(ticket).submit(
      harden([
        { name: 'city', json: '"Oslo"' },
        { name: 'price', json: '2.5' },
      ]),
    ),
    { message: mailTextOf.formFieldKind('price', 'decimal') },
  );
  await E(ticket).submit(
    harden([
      { name: 'price', json: '"2.50"' },
      { name: 'city', json: '"Oslo \\"centre\\""' },
    ]),
  );
  const values = [
    { name: 'city', json: '"Oslo \\"centre\\""' },
    { name: 'count', json: '1' },
    { name: 'price', json: '"2.50"' },
    { name: 'urgent', json: 'false' },
  ];
  t.deepEqual(await E(handle).whenSettled(), {
    kind: 'form',
    state: 'submitted',
    postmark: envelope.postmark,
    values,
  });
  const { messages } = await E(world.mailbox).list();
  t.is(messages.length, 1);
  t.like(messages[0], {
    type: 'value',
    fromTitle: 'Alpha',
    body: 'Order form',
    inReplyTo: envelope.postmark,
  });
  t.deepEqual(messages[0].values, values);
  t.is(messages[0].from, a.address);
  await t.throwsAsync(E(ticket).submit(harden(values)), {
    message: postOfficeTexts.requestClosed,
  });
});

test('a form whose envelope passes envelopeBytes is refused at the mailbox (acceptance 13)', async t => {
  const world = makeOperatorWorld();
  const a = world.addSession('Alpha');
  const fields = harden(
    Array.from({ length: mailLimits.formFields }, (_, i) => ({
      name: `field${i}`,
      kind: 'string',
      description: 'd'.repeat(mailLimits.formFieldDescriptionUnits),
      default: `"${'x'.repeat(mailLimits.formDefaultUnits - 2)}"`,
    })),
  );
  await t.throwsAsync(
    E(world.mailbox).form(
      harden({ to: a.session, description: 'Big', fields }),
    ),
    { message: /^The message is \d+ bytes .* the limit is 22528$/ },
  );
  t.is(a.envelopes.length, 0);
  t.is(world.mail.status().requests, 0, 'a refused form keeps no record');
});

test('requests are retained up to retainedRequests; the oldest settled one makes room', async t => {
  const world = makeOperatorWorld({ inboxLimit: 4096 });
  const a = world.addSession('Alpha');
  /** @type {any[]} */
  const handles = [];
  for (let i = 0; i < mailLimits.retainedRequests; i += 1) {
    handles.push(
      // eslint-disable-next-line no-await-in-loop
      await E(world.mailbox).request(
        harden({ to: a.session, description: `q${i}`, responseKey: `k${i}` }),
      ),
    );
  }
  const extra = harden({ to: a.session, description: 'one more' });
  await t.throwsAsync(E(world.mailbox).request(extra), {
    message: postOfficeTextOf.postOfficeBusy(mailLimits.retainedRequests),
  });
  await E(a.envelopes[5].ticket).answer(harden({ json: 'true' }));
  await E(a.envelopes[9].ticket).answer(harden({ json: 'true' }));
  await E(world.mailbox).request(extra);
  // The newer settled request (#9) is still answered by its key.
  t.is(
    await E(world.mailbox).request(
      harden({ to: a.session, description: 'q9', responseKey: 'k9' }),
    ),
    handles[9],
  );
  t.is(world.mail.status().requests, mailLimits.retainedRequests);
  // The evicted request's key is free again: a new request is made.
  const again = await E(world.mailbox).request(
    harden({ to: a.session, description: 'q5', responseKey: 'k5' }),
  );
  t.not(again, handles[5]);
});
