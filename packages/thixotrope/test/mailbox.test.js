// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';
import { setImmediate } from 'node:timers/promises';

import { makeMailIntroductions } from '../src/mail/introductions.js';
import { makeMailbox as makeProtocolMailbox } from '../src/mail/mailbox.js';
import { makeMailContact } from '../src/mail/mail-contact.js';
import { makeMailAddressBook } from '../src/mail/mail-address-book.js';
import { makeObservableMap } from '../src/observable-map.js';

const location = harden({
  type: 'ocapn-peer',
  network: 'thix-unix',
  transport: 'thix-unix',
  designator: '/tmp/peers.sock',
  hints: {},
});

/** @param {string} text */
const secretOf = text => JSON.parse(text).secret;

/**
 * A stand-in for the host introductions resource. Publications are a local
 * map, so several address books in one process can introduce each other and
 * redemption is a lookup rather than a dial. `plant` publishes a hand-made
 * invitation and returns its text.
 */
const makeFakeIntroductions = () => {
  /** @type {Map<string, any>} */
  const publications = new Map();
  /** @type {string[]} */
  const unpublished = [];
  let count = 0;
  let failNextPublish = false;
  /**
   * @param {any} invitation
   * @param {string} [name]
   */
  const plant = (invitation, name = 'planted') => {
    count += 1;
    const secret = count.toString(16).padStart(32, '0');
    publications.set(secret, invitation);
    return JSON.stringify({ version: 1, location, secret, name });
  };
  const introductions = Far('FakeIntroductions', {
    help: () => 'A stand-in for the host introductions resource.',
    /**
     * @param {any} invitation
     * @param {string} name
     */
    publish: (invitation, name) => {
      if (failNextPublish) {
        failNextPublish = false;
        throw Error('publication failed');
      }
      return plant(invitation, name);
    },
    /** @param {string} secret */
    unpublish: secret => {
      unpublished.push(secret);
      publications.delete(secret);
      return true;
    },
    /** @param {string} text */
    redeem: text => {
      let secret;
      try {
        secret = secretOf(text);
      } catch (error) {
        throw Error('Invalid invitation', { cause: error });
      }
      const invitation = publications.get(secret);
      if (invitation === undefined) throw Error('Unknown publication');
      return invitation;
    },
  });
  return {
    introductions,
    publications,
    unpublished,
    plant,
    /** @param {string} text */
    invitationOf: text => publications.get(secretOf(text)),
    failNextPublish: () => {
      failNextPublish = true;
    },
  };
};

/** @param {ReturnType<typeof makeFakeIntroductions>} [network] */
const makeMailbox = (network = makeFakeIntroductions()) =>
  makeMailAddressBook(
    makeProtocolMailbox(makeObservableMap),
    makeObservableMap(),
    makeMailContact,
    network.introductions,
  );

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
  const network = makeFakeIntroductions();
  const mailbox = makeMailbox(network);
  const text = await E(mailbox).invite('Bob');
  const invitation = network.invitationOf(text);
  const receiver = Far('BobInbox', { deliver: () => true });
  const first = await E(invitation).accept(receiver);
  t.is(await E(invitation).accept(receiver), first);
  await t.throwsAsync(() => E(invitation).accept(Far('Other', {})), {
    message: /already redeemed/,
  });
  await t.throwsAsync(() => E(mailbox).invite('Bob'), {
    message: /already started/,
  });
  t.deepEqual(await E(mailbox).contacts(), [
    { name: 'Bob', status: 'ready', error: undefined },
  ]);
  // The exchange completed, so the publication is withdrawn and there is
  // nothing left to revoke.
  await setImmediate();
  t.deepEqual(network.unpublished, [secretOf(text)]);
  t.false(await E(mailbox).revokeInvitation(text));
});

test('mailbox receivers bind local sender labels and deduplicate delivery', async t => {
  t.timeout(10_000);
  const network = makeFakeIntroductions();
  const mailbox = makeMailbox(network);
  const text = await E(mailbox).invite('locally named Bob');
  const receiver = await E(network.invitationOf(text)).accept(
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
  const network = makeFakeIntroductions();
  const mailbox = makeMailbox(network);
  /** @type {any[]} */
  const invalidNames = ['', 'x'.repeat(129), 1, undefined];
  await null;
  for (const name of invalidNames) {
    // Each assertion awaits the rejection of a separate boundary invocation.
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(mailbox).invite(name), {
      message: /contact name/,
    });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(mailbox).accept(name, 'irrelevant'), {
      message: /contact name/,
    });
  }
  const text = await E(mailbox).invite('valid');
  const invitation = network.invitationOf(text);
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
  // An invitation the host refuses reserves no name.
  await t.throwsAsync(() => E(mailbox).accept('still available', 'not json'), {
    message: /Invalid invitation/,
  });
  t.deepEqual(
    (await E(mailbox).contacts()).map(({ name }) => name),
    ['valid'],
  );
  await E(mailbox).invite('still available');
});

