// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import { makeTurnJournal } from '../src/turn-journal.js';

const fixture = () => {
  const store = new Map();
  /** @type {string[]} */
  const reads = [];
  let fail = false;
  const powers = Far('JournalStorage', {
    list: () => harden([...store.keys()]),
    lookup: name => {
      reads.push(name);
      return store.get(name);
    },
    storeValue: (value, name) => {
      if (store.has(name)) throw Error('Overwrite forbidden');
      store.set(name, value);
      if (fail) throw Error('Lost acknowledgement');
    },
    remove: name => {
      if (!store.has(name)) throw Error('Unknown name');
      store.delete(name);
    },
  });
  return {
    store,
    reads,
    powers,
    fail: () => {
      fail = true;
    },
  };
};
const options = harden({
  input: 'Review architecture',
  backendId: 'codex',
  modelId: 'sol',
});

test('targeted reads are detached snapshots and invalid transitions leave evidence unchanged', async t => {
  const { powers, store } = fixture();
  const journal = makeTurnJournal(powers);
  const id = await journal.begin(options);
  await journal.append(id, {
    type: 'tool-intent',
    callId: 'a',
    name: 'read',
    args: { path: 'x' },
  });
  const before = await journal.get(id);
  await t.throwsAsync(
    journal.append(id, {
      type: 'finish',
      state: 'invalid',
      output: 'not committed',
    }),
    { message: /Invalid terminal/ },
  );
  t.deepEqual(await journal.get(id), before);
  t.is(store.size, 2);
  await journal.append(id, { type: 'tool-result', callId: 'a', result: 'ok' });
  t.is(before.tools[0].settled, undefined);
  t.true((await journal.get(id)).tools[0].settled);
  await journal.append(id, { type: 'finish', state: 'completed' });
  const next = await journal.begin(options);
  t.is((await journal.get(next)).state, 'pending');
  t.is((await journal.get(id)).state, 'completed');
  await t.throwsAsync(journal.get('missing'), { message: /Unknown turn/ });
  t.deepEqual(await journal.get(id), (await journal.list())[0]);
  t.deepEqual(await makeTurnJournal(powers).get(id), await journal.get(id));
});

test('prepared transitions wait for storage and serialize following reads', async t => {
  t.timeout(5000);
  const store = new Map();
  // Replaced synchronously by the executor below; typed so the later call is
  // not reading a possibly-undefined binding.
  /** @type {(value?: any) => void} */
  let release = () => {};
  const barrier = new Promise(resolve => {
    release = resolve;
  });
  let writing;
  const entered = new Promise(resolve => {
    writing = resolve;
  });
  const powers = Far('DelayedJournalStorage', {
    list: () => harden([...store.keys()]),
    lookup: name => store.get(name),
    storeValue: async (value, name) => {
      if (value.type === 'tool-intent') {
        writing();
        await barrier;
      }
      store.set(name, value);
    },
  });
  const journal = makeTurnJournal(powers);
  const id = await journal.begin(options);
  const intent = journal.append(id, {
    type: 'tool-intent',
    callId: 'a',
    name: 'read',
    args: {},
  });
  await entered;
  let readFinished = false;
  const read = journal.get(id).then(record => {
    readFinished = true;
    return record;
  });
  await Promise.resolve();
  t.false(readFinished);
  t.is(store.size, 1);
  release();
  await intent;
  t.is((await read).tools[0].callId, 'a');
  await journal.append(id, { type: 'tool-result', callId: 'a', result: 'ok' });
  t.is((await journal.get(id)).tools[0].result, 'ok');
});

test('lost result acknowledgement poisons prepared writer and revival reads committed result', async t => {
  const f = fixture();
  const journal = makeTurnJournal(f.powers);
  const id = await journal.begin(options);
  await journal.append(id, {
    type: 'tool-intent',
    callId: 'a',
    name: 'read',
    args: {},
  });
  f.fail();
  await t.throwsAsync(
    journal.append(id, {
      type: 'tool-result',
      callId: 'a',
      result: 'durable despite lost acknowledgement',
    }),
    { message: /Lost acknowledgement/ },
  );
  await t.throwsAsync(journal.get(id), { message: /uncertain storage/ });
  const recovered = await makeTurnJournal(f.powers).get(id);
  t.is(recovered.state, 'outcome-unknown');
  t.is(recovered.tools[0].result, 'durable despite lost acknowledgement');
  t.true(recovered.tools[0].settled);
});

