// @ts-check
/* eslint-disable no-await-in-loop */
import test from '@endo/ses-ava/prepare-endo.js';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { loadFromJsonl } from '@endo/jsonl-transcript/reader.js';

import {
  findLatestSessionFile,
  makeTranscriptRoundRunner,
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

test('uuidv7 rejects a tamed or out-of-range clock', t => {
  t.throws(() => uuidv7(() => NaN), { instanceOf: RangeError });
  t.throws(() => uuidv7(() => -1), { instanceOf: RangeError });
  t.throws(() => uuidv7(() => 2 ** 48), { instanceOf: RangeError });
  t.regex(
    uuidv7(() => 2 ** 48 - 1),
    /^ffffffff-ffff-7/,
  );
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
  // The worker key is the hex of the UTF-8 name: `alice` is 616c696365.
  t.true(String(header?.sessionId).startsWith('w616c696365--'));
  t.is(header?.['endo:worker'], 'alice');
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

test('worker names that embed or slug like another never share a session', async t => {
  const { mount } = makeMemoryMount();
  const now = makeClock();
  const names = ['a', 'x_a', 'a--x', 'a b', 'a-b', 'a/b', '', 'é'];
  /** @type {Map<string, string>} */
  const fileNames = new Map();
  for (const workerName of names) {
    const transcript = await openWorkerTranscript({ mount, workerName, now });
    await transcript.recordMessages([user(`for ${workerName}`)]);
    fileNames.set(workerName, transcript.fileName);
  }
  t.is(new Set(fileNames.values()).size, names.length);
  for (const workerName of names) {
    t.is(
      await findLatestSessionFile(mount, workerName),
      fileNames.get(workerName),
    );
    const resumed = await openWorkerTranscript({ mount, workerName, now });
    t.deepEqual(
      resumed.seedMessages.map(message => message.content),
      [`for ${workerName}`],
    );
  }
});

test('a file whose header names another worker is not resumed', async t => {
  const { mount, files } = makeMemoryMount();
  const now = makeClock();
  const alice = await openWorkerTranscript({ mount, workerName: 'alice', now });
  await alice.recordMessages([user('mine')]);
  const forged = alice.fileName.replace(/^\d{14}/, '99999999999999');
  files.set(
    forged,
    String(files.get(alice.fileName)).replace(
      '"endo:worker":"alice"',
      '"endo:worker":"mallory"',
    ),
  );
  t.is(await findLatestSessionFile(mount, 'alice'), alice.fileName);
});

test('the transcript is hardened and hands out copies of its seed', async t => {
  const { mount } = makeMemoryMount();
  const now = makeClock();
  const first = await openWorkerTranscript({ mount, workerName: 'alice', now });
  await first.recordMessages([user('one')]);
  const second = await openWorkerTranscript({
    mount,
    workerName: 'alice',
    now,
  });
  t.true(Object.isFrozen(second));
  const seed = second.seedMessages;
  seed.push(user('injected'));
  t.is(second.seedMessages.length, 1);
});

test('a failed append is retried by the next record, in order', async t => {
  const { mount, files } = makeMemoryMount();
  const now = makeClock();
  let failNext = false;
  const flakyMount = makeExo(
    'FlakyMount',
    M.interface('FlakyMount', {}, { defaultGuards: 'passable' }),
    {
      list: () => mount.list(),
      maybeReadText: path => mount.maybeReadText(path),
      writeText: (path, text) => mount.writeText(path, text),
      makeFile: (path, text) => mount.makeFile(path, text),
      lookup: path => {
        const file = mount.lookup(path);
        return makeExo(
          'FlakyFile',
          M.interface('FlakyFile', {}, { defaultGuards: 'passable' }),
          {
            append: text => {
              if (failNext) {
                failNext = false;
                throw Error('transient');
              }
              return file.append(text);
            },
          },
        );
      },
    },
  );
  const transcript = await openWorkerTranscript({
    mount: flakyMount,
    workerName: 'alice',
    now,
  });
  const one = user('one');
  const two = assistant('two');
  failNext = true;
  await t.throwsAsync(() => transcript.recordMessages([one, two]), {
    message: 'transient',
  });
  await transcript.recordMessages([one, two]);
  const { entries } = loadFromJsonl(
    /** @type {string} */ (files.get(transcript.fileName)),
  );
  const nodes = entries.filter(entry => entry.type === 'message');
  t.deepEqual(
    nodes.map(entry => entry.message.role),
    ['user', 'assistant'],
  );
  t.is(nodes[0].parentId, null);
  t.is(nodes[1].parentId, nodes[0].id);
});

/**
 * A PiAgent stand-in: `runRound` appends the round's messages to
 * `state.messages`, as pi-agent-core does, and may throw midway.
 *
 * @param {unknown[]} seed
 */
const makeFakePiAgent = seed => {
  const piAgent = { state: { messages: [...seed] } };
  /**
   * @param {typeof piAgent} agent
   * @param {string} prompt
   */
  const runRound = async (agent, prompt) => {
    agent.state.messages.push(user(prompt));
    if (prompt.startsWith('fail')) {
      throw Error('round failed');
    }
    agent.state.messages.push(assistant(`re: ${prompt}`));
  };
  return { piAgent, runRound };
};

test('the round runner seeds, records mail, and records even a failed round', async t => {
  const { mount, files } = makeMemoryMount();
  const now = makeClock();
  const first = await openWorkerTranscript({ mount, workerName: 'alice', now });
  {
    const { piAgent, runRound } = makeFakePiAgent(first.seedMessages);
    const runOneRound = makeTranscriptRoundRunner({
      transcript: first,
      piAgent,
      runRound,
    });
    await runOneRound('hello', { number: 1n, messageIdentifier: 'm-1' });
    await t.throwsAsync(() => runOneRound('fail now', { number: 2n }), {
      message: 'round failed',
    });
  }
  const textAfterFirst = String(files.get(first.fileName));
  const kinds = loadFromJsonl(textAfterFirst)
    .entries.filter(entry => entry.type !== 'header')
    .map(entry => (entry.type === 'message' ? entry.message.role : entry.type));
  t.deepEqual(kinds, ['custom', 'user', 'assistant', 'custom', 'user']);

  // A restarted worker seeds its PiAgent and appends only the new round.
  const second = await openWorkerTranscript({
    mount,
    workerName: 'alice',
    now,
  });
  const { piAgent, runRound } = makeFakePiAgent(second.seedMessages);
  t.is(piAgent.state.messages.length, 3);
  const runOneRound = makeTranscriptRoundRunner({
    transcript: second,
    piAgent,
    runRound,
  });
  await runOneRound('again');
  const text = String(files.get(first.fileName));
  t.true(text.startsWith(textAfterFirst));
  const added = loadFromJsonl(text.slice(textAfterFirst.length - 1)).entries;
  t.deepEqual(
    added.map(entry => /** @type {any} */ (entry).message.content),
    ['again', [{ type: 'text', text: 're: again' }]],
  );
});

test('the round runner reports, and does not throw, a transcript write failure', async t => {
  /** @type {unknown[]} */
  const errors = [];
  const transcript = /** @type {any} */ ({
    markRecorded() {},
    async recordMail() {
      throw Error('mail write');
    },
    async recordMessages() {
      throw Error('message write');
    },
  });
  const { piAgent, runRound } = makeFakePiAgent([]);
  const runOneRound = makeTranscriptRoundRunner({
    transcript,
    piAgent,
    runRound,
    onError: error => errors.push(error),
  });
  await runOneRound('hello', { number: 1 });
  t.is(piAgent.state.messages.length, 2);
  t.deepEqual(
    errors.map(error => /** @type {Error} */ (error).message),
    ['mail write', 'message write'],
  );
});
