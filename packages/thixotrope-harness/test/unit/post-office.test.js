// @ts-check
// The post office in Node (designs/m9-interfaces.md D-M9-2, D-M9-8, D-M9-13,
// 3.1, 4.1-4.3, 5.2 KM2/KM3, acceptance 6, 13, 18, 22).
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import {
  blob,
  makeMailWorld,
  settle,
  stagedText,
} from './_post-office-fakes.js';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import {
  texts as postOfficeTexts,
  textOf as postOfficeTextOf,
} from '../../guest/lib/guards/factory.js';
import { REDRIVE_WINDOW } from '../../guest/factory/post-office.js';
import { texts } from '../../guest/lib/guards/session.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

const none = harden([]);

test('addresses and outboxes are minted once per row and recognised by amplification', async t => {
  const world = makeMailWorld();
  const a = world.addSession('Alpha');
  const { postOffice } = world;
  t.is(postOffice.addressFor(a.row), a.address);
  t.is(postOffice.outboxFor(a.row), a.outbox);
  t.deepEqual(await E(a.address).describe(), {
    title: 'Alpha',
    kind: 'session',
  });
  t.deepEqual(await E(postOffice.operatorAddress()).describe(), {
    title: 'user',
    kind: 'operator',
  });
  t.is(/** @type {any} */ (postOffice.recipientOf(a.address))?.row, a.row);
  t.is(postOffice.recipientOf(Far('Stranger', {})), undefined);
  t.is(postOffice.recipientOf(a.outbox), undefined);
});

test('a package goes to every recipient with the sender stamped, in its own seq', async t => {
  const world = makeMailWorld();
  const a = world.addSession('Alpha');
  const b = world.addSession('Beta');
  const c = world.addSession('Gamma');
  const attachment = Far('Thing', {});
  const receipt = await E(a.outbox).post(
    harden({
      to: [b.address, c.address],
      body: 'hello',
      attachments: [{ label: 'thing', value: attachment }],
    }),
  );
  t.is(receipt.results.length, 2);
  const [toB, toC] = receipt.results;
  t.true(typeof toB.postmark === 'number' && toB.postmark !== toC.postmark);
  t.is(b.envelopes.length, 1);
  const [envelope] = b.envelopes;
  t.is(envelope.type, 'package');
  t.is(envelope.from, a.address);
  t.is(envelope.fromTitle, 'Alpha');
  t.is(envelope.body, 'hello');
  t.is(envelope.seq, 1);
  t.is(envelope.postmark, toB.postmark);
  t.is(envelope.attachments[0].value, attachment);
  t.is(envelope.at, 1_700_000_000_000);
  t.is(c.envelopes[0].seq, 1);
  await E(a.outbox).post(
    harden({ to: [b.address], body: 'two', attachments: none }),
  );
  t.is(b.envelopes[1].seq, 2);
  t.is(world.postOffice.status().inFlight, 0);
  t.is(world.postOffice.status().keptBytes, 0);
});

test('a recipient the post office did not mint is refused and never called (acceptance 6)', async t => {
  const world = makeMailWorld();
  const a = world.addSession('Alpha');
  const b = world.addSession('Beta');
  let calls = 0;
  const stranger = Far('Inventory', {
    deliverMail: () => {
      calls += 1;
    },
    describe: () => {
      calls += 1;
    },
  });
  const receipt = await E(a.outbox).post(
    harden({ to: [stranger, b.address], body: 'x', attachments: none }),
  );
  t.deepEqual(receipt.results[0], { refused: postOfficeTexts.notAnAddress });
  t.true(typeof receipt.results[1].postmark === 'number');
  await settle();
  t.is(calls, 0);
});

test('a staged package body is copied once per recipient; the sender keeps its blob', async t => {
  const world = makeMailWorld();
  const a = world.addSession('Alpha');
  const b = world.addSession('Beta');
  const c = world.addSession('Gamma');
  const body = stagedText(20_000);
  await E(a.outbox).post(
    harden({ to: [b.address, c.address], body, attachments: none }),
  );
  t.is(world.copies.length, 2);
  t.true(world.copies.every(({ source }) => source === body.blob));
  t.deepEqual(world.copies[0].options, { from: a.session, to: b.session });
  t.deepEqual(world.copies[1].options, { from: a.session, to: c.session });
  t.is(b.envelopes[0].body, world.copies[0].copied);
  t.not(b.envelopes[0].body, c.envelopes[0].body);
  t.deepEqual(world.released, []);
  t.is(world.relays(), 1, 'the relay writers are fetched once');
});