test('legacy import acknowledgement is independent of event capacity and unknown turns', async t => {
  const { powers } = fixture();
  const pending = await makeTurnJournal(powers).begin(options);
  let resolution;
  const migration = Far('Migration', {
    status: () =>
      harden({ required: true, ...(resolution ? { resolution } : {}) }),
    resolve: note => {
      resolution = note;
    },
  });
  const journal = makeTurnJournal(powers, { migration });
  t.is((await journal.list())[0].turnId, 'legacy-import');
  await t.throwsAsync(journal.begin(options), { message: /imported legacy/ });
  await t.throwsAsync(journal.resolve('legacy-import', '   '));
  const before = await journal.status();
  await journal.resolve(
    'legacy-import',
    'Checked the external system independently',
  );
  t.deepEqual(await journal.status(), before);
  await journal.assertReady();
  await journal.resolve(pending, 'No external effects occurred');
  await journal.assertReady();
  const revived = makeTurnJournal(powers, { migration });
  await revived.assertReady();
  t.is((await revived.list())[0].resolution, resolution);
});

test('legacy acknowledgement loss poisons only the current incarnation', async t => {
  const { powers } = fixture();
  let resolution;
  const migration = Far('Migration', {
    status: () =>
      harden({ required: true, ...(resolution ? { resolution } : {}) }),
    resolve: note => {
      resolution = note;
      throw Error('Lost acknowledgement');
    },
  });
  const journal = makeTurnJournal(powers, { migration });
  await t.throwsAsync(
    journal.resolve('legacy-import', 'External effects checked'),
  );
  await t.throwsAsync(journal.assertReady(), { message: /uncertain storage/ });
  await makeTurnJournal(powers, { migration }).assertReady();
  t.pass();
});

test('empty input and backend-default model are valid, optional usage is omitted', async t => {
  const { powers } = fixture();
  const journal = makeTurnJournal(powers);
  const id = await journal.begin({
    input: '',
    backendId: 'direct',
    modelId: '',
  });
  await journal.append(id, {
    type: 'finish',
    state: 'completed',
    output: '',
    usage: undefined,
  });
  t.is((await journal.list())[0].modelId, '');
  t.false(Object.hasOwn((await journal.list())[0], 'usage'));
});

test('recovered turns cannot acquire new tool intents even after acknowledgement', async t => {
  const { powers } = fixture();
  const id = await makeTurnJournal(powers).begin(options);
  const journal = makeTurnJournal(powers);
  await journal.resolve(id, 'Checked');
  await t.throwsAsync(
    journal.append(id, {
      type: 'tool-intent',
      callId: 'new',
      name: 'exec',
      args: {},
    }),
    { message: /recovered turn/ },
  );
});

test('observed native activity is durable and separate from write-ahead tools', async t => {
  const { powers } = fixture();
  const journal = makeTurnJournal(powers);
  const id = await journal.begin(options);
  await Promise.all(
    ['tool-intent', 'observed-tool-call'].map(type =>
      journal.append(id, {
        type,
        callId: 'same-id',
        name: 'exec',
        args: '{}',
      }),
    ),
  );
  await journal.append(id, {
    type: 'tool-result',
    callId: 'same-id',
    result: 'authorized result',
  });
  await journal.append(id, {
    type: 'observed-tool-result',
    callId: 'same-id',
    result: 'observed result',
  });
  await journal.append(id, {
    type: 'finish',
    state: 'completed',
    output: 'done',
  });
  const revived = makeTurnJournal(powers);
  await revived.assertReady();
  const [record] = await revived.list();
  t.is(record.tools[0].result, 'authorized result');
  t.is(record.activity[0].result, 'observed result');
  t.is(record.state, 'completed');
});

