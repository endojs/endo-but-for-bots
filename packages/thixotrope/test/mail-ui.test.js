// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';

import { makeObservableMap } from '../src/observable-map.js';
import { makeWorkspaceAccess } from '../src/control/workspace-access.js';

import { makeMailUiService } from '../src/web/mail-ui-service.js';
import { serveMailUi } from '../src/platform/node/mail-ui-server.js';

test('the mail UI resolves labels at its edge and sends only granted values', async t => {
  const contact = Far('Contact', {});
  const granted = Far('Granted', {});
  const replacement = Far('Replacement', {});
  const attachments = new Map([['counter', granted]]);
  /** @type {any[]} */
  const sent = [];
  const book = Far('Mail', {
    contacts: () => harden([{ name: 'Bob', status: 'ready' }]),
    inbox: () => harden([{ id: '1', from: contact, content: ['Hello'] }]),
    outbox: () => harden([]),
    send: (recipient, content) => {
      sent.push({ recipient, content });
      return '1';
    },
  });
  const contacts = Far('Contacts', {
    get: name => (name === 'Bob' ? contact : undefined),
    keyOf: value => (value === contact ? 'Bob' : undefined),
  });
  const inventory = makeObservableMap();
  const service = makeMailUiService({
    book,
    contacts,
    inventory,
    workspace: 'alice',
    attachments,
    adoptValue: async () => 'unused',
  });
  attachments.set('counter', replacement);
  t.deepEqual(await service.snapshot(), {
    workspace: 'alice',
    contacts: [{ name: 'Bob', token: '2', status: 'ready' }],
    inbox: [{ id: '1', from: 'Bob', content: ['Hello'] }],
    outbox: [],
    attachments: [{ name: 'counter', token: '1' }],
    inventory: [],
  });
  await service.send('Bob', ['Text alone']);
  await service.send('Bob', ['A counter', { token: '1' }]);
  t.deepEqual(sent, [
    { recipient: contact, content: ['Text alone'] },
    {
      recipient: contact,
      content: ['A counter', { name: 'counter', value: granted }],
    },
  ]);
  await t.throwsAsync(() => service.send('Bob', ['No', { token: 'admin' }]), {
    message: /not offered/,
  });
  await t.throwsAsync(() => service.send('Unknown', ['No']), {
    message: /Unknown contact/,
  });
  await t.throwsAsync(() => service.send('Bob', ['x'.repeat(4097)]), {
    message: /4096/,
  });
  t.is(sent.length, 2);
  t.deepEqual(Object.keys(service).sort(), [
    'adopt',
    'send',
    'snapshot',
    'subscribe',
  ]);
});

test('inventory autocomplete captures references and preserves interleaved message parts', async t => {
  const inventory = makeObservableMap();
  const original = Far('Original', {});
  const replacement = Far('Replacement', {});
  const contact = Far('Contact', {});
  inventory.set('counter', original);
  inventory.set('plain text', 'not a value reference');
  const sent = [];
  const service = makeMailUiService({
    book: Far('Mail', {
      contacts: () => [],
      inbox: () => [],
      outbox: () => [],
      send: (to, content) => {
        sent.push({ to, content });
        return '1';
      },
    }),
    contacts: Far('Contacts', { get: () => contact }),
    inventory,
    workspace: 'test',
    attachments: new Map(),
    adoptValue: async () => 'unused',
  });
  const { attachments } = await service.snapshot();
  t.is(attachments.length, 1);
  t.is(attachments[0].name, 'counter');
  inventory.set('counter', replacement);
  await service.send('Bob', [
    'Before ',
    { token: attachments[0].token },
    ' after',
  ]);
  t.deepEqual(sent, [
    {
      to: contact,
      content: ['Before ', { name: 'counter', value: original }, ' after'],
    },
  ]);
  await t.throwsAsync(() => service.send('Bob', []), {
    message: /message parts/,
  });
  await t.throwsAsync(() => service.send('Bob', [' ']), {
    message: /nonempty/,
  });
});

