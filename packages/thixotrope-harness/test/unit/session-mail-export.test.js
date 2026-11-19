// @ts-check
// The inbox in a session's export and import (designs/m9-interfaces.md
// D-M9-21, seam S7; acceptance 21 at unit level): a session with a waiting
// package (staged body), a kept reply and an open request is exported page
// by page (head, records, queue, inbox, end; the blob pages list the inbox's
// staged body) and imported into a new session, which lists all three as
// kept and imported, starts no turn, answers no request and lets `dismiss`
// remove them; its packages counter resumes above the imported numbers.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { postOfficeTables } from '../../guest/lib/guards/post-office.js';
import { holdTexts } from '../../guest/session/holds.js';
import { inboxPart } from '../../guest/session/inbox.js';
import { makeQueue as realMakeQueue } from '../../guest/session/queue.js';
import { runtimeParts } from '../../guest/session/runtime-parts.js';
import { subagentsPart } from '../../guest/session/subagents.js';
/* eslint-enable import/no-relative-packages */
import { AT, drain, makeQueueSession } from './_m2-queue-session.js';
import { stagedText } from './_m2-w25-session.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { makeExo } = /** @type {GuestGlobals} */ (globalThis);

const { interfaces } = postOfficeTables();
const sender = makeExo('MailAddress', interfaces.MailAddress, {
  describe: () => harden({ title: 'Bea', kind: 'session' }),
});
/** @type {any[]} */
const ticketCalls = [];
const ticket = makeExo('RequestTicket', interfaces.RequestTicket, {
  describe: () => harden({ state: 'open' }),
  answer: (/** @type {any} */ answer) => {
    ticketCalls.push(answer);
  },
  submit: () => {},
});

/**
 * @param {number} seq
 * @param {Record<string, any>} fields
 */
const envelope = (seq, fields) =>
  harden({
    seq,
    postmark: 100 + seq,
    type: 'package',
    from: sender,
    fromTitle: 'Bea',
    body: `mail ${seq}`,
    attachments: harden([]),
    at: AT + seq,
    ...fields,
  });

/** A mail session whose queue and inbox part the test can reach. */
const makeMailSession = async () => {
  /** @type {any} */
  let queue;
  /** @type {any} */
  let inbox;
  const s = await makeQueueSession({
    parts: harden([
      ...runtimeParts,
      harden({
        name: inboxPart.name,
        make: (/** @type {any} */ runtime) => {
          inbox = inboxPart.make(runtime);
          return inbox;
        },
      }),
      subagentsPart,
    ]),
    makeQueue: options => {
      queue = realMakeQueue(options);
      return queue;
    },
  });
  return { ...s, queue: () => queue, inbox: () => inbox };
};

/** @param {any} internal */
const exportPages = internal => {
  const pages = [internal.exportState()];
  for (let page = pages[0]; page.part !== 'end';) {
    page = internal.exportState(page.next);
    pages.push(page);
  }
  return pages;
};

/** @param {any} internal */
const blobPages = internal => {
  const blobs = [];
  let page = internal.blobPage();
  blobs.push(...page.blobs);
  while (page.next !== undefined) {
    page = internal.blobPage(page.next);
    blobs.push(...page.blobs);
  }
  return blobs;
};

test('the inbox is exported after the queue and imported kept and read-only', async t => {
  const from = await makeMailSession();
  // Idle, with a held entry, so delivered mail waits (D-M9-5).
  await from.submit('first');
  await from.submit('held');
  from.queue().hold('stopped', holdTexts.stopped());
  await from.finish();
  const { blob, staged } = stagedText('long mail');
  t.deepEqual(from.internal.deliverMail(envelope(1, { body: staged })), {
    number: 1,
  });
  from.internal.deliverMail(
    envelope(2, { type: 'reply', body: 'thanks', inReplyTo: 7 }),
  );
  from.internal.deliverMail(
    envelope(3, { type: 'request', body: 'Pick a colour', ticket }),
  );
  await drain();
  t.deepEqual(from.sent(), ['first']);
  t.deepEqual(
    from
      .inbox()
      .views()
      .map((/** @type {any} */ v) => [v.number, v.state]),
    [
      [3, 'waiting'],
      [2, 'kept'],
      [1, 'waiting'],
    ],
  );
  t.true(
    blobPages(from.internal).includes(blob),
    'the blob pages list the inbox body',
  );

  const pages = exportPages(from.internal);
  t.deepEqual(
    pages.map(p => p.part),
    ['head', 'records', 'queue', 'inbox', 'end'],
  );
  const queuePage = pages[2];
  t.is(queuePage.next, 'm0');
  const inboxPage = pages[3];
  t.is(inboxPage.next, 'e');
  t.deepEqual(
    inboxPage.messages.map((/** @type {any} */ m) => [m.number, m.state]),
    [
      [1, 'waiting'],
      [2, 'kept'],
      [3, 'waiting'],
    ],
  );
  // Data only: no sender address or ticket crosses an export.
  for (const message of inboxPage.messages) {
    t.false('from' in message);
    t.false('ticket' in message);
  }

  const into = await makeMailSession();
  for (const page of pages) into.internal.importState(page);
  await drain();
  t.deepEqual(into.sent(), [], 'an imported session starts nothing');
  const inbox = into.inbox();
  t.deepEqual(
    inbox.views().map((/** @type {any} */ v) => [v.number, v.state]),
    [
      [3, 'kept'],
      [2, 'kept'],
      [1, 'kept'],
    ],
  );
  t.is(inbox.get(1).body, staged, 'the staged body is the exported handle');
  t.true(inbox.get(3).imported);
  t.is(inbox.settleRequest(3), undefined, 'no ticket to answer');
  t.deepEqual(ticketCalls, []);
  t.true(blobPages(into.internal).includes(blob));
  // A delivery after the import numbers above the imported messages.
  t.deepEqual(into.internal.deliverMail(envelope(1, {})), { number: 4 });
  t.deepEqual(inbox.dismiss(2), { ok: true });
  t.deepEqual(inbox.dismiss(1), { ok: true });
  t.is(inbox.get(1), undefined);
});

test('an inbox page after end is ignored; before head it is refused', async t => {
  const s = await makeMailSession();
  const page = harden({ part: 'inbox', messages: harden([]) });
  t.throws(() => s.internal.importState(page), {
    message: /no import is open/,
  });
  s.internal.importState(harden({ part: 'head' }));
  s.internal.importState(harden({ part: 'end' }));
  t.deepEqual(s.internal.importState(page), {
    records: 0,
    complete: true,
  });
});

test('a session without the inbox part exports no inbox page', async t => {
  const s = await makeQueueSession();
  t.deepEqual(
    exportPages(s.internal).map(p => p.part),
    ['head', 'records', 'queue', 'end'],
  );
});