test('unsettled observed activity fences terminal outcome and late results do not erase uncertainty', async t => {
  const { powers } = fixture();
  const journal = makeTurnJournal(powers);
  const id = await journal.begin(options);
  await journal.append(id, {
    type: 'observed-tool-call',
    callId: 'native',
    name: 'exec',
    args: '{}',
  });
  await t.throwsAsync(
    journal.append(id, {
      type: 'observed-tool-call',
      callId: 'native',
      name: 'exec',
      args: '{}',
    }),
    { message: /Duplicate tool/ },
  );
  await t.throwsAsync(
    journal.append(id, {
      type: 'tool-result',
      callId: 'native',
      result: 'wrong channel',
    }),
    { message: /without intent/ },
  );
  await journal.append(id, {
    type: 'finish',
    state: 'completed',
    output: 'claimed done',
  });
  await journal.assertReady();
  await journal.append(id, {
    type: 'observed-tool-result',
    callId: 'native',
    result: 'late known result',
  });
  await journal.assertReady();
  await journal.resolve(id, 'Operator checked native effect');
  await journal.assertReady();
  const [record] = await makeTurnJournal(powers).list();
  t.is(record.state, 'outcome-unknown');
  t.is(record.activity[0].result, 'late known result');
  t.is(record.resolution, 'Operator checked native effect');
  t.is(record.tools.length, 0);
});

test('journal persists complete turns and concurrent tool results in order', async t => {
  const { powers, store } = fixture();
  const journal = makeTurnJournal(powers);
  const id = await journal.begin(options);
  await journal.assertReady();
  await journal.append(id, {
    type: 'tool-intent',
    callId: 'a',
    name: 'read',
    args: { path: 'x' },
  });
  await journal.append(id, {
    type: 'tool-intent',
    callId: 'b',
    name: 'read',
    args: { path: 'y' },
  });
  await Promise.all(
    ['a', 'b'].map(callId =>
      journal.append(id, { type: 'tool-result', callId, result: 'ok' }),
    ),
  );
  await journal.append(id, {
    type: 'finish',
    state: 'completed',
    output: 'report',
    conversationNodeId: 'node',
  });
  const revived = makeTurnJournal(powers);
  await revived.assertReady();
  t.deepEqual(await revived.list(), await journal.list());
  t.is((await revived.list())[0].tools.length, 2);
  t.is(store.size, 6);
});

test('revival preserves unknown outcomes while new work and explicit resolution remain independent', async t => {
  const { powers } = fixture();
  const first = makeTurnJournal(powers);
  const id = await first.begin(options);
  await first.append(id, {
    type: 'tool-intent',
    callId: 'a',
    name: 'exec',
    args: {},
  });
  const journal = makeTurnJournal(powers);
  await journal.assertReady();
  const next = await journal.begin(options);
  t.is((await journal.get(id)).resolution, undefined);
  await t.throwsAsync(journal.begin(options), { message: /already active/ });
  await journal.resolve(id, 'Operator checked the effect');
  await journal.append(id, {
    type: 'tool-result',
    callId: 'a',
    result: 'late',
  });
  const records = await journal.list();
  t.is(records[0].state, 'outcome-unknown');
  t.is(records[0].resolution, 'Operator checked the effect');
  t.is(records[0].tools[0].result, 'late');
  t.is(records[1].turnId, next);
  t.is(records[1].tools.length, 0);
});

test('terminal turn with unresolved effect is unknown, including cancellation', async t => {
  const { powers } = fixture();
  const journal = makeTurnJournal(powers);
  const id = await journal.begin(options);
  await journal.append(id, {
    type: 'tool-intent',
    callId: 'a',
    name: 'exec',
    args: {},
  });
  await journal.append(id, {
    type: 'finish',
    state: 'cancelled',
    error: 'Cancelled',
  });
  t.is((await journal.list())[0].state, 'outcome-unknown');
  t.is((await journal.list())[0].reportedState, 'cancelled');
  await journal.assertReady();
});

test('ambiguous writes poison all subsequent operations, revival keeps committed intent', async t => {
  const f = fixture();
  const journal = makeTurnJournal(f.powers);
  f.fail();
  await t.throwsAsync(journal.begin(options), {
    message: /Lost acknowledgement/,
  });
  await t.throwsAsync(journal.begin(options), { message: /uncertain storage/ });
  await t.throwsAsync(journal.list(), { message: /uncertain storage/ });
  const recovered = makeTurnJournal(f.powers);
  t.is((await recovered.list())[0].state, 'outcome-unknown');
});