test('legacy mail projection resolves each contact once and reuses current inventory names', async t => {
  const contact = Far('Contact', {});
  const value = Far('Value', {});
  let contactName = 'Bob';
  let contactReads = 0;
  let valueReads = 0;
  const inventory = makeObservableMap();
  inventory.set('our value', value);
  const book = Far('Mail', {
    contacts: () => [],
    inbox: () =>
      harden(
        Array.from({ length: 12 }, (_, index) => ({
          id: String(index),
          from: contact,
          content: [{ name: 'their value' }],
        })),
      ),
    outbox: () => harden([{ id: 'sent', to: contact, content: ['hello'] }]),
    take: () => value,
  });
  const service = makeMailUiService({
    book,
    contacts: Far('Contacts', {
      keyOf: () => {
        contactReads += 1;
        return contactName;
      },
    }),
    inventory: Far('Inventory', {
      snapshot: () => inventory.snapshot(),
      entries: () => inventory.entries(),
      keyOf: () => {
        valueReads += 1;
        return inventory.keyOf(value);
      },
    }),
    workspace: 'test',
    attachments: new Map(),
    adoptValue: async () => 'unused',
  });
  const first = await service.snapshot();
  t.is(contactReads, 1);
  t.is(valueReads, 0);
  t.is(first.inbox[0].from, 'Bob');
  t.like(first.inbox[0].content[0], { localName: 'our value' });
  t.is(first.outbox[0].to, 'Bob');

  contactName = 'Robert';
  inventory.delete('our value');
  inventory.set('renamed value', value);
  const next = await service.snapshot();
  t.is(contactReads, 2);
  t.is(valueReads, 0);
  t.is(next.inbox[0].from, 'Robert');
  t.like(next.inbox[0].content[0], { localName: 'renamed value' });
});

test.serial(
  'the local mail bridge requires its secret and refuses cross-origin requests',
  async t => {
    t.timeout(10_000);
    let reads = 0;
    let sends = 0;
    const mail = harden({
      snapshot: async () => {
        reads += 1;
        return {
          workspace: 'test',
          contacts: [],
          inbox: [],
          outbox: [],
          attachments: [],
          inventory: [],
        };
      },
      subscribe: async () => async () => {},
      adopt: async () => 'kept',
      send: async recipient => {
        t.deepEqual(recipient, { token: 'selected' });
        sends += 1;
        return '1';
      },
    });
    const server = await serveMailUi({
      token: 'a'.repeat(64),
      mail,
      assets: new Map([['/', { type: 'text/html', body: '<h1>Mail</h1>' }]]),
      port: 0,
    });
    t.teardown(() => server.close());
    const url = new URL(server.url);
    const headers = harden({ authorization: `Bearer ${url.hash.slice(1)}` });
    const origin = url.origin;
    t.is((await fetch(`${origin}/api/mail`)).status, 403);
    for (const endpoint of ['mail', 'events']) {
      // eslint-disable-next-line no-await-in-loop -- Check each refused endpoint before reading mail.
      const refused = await fetch(`${origin}/api/${endpoint}`, {
        headers: { authorization: `Bearer ${'b'.repeat(64)}` },
      });
      t.is(refused.status, 403);
      // eslint-disable-next-line no-await-in-loop -- Consume this response before the next request.
      t.deepEqual(await refused.json(), {
        error:
          'Invalid or missing mail URL secret. Open this workspace’s private mail URL.',
      });
    }
    t.is(
      (
        await fetch(`${origin}/api/mail`, {
          headers: { ...headers, origin: 'https://attacker.example' },
        })
      ).status,
      403,
    );
    t.is(reads, 0);
    const response = await fetch(`${origin}/api/mail`, { headers });
    t.is(response.status, 200);
    t.is((await response.json()).workspace, 'test');
    t.is(response.headers.get('access-control-allow-origin'), null);
    t.regex(
      response.headers.get('content-security-policy') ?? '',
      /form-action 'none'/,
    );
    t.is(
      (
        await fetch(`${origin}/api/send`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: 'null',
        })
      ).status,
      400,
    );
    t.is(
      (
        await fetch(`${origin}/api/send`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: '{',
        })
      ).status,
      400,
    );
    t.is(
      (
        await fetch(`${origin}/api/send`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: ' '.repeat(33 * 1024),
        })
      ).status,
      413,
    );
    t.is(sends, 0);
    t.is(
      (
        await fetch(`${origin}/api/send`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            recipient: { token: 'selected' },
            content: ['Hello'],
          }),
        })
      ).status,
      200,
    );
    t.is(sends, 1);
    const adoption = await fetch(`${origin}/api/adopt`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ token: '1', name: 'kept' }),
    });
    t.is(adoption.status, 200);
    t.is(await adoption.json(), 'kept');
    t.is((await fetch(`${origin}/api/evaluate`, { headers })).status, 404);
    t.is((await fetch(`${origin}/`)).status, 200);
  },
);

