// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import { makeTurnJournal } from '../src/turn-journal.js';

const fixture = () => {
  const store = new Map();
  let fail = false;
  const powers = Far('JournalStorage', {
    list: () => harden([...store.keys()]),
    lookup: name => store.get(name),
    storeValue: (value, name) => {
      if (store.has(name)) throw Error('Overwrite forbidden');
      store.set(name, value);
      if (fail) throw Error('Lost acknowledgement');
    },
  });
  return {
    store,
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
  await t.throwsAsync(journal.assertReady(), { message: /unknown turn/ });
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
  await t.throwsAsync(journal.assertReady(), {
    message: /unknown turn outcome/,
  });
  await journal.append(id, {
    type: 'observed-tool-result',
    callId: 'native',
    result: 'late known result',
  });
  await t.throwsAsync(journal.assertReady(), {
    message: /unknown turn outcome/,
  });
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

test('revival fences unknown outcomes and explicit resolution retains evidence', async t => {
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
  await t.throwsAsync(journal.assertReady(), {
    message: /unknown turn outcome/,
  });
  await t.throwsAsync(journal.begin(options), {
    message: /unknown turn outcome/,
  });
  await journal.resolve(id, 'Operator checked the effect');
  const next = await journal.begin(options);
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
  await t.throwsAsync(journal.assertReady(), {
    message: /unknown turn outcome/,
  });
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
  await t.throwsAsync(
    journal.append(id, {
      type: 'finish',
      state: 'completed',
      output: 'x'.repeat(131_072),
    }),
    { message: /too large/ },
  );
  t.is(store.size, 1);
  await journal.append(id, {
    type: 'finish',
    state: 'completed',
    output: 'ok',
  });
  t.is((await journal.list())[0].state, 'completed');
});