test('missing journal events fail closed instead of loading a newer suffix', async t => {
  const f = fixture();
  const journal = makeTurnJournal(f.powers);
  const id = await journal.begin(options);
  await journal.append(id, {
    type: 'finish',
    state: 'failed',
    error: 'Unavailable',
  });
  f.store.delete([...f.store.keys()][0]);
  await t.throwsAsync(makeTurnJournal(f.powers).list(), {
    message: /missing or malformed/,
  });
});

test('invalid or excessive values never persist capabilities or partial events', async t => {
  const { powers, store } = fixture();
  const journal = makeTurnJournal(powers);
  const id = await journal.begin(options);
  await t.throwsAsync(
    journal.append(id, { type: 'tool-result', callId: 'missing', result: 'x' }),
    { message: /without intent/ },
  );
  await t.throwsAsync(
    journal.append(id, {
      type: 'tool-intent',
      callId: 'a',
      name: 'exec',
      args: { cap: powers },
    }),
    { message: /inert JSON/ },
  );
  await t.throwsAsync(
    journal.append(id, {
      type: 'finish',
      state: 'failed',
      error: Error('secret'),
    }),
    { message: /inert JSON/ },
  );
  // A field beyond the storage-value bound fails the append and persists
  // nothing; a field beyond the preview bound is stored by reference below.
  await t.throwsAsync(
    journal.append(id, {
      type: 'finish',
      state: 'completed',
      output: 'x'.repeat(16 * 1024 * 1024 + 1),
    }),
    { message: /storage value bound/ },
  );
  t.is(store.size, 1);
  await journal.append(id, {
    type: 'finish',
    state: 'completed',
    output: 'ok',
  });
  t.is((await journal.list())[0].state, 'completed');
});

test('large text is stored by reference: the record keeps a preview, the content is readable', async t => {
  const { powers, store } = fixture();
  const journal = makeTurnJournal(powers);
  const big = 'y'.repeat(131_072);
  const id = await journal.begin({ ...options, input: big });
  await journal.append(id, {
    type: 'tool-intent',
    callId: 'a',
    name: 'read',
    args: '{}',
  });
  await journal.append(id, { type: 'tool-result', callId: 'a', result: big });
  await journal.append(id, { type: 'finish', state: 'completed', output: big });
  const [record] = await journal.list();
  t.is(record.input.length, 8192);
  t.is(record.inputRef.chars, big.length);
  t.is(record.tools[0].result.length, 8192);
  t.is(record.output.length, 8192);
  t.is(await journal.readContent(record.inputRef), big);
  t.is(await journal.readContent(record.tools[0].resultRef), big);
  t.is(await journal.readContent(record.outputRef), big);
  // The content was written before the event that refers to it, and no
  // stored event approaches the event bound.
  for (const [name, value] of store) {
    if (name.startsWith('floot-turn-event-')) {
      t.true(JSON.stringify(value).length <= 131_072, name);
    }
  }
  // A revival reads the same previews and can still reach the content.
  const revived = makeTurnJournal(powers);
  t.deepEqual(await revived.list(), await journal.list());
  t.is(await revived.readContent(record.outputRef), big);
  // A reference is data, not a capability: only names this journal wrote
  // resolve, and content must match what the reference claims.
  await t.throwsAsync(
    revived.readContent({
      name: 'floot-turn-content-00000000000000000009-output',
      chars: 9000,
    }),
    { message: /Unknown turn journal content/ },
  );
  await t.throwsAsync(
    revived.readContent({ name: 'floot-usage', chars: 9000 }),
    {
      message: /Invalid turn journal content reference/,
    },
  );
});

