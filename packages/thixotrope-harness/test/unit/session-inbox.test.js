// @ts-check
// The session's inbox part (guest/session/inbox.js; designs/m9-interfaces.md
// 3.2, D-M9-5..D-M9-8, D-M9-13, D-M9-21): the delivery rule (re-drive
// answered from the outcome ring, the 256 bound, waiting or kept by type),
// the turn source with `take`, the claim's package and note, the settle
// for each status and type, cancel, views, dismiss, settleRequest, blobs,
// and the export page round trip into a new inbox (each page within
// frameBytes; imported messages kept and read-only; the counter raised).
// The runtime is made with the real parts plus the inbox, through the
// `parts` option; deliveries cross a SessionInternal fake built with the
// real `deliverMail` guard, and the Outbox and RequestTicket fakes are built
// from the post office's interfaces.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { shapes, textOf } from '../../guest/lib/guards/session.js';
import {
  mailTables,
  mailTexts,
  mailTextOf,
} from '../../guest/lib/guards/mail.js';
import { postOfficeTables } from '../../guest/lib/guards/post-office.js';
import { mailLimits } from '../../guest/lib/mail-limits.js';
import { limits } from '../../guest/lib/limits.js';
import { messageBytes } from '../../guest/lib/bounded.js';
import { makeLabels } from '../../guest/session/labels.js';
import {
  makeRuntime,
  runtimeParts,
} from '../../guest/session/runtime-parts.js';
import { inboxPart } from '../../guest/session/inbox.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, M, makeExo, matches } = /** @type {GuestGlobals} */ (globalThis);

const AT = 1_700_000_000_000;
const drain = () => new Promise(resolve => setImmediate(resolve));

const { interfaces } = postOfficeTables();

/** @param {string} title */
const address = title =>
  makeExo('MailAddress', interfaces.MailAddress, {
    describe: () => harden({ title, kind: 'session' }),
  });

const makeOutbox = () => {
  /** @type {any[]} */
  const posts = [];
  const outbox = makeExo('Outbox', interfaces.Outbox, {
    async post(/** @type {any} */ draft) {
      posts.push(draft);
      return harden({ results: harden([harden({ postmark: 900 })]) });
    },
  });
  return { outbox, posts };
};

const makeTicket = () => {
  /** @type {any[]} */
  const answers = [];
  const ticket = makeExo('RequestTicket', interfaces.RequestTicket, {
    describe: () => harden({ state: 'open' }),
    answer: (/** @type {any} */ answer) => {
      answers.push(answer);
    },
    submit: () => {},
  });
  return { ticket, answers };
};

/** @param {{ mail?: any }} [services] */
const makeInboxRuntime = (services = {}) => {
  const runtime = /** @type {any} */ (
    makeRuntime({
      labels: makeLabels(),
      services: harden(services),
      config: harden({}),
      parts: harden([...runtimeParts, inboxPart]),
    })
  );
  const { inbox } = runtime;
  // The guard `SessionInternal.deliverMail` crosses (seam S5's caller).
  const internal = makeExo(
    'SessionInternal',
    M.interface('SessionInternal', mailTables().sessionInternalMethods()),
    {
      deliverMail: (/** @type {any} */ envelope) => inbox.deliver(envelope),
      cancelMail: () => {},
    },
  );
  return { runtime, inbox, internal };
};

const alice = address('Alice');
let postmarks = 0;

/**
 * @param {number} seq
 * @param {Record<string, any>} [fields]
 */
const envelope = (seq, fields = {}) => {
  postmarks += 1;
  return harden({
    seq,
    postmark: postmarks,
    type: 'package',
    from: alice,
    fromTitle: 'Alice',
    body: `message ${seq}`,
    attachments: harden([]),
    at: AT + seq,
    ...fields,
  });
};

/** @param {string[]} labels */
const attach = labels =>
  harden(labels.map(label => harden({ label, value: Far(label, {}) })));

/**
 * A HookTurn as the runner builds one, with the settle's final text.
 * @param {string} turnId
 * @param {{ state?: string, error?: string, final?: any }} [settled]
 */
