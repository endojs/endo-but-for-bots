// @ts-check
import { E, Far } from '@endo/far';
import test from '@endo/ses-ava/test.js';
import { setImmediate } from 'node:timers/promises';

import { makeMailbox as makeProtocolMailbox } from '../src/mail/mailbox.js';
import { makeMailContact } from '../src/mail/mail-contact.js';
import { makeMailAddressBook } from '../src/mail/mail-address-book.js';

const makeMailbox = () =>
  makeMailAddressBook(makeProtocolMailbox(), new Map(), makeMailContact);

const makeCounter = () => {
  let count = 0n;
  return Far('Counter', {
    incr: () => {
      count += 1n;
      return count;
    },
  });
};

const deferred = () => {
  /** @type {(value: any) => void} */
  let resolve = () => {};
  /** @type {(reason: Error) => void} */
  let reject = () => {};
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test('mailbox invitation is single-use and idempotent for the same receiver', async t => {
  t.timeout(10_000);
  const mailbox = makeMailbox();
  const invitation = await E(mailbox).invite('Bob');
  const receiver = Far('BobInbox', { deliver: () => true });
  const first = await E(invitation).accept(receiver);
  t.is(await E(invitation).accept(receiver), first);
  await t.throwsAsync(() => E(invitation).accept(Far('Other', {})), {
    message: /already redeemed/,
  });
  await t.throwsAsync(() => E(mailbox).invite('Bob'), {
    message: /already reserved/,
  });
  t.deepEqual(await E(mailbox).contacts(), [
    { name: 'Bob', status: 'ready', error: undefined },
  ]);
});

test('mailbox receivers bind local sender labels and deduplicate delivery', async t => {
  t.timeout(10_000);
  const mailbox = makeMailbox();
  const invitation = await E(mailbox).invite('locally named Bob');
  const receiver = await E(invitation).accept(
    Far('Untrusted claimed identity', {}),
  );
  const counter = makeCounter();
  const impostor = makeCounter();
  t.true(await E(receiver).deliver(1n, 'From Alice', counter));
  t.true(await E(receiver).deliver(1n, 'replacement', impostor));
  t.true(await E(receiver).deliver(3n, 'second', counter));
  t.true(await E(receiver).deliver(2n, 'earlier retry', impostor));
  t.true(await E(receiver).deliver(1n, 'old retry', impostor));
  t.deepEqual(await E(mailbox).inbox(), [
    { id: '1', from: 'locally named Bob', text: 'From Alice' },
    { id: '2', from: 'locally named Bob', text: 'second' },
  ]);
  t.is(await E(mailbox).take('1'), counter);
  t.is(await E(mailbox).take('2'), counter);
});

test('mailbox validation does not consume an invitation or an inbound sequence', async t => {
  t.timeout(10_000);
  const mailbox = makeMailbox();
  /** @type {any[]} */
  const invalidNames = ['', 'x'.repeat(129), 1, undefined];
  await null;
  for (const name of invalidNames) {
    // Each assertion awaits the rejection of a separate boundary invocation.
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(mailbox).invite(name), {
      message: /contact name/,
    });
  }
  const invitation = await E(mailbox).invite('valid');
  await t.throwsAsync(() => E(invitation).accept({}), { message: /remotable/ });
  const receiver = await E(invitation).accept(Far('Receiver', {}));
  const counter = makeCounter();
  await t.throwsAsync(() => E(receiver).deliver(0n, 'text', counter), {
    message: /Invalid message sequence/,
  });
  await t.throwsAsync(
    () => E(receiver).deliver(/** @type {any} */ (1), 'text', counter),
    {
      message: /Invalid message sequence/,
    },
  );
  await t.throwsAsync(
    () => E(receiver).deliver(1n, 'x'.repeat(4097), counter),
    { message: /4096/ },
  );
  await t.throwsAsync(() => E(receiver).deliver(1n, 'text', {}), {
    message: /remotable/,
  });
  t.true(await E(receiver).deliver(1n, 'x'.repeat(4096), counter));
  t.is((await E(mailbox).inbox()).length, 1);
  await t.throwsAsync(() => E(mailbox).connect('still available', {}), {
    message: /remotable/,
  });
  await E(mailbox).invite('still available');
});