test('replay is bounded by snapshots: covered events are kept but not read again', async t => {
  const { powers, store, reads } = fixture();
  const journal = makeTurnJournal(powers);
  const ids = [];
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const id = await journal.begin(options);
    ids.push(id);
    // eslint-disable-next-line no-await-in-loop
    await journal.append(id, {
      type: 'finish',
      state: 'completed',
      output: `out ${i}`,
    });
  }
  // 80 events and a snapshot at 64. Every event is still there — the
  // transcript is kept until the session is removed — but a revival reads
  // the snapshot and only the 16 events after it.
  const events = [...store.keys()].filter(name =>
    name.startsWith('floot-turn-event-'),
  );
  const snapshots = [...store.keys()].filter(name =>
    name.startsWith('floot-turn-snapshot-'),
  );
  t.is(snapshots.length, 1);
  t.is(events.length, 80);
  const expected = await journal.list();
  t.is(expected.length, 40);
  reads.length = 0;
  const revived = makeTurnJournal(powers);
  t.deepEqual(await revived.list(), expected);
  const replayed = reads.filter(name => name.startsWith('floot-turn-event-'));
  t.is(replayed.length, 16);
  t.true(replayed.every(name => BigInt(name.slice(-20)) > 64n));
  t.like(await revived.status(), {
    usedEvents: '80',
    retainedTurns: 40,
    archivedTurns: 0,
  });
  // A turn pending at the snapshot is recovered as outcome-unknown, and a
  // later event still settles it.
  const pending = await revived.begin(options);
  for (let i = 0; i < 64; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await revived.append(pending, {
      type: 'observed-tool-call',
      callId: `c${i}`,
      name: 'shell',
      args: '{}',
    });
  }
  const midTurn = makeTurnJournal(powers);
  t.is((await midTurn.get(pending)).state, 'outcome-unknown');
  t.is((await midTurn.get(pending)).activity.length, 64);
});

test('a stale snapshot left by a crash is superseded, never trusted over the newer one', async t => {
  const { powers, store } = fixture();
  const journal = makeTurnJournal(powers);
  for (let i = 0; i < 64; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await journal
      .begin(options)
      .then(id => journal.append(id, { type: 'finish', state: 'completed' }));
  }
  // Two snapshots have been taken (at 64 and 128) and the first was removed;
  // put a stale copy of it back, as a crash between the second write and the
  // first's removal would leave it.
  const [newest] = [...store.keys()].filter(name =>
    name.startsWith('floot-turn-snapshot-'),
  );
  t.is(newest, 'floot-turn-snapshot-00000000000000000128');
  const stale = { ...store.get(newest), through: '64', records: [] };
  store.set('floot-turn-snapshot-00000000000000000064', harden(stale));
  const revived = makeTurnJournal(powers);
  t.is((await revived.list()).length, 64);
  // The next snapshot clears the stale one.
  for (let i = 0; i < 32; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await revived
      .begin(options)
      .then(id => revived.append(id, { type: 'finish', state: 'completed' }));
  }
  t.deepEqual(
    [...store.keys()].filter(name => name.startsWith('floot-turn-snapshot-')),
    ['floot-turn-snapshot-00000000000000000192'],
  );
});

test('settled turns beyond the retained window are archived; unresolved ones never are', async t => {
  const { powers, store } = fixture();
  const journal = makeTurnJournal(powers);
  // One unresolved turn at the very start, then enough settled turns to push
  // the window.
  const unknown = await journal.begin(options);
  await journal.append(unknown, {
    type: 'tool-intent',
    callId: 'a',
    name: 'exec',
    args: '{}',
  });
  await journal.append(unknown, { type: 'finish', state: 'completed' });
  t.is((await journal.get(unknown)).state, 'outcome-unknown');
  for (let i = 0; i < 300; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await journal.begin(options).then(id =>
      journal.append(id, {
        type: 'finish',
        state: 'completed',
        output: `${i}`,
      }),
    );
  }
  const status = await journal.status();
  t.is(status.retainedTurns + status.archivedTurns, 301);
  // The window is enforced at snapshot points, so up to a snapshot's worth of
  // turns (64 events, two per turn here) may sit above it between them.
  t.true(
    status.retainedTurns <= 256 + 1 + 32,
    'the window, the unresolved turn, and at most one snapshot interval',
  );
  t.true(status.archivedTurns > 0);
  const live = await journal.list();
  t.truthy(
    live.find(record => record.turnId === unknown),
    'unresolved stays in front',
  );
  const archived = await journal.listArchived();
  t.is(archived.length, status.archivedTurns);
  t.true(archived.every(record => record.state === 'completed'));
  t.is(archived[0].output, '0', 'oldest settled turn archived first');
  t.true(
    [...store.keys()].some(name => name.startsWith('floot-turn-archive-')),
  );
  // Archived turns are not in memory, but the whole history is still there.
  const revived = makeTurnJournal(powers);
  t.deepEqual(await revived.list(), live);
  t.deepEqual(await revived.listArchived(), archived);
  await t.throwsAsync(revived.get(archived[0].turnId), {
    message: /Unknown turn/,
  });
});