const hookTurn = (turnId, { state = 'running', error, final } = {}) =>
  Object.freeze({
    active: {
      turnId,
      state,
      info: { turnId, error },
      /** @type {string | undefined} */
      systemNote: undefined,
    },
    round: 0,
    append: () => {},
    emit: () => {},
    final,
  });

/**
 * Claims the inbox's next turn as `claim` does: `take` first, then onClaim.
 * @param {any} runtime
 * @param {string} turnId
 */
const claimMail = (runtime, turnId) => {
  const next = runtime.hooks.nextTurn();
  if (next === undefined) return undefined;
  next.take({ turnId });
  const turn = hookTurn(turnId);
  runtime.hooks.onClaim(turn, undefined);
  return { next, turn };
};

/**
 * @param {any} runtime
 * @param {string} turnId
 * @param {{ state: string, error?: string, final?: any }} settled
 */
const settleMail = (runtime, turnId, settled) => {
  runtime.hooks.onSettle(hookTurn(turnId, settled));
};

// ---------------------------------------------------------------- delivery

test('delivery: a package waits, a reply is kept; numbers come from the packages counter', t => {
  const { inbox, internal, runtime } = makeInboxRuntime();
  const first = internal.deliverMail(envelope(1));
  t.deepEqual(first, { number: 1 });
  t.is(inbox.get(1).state, 'waiting');
  const reply = internal.deliverMail(envelope(2, { type: 'reply' }));
  t.deepEqual(reply, { number: 2 });
  t.is(inbox.get(2).state, 'kept');
  // The counter is the packages one: its next number follows.
  t.is(/** @type {any} */ (runtime).packages.table.reserve(), 3);
});

test('a re-drive answers the remembered outcome as a duplicate; older than the ring, a bare duplicate', t => {
  const { inbox, internal } = makeInboxRuntime();
  t.deepEqual(internal.deliverMail(envelope(1)), { number: 1 });
  t.deepEqual(internal.deliverMail(envelope(1)), {
    number: 1,
    duplicate: true,
  });
  t.is(inbox.views().length, 1);
  for (let seq = 2; seq <= mailLimits.deliveryOutcomesKept + 1; seq += 1) {
    internal.deliverMail(envelope(seq, { type: 'reply' }));
  }
  // seq 1 fell out of the 64-outcome ring.
  t.deepEqual(internal.deliverMail(envelope(1)), { duplicate: true });
  t.deepEqual(internal.deliverMail(envelope(2)), {
    number: 2,
    duplicate: true,
  });
  t.is(inbox.views({ limit: 1000 }).length, mailLimits.listMessagesPage);
});

test('the inbox holds 256 messages: the 257th is refused (and remembered), nothing dropped', t => {
  const { inbox, internal } = makeInboxRuntime();
  for (let seq = 1; seq <= mailLimits.inboxMessages; seq += 1) {
    t.is(internal.deliverMail(envelope(seq, { type: 'reply' })).number, seq);
  }
  const refused = { refused: mailTextOf.inboxFull(mailLimits.inboxMessages) };
  const seq = mailLimits.inboxMessages + 1;
  t.deepEqual(internal.deliverMail(envelope(seq)), refused);
  t.deepEqual(internal.deliverMail(envelope(seq)), {
    ...refused,
    duplicate: true,
  });
  t.truthy(inbox.get(1));
  t.is(inbox.get(seq), undefined);
  // A dismissal makes room again.
  t.deepEqual(inbox.dismiss(1), { ok: true });
  t.is(internal.deliverMail(envelope(seq + 1)).number, seq);
});

// ---------------------------------------------------------------- turns

test('the turn source offers the oldest waiting message; take marks it handling; kept mail starts nothing', t => {
  const { inbox, internal, runtime } = makeInboxRuntime();
  internal.deliverMail(envelope(1, { type: 'reply' }));
  internal.deliverMail(envelope(2));
  internal.deliverMail(envelope(3));
  const next = runtime.hooks.nextTurn();
  t.is(next.text, 'message 2');
  t.is(next.at, AT + 2);
  t.is(inbox.get(2).state, 'waiting');
  next.take({ turnId: 't1' });
  t.is(inbox.get(2).state, 'handling');
  t.is(inbox.get(2).turnId, 't1');
  // The next offer is the following waiting message.
  t.is(runtime.hooks.nextTurn().text, 'message 3');
});