test('mailbox connection tracks pending, ready and rejected introductions', async t => {
  t.timeout(10_000);
  const mailbox = makeMailbox();
  const answer = deferred();
  const invitation = Far('DeferredInvitation', {
    accept: () => answer.promise,
  });
  await E(mailbox).connect('pending', invitation);
  t.is((await E(mailbox).contacts())[0].status, 'pending');
  await t.throwsAsync(
    () => E(mailbox).send('pending', 'hello', makeCounter()),
    { message: /not ready/ },
  );
  answer.resolve(Far('RemoteInbox', { deliver: () => true }));
  await setImmediate();
  t.is((await E(mailbox).contacts())[0].status, 'ready');
  const failure = deferred();
  await E(mailbox).connect(
    'refused',
    Far('RefusedInvitation', { accept: () => failure.promise }),
  );
  failure.reject(Error('refused introduction'));
  await setImmediate();
  const refused = (await E(mailbox).contacts())[1];
  t.is(refused.status, 'failed');
  t.regex(refused.error, /refused introduction/);
  await t.throwsAsync(
    () => E(mailbox).send('refused', 'hello', makeCounter()),
    { message: /not ready/ },
  );
});

test('mailbox marks an introduction failed when its result is not a capability', async t => {
  t.timeout(10_000);
  const mailbox = makeMailbox();
  await E(mailbox).connect(
    'malformed',
    Far('MalformedInvitation', { accept: () => ({}) }),
  );
  await setImmediate();
  const contact = (await E(mailbox).contacts())[0];
  t.is(contact.status, 'failed');
  t.regex(contact.error, /remotable/);
});

test('mailbox outbox distinguishes accepted invocation, delivery and rejection', async t => {
  t.timeout(10_000);
  const mailbox = makeMailbox();
  const first = deferred();
  /** @type {Array<{sequence: bigint, text: string, capability: any}>} */
  const calls = [];
  const receiver = Far('RemoteInbox', {
    /**
     * @param {bigint} sequence
     * @param {string} text
     * @param {any} capability
     */
    deliver: (sequence, text, capability) => {
      calls.push({ sequence, text, capability });
      if (sequence === 1n) return first.promise;
      throw Error('receiver refused');
    },
  });
  const invitation = await E(mailbox).invite('Bob');
  await E(invitation).accept(receiver);
  const counter = makeCounter();
  await t.throwsAsync(() => E(mailbox).send('Bob', 'x'.repeat(4097), counter), {
    message: /4096/,
  });
  await t.throwsAsync(() => E(mailbox).send('Bob', 'text', {}), {
    message: /remotable/,
  });
  t.deepEqual(await E(mailbox).outbox(), []);
  t.is(await E(mailbox).send('Bob', 'counter', counter), '1');
  await setImmediate();
  t.deepEqual(await E(mailbox).outbox(), [
    {
      id: '1',
      to: 'Bob',
      text: 'counter',
      status: 'sending',
      error: undefined,
    },
  ]);
  t.deepEqual(calls, [{ sequence: 1n, text: 'counter', capability: counter }]);
  first.resolve(true);
  await setImmediate();
  t.is((await E(mailbox).outbox())[0].status, 'delivered');
  t.is(await E(mailbox).send('Bob', 'another', counter), '2');
  await setImmediate();
  const failed = (await E(mailbox).outbox())[1];
  t.is(failed.status, 'failed');
  t.regex(failed.error, /receiver refused/);
  t.deepEqual(
    calls.map(({ sequence }) => sequence),
    [1n, 2n],
  );
});

test('mailbox take preserves reference identity and discard releases only the offer', async t => {
  t.timeout(10_000);
  const mailbox = makeMailbox();
  const invitation = await E(mailbox).invite('Bob');
  const receiver = await E(invitation).accept(Far('Remote', {}));
  const counter = makeCounter();
  await E(receiver).deliver(1n, 'counter', counter);
  const taken = await E(mailbox).take('1');
  t.is(taken, counter);
  t.is(await E(mailbox).take('1'), taken);
  t.is(await E(taken).incr(), 1n);
  t.true(await E(mailbox).discard('1'));
  t.false(await E(mailbox).discard('1'));
  await t.throwsAsync(() => E(mailbox).take('1'), { message: /Unknown offer/ });
  t.deepEqual(await E(mailbox).inbox(), []);
  t.is(await E(taken).incr(), 2n);
});