test('a retired relay is fetched again once; a second break fails that recipient', async t => {
  const world = makeMailWorld();
  const a = world.addSession('Alpha');
  const b = world.addSession('Beta');
  world.failures.copy = 1;
  const first = await E(a.outbox).post(
    harden({ to: [b.address], body: stagedText(9000), attachments: none }),
  );
  t.true(typeof first.results[0].postmark === 'number');
  t.is(world.relays(), 2);
  world.failures.copy = 2;
  const second = await E(a.outbox).post(
    harden({ to: [b.address], body: stagedText(9000), attachments: none }),
  );
  t.truthy(second.results[0].refused);
  t.is(b.envelopes.length, 1);
});

test('a reply goes back to the sender kept inline; a staged reply is cut to its preview (acceptance 13)', async t => {
  const world = makeMailWorld();
  const a = world.addSession('Alpha');
  const b = world.addSession('Beta');
  const { results } = await E(a.outbox).post(
    harden({ to: [b.address], body: 'question', attachments: none }),
  );
  const { postmark } = results[0];
  const long = stagedText(20_000, 'the answer begins');
  const receipt = await E(b.outbox).post(
    harden({
      to: [a.address],
      body: long,
      attachments: none,
      inReplyTo: postmark,
    }),
  );
  t.true(typeof receipt.results[0].postmark === 'number');
  t.not(
    receipt.results[0].postmark,
    postmark,
    'the reply has its own postmark',
  );
  const [reply] = a.envelopes;
  t.is(reply.type, 'reply');
  t.is(reply.inReplyTo, postmark);
  t.is(reply.from, b.address);
  t.is(reply.body, `the answer begins${postOfficeTextOf.bodyCut(20_000)}`);
  t.is(reply.cutFrom, 20_000);
  t.is(world.copies.length, 0, 'a kept message holds no file');
});

test('a reply naming a postmark not delivered to the replier is mail fraud (acceptance 6)', async t => {
  const world = makeMailWorld();
  const a = world.addSession('Alpha');
  const b = world.addSession('Beta');
  const c = world.addSession('Gamma');
  const { results } = await E(a.outbox).post(
    harden({ to: [b.address], body: 'q', attachments: none }),
  );
  const { postmark } = results[0];
  await t.throwsAsync(
    E(c.outbox).post(
      harden({
        to: [a.address],
        body: 'forged',
        attachments: none,
        inReplyTo: postmark,
      }),
    ),
    { message: postOfficeTexts.mailFraud },
  );
  await t.throwsAsync(
    E(b.outbox).post(
      harden({
        to: [c.address],
        body: 'misrouted',
        attachments: none,
        inReplyTo: postmark,
      }),
    ),
    { message: postOfficeTexts.mailFraud },
  );
  await t.throwsAsync(
    E(b.outbox).post(
      harden({
        to: [a.address],
        body: 'x',
        attachments: none,
        inReplyTo: 9999,
      }),
    ),
    { message: postOfficeTexts.mailFraud },
  );
  t.is(a.envelopes.length, 0);
});