test('value pills use inventory identity and adoption never replaces a different value', async t => {
  const known = Far('Known', {});
  const unknown = Far('Unknown', {});
  const other = Far('Other', {});
  const inventory = makeObservableMap();
  inventory.set('our-counter', known);
  inventory.set('taken', other);
  const access = makeWorkspaceAccess(inventory);
  let present = true;
  const content = harden([
    { name: 'sender-name' },
    ' and ',
    { name: 'our-counter' },
    { name: 'another-suggestion' },
  ]);
  const book = Far('Mail', {
    contacts: () => harden([]),
    inbox: () => harden(present ? [{ id: '1', from: known, content }] : []),
    outbox: () =>
      harden(
        present
          ? [{ id: '1', to: known, content: [{ name: 'different-name' }] }]
          : [],
      ),
    take: (_id, index, box) =>
      box === 'outbox' || index === 0 ? known : unknown,
  });
  const contacts = Far('Contacts', { keyOf: () => 'Bob' });
  const service = makeMailUiService({
    book,
    contacts,
    inventory,
    workspace: 'test',
    attachments: new Map(),
    adoptValue: async (name, value) => {
      await E(access).put(name, value);
      return name;
    },
  });
  const snapshot = await service.snapshot();
  const first = snapshot.inbox[0].content[0];
  const offered = snapshot.inbox[0].content[2];
  if (typeof first === 'string' || typeof offered === 'string')
    return t.fail('Expected value descriptions');
  t.is(first.localName, 'our-counter');
  t.is(first.name, 'sender-name');
  t.is(
    offered.localName,
    undefined,
    'matching a sender spelling is not an identity match',
  );
  t.false(
    'value' in offered,
    'raw authority never crosses into the browser snapshot',
  );
  t.deepEqual(snapshot.inbox[0].content[3], {
    ...offered,
    name: 'another-suggestion',
  });
  t.deepEqual(snapshot.outbox[0].content[0], {
    ...first,
    name: 'different-name',
  });
  await t.throwsAsync(() => service.adopt('invented', 'new'), {
    message: /no longer available/,
  });
  await t.throwsAsync(() => service.adopt(offered.token, ''), {
    message: /local name/,
  });
  await t.throwsAsync(() => service.adopt(offered.token, 'taken'), {
    message: /taken/,
  });
  t.is(inventory.get('taken'), other);
  t.is(
    await service.adopt(offered.token, 'received-counter'),
    'received-counter',
  );
  t.is(inventory.get('received-counter'), unknown);
  t.is(await service.adopt(offered.token, 'an-alias'), 'received-counter');
  t.false(
    inventory.has('an-alias'),
    'another tab adopting the same value reuses its local name',
  );
  const updated = await service.snapshot();
  t.like(updated.inbox[0].content[2], { localName: 'received-counter' });
  t.like(updated.inbox[0].content[3], { localName: 'received-counter' });
  t.true(updated.inventory.some(([name]) => name === 'received-counter'));
  inventory.delete('our-counter');
  inventory.set('renamed', known);
  t.like((await service.snapshot()).inbox[0].content[0], {
    localName: 'renamed',
  });
  present = false;
  await service.snapshot();
  await t.throwsAsync(() => service.adopt(offered.token, 'stale'), {
    message: /no longer available/,
  });
});