test('mailbox contact names safely include object prototype property names', async t => {
  t.timeout(10_000);
  const alice = makeMailbox();
  const bob = makeMailbox();
  const invitation = await E(alice).invite('__proto__');
  await E(bob).connect('constructor', invitation);
  await setImmediate();
  const counter = makeCounter();
  await E(bob).send('constructor', 'hello', counter);
  await setImmediate();
  t.deepEqual(await E(alice).inbox(), [
    { id: '1', from: '__proto__', text: 'hello' },
  ]);
  await E(alice).send('__proto__', 'reply', counter);
  await setImmediate();
  t.deepEqual(await E(bob).inbox(), [
    { id: '1', from: 'constructor', text: 'reply' },
  ]);
  t.is(await E(alice).take('1'), await E(bob).take('1'));
});

test('mailbox failed admission does not poison the next offer sequence', async t => {
  t.timeout(10_000);
  const sender = makeMailbox();
  const destination = makeMailbox();
  const destinationInvitation = await E(destination).invite('Alice');
  const destinationReceiver = await E(destinationInvitation).accept(
    Far('AliceInbox', {}),
  );
  const transport = Far('FailFirstAdmission', {
    /**
     * @param {bigint} sequence
     * @param {string} text
     * @param {any} capability
     */
    deliver: (sequence, text, capability) => {
      if (sequence === 1n) throw Error('not admitted');
      return E(destinationReceiver).deliver(sequence, text, capability);
    },
  });
  const invitation = await E(sender).invite('Bob');
  await E(invitation).accept(transport);
  const counter = makeCounter();
  t.is(await E(sender).send('Bob', 'lost before acceptance', counter), '1');
  await setImmediate();
  t.is((await E(sender).outbox())[0].status, 'failed');
  t.deepEqual(await E(destination).inbox(), []);
  t.is(await E(sender).send('Bob', 'accepted later', counter), '2');
  await setImmediate();
  t.deepEqual(
    (await E(sender).outbox()).map(({ status }) => status),
    ['failed', 'delivered'],
  );
  t.deepEqual(await E(destination).inbox(), [
    { id: '1', from: 'Alice', text: 'accepted later' },
  ]);
  t.is(await E(destination).take('1'), counter);
});

test('mailbox cancellation prevents redemption of an already-fetched invitation', async t => {
  t.timeout(10_000);
  const mailbox = makeMailbox();
  const invitation = await E(mailbox).invite('Bob');
  t.true(await E(mailbox).cancelInvitation('Bob'));
  t.true(await E(mailbox).cancelInvitation('Bob'));
  await t.throwsAsync(() => E(invitation).accept(Far('BobInbox', {})), {
    message: /cancelled/,
  });
  t.deepEqual(await E(mailbox).contacts(), [
    { name: 'Bob', status: 'cancelled', error: undefined },
  ]);
  await t.throwsAsync(() => E(mailbox).send('Bob', 'hello', makeCounter()), {
    message: /not ready/,
  });
  await t.throwsAsync(() => E(mailbox).cancelInvitation('missing'), {
    message: /Unknown invitation/,
  });
});

test('mailbox invitation cancellation preserves an established contact in both directions', async t => {
  t.timeout(10_000);
  const alice = makeMailbox();
  const bob = makeMailbox();
  const invitation = await E(alice).invite('Bob');
  await E(bob).connect('Alice', invitation);
  await setImmediate();
  t.true(await E(alice).cancelInvitation('Bob'));
  t.is((await E(alice).contacts())[0].status, 'ready');
  await t.throwsAsync(() => E(invitation).accept(Far('LaterRedeemer', {})), {
    message: /cancelled/,
  });
  await t.throwsAsync(() => E(bob).cancelInvitation('Alice'), {
    message: /Unknown invitation/,
  });
  const counter = makeCounter();
  await E(alice).send('Bob', 'to Bob', counter);
  await E(bob).send('Alice', 'to Alice', counter);
  await setImmediate();
  t.deepEqual(await E(alice).inbox(), [
    { id: '1', from: 'Bob', text: 'to Alice' },
  ]);
  t.deepEqual(await E(bob).inbox(), [
    { id: '1', from: 'Alice', text: 'to Bob' },
  ]);
  t.is(await E(alice).take('1'), await E(bob).take('1'));
});