test('a reply to an open ask goes to its listener; one to a closed postmark is consumed (D-M9-8)', async t => {
  const world = makeMailWorld();
  const p = world.addSession('Parent');
  const c = world.addSession('Child');
  /** @type {any[]} */
  const replies = [];
  const receipt = await world.postOffice.post({
    from: { row: p.row },
    draft: harden({ to: [c.address], body: 'task', attachments: none }),
    at: 1_700_000_000_500,
    onReply: reply => replies.push(reply),
  });
  const { postmark } = receipt.results[0];
  t.is(c.envelopes[0].at, 1_700_000_000_500);
  t.is(world.postOffice.status().asks, 1);
  await E(c.outbox).post(
    harden({
      to: [p.address],
      body: 'done',
      attachments: none,
      inReplyTo: postmark,
    }),
  );
  t.is(replies.length, 1);
  t.like(replies[0], { body: 'done', fromTitle: 'Child', postmark });
  t.is(p.envelopes.length, 0, 'an ask reply never reaches the inbox');
  // A second reply to the same postmark: the ask is closed, so consumed.
  await E(c.outbox).post(
    harden({
      to: [p.address],
      body: 'again',
      attachments: none,
      inReplyTo: postmark,
    }),
  );
  t.is(replies.length, 1);
  t.is(p.envelopes.length, 0);
  // A closed postmark (a timed-out ask) consumes its reply too.
  const second = await E(p.outbox).post(
    harden({ to: [c.address], body: 'task 2', attachments: none }),
  );
  const pm2 = second.results[0].postmark;
  t.true(world.postOffice.onReply(pm2, reply => replies.push(reply)));
  world.postOffice.closePostmark(pm2);
  t.false(world.postOffice.onReply(pm2, () => {}));
  await E(c.outbox).post(
    harden({
      to: [p.address],
      body: 'late',
      attachments: none,
      inReplyTo: pm2,
    }),
  );
  t.is(replies.length, 1);
  t.is(p.envelopes.length, 0);
  t.is(world.postOffice.status().asks, 0);
});

test('cancelDelivery closes the postmark and tells the recipient to cancel', async t => {
  const world = makeMailWorld();
  const p = world.addSession('Parent');
  const c = world.addSession('Child');
  const { results } = await E(p.outbox).post(
    harden({ to: [c.address], body: 'task', attachments: none }),
  );
  world.postOffice.cancelDelivery(results[0].postmark);
  await settle();
  t.deepEqual(c.cancelled, [results[0].postmark]);
  await E(c.outbox).post(
    harden({
      to: [p.address],
      body: 'late',
      attachments: none,
      inReplyTo: results[0].postmark,
    }),
  );
  t.is(p.envelopes.length, 0);
});

test('an envelope over envelopeBytes is refused before any delivery', async t => {
  const world = makeMailWorld();
  const b = world.addSession('Beta');
  const fields = harden(
    Array.from({ length: limits.formFields }, (_, i) =>
      harden({
        name: `field${i}`,
        kind: 'string',
        description: 'd'.repeat(limits.formFieldDescriptionUnits),
        default: `"${'x'.repeat(limits.formDefaultUnits - 2)}"`,
      }),
    ),
  );
  await t.throwsAsync(
    world.postOffice.post({
      from: { operator: true },
      draft: harden({ to: [b.address], body: 'fill this', attachments: none }),
      type: 'form',
      fields,
    }),
    { message: /^The message is \d+ bytes .* the limit is 22528$/ },
  );
  t.is(b.envelopes.length, 0);
  t.is(world.postOffice.status().inFlight, 0);
});

test('a full inbox refuses the delivery; the copy made for it is released', async t => {
  const world = makeMailWorld({ inboxLimit: 1 });
  const a = world.addSession('Alpha');
  const b = world.addSession('Beta');
  await E(a.outbox).post(
    harden({ to: [b.address], body: 'one', attachments: none }),
  );
  const receipt = await E(a.outbox).post(
    harden({ to: [b.address], body: stagedText(9000), attachments: none }),
  );
  t.deepEqual(receipt.results[0], { refused: 'inbox of Beta is full' });
  await settle();
  t.deepEqual(world.released, [world.copies[0].copied.blob]);
});

test('a lost recipient is marked lost and refused with recipientLost, then and later', async t => {
  const world = makeMailWorld();
  const a = world.addSession('Alpha');
  const b = world.addSession('Beta');
  b.state.retired = true;
  const first = await E(a.outbox).post(
    harden({ to: [b.address], body: 'x', attachments: none }),
  );
  t.deepEqual(first.results[0], {
    refused: postOfficeTextOf.recipientLost('Beta'),
  });
  t.is(b.row.state, 'lost');
  const calls = b.state.calls;
  const second = await E(a.outbox).post(
    harden({ to: [b.address], body: 'y', attachments: none }),
  );
  t.deepEqual(second.results[0], {
    refused: postOfficeTextOf.recipientLost('Beta'),
  });
  t.is(b.state.calls, calls, 'no call to a lost row');
});

