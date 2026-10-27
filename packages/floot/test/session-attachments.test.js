// @ts-check
/* eslint-disable no-await-in-loop -- Resource ownership and cleanup are serial. */
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { makeSessionAttachments } from '../src/session-attachments.js';
import { makeStreamingAgent } from '../agent.js';
import { makeReplyChannel } from '../src/stream.js';
import { directoryHost } from './_directory-host.js';

const SELF = `endo://${'a'.repeat(64)}/${'b'.repeat(64)}?type=handle`;
const message = harden({ strings: ['Read ', ''], names: ['document'] });
const setup = t => {
  const storage = new Map([
    [
      'floot-private-sessions/one/schema',
      harden({ version: 2, sessionId: 'one' }),
    ],
  ]);
  const values = new Map();
  const inventory = new Map();
  const messages = new Map();
  const inbox = makeBufferedReader();
  t.teardown(() => inbox.close());
  let sequence = 0n;
  let deliveries = 0;
  let loseAck = false;
  let refuseDismiss = false;
  const journal = new Map();
  const host = Far('Host', {
    ...directoryHost(storage),
    identify: (...path) => {
      const id = `object-${path.join('/')}`;
      values.set(id, storage.get(path.join('/')));
      return id;
    },
  });
  const guest = Far('Guest', {
    locate: () => SELF,
    identify: () => 'self-id',
    list: name => harden(name === 'tools' ? [] : [...inventory.keys()]),
    has: name => journal.has(name) || inventory.has(name),
    lookup: name =>
      journal.has(name) ? journal.get(name) : inventory.get(name),
    storeValue: (value, name) => {
      journal.set(name, value);
    },
    remove: name => {
      journal.delete(name);
    },
    lookupByLocator: id => values.get(id),
    followMessages: () => inbox.reader,
    listMessages: () => harden([...messages.values()]),
    dismiss: number => {
      if (refuseDismiss) throw Error('dismiss refused');
      messages.delete(number);
    },
    deliver: envelope => {
      deliveries += 1;
      const item = harden({
        ...envelope,
        from: SELF,
        to: SELF,
        number: sequence,
      });
      messages.set(sequence, item);
      sequence += 1n;
      inbox.push(item);
      if (loseAck) throw Error('lost delivery ACK');
    },
    adopt: (number, edge, petName) => {
      const item = messages.get(number);
      if (!item) throw Error('Package missing');
      inventory.set(petName, values.get(item.ids[item.names.indexOf(edge)]));
    },
  });
  const manager = makeSessionAttachments(host, guest, 'one');
  const object = Far('Document', { read: () => 'hello' });
  const references = harden([
    { path: ['folder', 'notes'], identity: 'source-id', value: object },
  ]);
  return {
    host,
    guest,
    manager,
    storage,
    inventory,
    messages,
    object,
    references,
    inbox,
    deliveries: () => deliveries,
    loseAck: () => {
      loseAck = true;
    },
    refuseDismiss: value => {
      refuseDismiss = value;
    },
  };
};

test('real package semantics: lost delivery ACK recovers; adoption survives dismissal; staging stays bounded', async t => {
  t.timeout(5000);
  const w = setup(t);
  w.loseAck();
  for (let i = 0; i < 3; i += 1) {
    const packet = await w.manager.open(
      message,
      w.references,
      `${i}`,
      () => {},
    );
    const mail = [...w.messages.values()][0];
    t.true(w.manager.owns(mail.messageId));
    t.is(
      w.inventory.size,
      i ? 1 : 0,
      'delivery does not auto-install inventory',
    );
    t.regex(packet.context, /adoptTool/);
    await E(w.guest).adopt(mail.number, 'document', 'notes');
    await packet.close();
    t.is(w.messages.size, 0);
    t.false(
      [...w.storage.keys()].some(name => name.includes('floot-attachment-')),
    );
    t.is(w.inventory.get('notes'), w.object);
  }
  t.is(w.deliveries(), 3, 'no redelivery on lost ACK');
});

test('cancelled preparation cleans bounded crash leftovers and leaves no guest authority', async t => {
  t.timeout(5000);
  const w = setup(t);
  w.storage.set('floot-private-sessions/one/floot-attachment-31', w.object);
  let checks = 0;
  await t.throwsAsync(
    () =>
      w.manager.open(message, w.references, '1', () => {
        checks += 1;
        if (checks === 2) throw Error('cancelled');
      }),
    { message: /cancelled/ },
  );
  t.is(w.inventory.size, 0);
  t.is(w.messages.size, 0);
  t.false(
    [...w.storage.keys()].some(name => name.includes('floot-attachment-')),
  );
});

