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
    contacts: [{ name: 'Bob', status: 'ready' }],
    inbox: [{ id: '1', from: 'Bob', content: ['Hello'] }],
    outbox: [],
    attachments: ['counter'],
    inventory: [],
  });
  await service.send('Bob', 'Text alone', '');
  await service.send('Bob', 'A counter', 'counter');
  t.deepEqual(sent, [
    { recipient: contact, content: ['Text alone'] },
    {
      recipient: contact,
      content: ['A counter', { name: 'counter', value: granted }],
    },
  ]);
  await t.throwsAsync(() => service.send('Bob', 'No', 'admin'), {
    message: /not granted/,
  });
  await t.throwsAsync(() => service.send('Unknown', 'No', ''), {
    message: /Unknown contact/,
  });
  await t.throwsAsync(() => service.send('Bob', 'x'.repeat(4097), ''), {
    message: /4096/,
  });
  t.is(sent.length, 2);
  t.deepEqual(Object.keys(service).sort(), ['adopt', 'send', 'snapshot']);
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
      adopt: async () => 'kept',
      send: async () => {
        sends += 1;
        return '1';
      },
    });
    const server = await serveMailUi({
      mail,
      assets: new Map([['/', { type: 'text/html', body: '<h1>Mail</h1>' }]]),
      port: 0,
    });
    t.teardown(() => server.close());
    const url = new URL(server.url);
    const headers = harden({ authorization: `Bearer ${url.hash.slice(1)}` });
    const origin = url.origin;
    t.is((await fetch(`${origin}/api/mail`)).status, 403);
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
          body: JSON.stringify({ name: 'Bob', text: 'Hello', attachment: '' }),
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