test('mail subscriptions follow messages, inventory and contact state, and release upstream observers', async t => {
  t.timeout(10_000);
  const { makeMailbox } = await import('../src/mail/mailbox.js');
  const { makeMailContact } = await import('../src/mail/mail-contact.js');
  const mailbox = makeMailbox(makeObservableMap);
  const inventory = makeObservableMap();
  const contacts = makeObservableMap();
  const contact = makeMailContact(() => mailbox);
  contacts.set('Bob', contact);
  const book = Far('LiveMail', {
    contacts: () =>
      Promise.all(
        contacts.entries().map(async ([name, value]) => ({
          name,
          ...(await E(value).status()),
        })),
      ),
    inbox: () => E(mailbox).inbox(),
    outbox: () => E(mailbox).outbox(),
    take: (id, index, box) => E(mailbox).take(id, index, box),
    send: (to, parts) => E(mailbox).send(to, parts),
  });
  const service = makeMailUiService({
    book,
    mailbox,
    contacts,
    inventory,
    workspace: 'live',
    attachments: new Map(),
    adoptValue: async () => 'unused',
  });
  /** @type {import('../src/web/mail-ui.js').MailSnapshot[]} */
  const updates = [];
  /** @type {(() => void) | undefined} */
  let wake;
  /** @type {Error | undefined} */
  let failure;
  const close = await service.subscribe(
    state => {
      updates.push(state);
      wake?.();
    },
    error => {
      failure = error;
      wake?.();
    },
  );
  t.teardown(close);
  /** @param {(state: import('../src/web/mail-ui.js').MailSnapshot) => boolean} predicate */
  const until = async predicate => {
    while (!updates.some(predicate)) {
      if (failure) throw failure;
      // eslint-disable-next-line no-await-in-loop -- Wait for the next subscription notification.
      await new Promise(resolve => {
        wake = () => resolve(undefined);
      });
    }
  };
  await until(state => state.contacts[0]?.status === 'pending');
  const value = Far('Counter', {});
  await E(mailbox).receive(contact, 1n, ['hello ', { name: 'theirs', value }]);
  await until(state => state.inbox.length === 1);
  inventory.set('mine', value);
  await until(state =>
    state.inbox[0]?.content.some(
      part => typeof part !== 'string' && part.localName === 'mine',
    ),
  );
  const invitation = await E(contact).invite();
  await E(invitation).accept(Far('Receiver', { deliver: () => true }));
  await until(state => state.contacts[0]?.status === 'ready');
  await service.send('Bob', ['outgoing']);
  await until(state => state.outbox[0]?.status === 'delivered');
  await close();
  t.deepEqual(inventory.subscriptionCounts(), { durable: 0n, ephemeral: 0n });
  t.deepEqual(contacts.subscriptionCounts(), { durable: 0n, ephemeral: 0n });
  t.is(failure, undefined);
});

test.serial(
  'event stream delivers pushed state and releases its subscription on disconnect',
  async t => {
    t.timeout(10_000);
    /** @type {((state: any) => void) | undefined} */
    let publish;
    let closes = 0;
    let finish;
    const closed = new Promise(resolve => {
      finish = resolve;
    });
    const server = await serveMailUi({
      token: 'a'.repeat(64),
      mail: harden({
        snapshot: async () => {
          throw Error('stream must not poll');
        },
        subscribe: async onState => {
          publish = onState;
          return async () => {
            closes += 1;
            finish();
          };
        },
        adopt: async () => '',
        send: async () => '',
      }),
      assets: new Map(),
      port: 0,
    });
    t.teardown(() => server.close());
    const url = new URL(server.url);
    const abort = new AbortController();
    t.teardown(() => abort.abort());
    t.is((await fetch(`${url.origin}/api/events`)).status, 403);
    const response = await fetch(`${url.origin}/api/events`, {
      headers: { authorization: `Bearer ${url.hash.slice(1)}` },
      signal: abort.signal,
    });
    t.is(response.headers.get('content-type'), 'text/event-stream');
    const reader = response.body?.getReader();
    t.truthy(reader);
    const pending = reader?.read();
    publish?.({ workspace: 'pushed' });
    const chunk = await pending;
    t.is(
      new TextDecoder().decode(chunk?.value),
      'data: {"workspace":"pushed"}\n\n',
    );
    abort.abort();
    await closed;
    t.is(closes, 1);
  },
);