test('a removed row refuses its undelivered and later mail with recipientLost (acceptance 18)', async t => {
  const world = makeMailWorld();
  const a = world.addSession('Alpha');
  const b = world.addSession('Beta');
  b.stall();
  const pending = E(a.outbox).post(
    harden({ to: [b.address], body: 'x', attachments: none }),
  );
  await settle();
  t.is(world.postOffice.status().inFlight, 1);
  world.rows.drop(b.row);
  world.postOffice.rowRemoved(b.row);
  t.deepEqual((await pending).results[0], {
    refused: postOfficeTextOf.recipientLost('Beta'),
  });
  t.is(world.postOffice.status().inFlight, 0);
  const later = await E(a.outbox).post(
    harden({ to: [b.address], body: 'y', attachments: none }),
  );
  t.deepEqual(later.results[0], {
    refused: postOfficeTextOf.recipientLost('Beta'),
  });
  b.release();
});

test('the in-flight bound holds in bytes and in rows; posts are accepted again once deliveries answer (acceptance 22)', async t => {
  // The fake inbox holds every delivery: only the post office bounds here.
  const world = makeMailWorld({ inboxLimit: 4096 });
  const a = world.addSession('Alpha');
  const b = world.addSession('Beta');
  b.stall();
  const body = 'x'.repeat(limits.inlineBytes);
  const busy = {
    refused: postOfficeTextOf.postOfficeBusy(limits.postInFlight),
  };
  /** @type {Promise<any>[]} */
  const accepted = [];
  let refused;
  for (let i = 0; i < 1000; i += 1) {
    const before = world.postOffice.status().inFlight;
    const receipt = world.postOffice.post({
      from: { row: a.row },
      draft: harden({ to: [b.address], body, attachments: none }),
    });
    // Admission is synchronous, in the post's crank.
    if (world.postOffice.status().inFlight === before) {
      // eslint-disable-next-line no-await-in-loop
      refused = await receipt;
      break;
    }
    accepted.push(receipt);
  }
  t.deepEqual(refused?.results[0], busy);
  const { keptBytes, inFlight } = world.postOffice.status();
  t.is(inFlight, accepted.length);
  t.true(keptBytes <= limits.postInFlightBytes);
  t.true(keptBytes + limits.inlineBytes > limits.postInFlightBytes);
  t.log(
    `${inFlight} envelopes of ${limits.inlineBytes} bytes, ${keptBytes} kept bytes`,
  );
  b.release();
  const answered = await Promise.all(accepted);
  t.true(answered.every(r => typeof r.results[0].postmark === 'number'));
  t.is(world.postOffice.status().keptBytes, 0);
  const again = await E(a.outbox).post(
    harden({ to: [b.address], body, attachments: none }),
  );
  t.true(typeof again.results[0].postmark === 'number');

  // Rows: small envelopes stop at postInFlight.
  b.stall();
  /** @type {Promise<any>[]} */
  const small = [];
  for (let i = 0; i < limits.postInFlight; i += 1) {
    small.push(
      world.postOffice.post({
        from: { row: a.row },
        draft: harden({ to: [b.address], body: 's', attachments: none }),
      }),
    );
  }
  await settle();
  t.is(world.postOffice.status().inFlight, limits.postInFlight);
  const over = await world.postOffice.post({
    from: { row: a.row },
    draft: harden({ to: [b.address], body: 's', attachments: none }),
  });
  t.deepEqual(over.results[0], busy);
  b.release();
  await Promise.all(small);
  t.is(world.postOffice.status().inFlight, 0);
});

test('a restart re-drives deliveries stamped with an earlier start, with the same seq (KM2, KM3)', async t => {
  const world = makeMailWorld();
  const a = world.addSession('Alpha');
  const b = world.addSession('Beta');
  const current = world.starts.next();
  b.stall();
  const pending = E(a.outbox).post(
    harden({ to: [b.address], body: 'across a restart', attachments: none }),
  );
  await settle();
  t.is(b.state.calls, 1);
  // The same start: nothing to re-drive.
  await world.postOffice.restart(current);
  await settle();
  t.is(b.state.calls, 1);
  // The daemon restarts: the first send is never answered (C-10 stand-in);
  // the re-drive is answered.
  const gate = b.state.gate;
  b.state.gate = undefined;
  await world.postOffice.restart(world.starts.next());
  const receipt = await pending;
  t.true(typeof receipt.results[0].postmark === 'number');
  t.is(b.state.calls, 2);
  t.is(b.envelopes.length, 1);
  t.is(world.postOffice.status().redriven, 1);
  // The original send answers late: a duplicate, nothing changes.
  gate?.resolve(undefined);
  await settle();
  t.is(b.envelopes.length, 1);
  t.is(world.postOffice.status().inFlight, 0);
});

