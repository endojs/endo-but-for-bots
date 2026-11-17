// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { loadFromJsonl } from '@endo/jsonl-transcript/reader.js';

import {
  findLatestSessionFile,
  openWorkerTranscript,
  provideTranscriptsMount,
  TRANSCRIPTS_MOUNT_NAME,
  uuidv7,
} from '../transcript.js';

/**
 * An in-memory stand-in for a writable daemon scratch mount: just the
 * methods the transcript harness uses.
 */
const makeMemoryMount = () => {
  /** @type {Map<string, string>} */
  const files = new Map();
  const mount = makeExo(
    'MemoryMount',
    M.interface('MemoryMount', {}, { defaultGuards: 'passable' }),
    {
      list: () => harden([...files.keys()]),
      maybeReadText: path => files.get(path),
      writeText: (path, text) => {
        files.set(path, text);
      },
      makeFile: (path, text = '') => {
        if (files.has(path)) throw Error(`exists: ${path}`);
        files.set(path, text);
      },
      lookup: path => {
        if (!files.has(path)) throw Error(`absent: ${path}`);
        return makeExo(
          'MemoryMountFile',
          M.interface('MemoryMountFile', {}, { defaultGuards: 'passable' }),
          {
            append: text => {
              files.set(path, `${files.get(path)}${text}`);
            },
          },
        );
      },
    },
  );
  return { mount, files };
};

const makeClock = (start = 1_700_000_000_000) => {
  let t = start;
  return () => {
    t += 1;
    return t;
  };
};

const user = text => ({ role: 'user', content: text, timestamp: 1 });
const assistant = text => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  stopReason: 'stop',
  timestamp: 2,
});

test('uuidv7 has the version and variant bits and a sortable time prefix', t => {
  const a = uuidv7(() => 1000);
  const b = uuidv7(() => 2000);
  t.regex(
    a,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  t.true(a < b);
});

test('a fresh session writes a header, the mail entry, and linked messages', async t => {
  const { mount, files } = makeMemoryMount();
  const now = makeClock();
  const transcript = await openWorkerTranscript({
    mount,
    workerName: 'alice',
    now,
  });
  t.deepEqual(transcript.seedMessages, []);

  await transcript.recordMail({ number: 3n, messageIdentifier: 'm-1' });
  await transcript.recordMessages([
    { role: 'system', content: 'not projected' },
    user('hi'),
    assistant('hello'),
  ]);

  t.deepEqual([...files.keys()], [transcript.fileName]);
  t.true(transcript.fileName.endsWith('.jsonl'));
  const { header, entries } = loadFromJsonl(
    /** @type {string} */ (files.get(transcript.fileName)),
  );
  t.like(header, { type: 'header', version: 3 });
  t.true(String(header?.sessionId).startsWith('alice--'));
  const nodes = entries.filter(entry => entry.type !== 'header');
  t.deepEqual(
    nodes.map(entry => entry.type),
    ['custom', 'message', 'message'],
  );
  t.like(nodes[0], {
    parentId: null,
    custom: { 'endo:kind': 'endo:mail', messageId: 'm-1', number: '3' },
  });
  t.is(nodes[1].parentId, nodes[0].id);
  t.is(nodes[2].parentId, nodes[1].id);
});

test('a restarted worker resumes the same file, seeds messages, and appends only news', async t => {
  const { mount, files } = makeMemoryMount();
  const now = makeClock();
  const first = await openWorkerTranscript({ mount, workerName: 'alice', now });
  await first.recordMessages([user('one'), assistant('two')]);
  const textBefore = files.get(first.fileName);

  const second = await openWorkerTranscript({
    mount,
    workerName: 'alice',
    now,
  });
  t.is(second.fileName, first.fileName);
  t.deepEqual(
    second.seedMessages.map(message => message.role),
    ['user', 'assistant'],
  );

  // The PiAgent holds the seeded messages; re-recording them is a no-op.
  const state = [...second.seedMessages];
  second.markRecorded(state);
  await second.recordMessages(state);
  t.is(files.get(first.fileName), textBefore);

  const next = user('three');
  await second.recordMessages([...state, next]);
  const { entries } = loadFromJsonl(
    /** @type {string} */ (files.get(first.fileName)),
  );
  const nodes = entries.filter(entry => entry.type !== 'header');
  t.is(nodes.length, 3);
  t.is(nodes[2].parentId, nodes[1].id);
  t.is(entries.filter(entry => entry.type === 'header').length, 1);
});

test('a torn tail is repaired on reopen', async t => {
  const { mount, files } = makeMemoryMount();
  const now = makeClock();
  const first = await openWorkerTranscript({ mount, workerName: 'alice', now });
  await first.recordMessages([user('kept')]);
  files.set(
    first.fileName,
    `${files.get(first.fileName)}{"type":"message","id":"torn`,
  );

  const second = await openWorkerTranscript({
    mount,
    workerName: 'alice',
    now,
  });
  t.deepEqual(
    second.seedMessages.map(message => message.content),
    ['kept'],
  );
  t.true(String(files.get(first.fileName)).endsWith('\n'));
  t.false(String(files.get(first.fileName)).includes('torn'));
});

test('workers share one mount without crossing sessions; fresh starts a new file', async t => {
  const { mount } = makeMemoryMount();
  const now = makeClock();
  const alice = await openWorkerTranscript({ mount, workerName: 'alice', now });
  await alice.recordMessages([user('for alice')]);
  const bob = await openWorkerTranscript({ mount, workerName: 'bob', now });
  t.not(bob.fileName, alice.fileName);
  t.deepEqual(bob.seedMessages, []);
  t.is(await findLatestSessionFile(mount, 'alice'), alice.fileName);

  const aliceAgain = await openWorkerTranscript({
    mount,
    workerName: 'alice',
    now,
    fresh: true,
  });
  t.not(aliceAgain.fileName, alice.fileName);
  t.deepEqual(aliceAgain.seedMessages, []);
  await aliceAgain.recordMessages([user('new session')]);
  t.is(await findLatestSessionFile(mount, 'alice'), aliceAgain.fileName);
});

test('provideTranscriptsMount reuses an existing pet name', async t => {
  const { mount } = makeMemoryMount();
  /** @type {Map<string, unknown>} */
  const names = new Map();
  let made = 0;
  const host = makeExo(
    'Host',
    M.interface('Host', {}, { defaultGuards: 'passable' }),
    {
      has: name => names.has(name),
      lookup: name => names.get(name),
      provideScratchMount: name => {
        made += 1;
        names.set(name, mount);
        return mount;
      },
    },
  );
  t.is(await provideTranscriptsMount(host), mount);
  t.is(await provideTranscriptsMount(host), mount);
  t.is(made, 1);
  t.true(names.has(TRANSCRIPTS_MOUNT_NAME));
});
