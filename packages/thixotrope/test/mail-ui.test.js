// @ts-check
import { Far } from '@endo/far';
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';

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
  const service = makeMailUiService(book, contacts, 'alice', attachments);
  attachments.set('counter', replacement);
  t.deepEqual(await service.snapshot(), {
    workspace: 'alice',
    contacts: [{ name: 'Bob', status: 'ready' }],
    inbox: [{ id: '1', from: 'Bob', content: ['Hello'] }],
    outbox: [],
    attachments: ['counter'],
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
  t.deepEqual(Object.keys(service).sort(), ['send', 'snapshot']);
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
        };
      },
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
    t.is((await fetch(`${origin}/api/evaluate`, { headers })).status, 404);
    t.is((await fetch(`${origin}/`)).status, 200);
  },
);