test('a re-drive older than the outcome ring is reported as an unknown outcome, not delivered', async t => {
  const world = makeMailWorld();
  const a = world.addSession('Alpha');
  const b = world.addSession('Beta');
  world.starts.next();
  // The first send reaches Beta's inbox, but its answer is lost.
  b.state.loseAnswers = true;
  const pending = E(a.outbox).post(
    harden({ to: [b.address], body: 'lost answer', attachments: none }),
  );
  await settle();
  t.is(b.envelopes.length, 1);
  // Beta's ring no longer holds that seq when the restart re-drives it.
  b.forgetOutcomes();
  b.state.loseAnswers = false;
  await world.postOffice.restart(world.starts.next());
  const receipt = await pending;
  t.deepEqual(receipt.results, [{ refused: texts.toolOutcomeUnknown }]);
  t.is(b.envelopes.length, 1, 'not delivered twice');
  t.is(world.postOffice.status().inFlight, 0);
});

test('a re-drive keeps at most REDRIVE_WINDOW deliveries in flight', async t => {
  const world = makeMailWorld();
  const a = world.addSession('Alpha');
  const b = world.addSession('Beta');
  world.starts.next();
  b.stall();
  const total = REDRIVE_WINDOW + 8;
  /** @type {Promise<any>[]} */
  const posts = [];
  for (let i = 0; i < total; i += 1) {
    posts.push(
      E(a.outbox).post(
        harden({ to: [b.address], body: `m${i}`, attachments: none }),
      ),
    );
  }
  await settle();
  t.is(b.state.calls, total);
  await world.postOffice.restart(world.starts.next());
  await settle();
  t.is(b.state.calls, total + REDRIVE_WINDOW, 'the first window only');
  b.release();
  await Promise.all(posts);
  await settle();
  t.is(b.envelopes.length, total);
  t.is(world.postOffice.status().inFlight, 0);
});

test('a staged body re-driven before its copy answered is copied again; the spare copy is released (KM12)', async t => {
  const world = makeMailWorld();
  const a = world.addSession('Alpha');
  const b = world.addSession('Beta');
  world.starts.next();
  const body = stagedText(9000);
  world.stallCopies();
  const receipt = E(a.outbox).post(
    harden({ to: [b.address], body, attachments: none }),
  );
  await settle();
  // The restart lands before the first copy answers.
  await world.postOffice.restart(world.starts.next());
  world.releaseCopies();
  const { results } = await receipt;
  await settle();
  t.true(typeof results[0].postmark === 'number');
  t.is(world.copies.length, 2);
  t.is(b.envelopes.length, 1);
  t.deepEqual(world.released.length, 1);
  t.true(world.copies.some(({ copied }) => copied.blob === world.released[0]));
  t.not(b.envelopes[0].body.blob, world.released[0]);
});

test('a deleted sender cannot post; a blob given to a stranger is no address', async t => {
  const world = makeMailWorld();
  const a = world.addSession('Alpha');
  const b = world.addSession('Beta');
  world.rows.drop(a.row);
  await t.throwsAsync(
    E(a.outbox).post(harden({ to: [b.address], body: 'x', attachments: none })),
    { message: postOfficeTexts.notASession },
  );
  const c = world.addSession('Gamma');
  const receipt = await E(c.outbox).post(
    harden({ to: [blob()], body: 'x', attachments: none }),
  );
  t.deepEqual(receipt.results[0], { refused: postOfficeTexts.notAnAddress });
});

test('bindAddress makes a handle an address of its row; a child row is a subagent', async t => {
  const world = makeMailWorld();
  const p = world.addSession('Parent');
  const c = world.addSession('Parent / helper');
  /** @type {any} */ (c.row).parent = p.row;
  const handle = Far('SubagentHandle', {});
  world.postOffice.bindAddress(handle, c.row);
  await E(p.outbox).post(
    harden({ to: [handle], body: 'x', attachments: none }),
  );
  t.is(c.envelopes.length, 1);
  t.deepEqual(await E(c.address).describe(), {
    title: 'Parent / helper',
    kind: 'subagent',
  });
});