test('mailbox acceptance tracks pending, ready and rejected introductions', async t => {
  t.timeout(10_000);
  const network = makeFakeIntroductions();
  const mailbox = makeMailbox(network);
  const answer = deferred();
  const pending = network.plant(
    Far('DeferredInvitation', { accept: () => answer.promise }),
  );
  t.true(await E(mailbox).accept('pending', pending));
  t.is((await E(mailbox).contacts())[0].status, 'pending');
  await t.throwsAsync(
    () => E(mailbox).send('pending', 'hello', makeCounter()),
    { message: /not ready/ },
  );
  answer.resolve(Far('RemoteInbox', { deliver: () => true }));
  await setImmediate();
  t.is((await E(mailbox).contacts())[0].status, 'ready');
  const failure = deferred();
  t.true(
    await E(mailbox).accept(
      'refused',
      network.plant(
        Far('RefusedInvitation', { accept: () => failure.promise }),
      ),
    ),
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

test('a failed acceptance can be retried under the same name with accept', async t => {
  t.timeout(10_000);
  const network = makeFakeIntroductions();
  const contacts = makeObservableMap();
  const mailbox = makeMailAddressBook(
    makeProtocolMailbox(makeObservableMap),
    contacts,
    makeMailContact,
    network.introductions,
  );
  const refusing = network.plant(
    Far('RefusingInvitation', {
      accept: () => {
        throw Error('refused introduction');
      },
    }),
  );
  t.true(await E(mailbox).accept('bob', refusing));
  await setImmediate();
  const contact = contacts.get('bob');
  t.like((await E(mailbox).contacts())[0], { status: 'failed' });
  // The retry reuses the contact and keeps the last error visible until
  // an attempt succeeds.
  const answer = deferred();
  const working = network.plant(
    Far('WorkingInvitation', { accept: () => answer.promise }),
  );
  t.true(await E(mailbox).accept('bob', working));
  t.is(contacts.get('bob'), contact);
  const retrying = (await E(mailbox).contacts())[0];
  t.is(retrying.status, 'pending');
  t.regex(retrying.error, /refused introduction/);
  // One attempt at a time.
  await t.throwsAsync(() => E(mailbox).accept('bob', working), {
    message: /already started/,
  });
  answer.resolve(Far('BobInbox', { deliver: () => true }));
  await setImmediate();
  t.deepEqual(await E(mailbox).contacts(), [
    { name: 'bob', status: 'ready', error: undefined },
  ]);
  t.is(await E(mailbox).send('bob', 'hello', makeCounter()), '1');
  // A ready contact is not introduced again.
  await t.throwsAsync(() => E(mailbox).accept('bob', working), {
    message: /already started/,
  });
  await t.throwsAsync(() => E(mailbox).invite('bob'), {
    message: /already started/,
  });
});

test('a failed acceptance can be retried under the same name with invite', async t => {
  t.timeout(10_000);
  const network = makeFakeIntroductions();
  const mailbox = makeMailbox(network);
  t.true(
    await E(mailbox).accept(
      'carol',
      network.plant(
        Far('RefusingInvitation', {
          accept: () => {
            throw Error('refused introduction');
          },
        }),
      ),
    ),
  );
  await setImmediate();
  t.like((await E(mailbox).contacts())[0], { status: 'failed' });
  const text = await E(mailbox).invite('carol');
  const invited = (await E(mailbox).contacts())[0];
  t.is(invited.status, 'pending');
  t.regex(invited.error, /refused introduction/);
  await E(network.invitationOf(text)).accept(
    Far('CarolInbox', { deliver: () => true }),
  );
  t.deepEqual(await E(mailbox).contacts(), [
    { name: 'carol', status: 'ready', error: undefined },
  ]);
});

test('a failed publication closes the invitation so the name can be retried', async t => {
  t.timeout(10_000);
  const network = makeFakeIntroductions();
  const mailbox = makeMailbox(network);
  network.failNextPublish();
  await t.throwsAsync(() => E(mailbox).invite('Bob'), {
    message: /publication failed/,
  });
  t.deepEqual(await E(mailbox).contacts(), [
    { name: 'Bob', status: 'cancelled', error: undefined },
  ]);
  const text = await E(mailbox).invite('Bob');
  t.is((await E(mailbox).contacts())[0].status, 'pending');
  await E(network.invitationOf(text)).accept(Far('BobInbox', {}));
  t.is((await E(mailbox).contacts())[0].status, 'ready');
});

test('mailbox marks an introduction failed when its result is not a capability', async t => {
  t.timeout(10_000);
  const network = makeFakeIntroductions();
  const mailbox = makeMailbox(network);
  await E(mailbox).accept(
    'malformed',
    network.plant(Far('MalformedInvitation', { accept: () => ({}) })),
  );
  await setImmediate();
  const contact = (await E(mailbox).contacts())[0];
  t.is(contact.status, 'failed');
  t.regex(contact.error, /remotable/);
});

test('mailbox outbox distinguishes accepted invocation, delivery and rejection', async t => {
  t.timeout(10_000);
  const network = makeFakeIntroductions();
  const mailbox = makeMailbox(network);
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
  const text = await E(mailbox).invite('Bob');
  await E(network.invitationOf(text)).accept(receiver);
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

test('mailbox inbox and outbox notify subscribers and bound delivery errors', async t => {
  t.timeout(10_000);
  const mailbox = makeProtocolMailbox(makeObservableMap);
  /** @type {bigint[]} */
  const inboxRevisions = [];
  /** @type {bigint[]} */
  const outboxRevisions = [];
  await E(mailbox).subscribeInbox(
    Far('InboxObserver', {
      changed: snapshot => {
        inboxRevisions.push(snapshot.revision);
      },
    }),
  );
  await E(mailbox).subscribeOutbox(
    Far('OutboxObserver', {
      changed: snapshot => {
        outboxRevisions.push(snapshot.revision);
      },
    }),
  );
  const contact = Far('Contact', {
    deliver: () => {
      throw Error('x'.repeat(10_000));
    },
  });
  const counter = makeCounter();
  t.true(await E(mailbox).receive(contact, 1n, 'hello', counter));
  t.is(await E(mailbox).send(contact, 'text', counter), '1');
  await setImmediate();
  t.deepEqual(inboxRevisions, [0n, 1n]);
  // Admission, then the delivery outcome, each replace the record.
  t.deepEqual(outboxRevisions, [0n, 1n, 2n]);
  const [failed] = await E(mailbox).outbox();
  t.is(failed.status, 'failed');
  t.is(typeof failed.error, 'string');
  t.true(String(failed.error).length <= 512);
  t.true(await E(mailbox).discard('1'));
  await setImmediate();
  t.deepEqual(inboxRevisions, [0n, 1n, 2n]);
  await t.throwsAsync(() => E(mailbox).take(/** @type {any} */ (1)), {
    message: /message id/,
  });
});

test('mailbox take preserves reference identity and discard releases only the message', async t => {
  t.timeout(10_000);
  const network = makeFakeIntroductions();
  const mailbox = makeMailbox(network);
  const text = await E(mailbox).invite('Bob');
  const receiver = await E(network.invitationOf(text)).accept(
    Far('Remote', {}),
  );
  const counter = makeCounter();
  await E(receiver).deliver(1n, 'counter', counter);
  const taken = await E(mailbox).take('1');
  t.is(taken, counter);
  t.is(await E(mailbox).take('1'), taken);
  t.is(await E(taken).incr(), 1n);
  t.true(await E(mailbox).discard('1'));
  t.false(await E(mailbox).discard('1'));
  await t.throwsAsync(() => E(mailbox).take('1'), {
    message: /Unknown message/,
  });
  t.deepEqual(await E(mailbox).inbox(), []);
  t.is(await E(taken).incr(), 2n);
});

test('mailbox contact names safely include object prototype property names', async t => {
  t.timeout(10_000);
  const network = makeFakeIntroductions();
  const alice = makeMailbox(network);
  const bob = makeMailbox(network);
  const text = await E(alice).invite('__proto__');
  await E(bob).accept('constructor', text);
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

test('mailbox failed admission does not poison the next message sequence', async t => {
  t.timeout(10_000);
  const network = makeFakeIntroductions();
  const sender = makeMailbox(network);
  const destination = makeMailbox(network);
  const destinationReceiver = await E(
    network.invitationOf(await E(destination).invite('Alice')),
  ).accept(Far('AliceInbox', {}));
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
  await E(network.invitationOf(await E(sender).invite('Bob'))).accept(
    transport,
  );
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

test('mailbox revocation prevents redemption of an already-fetched invitation', async t => {
  t.timeout(10_000);
  const network = makeFakeIntroductions();
  const mailbox = makeMailbox(network);
  const text = await E(mailbox).invite('Bob');
  const invitation = network.invitationOf(text);
  t.true(await E(mailbox).revokeInvitation(text));
  t.false(await E(mailbox).revokeInvitation(text));
  // Every revocation withdraws the publication, even a repeated one.
  t.deepEqual(network.unpublished, [secretOf(text), secretOf(text)]);
  await t.throwsAsync(() => E(invitation).accept(Far('BobInbox', {})), {
    message: /revoked/,
  });
  t.deepEqual(await E(mailbox).contacts(), [
    { name: 'Bob', status: 'cancelled', error: undefined },
  ]);
  await t.throwsAsync(() => E(mailbox).send('Bob', 'hello', makeCounter()), {
    message: /not ready/,
  });
  await t.throwsAsync(() => E(mailbox).revokeInvitation('not an invitation'), {
    message: /Invalid invitation/,
  });
  t.false(
    await E(mailbox).revokeInvitation(
      JSON.stringify({
        version: 1,
        location,
        secret: 'f'.repeat(32),
        name: 'x',
      }),
    ),
  );
  // A cancelled name can be invited again, on the same contact.
  const again = await E(mailbox).invite('Bob');
  t.not(again, text);
  t.is((await E(mailbox).contacts())[0].status, 'pending');
  await E(network.invitationOf(again)).accept(
    Far('BobInbox', { deliver: () => true }),
  );
  t.is((await E(mailbox).contacts())[0].status, 'ready');
});

test('mailbox invitation revocation preserves an established contact in both directions', async t => {
  t.timeout(10_000);
  const network = makeFakeIntroductions();
  const alice = makeMailbox(network);
  const bob = makeMailbox(network);
  const text = await E(alice).invite('Bob');
  const invitation = network.invitationOf(text);
  await E(bob).accept('Alice', text);
  await setImmediate();
  // Redemption already withdrew the publication; nothing remains to revoke,
  // and the contact stays ready.
  t.false(await E(alice).revokeInvitation(text));
  t.is((await E(alice).contacts())[0].status, 'ready');
  await t.throwsAsync(() => E(invitation).accept(Far('LaterRedeemer', {})), {
    message: /already redeemed/,
  });
  t.false(await E(bob).revokeInvitation(text));
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

test('mailbox sends directly to a contact without any name registry', async t => {
  t.timeout(10_000);
  const alice = makeProtocolMailbox(makeObservableMap);
  const bob = makeProtocolMailbox(makeObservableMap);
  const bobContact = makeMailContact(alice);
  const aliceContact = makeMailContact(bob);
  const invitation = await E(bobContact).invite();
  await E(aliceContact).accept(invitation);
  // eslint-disable-next-line no-await-in-loop
  while ((await E(aliceContact).status()).status !== 'ready') {
    // eslint-disable-next-line no-await-in-loop
    await setImmediate();
  }
  const counter = makeCounter();
  t.is(await E(alice).send(bobContact, 'No pet name needed', counter), '1');
  // eslint-disable-next-line no-await-in-loop
  while ((await E(bob).inbox()).length === 0) {
    // eslint-disable-next-line no-await-in-loop
    await setImmediate();
  }
  t.deepEqual(await E(bob).inbox(), [
    { id: '1', from: aliceContact, text: 'No pet name needed' },
  ]);
  t.is(await E(bob).take('1'), counter);
  t.is((await E(alice).outbox())[0].to, bobContact);
});

test('renaming a workspace contact preserves the contact and pending messages', async t => {
  t.timeout(10_000);
  const network = makeFakeIntroductions();
  const mailbox = makeProtocolMailbox(makeObservableMap);
  const contacts = makeObservableMap();
  const book = makeMailAddressBook(
    mailbox,
    contacts,
    makeMailContact,
    network.introductions,
  );
  const text = await E(book).invite('old name');
  const receiver = await E(network.invitationOf(text)).accept(
    Far('RemoteInbox', {
      deliver: () => true,
    }),
  );
  const counter = makeCounter();
  await E(receiver).deliver(1n, 'Before rename', counter);
  const contact = contacts.get('old name');
  contacts.delete('old name');
  contacts.set('new name', contact);
  t.deepEqual(await E(book).inbox(), [
    { id: '1', from: 'new name', text: 'Before rename' },
  ]);
  t.is((await E(mailbox).inbox())[0].from, contact);
  t.is(await E(book).send('new name', 'After rename', counter), '1');
  t.is((await E(mailbox).outbox())[0].to, contact);
  contacts.delete('new name');
  t.deepEqual(await E(book).inbox(), [
    { id: '1', from: '<unnamed>', text: 'Before rename' },
  ]);
});

test('two mailboxes sharing a correspondent do not reuse delivery sequences', async t => {
  t.timeout(10_000);
  const alice = makeProtocolMailbox(makeObservableMap);
  const secondSender = makeProtocolMailbox(makeObservableMap);
  const bob = makeProtocolMailbox(makeObservableMap);
  const bobContact = makeMailContact(alice);
  const aliceContact = makeMailContact(bob);
  await E(aliceContact).accept(await E(bobContact).invite());
  // eslint-disable-next-line no-await-in-loop
  while ((await E(aliceContact).status()).status !== 'ready') {
    // eslint-disable-next-line no-await-in-loop
    await setImmediate();
  }
  const counter = makeCounter();
  t.is(await E(alice).send(bobContact, 'First sender', counter), '1');
  t.is(await E(secondSender).send(bobContact, 'Second sender', counter), '1');
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
  const network = makeFakeIntroductions();
  const mailbox = makeProtocolMailbox(makeObservableMap);
  const contacts = makeObservableMap();
  const book = makeMailAddressBook(
    mailbox,
    contacts,
    makeMailContact,
    network.introductions,
  );
  // Invoke the local facet synchronously to reassign the name while it is
  // awaiting publication of the invitation.
  const pending = book.invite('Bob');
  const original = contacts.get('Bob');
  contacts.set('Bob', makeMailContact(mailbox));
  const text = await pending;
  const invitation = network.invitationOf(text);
  t.not(contacts.get('Bob'), original);
  t.true(await E(book).revokeInvitation(text));
  t.is((await E(original).status()).status, 'cancelled');
  t.is((await E(contacts.get('Bob')).status()).status, 'pending');
  await t.throwsAsync(() => E(invitation).accept(Far('Remote', {})), {
    message: /revoked/,
  });
});

test('mail introductions validate invitation text before dialing', async t => {
  t.timeout(10_000);
  /** @type {any[][]} */
  const calls = [];
  const secret = 'ab'.repeat(16);
  const introductions = makeMailIntroductions({
    publish: value => {
      calls.push(['publish', value]);
      return secret;
    },
    unpublish: withdrawn => {
      calls.push(['unpublish', withdrawn]);
    },
    importReference: async (peer, fetched) => {
      calls.push(['import', peer, fetched]);
      return Far('RemoteInvitation', {});
    },
    location: () => location,
    assertLocation: candidate => {
      if (/** @type {any} */ (candidate)?.designator !== location.designator)
        throw Error('Invalid Unix peer location');
      return location;
    },
  });
  const invitation = Far('Invitation', {});
  const text = await E(introductions).publish(invitation, 'bob');
  t.deepEqual(JSON.parse(text), { version: 1, location, secret, name: 'bob' });
  t.deepEqual(calls, [['publish', invitation]]);
  await t.throwsAsync(() => E(introductions).publish(invitation, ''), {
    message: /contact name/,
  });
  await t.throwsAsync(
    () => E(introductions).publish(/** @type {any} */ ('text'), 'bob'),
    { message: /invitation capability/ },
  );
  await E(introductions).redeem(text);
  t.deepEqual(calls[1], ['import', location, secret]);
  const parsed = JSON.parse(text);
  const invalid = [
    'x'.repeat(4097),
    'not json',
    'null',
    JSON.stringify([]),
    JSON.stringify({ ...parsed, version: 2 }),
    JSON.stringify({ ...parsed, secret: 'nope' }),
    JSON.stringify({ ...parsed, name: '' }),
    JSON.stringify({ ...parsed, name: 'x'.repeat(129) }),
  ];
  for (const bad of invalid) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(introductions).redeem(bad), {
      message: /Invalid invitation/,
    });
  }
  await t.throwsAsync(
    () =>
      E(introductions).redeem(
        JSON.stringify({ ...parsed, location: { designator: '/elsewhere' } }),
      ),
    { message: /Unix peer/ },
  );
  // Nothing was dialed for text the validator refused.
  t.is(calls.length, 2);
  t.true(await E(introductions).unpublish(secret));
  t.deepEqual(calls[2], ['unpublish', secret]);
  await t.throwsAsync(() => E(introductions).unpublish('short'), {
    message: /secret/,
  });
});