test('a staged package body is the turn input itself; a request is its composed text', t => {
  const { internal, runtime } = makeInboxRuntime();
  const { ticket } = makeTicket();
  const body = harden({ blob: Far('Blob', {}), preview: 'long', bytes: 9000 });
  internal.deliverMail(envelope(1, { body }));
  internal.deliverMail(
    envelope(2, { type: 'request', body: 'Pick a colour', ticket }),
  );
  const form = harden([
    harden({ name: 'colour', kind: 'string' }),
    harden({ name: 'count', kind: 'integer' }),
  ]);
  internal.deliverMail(
    envelope(3, { type: 'form', body: 'Fill', ticket, fields: form }),
  );
  t.is(claimMail(runtime, 't1')?.next.text, body);
  settleMail(runtime, 't1', { state: 'completed', final: 'ok' });
  t.is(
    claimMail(runtime, 't2')?.next.text,
    mailTextOf.requestTurnText('request', 2, 'Pick a colour', []),
  );
  settleMail(runtime, 't2', { state: 'failed', error: 'x' });
  t.is(
    claimMail(runtime, 't3')?.next.text,
    mailTextOf.requestTurnText('form', 3, 'Fill', ['colour', 'count']),
  );
});

test('claim: a package with attachments opens under its number with the R4-58 note; none, no package', t => {
  const { internal, runtime } = makeInboxRuntime();
  const table = /** @type {any} */ (runtime).packages.table;
  internal.deliverMail(envelope(1));
  internal.deliverMail(envelope(2, { attachments: attach(['doc', 'img']) }));
  const plain = claimMail(runtime, 't1');
  t.is(plain?.turn.active.systemNote, undefined);
  t.is(table.size(), 0);
  settleMail(runtime, 't1', { state: 'completed', final: 'done' });
  const withObjects = claimMail(runtime, 't2');
  t.is(
    withObjects?.turn.active.systemNote,
    textOf.mentionLine(2, ['doc', 'img']),
  );
  t.is(table.take(2, 'doc', 't2').toString(), '[object Alleged: doc]');
  // M5's packages hook closes it at settle (the stand-in's hook here).
  settleMail(runtime, 't2', { state: 'completed', final: 'done' });
  t.throws(() => table.take(2, 'doc', 't2'), {
    message: textOf.noPackage(2),
  });
});

test('settle of a package: the final text, or Error: ..., goes to the sender in reply; the message is removed', async t => {
  const { outbox, posts } = makeOutbox();
  const { inbox, internal, runtime } = makeInboxRuntime({ mail: outbox });
  internal.deliverMail(envelope(1));
  const { postmark } = inbox.get(1);
  claimMail(runtime, 't1');
  settleMail(runtime, 't1', { state: 'completed', final: 'All done.' });
  internal.deliverMail(envelope(2));
  claimMail(runtime, 't2');
  settleMail(runtime, 't2', { state: 'failed', error: 'provider broke' });
  internal.deliverMail(envelope(3));
  claimMail(runtime, 't3');
  settleMail(runtime, 't3', {
    state: 'interrupted',
    error: 'Interrupted before dispatch',
  });
  internal.deliverMail(envelope(4));
  claimMail(runtime, 't4');
  settleMail(runtime, 't4', { state: 'outcome-unknown' });
  await drain();
  t.deepEqual(
    posts.map(post => post.body),
    [
      'All done.',
      textOf.errorResult('provider broke'),
      textOf.errorResult('Interrupted before dispatch'),
      textOf.errorResult('outcome-unknown'),
    ],
  );
  t.is(posts[0].inReplyTo, postmark);
  t.deepEqual(posts[0].to, [alice]);
  t.deepEqual(posts[0].attachments, []);
  t.is(inbox.views().length, 0);
});