test('failed dismissal retains ownership until explicit cleanup retry', async t => {
  t.timeout(5000);
  const w = setup(t);
  const packet = await w.manager.open(message, w.references, '1', () => {});
  const mail = [...w.messages.values()][0];
  w.refuseDismiss(true);
  await t.throwsAsync(packet.close, { message: /dismiss refused/ });
  t.true(w.manager.owns(mail.messageId));
  w.refuseDismiss(false);
  await packet.close();
  t.false(w.manager.owns(mail.messageId));
});

test('UI attachment package is suppressed by the inbox and visible to normal adoption tools', async t => {
  t.timeout(5000);
  const w = setup(t);
  let calls = 0;
  const agent = await makeStreamingAgent(
    w.guest,
    undefined,
    {
      kind: 'hosted',
      provideHostedClient: () =>
        harden({
          async send(text, options) {
            calls += 1;
            t.is(text, 'Read @document');
            t.regex(options.systemPrompt, /Message #0 attaches/);
            const mail = [...w.messages.values()][0];
            await E(w.guest).adopt(mail.number, 'document', 'notes');
            const stream = makeBufferedReader();
            stream.push(harden({ type: 'text-delta', text: 'Done' }));
            stream.push(harden({ type: 'end' }));
            return stream.reader;
          },
        }),
    },
    'test',
    { journalPowers: w.guest, attachments: w.manager },
  );
  t.teardown(async () => {
    w.inbox.close();
    await agent.shutdown();
  });
  agent.startInbox();
  const channel = makeReplyChannel();
  await agent.converse(
    'Read @document',
    channel.writer,
    harden({ message }),
    undefined,
    undefined,
    undefined,
    w.references,
  );
  t.is(calls, 1);
  t.is(w.inventory.get('notes'), w.object);
  t.is(w.messages.size, 0);
  t.deepEqual(
    (await agent.getHistory()).find(m => m.role === 'user').meta.message,
    message,
  );
});

test('duplicate delivery identities reuse the package and cleanup dismisses all copies', async t => {
  t.timeout(5000);
  const w = setup(t);
  const packet = await w.manager.open(message, w.references, '1', () => {});
  const original = [...w.messages.values()][0];
  const again = await w.manager.open(message, w.references, '1', () => {});
  t.is(w.deliveries(), 1);
  await E(w.guest).deliver(original);
  t.is(w.messages.size, 2);
  await again.close();
  await packet.close();
  t.is(w.messages.size, 0);
});

test('failed preparation cleanup quarantines new turns and remains retryable at shutdown', async t => {
  t.timeout(5000);
  const w = setup(t);
  let opens = 0;
  const manager = harden({
    owns: w.manager.owns,
    cleanup: w.manager.cleanup,
    open: async (...args) => {
      opens += 1;
      await w.manager.open(...args);
      w.refuseDismiss(true);
      throw Error('preparation interrupted');
    },
  });
  const agent = await makeStreamingAgent(
    w.guest,
    undefined,
    {
      kind: 'provider',
      provideProvider: () => {
        throw Error('must not start backend');
      },
    },
    'test',
    { journalPowers: w.guest, attachments: manager },
  );
  t.teardown(async () => {
    w.refuseDismiss(false);
    w.inbox.close();
    await agent.shutdown();
  });
  await t.throwsAsync(
    () =>
      agent.converse(
        'Read @document',
        makeReplyChannel().writer,
        harden({ message }),
        undefined,
        undefined,
        undefined,
        w.references,
      ),
    { message: /Attachment cleanup failed/ },
  );
  await t.throwsAsync(
    () => agent.converse('another', makeReplyChannel().writer),
    { message: /Attachment cleanup failed/ },
  );
  t.is(opens, 1);
  w.refuseDismiss(false);
  await agent.shutdown();
  t.is(w.messages.size, 0);
});

test('a restarted inbox dismisses orphaned self packages without starting a second turn', async t => {
  t.timeout(5000);
  const w = setup(t);
  await w.manager.open(message, w.references, 'old-incarnation', () => {});
  let backendCalls = 0;
  const agent = await makeStreamingAgent(
    w.guest,
    undefined,
    {
      kind: 'hosted',
      provideHostedClient: () => {
        backendCalls += 1;
        throw Error('must not run');
      },
    },
    'test',
    {
      journalPowers: w.guest,
      attachments: makeSessionAttachments(w.host, w.guest, 'one'),
    },
  );
  t.teardown(async () => {
    w.inbox.close();
    await agent.shutdown();
  });
  agent.startInbox();
  for (let i = 0; i < 100 && w.messages.size; i += 1)
    await new Promise(resolve => setTimeout(resolve, 1));
  t.is(w.messages.size, 0);
  t.is(backendCalls, 0);
  t.deepEqual(await agent.getTurns(), []);
});
