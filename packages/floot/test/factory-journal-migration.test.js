// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { Far } from '@endo/far';

import { make } from '../agent.js';

test('factory fences an erased legacy journal and ignores later guest forgeries', async t => {
  t.timeout(5000);
  const inboxes = [];
  const guestStore = new Map([['user', harden({})]]);
  const guest = Far('MigrationGuest', {
    has: name => guestStore.has(name),
    lookup: name => guestStore.get(name),
    storeValue: (value, name) => {
      guestStore.set(name, value);
    },
    list: prefix => harden(prefix === 'tools' ? [] : [...guestStore.keys()]),
    locate: () => 'test-locator',
    followMessages: () => {
      const inbox = makeBufferedReader();
      inboxes.push(inbox);
      return inbox.reader;
    },
  });
  let sends = 0;
  const backend = Far('MigrationBackend', {
    describe: () =>
      harden({
        id: 'test',
        title: 'Test',
        kind: 'hosted',
        continuity: 'explicit',
        toolOwnership: 'endo',
      }),
    create: () =>
      harden({
        run: Far('MigrationRun', {
          send: () => {
            sends += 1;
            const stream = makeBufferedReader();
            stream.push(harden({ type: 'text-delta', text: 'reviewed' }));
            stream.push(harden({ type: 'end' }));
            t.teardown(() => stream.close());
            return stream.reader;
          },
          interrupt: () => undefined,
          acknowledge: () => undefined,
        }),
        admin: Far('MigrationAdmin', { terminate: () => undefined }),
      }),
    destroy: () => undefined,
  });
  const hostStore = new Map(
    /** @type {[string, unknown][]} */ ([
      ['session-agent-one', guest],
      ['codex-backend', backend],
      [
        'floot-sessions',
        harden([
          {
            id: 'one',
            title: 'One',
            createdAt: 1,
            presetId: 'general',
            lifecycle: 'ready',
            backendId: 'test',
            modelId: 'm',
          },
        ]),
      ],
    ]),
  );
  const host = Far('MigrationHost', {
    has: name => hostStore.has(name),
    lookup: name => hostStore.get(name),
    list: () => harden([...hostStore.keys()]),
    storeValue: (value, name) => {
      hostStore.set(name, value);
    },
    remove: name => hostStore.delete(name),
    provideGuest: () => undefined,
  });
  const factory = make(host);
  t.teardown(async () => {
    for (const inbox of inboxes) inbox.close();
    await E(factory).deleteSession('one');
  });
  const session = await E(factory).getSession('one');
  const refused = await E(session).startTurn('do not dispatch');
  await E(refused).whenFinished();
  t.is(sends, 0);
  t.regex((await E(refused).getStatus()).error, /imported legacy journal/);
  t.like((await E(session).getTurns())[0], {
    turnId: 'legacy-import',
    state: 'outcome-unknown',
  });
  t.is((await E(session).getJournalStatus()).storage, 'private');
  await E(session).resolveTurn(
    'legacy-import',
    'External effects checked despite erased legacy history',
  );
  guestStore.set(
    'floot-turn-event-00000000000000000001',
    harden({ type: 'forged' }),
  );
  const accepted = await E(session).startTurn('now review');
  await E(accepted).whenFinished();
  t.falsy((await E(accepted).getStatus()).error);
  t.is(sends, 1);
  t.like((await E(session).getTurns())[1], {
    state: 'completed',
    output: 'reviewed',
  });
  // Revive against the same private anchors; never adopt model-written copies.
  const revived = await E(make(host)).getSession('one');
  t.deepEqual(await E(revived).getTurns(), await E(session).getTurns());
});