test('settle: an inline final over inlineBytes is cut; a staged final goes as it is', async t => {
  const { outbox, posts } = makeOutbox();
  const { internal, runtime } = makeInboxRuntime({ mail: outbox });
  internal.deliverMail(envelope(1));
  claimMail(runtime, 't1');
  settleMail(runtime, 't1', {
    state: 'completed',
    final: 'y'.repeat(limits.inlineBytes + 10),
  });
  const staged = harden({ blob: Far('Blob', {}), preview: 'p', bytes: 1e6 });
  internal.deliverMail(envelope(2));
  claimMail(runtime, 't2');
  settleMail(runtime, 't2', { state: 'completed', final: staged });
  await drain();
  t.is(posts[0].body.length, limits.inlineBytes);
  t.is(posts[1].body, staged);
});

test('settle of a request: completed and unanswered, rejected and removed; failed, kept and answerable later', async t => {
  const { inbox, internal, runtime } = makeInboxRuntime();
  const first = makeTicket();
  internal.deliverMail(
    envelope(1, { type: 'request', body: 'Q1', ticket: first.ticket }),
  );
  claimMail(runtime, 't1');
  settleMail(runtime, 't1', { state: 'completed', final: 'prose' });
  await drain();
  t.deepEqual(first.answers, [{ rejected: mailTexts.unansweredRequest }]);
  t.is(inbox.get(1), undefined);

  const second = makeTicket();
  internal.deliverMail(
    envelope(2, { type: 'request', body: 'Q2', ticket: second.ticket }),
  );
  claimMail(runtime, 't2');
  settleMail(runtime, 't2', { state: 'failed', error: 'boom' });
  t.is(inbox.get(2).state, 'kept');
  t.is(runtime.hooks.nextTurn(), undefined);
  // A later turn answers it: the ticket for the tool; a refused answer
  // leaves it open to retry, a sent one removes it.
  const refusedClaim = inbox.settleRequest(2);
  t.is(refusedClaim.ticket, second.ticket);
  t.is(inbox.settleRequest(2), undefined, 'one answer at a time');
  refusedClaim.settled(false);
  t.is(inbox.get(2).state, 'kept');
  const claim = inbox.settleRequest(2);
  t.is(claim.ticket, second.ticket);
  claim.settled(true);
  t.is(inbox.get(2), undefined);
  t.is(inbox.settleRequest(2), undefined);
  await drain();
  t.deepEqual(second.answers, []);
});

test('settle of a request answered in its own turn: removed, no rejection; a form stays unless submitted', async t => {
  const { inbox, internal, runtime } = makeInboxRuntime();
  const request = makeTicket();
  internal.deliverMail(
    envelope(1, { type: 'request', body: 'Q', ticket: request.ticket }),
  );
  claimMail(runtime, 't1');
  inbox.settleRequest(1).settled(true);
  t.is(inbox.get(1).state, 'handling');
  settleMail(runtime, 't1', { state: 'completed', final: 'answered' });
  t.is(inbox.get(1), undefined);

  const form = makeTicket();
  const fields = harden([harden({ name: 'a', kind: 'boolean' })]);
  internal.deliverMail(
    envelope(2, { type: 'form', body: 'F', ticket: form.ticket, fields }),
  );
  claimMail(runtime, 't2');
  settleMail(runtime, 't2', { state: 'completed', final: 'nope' });
  t.is(inbox.get(2).state, 'kept');
  internal.deliverMail(
    envelope(3, { type: 'form', body: 'G', ticket: form.ticket, fields }),
  );
  claimMail(runtime, 't3');
  t.is(inbox.settleRequest(3).ticket, form.ticket);
  settleMail(runtime, 't3', { state: 'completed', final: 'sent' });
  t.is(inbox.get(3), undefined);
  await drain();
  t.deepEqual(request.answers, []);
  t.deepEqual(form.answers, []);
});

test('a settle of another turn (a user turn) leaves the inbox alone', t => {
  const { inbox, internal, runtime } = makeInboxRuntime();
  internal.deliverMail(envelope(1));
  claimMail(runtime, 't1');
  settleMail(runtime, 'user-turn', { state: 'completed', final: 'x' });
  t.is(inbox.get(1).state, 'handling');
});