test('mailbox sends directly to an identity without any name registry', async t => {
  t.timeout(10_000);
  const alice = makeProtocolMailbox();
  const bob = makeProtocolMailbox();
  const bobIdentity = makeMailContact(alice);
  const aliceIdentity = makeMailContact(bob);
  const invitation = await E(bobIdentity).invite();
  await E(aliceIdentity).connect(invitation);
  // eslint-disable-next-line no-await-in-loop
  while ((await E(aliceIdentity).status()).status !== 'ready') {
    // eslint-disable-next-line no-await-in-loop
    await setImmediate();
  }
  const counter = makeCounter();
  t.is(await E(alice).send(bobIdentity, 'No pet name needed', counter), '1');
  // eslint-disable-next-line no-await-in-loop
  while ((await E(bob).inbox()).length === 0) {
    // eslint-disable-next-line no-await-in-loop
    await setImmediate();
  }
  t.deepEqual(await E(bob).inbox(), [
    { id: '1', from: aliceIdentity, text: 'No pet name needed' },
  ]);
  t.is(await E(bob).take('1'), counter);
  t.is((await E(alice).outbox())[0].to, bobIdentity);
});

test('renaming a workspace contact preserves identity and pending offers', async t => {
  t.timeout(10_000);
  const mailbox = makeProtocolMailbox();
  const contacts = new Map();
  const book = makeMailAddressBook(mailbox, contacts, makeMailContact);
  const invitation = await E(book).invite('old name');
  const receiver = await E(invitation).accept(
    Far('RemoteInbox', {
      deliver: () => true,
    }),
  );
  const counter = makeCounter();
  await E(receiver).deliver(1n, 'Before rename', counter);
  const identity = contacts.get('old name');
  contacts.delete('old name');
  contacts.set('new name', identity);
  t.deepEqual(await E(book).inbox(), [
    { id: '1', from: 'new name', text: 'Before rename' },
  ]);
  t.is((await E(mailbox).inbox())[0].from, identity);
  t.is(await E(book).send('new name', 'After rename', counter), '1');
  t.is((await E(mailbox).outbox())[0].to, identity);
});

test('two mailboxes sharing a correspondent do not reuse delivery sequences', async t => {
  t.timeout(10_000);
  const alice = makeProtocolMailbox();
  const secondSender = makeProtocolMailbox();
  const bob = makeProtocolMailbox();
  const bobIdentity = makeMailContact(alice);
  const aliceIdentity = makeMailContact(bob);
  await E(aliceIdentity).connect(await E(bobIdentity).invite());
  // eslint-disable-next-line no-await-in-loop
  while ((await E(aliceIdentity).status()).status !== 'ready') {
    // eslint-disable-next-line no-await-in-loop
    await setImmediate();
  }
  const counter = makeCounter();
  t.is(await E(alice).send(bobIdentity, 'First sender', counter), '1');
  t.is(await E(secondSender).send(bobIdentity, 'Second sender', counter), '1');
  // eslint-disable-next-line no-await-in-loop
  while ((await E(bob).inbox()).length !== 2) {
    // eslint-disable-next-line no-await-in-loop
    await setImmediate();
  }
  t.deepEqual(
    (await E(bob).inbox()).map(entry => entry.text),
    ['First sender', 'Second sender'],
  );
});

test('invitation ownership survives reassignment of its pet name', async t => {
  t.timeout(10_000);
  const mailbox = makeProtocolMailbox();
  const contacts = new Map();
  const book = makeMailAddressBook(mailbox, contacts, makeMailContact);
  // Invoke the local factory facet synchronously to reassign the name while
  // it is awaiting the invitation, before the host could publish its result.
  const pairPromise = book.inviteWithIdentity('Bob');
  const original = contacts.get('Bob');
  contacts.set('Bob', makeMailContact(mailbox));
  const { identity, invitation } = await pairPromise;
  t.is(identity, original);
  t.not(identity, contacts.get('Bob'));
  await E(identity).cancelInvitation();
  await t.throwsAsync(() => E(invitation).accept(Far('Remote', {})), {
    message: /cancelled/,
  });
});