test('failed subscription setup releases observers already acquired', async t => {
  t.timeout(10_000);
  let released = false;
  const inventory = makeObservableMap();
  const contacts = makeObservableMap();
  const service = makeMailUiService({
    book: Far('UnusedBook', {}),
    mailbox: Far('RefusingMailbox', {
      subscribeInbox: () =>
        Far('Subscription', {
          unsubscribe: () => {
            released = true;
          },
        }),
      subscribeOutbox: () => {
        throw Error('subscription refused');
      },
    }),
    contacts,
    inventory,
    workspace: 'test',
    attachments: new Map(),
    adoptValue: async () => '',
  });
  await t.throwsAsync(
    () =>
      service.subscribe(
        () => {},
        () => {},
      ),
    { message: /subscription refused/ },
  );
  t.true(released);
  t.deepEqual(inventory.subscriptionCounts(), { durable: 0n, ephemeral: 0n });
});

test.serial(
  'the same durable token keeps a mail URL valid across web server restarts',
  async t => {
    t.timeout(10_000);
    const token = 'b'.repeat(64);
    const mail = harden({
      snapshot: async () => ({
        workspace: 'stable',
        contacts: [],
        inbox: [],
        outbox: [],
        inventory: [],
        attachments: [],
      }),
      subscribe: async () => async () => {},
      adopt: async () => '',
      send: async () => '',
    });
    const first = await serveMailUi({
      mail,
      token,
      assets: new Map(),
      port: 0,
    });
    let current = first;
    t.teardown(() => current.close());
    const original = new URL(first.url);
    await first.close();
    current = await serveMailUi({
      mail,
      token,
      assets: new Map(),
      port: Number(original.port),
    });
    t.is(current.url, first.url);
    const response = await fetch(`${original.origin}/api/mail`, {
      headers: { authorization: `Bearer ${original.hash.slice(1)}` },
    });
    t.is(response.status, 200);
    t.is((await response.json()).workspace, 'stable');
    await t.throwsAsync(
      () => serveMailUi({ mail, token: '', assets: new Map(), port: 0 }),
      { message: /256-bit/ },
    );
  },
);