test('cancel: a waiting message is dismissed, a handling one cancels its turn and goes at settle', t => {
  const { inbox, internal, runtime } = makeInboxRuntime();
  internal.deliverMail(envelope(1));
  internal.deliverMail(envelope(2));
  const { ticket } = makeTicket();
  internal.deliverMail(envelope(3, { type: 'request', body: 'Q', ticket }));
  const [one, two, three] = [1, 2, 3].map(n => inbox.get(n).postmark);
  claimMail(runtime, 't1');
  t.is(inbox.cancel(two), 'dismissed');
  t.is(inbox.get(2), undefined);
  t.is(inbox.cancel(one), 'cancel-turn');
  settleMail(runtime, 't1', { state: 'cancelled' });
  t.is(inbox.get(1), undefined);
  // A cancelled request is removed at its settle, not kept.
  claimMail(runtime, 't3');
  t.is(inbox.cancel(three), 'cancel-turn');
  settleMail(runtime, 't3', { state: 'cancelled' });
  t.is(inbox.get(3), undefined);
  t.is(inbox.cancel(12_345), 'none');
});

// ---------------------------------------------------------------- tools' side

test('views newest first, at most listMessagesPage; dismiss refuses unhandled and unknown messages', t => {
  const { inbox, internal, runtime } = makeInboxRuntime();
  internal.deliverMail(envelope(1));
  internal.deliverMail(
    envelope(2, { type: 'reply', attachments: attach(['a']) }),
  );
  internal.deliverMail(envelope(3));
  claimMail(runtime, 't1');
  t.deepEqual(
    inbox.views().map((/** @type {any} */ v) => [v.number, v.state]),
    [
      [3, 'waiting'],
      [2, 'kept'],
      [1, 'handling'],
    ],
  );
  t.deepEqual(inbox.views({ limit: 1 })[0].edges, []);
  t.deepEqual(inbox.views()[1].edges, ['a']);
  t.deepEqual(inbox.dismiss(1), {
    refused: mailTextOf.dismissUnhandled(1),
  });
  t.deepEqual(inbox.dismiss(3), {
    refused: mailTextOf.dismissUnhandled(3),
  });
  t.deepEqual(inbox.dismiss(9), { refused: mailTexts.noSuchMessage });
  t.deepEqual(inbox.dismiss(2), { ok: true });
  t.is(inbox.get(2), undefined);
});

test('blobs: the staged bodies the inbox holds, released from the list when removed', t => {
  const { inbox, internal, runtime } = makeInboxRuntime();
  const body = harden({ blob: Far('Blob', {}), preview: 'p', bytes: 9000 });
  internal.deliverMail(envelope(1, { body }));
  internal.deliverMail(envelope(2));
  t.deepEqual(inbox.blobs(), [body]);
  claimMail(runtime, 't1');
  settleMail(runtime, 't1', { state: 'completed', final: 'ok' });
  t.deepEqual(inbox.blobs(), []);
});

// ---------------------------------------------------------------- export

/**
 * Every page of an inbox's export, from `m0` to the end cursor.
 * @param {any} inbox
 */
const exportAll = inbox => {
  /** @type {any[]} */
  const pages = [];
  let cursor = 'm0';
  while (cursor !== 'e') {
    const page = inbox.exportPage(Number(cursor.slice(1)));
    pages.push(page);
    cursor = page.next;
  }
  return pages;
};

test('export pages round-trip into a new inbox: kept, read-only, nothing starts, the counter raised', t => {
  const { inbox, internal, runtime } = makeInboxRuntime();
  const { ticket } = makeTicket();
  const staged = harden({ blob: Far('Blob', {}), preview: 'p', bytes: 9000 });
  const big = 'z'.repeat(8000);
  internal.deliverMail(envelope(1, { body: staged }));
  internal.deliverMail(envelope(2, { type: 'reply', body: big }));
  internal.deliverMail(
    envelope(3, {
      type: 'form',
      body: 'F',
      ticket,
      fields: harden([harden({ name: 'n', kind: 'decimal', default: '1' })]),
    }),
  );
  internal.deliverMail(
    envelope(4, { type: 'reply', body: big, cutFrom: 20_000, inReplyTo: 7 }),
  );
  internal.deliverMail(
    envelope(5, { type: 'value', body: big, attachments: attach(['x']) }),
  );
  claimMail(runtime, 't1');

  const pages = exportAll(inbox);
  t.true(pages.length > 1);
  for (const page of pages) {
    t.true(messageBytes(page) <= limits.frameBytes);
    t.true(matches(page, shapes.SessionExportPage), JSON.stringify(page.next));
  }
  const exported = pages.flatMap(page => page.messages);
  t.deepEqual(
    exported.map(m => [m.number, m.type, m.state]),
    [
      [1, 'package', 'handling'],
      [2, 'reply', 'kept'],
      [3, 'form', 'waiting'],
      [4, 'reply', 'kept'],
      [5, 'value', 'kept'],
    ],
  );
  t.is(exported[0].body, staged);
  t.deepEqual(exported[4].edges, ['x']);
  t.is(exported[3].cutFrom, 20_000);
  t.false('from' in exported[0]);
  t.false('ticket' in exported[2]);

  const target = makeInboxRuntime();
  for (const page of pages) target.inbox.importPage(page);
  // A page sent again is applied without effect.
  target.inbox.importPage(pages[0]);
  const views = target.inbox.views();
  t.deepEqual(
    views.map((/** @type {any} */ v) => [v.number, v.state]),
    [
      [5, 'kept'],
      [4, 'kept'],
      [3, 'kept'],
      [2, 'kept'],
      [1, 'kept'],
    ],
  );
  t.true(target.inbox.get(3).imported);
  t.is(target.inbox.get(1).body, staged);
  t.deepEqual(target.inbox.blobs(), [staged]);
  t.is(target.runtime.hooks.nextTurn(), undefined);
  // Read-only: no ticket to answer (the tools say mailTexts.imported).
  t.is(target.inbox.settleRequest(3), undefined);
  t.is(target.inbox.cancel(target.inbox.get(3).postmark), 'none');
  t.deepEqual(target.inbox.dismiss(3), { ok: true });
  // The packages counter resumes above the highest imported number at
  // the import, so a package opened before the next delivery (an imported
  // queue entry's) cannot reuse one.
  const opened = /** @type {any} */ (target.runtime).packages.table.open({
    labels: harden([]),
    values: new Map(),
    turnId: 'queued',
  });
  t.true(opened > 5);
  t.deepEqual(target.internal.deliverMail(envelope(1)), {
    number: opened + 1,
  });
  t.is(target.runtime.hooks.nextTurn().text, 'message 1');
  // ... and the session is not new any more.
  t.throws(() => target.inbox.importPage(pages[0]), {
    message: 'only a new session imports mail',
  });
});

test('importPage refuses an unknown type or state, more than 256 messages, a page over frameBytes', t => {
  const item = harden({
    number: 1,
    type: 'package',
    fromTitle: 'A',
    body: 'b',
    edges: harden([]),
    at: AT,
    state: 'kept',
  });
  /** @param {any[]} messages */
  const page = messages => harden({ part: 'inbox', messages, next: 'e' });
  t.throws(
    () =>
      makeInboxRuntime().inbox.importPage(page([{ ...item, state: 'lost' }])),
    { message: /not an inbox message/ },
  );
  t.throws(
    () =>
      makeInboxRuntime().inbox.importPage(
        page([{ ...item, type: 'definition' }]),
      ),
    { message: /not an inbox message/ },
  );
  const { inbox } = makeInboxRuntime();
  for (let n = 1; n <= mailLimits.inboxMessages; n += 1) {
    inbox.importPage(page([{ ...item, number: n }]));
  }
  t.throws(() => inbox.importPage(page([{ ...item, number: 1000 }])), {
    message: /at most 256/,
  });
  t.throws(
    () =>
      makeInboxRuntime().inbox.importPage(
        page([{ ...item, body: 'q'.repeat(limits.frameBytes) }]),
      ),
    { message: 'an inbox page over frameBytes' },
  );
});