test('incremental mail projection shares upstream streams and never rereads history', async t => {
  t.timeout(10_000);
  const { makeMailbox } = await import('../src/mail/mailbox.js');
  const rawMailbox = makeMailbox(makeObservableMap);
  const inventory = makeObservableMap();
  const contacts = makeObservableMap();
  const contact = Far('ConstantContact', {
    status: () => harden({ status: 'ready' }),
  });
  contacts.set('Notes', contact);
  const value = Far('Value', {});
  inventory.set('mine', value);
  for (let i = 1; i <= 100; i += 1) {
    rawMailbox.receive(contact, BigInt(i), ['old', { name: 'theirs', value }]);
  }
  const sent = [];
  let inboxStreams = 0;
  const mailbox = Far('PushOnlyMailbox', {
    subscribeInboxEntries: (listener, ephemeral) => {
      inboxStreams += 1;
      return rawMailbox.subscribeInboxEntries(listener, ephemeral);
    },
    subscribeOutboxEntries: (listener, ephemeral) =>
      rawMailbox.subscribeOutboxEntries(listener, ephemeral),
    inbox: () => {
      throw Error('Must not reread inbox');
    },
    outbox: () => {
      throw Error('Must not reread outbox');
    },
    take: () => {
      throw Error('Values must arrive in subscription data');
    },
  });
  const service = makeMailUiService({
    mailbox,
    inventory,
    contacts,
    book: Far('NoReads', {
      send: (recipient, content) => {
        sent.push({ recipient, content });
        return 'sent';
      },
    }),
    workspace: 'push',
    attachments: new Map(),
    adoptValue: async () => 'unused',
  });
  /** @type {any[]} */
  const views = [];
  /** @type {Error | undefined} */
  let failure;
  const closed = [];
  for (let i = 0; i < 3; i += 1) {
    closed.push(
      // eslint-disable-next-line no-await-in-loop -- Exercise sequential browser connections.
      await service.subscribe(
        state => {
          views[i] = state;
        },
        error => {
          failure = error;
        },
      ),
    );
  }
  t.teardown(() => Promise.all(closed.map(close => close())));
  const flush = async () => {
    await new Promise(resolve => setImmediate(resolve));
    if (failure) throw failure;
  };
  await flush();
  t.is(inboxStreams, 1);
  t.deepEqual(inventory.subscriptionCounts(), { durable: 0n, ephemeral: 1n });
  t.is(views[0].inbox.length, 100);
  const selected = views[0].contacts[0].token;
  t.is(views[0], views[2]);
  rawMailbox.receive(contact, 101n, ['new', { name: 'theirs', value }]);
  await flush();
  t.is(views[0].inbox.length, 101);
  t.like(views[0].inbox[100].content[1], { localName: 'mine' });
  inventory.set('newest', value);
  contacts.set('Self', contact);
  await flush();
  t.like(views[0].inbox[100], { from: 'Self' });
  t.like(views[0].inbox[100].content[1], { localName: 'newest' });
  inventory.delete('newest');
  rawMailbox.discard('1');
  await flush();
  t.is(views[0].inbox.length, 100);
  t.like(views[0].inbox[99].content[1], { localName: 'mine' });
  contacts.delete('Notes');
  contacts.set(
    'Self',
    Far('ReplacementContact', { status: () => ({ status: 'ready' }) }),
  );
  await flush();
  await service.send({ token: selected }, ['captured recipient']);
  t.deepEqual(sent, [{ recipient: contact, content: ['captured recipient'] }]);
  await t.throwsAsync(() => service.send({ token: 'unknown' }, ['no']), {
    message: /Unknown contact selection/,
  });
  await closed[0]();
  t.deepEqual(inventory.subscriptionCounts(), { durable: 0n, ephemeral: 1n });
  await Promise.all(closed.slice(1).map(close => close()));
  t.deepEqual(inventory.subscriptionCounts(), { durable: 0n, ephemeral: 0n });
  t.deepEqual(contacts.subscriptionCounts(), { durable: 0n, ephemeral: 0n });
  rawMailbox.receive(contact, 102n, ['while disconnected']);
  const reopened = await service.subscribe(
    state => {
      views[0] = state;
    },
    error => {
      failure = error;
    },
  );
  t.teardown(reopened);
  await flush();
  t.is(inboxStreams, 2);
  t.is(views[0].inbox.length, 101);
  t.is(views[0].inbox[100].content[0], 'while disconnected');
  await reopened();
  t.deepEqual(inventory.subscriptionCounts(), { durable: 0n, ephemeral: 0n });
});

test('incremental setup failure releases concurrently acquired entry streams', async t => {
  t.timeout(5000);
  const inventory = makeObservableMap();
  const contacts = makeObservableMap();
  let closed = false;
  const mailbox = Far('PartialEntryMailbox', {
    subscribeInboxEntries: () =>
      Far('OpenedEntries', {
        unsubscribe: () => {
          closed = true;
        },
      }),
    subscribeOutboxEntries: () => {
      throw Error('entry stream refused');
    },
  });
  const service = makeMailUiService({
    book: Far('UnusedBook', {}),
    mailbox,
    inventory,
    contacts,
    workspace: 'partial',
    attachments: new Map(),
    adoptValue: async () => 'unused',
  });
  await t.throwsAsync(
    () =>
      service.subscribe(
        () => {},
        () => {},
      ),
    {
      message: /entry stream refused/,
    },
  );
  t.true(closed);
  t.deepEqual(inventory.subscriptionCounts(), { durable: 0n, ephemeral: 0n });
  t.deepEqual(contacts.subscriptionCounts(), { durable: 0n, ephemeral: 0n });
});
