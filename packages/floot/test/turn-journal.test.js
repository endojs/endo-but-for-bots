// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import { makeTurnJournal } from '../src/turn-journal.js';

const fixture = () => {
  const store = new Map();
  /** @type {string[]} */
  const reads = [];
  let fail = false;
  let refuseSnapshot = false;
  const powers = Far('JournalStorage', {
    list: () => harden([...store.keys()]),
    lookup: name => {
      reads.push(name);
      return store.get(name);
    },
    storeValue: (value, name) => {
      if (refuseSnapshot && name.startsWith('floot-turn-snapshot-'))
        throw Error('Snapshot refused');
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
    refuseSnapshots: () => {
      refuseSnapshot = true;
    },
  };
};
const options = harden({
  input: 'Review architecture',
  backendId: 'codex',
  modelId: 'sol',
});

test('compaction publication compares the captured journal cut atomically', async t => {
  const f = fixture();
  const journal = makeTurnJournal(f.powers);
  const id = await journal.begin(options);
  await journal.dispatch(id);
  const { frontier } = await journal.readView();
  await journal.recordTranscript(id, '0', {
    kind: 'message',
    role: 'user',
    content: 'newer evidence',
  });
  await t.throwsAsync(
    journal.recordTranscript(
      id,
      '1',
      {
        kind: 'compaction',
        summary: 'stale',
        retainedTail: [],
      },
      frontier,
    ),
    { message: /Compaction source changed/ },
  );
  t.is((await journal.get(id)).transcript.length, 1);
  await journal.recordTranscript(
    id,
    '1',
    {
      kind: 'compaction',
      summary: 'current',
      retainedTail: [],
    },
    (await journal.readView()).frontier,
  );
  t.is((await journal.get(id)).transcript.length, 2);
});

test('admission and dispatch are distinct durable transitions', async t => {
  const f = fixture();
  const journal = makeTurnJournal(f.powers);
  const id = await journal.begin(options);
  t.is((await journal.get(id)).dispatchState, 'not-dispatched');
  t.is(
    (await makeTurnJournal(f.powers).get(id)).dispatchState,
    'not-dispatched',
  );
  for (const type of ['tool-intent', 'observed-tool-call']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      journal.append(id, { type, callId: 'a', name: 'exec', args: {} }),
      {
        message: /requires dispatch intent/,
      },
    );
  }
  await t.throwsAsync(
    journal.recordTranscript(id, '0', {
      kind: 'message',
      role: 'user',
      content: 'hello',
    }),
    { message: /requires dispatch intent/ },
  );
  await t.throwsAsync(
    journal.append(id, {
      type: 'finish',
      state: 'completed',
      backendCheckpoint: 'checkpoint',
    }),
    { message: /requires dispatch intent/ },
  );
  t.is(f.store.size, 1);
  await journal.dispatch(id);
  t.is((await journal.get(id)).dispatchState, 'possibly-dispatched');
  await journal.dispatch(id);
  t.is(f.store.size, 2);
  const revived = makeTurnJournal(f.powers);
  t.is((await revived.get(id)).dispatchState, 'possibly-dispatched');
  await t.throwsAsync(revived.dispatch(id), {
    message: /recovered or terminal/,
  });
  await journal.append(id, { type: 'finish', state: 'failed' });
  await t.throwsAsync(journal.dispatch(id), {
    message: /recovered or terminal/,
  });
});

for (const persisted of [false, true]) {
  test(`dispatch write rejection poisons the incarnation (persisted=${persisted})`, async t => {
    const f = fixture();
    const powers = Far('DispatchFailure', {
      ...f.powers,
      storeValue: async (value, name) => {
        if (value.type === 'dispatch-intent') {
          if (persisted) await f.powers.storeValue(value, name);
          throw Error('Dispatch write uncertain');
        }
        return f.powers.storeValue(value, name);
      },
    });
    const journal = makeTurnJournal(powers);
    const id = await journal.begin(options);
    await t.throwsAsync(journal.dispatch(id), {
      message: 'Dispatch write uncertain',
    });
    await t.throwsAsync(journal.dispatch(id), { message: /uncertain storage/ });
    const revived = makeTurnJournal(f.powers);
    t.is(
      (await revived.get(id)).dispatchState,
      persisted ? 'possibly-dispatched' : 'not-dispatched',
    );
    await t.throwsAsync(revived.dispatch(id), {
      message: /recovered or terminal/,
    });
  });
}

test('dispatch acknowledgement waits for durable marker storage', async t => {
  t.timeout(5000);
  const f = fixture();
  let release = () => {};
  let entered = () => {};
  const waiting = new Promise(resolve => {
    entered = () => resolve(undefined);
  });
  const barrier = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  t.teardown(() => release());
  const powers = Far('DelayedDispatch', {
    ...f.powers,
    storeValue: async (value, name) => {
      if (value.type === 'dispatch-intent') {
        entered();
        await barrier;
      }
      return f.powers.storeValue(value, name);
    },
  });
  const journal = makeTurnJournal(powers);
  const id = await journal.begin(options);
  let acknowledged = false;
  const dispatch = journal.dispatch(id).then(() => {
    acknowledged = true;
  });
  await waiting;
  t.false(acknowledged);
  t.is(f.store.size, 1);
  release();
  await dispatch;
  t.true(acknowledged);
  t.is(f.store.size, 2);
});

for (const mutation of [
  'legacy',
  'missing-state',
  'wrong-state',
  'duplicate-marker',
]) {
  test(`event replay refuses ${mutation}`, async t => {
    const f = fixture();
    const journal = makeTurnJournal(f.powers);
    await journal.begin(options);
    const [name] = f.store.keys();
    const event = { ...f.store.get(name) };
    if (mutation === 'legacy') event.type = 'dispatch';
    if (mutation === 'missing-state') delete event.dispatchState;
    if (mutation === 'wrong-state') event.dispatchState = 'possibly-dispatched';
    f.store.set(name, harden(event));
    if (mutation === 'duplicate-marker') {
      await journal.dispatch(event.turnId);
      f.store.set(
        'floot-turn-event-00000000000000000003',
        harden({ type: 'dispatch-intent', turnId: event.turnId }),
      );
    }
    await t.throwsAsync(makeTurnJournal(f.powers).list());
  });
}

for (const location of ['snapshot', 'archive']) {
  for (const mutation of [
    'legacy-version',
    'missing-state',
    'wrong-state',
    'contradictory-tools',
    'contradictory-transcript',
    'contradictory-completion',
    'contradictory-presentation',
    'contradictory-output',
    'contradictory-usage',
    'contradictory-served-by',
    'contradictory-checkpoint',
    'contradictory-completed',
  ]) {
    test(`${location} refuses ${mutation} dispatch evidence`, async t => {
      const f = fixture();
      const journal = makeTurnJournal(f.powers);
      for (let i = 0; i < (location === 'snapshot' ? 34 : 290); i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const id = await journal.begin(options);
        // eslint-disable-next-line no-await-in-loop
        await journal.append(id, { type: 'finish', state: 'failed' });
      }
      const name = [...f.store.keys()].find(key =>
        key.startsWith(`floot-turn-${location}-`),
      );
      const data = JSON.parse(JSON.stringify(f.store.get(name)));
      const record = data.records[0];
      if (mutation === 'legacy-version') data.version = 2;
      if (mutation === 'missing-state') delete record.dispatchState;
      if (mutation === 'wrong-state') record.dispatchState = 'sent';
      if (mutation === 'contradictory-tools')
        record.tools.push({ callId: 'a' });
      if (mutation === 'contradictory-transcript') record.transcript = [{}];
      if (mutation === 'contradictory-completion')
        record.transcriptComplete = true;
      if (mutation === 'contradictory-presentation') record.presentation = {};
      if (mutation === 'contradictory-output') record.output = 'reply';
      if (mutation === 'contradictory-usage') record.usage = {};
      if (mutation === 'contradictory-served-by') record.servedBy = ['model'];
      if (mutation === 'contradictory-checkpoint')
        record.backendCheckpoint = 'native';
      if (mutation === 'contradictory-completed') record.state = 'completed';
      f.store.set(name, harden(data));
      const revived = makeTurnJournal(f.powers);
      await t.throwsAsync(
        location === 'snapshot' ? revived.list() : revived.listArchived(),
      );
    });
  }
}

// These fixtures deliberately serialize journal transitions and publication.
/* eslint-disable no-await-in-loop */
const thinkingBlock = harden({
  id: 'thinking-1',
  text: 'Public reasoning',
  startedAt: 100,
  endedAt: 200,
  truncated: false,
  beforeTranscriptOrdinal: '0',
});

test('thinking presentation is immutable, idempotent and survives replay and archives', async t => {
  const f = fixture();
  const journal = makeTurnJournal(f.powers);
  const id = await journal.begin(options);
  await journal.dispatch(id);
  const blocks = [{ ...thinkingBlock, text: '\u0000'.repeat(65_536) }];
  await journal.recordPresentation(id, blocks);
  const size = f.store.size;
  await journal.recordPresentation(id, blocks);
  t.is(f.store.size, size);
  await t.throwsAsync(journal.recordPresentation(id, [thinkingBlock]), {
    message: /Conflicting/,
  });
  const revived = makeTurnJournal(f.powers);
  const turn = await revived.get(id);
  t.deepEqual(
    JSON.parse(await revived.readContent(turn.presentation.payloadRef)),
    blocks,
  );
  await journal.append(id, { type: 'finish', state: 'failed' });
  for (let index = 0; index < 290; index += 1) {
    const next = await journal.begin(options);
    await journal.dispatch(next);
    await journal.append(next, { type: 'finish', state: 'completed' });
  }
  const archived = await makeTurnJournal(f.powers).listArchived();
  t.deepEqual(
    archived.find(item => item.turnId === id).presentation,
    turn.presentation,
  );
});

test('thinking presentation rejects malformed data before storage', async t => {
  for (const blocks of [
    new Array(1),
    [{ ...thinkingBlock, authority: 'x' }],
    [thinkingBlock, thinkingBlock],
    [{ ...thinkingBlock, endedAt: 99 }],
    [{ ...thinkingBlock, startedAt: Infinity }],
    [{ ...thinkingBlock, beforeTranscriptOrdinal: '1' }],
    [{ ...thinkingBlock, beforeTranscriptOrdinal: '00' }],
    [{ ...thinkingBlock, text: 'x'.repeat(65_537) }],
    Array.from({ length: 65 }, (_, i) => ({ ...thinkingBlock, id: `${i}` })),
  ]) {
    const f = fixture();
    const journal = makeTurnJournal(f.powers);
    const id = await journal.begin(options);
    await journal.dispatch(id);
    await t.throwsAsync(journal.recordPresentation(id, blocks));
    t.is(f.store.size, 2);
  }
});

for (const location of ['snapshot', 'archive']) {
  test(`thinking presentation rejects corrupted ${location} anchors`, async t => {
    const f = fixture();
    const journal = makeTurnJournal(f.powers);
    const id = await journal.begin(options);
    await journal.dispatch(id);
    await journal.recordPresentation(id, [thinkingBlock]);
    await journal.append(id, { type: 'finish', state: 'failed' });
    for (
      let index = 0;
      index < (location === 'snapshot' ? 34 : 290);
      index += 1
    ) {
      const next = await journal.begin(options);
      await journal.dispatch(next);
      await journal.append(next, { type: 'finish', state: 'completed' });
    }
    const key = [...f.store.keys()]
      .filter(name => name.startsWith(`floot-turn-${location}-`))
      .sort()
      .at(location === 'snapshot' ? -1 : 0);
    const data = JSON.parse(JSON.stringify(f.store.get(key)));
    data.records.find(turn => turn.turnId === id).presentation.payload =
      JSON.stringify([{ ...thinkingBlock, beforeTranscriptOrdinal: '1' }]);
    f.store.set(key, harden(data));
    const revived = makeTurnJournal(f.powers);
    await t.throwsAsync(
      location === 'snapshot' ? revived.list() : revived.listArchived(),
      { message: /thinking anchor/ },
    );
  });
}

test('mail receipt metadata survives dispatch replay and archival unchanged', async t => {
  const f = fixture();
  const journal = makeTurnJournal(f.powers);
  const mail = { from: 'sender', messageNumber: '123' };
  const id = await journal.begin({ ...options, mail });
  await journal.dispatch(id);
  // The journal's existing pass-style boundary hardens all admitted data.
  t.throws(
    () => {
      mail.from = 'renamed';
    },
    { instanceOf: TypeError },
  );
  t.deepEqual((await makeTurnJournal(f.powers).get(id)).mail, {
    from: 'sender',
    messageNumber: '123',
  });
  await journal.append(id, { type: 'finish', state: 'failed' });
  for (let index = 0; index < 290; index += 1) {
    const next = await journal.begin(options);
    await journal.dispatch(next);
    await journal.append(next, { type: 'finish', state: 'completed' });
  }
  const archived = await makeTurnJournal(f.powers).listArchived();
  t.deepEqual(archived.find(turn => turn.turnId === id).mail, {
    from: 'sender',
    messageNumber: '123',
  });
});

test('mail receipt schema rejects malformed fields before dispatch publication', async t => {
  for (const mail of [
    null,
    [],
    {},
    { from: '' },
    { from: 'x'.repeat(8193) },
    { messageNumber: 123 },
    { messageNumber: '' },
    { messageNumber: 'x'.repeat(129) },
    { from: 'sender', authority: 'host' },
  ]) {
    const f = fixture();
    const journal = makeTurnJournal(f.powers);
    await t.throwsAsync(
      journal.begin({
        ...options,
        // Exercise the parser's rejection of intentionally invalid receipts.
        mail: /** @type {Parameters<typeof journal.begin>[0]['mail']} */ (
          /** @type {unknown} */ (mail)
        ),
      }),
    );
    t.is(f.store.size, 0);
  }
  for (const mail of [{ from: 'sender' }, { messageNumber: '123' }]) {
    const f = fixture();
    const journal = makeTurnJournal(f.powers);
    const id = await journal.begin({ ...options, mail });
    t.deepEqual((await journal.get(id)).mail, mail);
  }
});

for (const location of ['snapshot', 'archive']) {
  test(`mail receipt ${location} rejects malformed stored metadata`, async t => {
    const f = fixture();
    const journal = makeTurnJournal(f.powers);
    const id = await journal.begin({
      ...options,
      mail: { from: 'sender', messageNumber: '123' },
    });
    await journal.dispatch(id);
    await journal.append(id, { type: 'finish', state: 'failed' });
    for (
      let index = 0;
      index < (location === 'snapshot' ? 34 : 290);
      index += 1
    ) {
      const next = await journal.begin(options);
      await journal.dispatch(next);
      await journal.append(next, { type: 'finish', state: 'completed' });
    }
    const key = [...f.store.keys()]
      .filter(name => name.startsWith(`floot-turn-${location}-`))
      .sort()
      .at(location === 'snapshot' ? -1 : 0);
    const data = JSON.parse(JSON.stringify(f.store.get(key)));
    data.records.find(turn => turn.turnId === id).mail.authority = 'forged';
    f.store.set(key, harden(data));
    const revived = makeTurnJournal(f.powers);
    await t.throwsAsync(
      location === 'snapshot' ? revived.list() : revived.listArchived(),
      { message: /mail receipt fields/ },
    );
  });
}

test('backend checkpoint survives event replay, snapshots and archival', async t => {
  const f = fixture();
  const journal = makeTurnJournal(f.powers);
  const id = await journal.begin(options);
  await journal.dispatch(id);
  await journal.append(id, {
    type: 'finish',
    state: 'completed',
    backendCheckpoint: 'native-turn-1',
  });
  t.is(
    (await makeTurnJournal(f.powers).get(id)).backendCheckpoint,
    'native-turn-1',
  );
  for (let index = 0; index < 290; index += 1) {
    const next = await journal.begin(options);
    await journal.dispatch(next);
    await journal.append(next, { type: 'finish', state: 'completed' });
  }
  const revived = makeTurnJournal(f.powers);
  const archived = await revived.listArchived();
  t.is(
    archived.find(turn => turn.turnId === id).backendCheckpoint,
    'native-turn-1',
  );
});

for (const location of ['snapshot', 'archive']) {
  for (const collection of ['tools', 'activity']) {
    test(`checkpoint ${location} refuses unsettled ${collection}`, async t => {
      const f = fixture();
      const journal = makeTurnJournal(f.powers);
      const id = await journal.begin(options);
      await journal.dispatch(id);
      await journal.append(id, {
        type: 'finish',
        state: 'completed',
        backendCheckpoint: 'native-turn-1',
      });
      for (
        let index = 0;
        index < (location === 'snapshot' ? 34 : 290);
        index += 1
      ) {
        const next = await journal.begin(options);
        await journal.dispatch(next);
        await journal.append(next, { type: 'finish', state: 'completed' });
      }
      const key = [...f.store.keys()]
        .filter(name => name.startsWith(`floot-turn-${location}-`))
        .sort()
        .at(location === 'snapshot' ? -1 : 0);
      const data = JSON.parse(JSON.stringify(f.store.get(key)));
      const record = data.records.find(turn => turn.turnId === id);
      t.truthy(record);
      record[collection].push({
        callId: 'unsettled',
        name: 'effect',
        args: '{}',
      });
      f.store.set(key, harden(data));
      const revived = makeTurnJournal(f.powers);
      await t.throwsAsync(
        location === 'snapshot' ? revived.list() : revived.listArchived(),
        { message: /settled tool evidence/ },
      );
    });
  }
}

test('backend checkpoints require bounded text and a truly completed turn', async t => {
  for (const value of ['', 'x'.repeat(8193), null, 42, {}]) {
    const f = fixture();
    const journal = makeTurnJournal(f.powers);
    const id = await journal.begin(options);
    await journal.dispatch(id);
    await t.throwsAsync(
      journal.append(id, {
        type: 'finish',
        state: 'completed',
        backendCheckpoint: value,
      }),
    );
    t.is(f.store.size, 2);
    t.is((await journal.get(id)).state, 'pending');
  }
  for (const state of ['failed', 'cancelled', 'outcome-unknown', 'unsettled']) {
    const f = fixture();
    const journal = makeTurnJournal(f.powers);
    const id = await journal.begin(options);
    await journal.dispatch(id);
    if (state === 'unsettled')
      await journal.append(id, {
        type: 'tool-intent',
        callId: 'a',
        name: 'effect',
        args: '{}',
      });
    await t.throwsAsync(
      journal.append(id, {
        type: 'finish',
        state: state === 'unsettled' ? 'completed' : state,
        backendCheckpoint: 'native-turn-1',
      }),
      { message: /requires a completed/ },
    );
  }
});

test('lost checkpoint finish acknowledgement replays the durable completed token', async t => {
  const f = fixture();
  const journal = makeTurnJournal(f.powers);
  const id = await journal.begin(options);
  await journal.dispatch(id);
  f.fail();
  await t.throwsAsync(
    journal.append(id, {
      type: 'finish',
      state: 'completed',
      backendCheckpoint: 'native-turn-1',
    }),
    { message: /Lost acknowledgement/ },
  );
  await t.throwsAsync(journal.get(id), { message: /uncertain storage/ });
  const restored = await makeTurnJournal(f.powers).get(id);
  t.is(restored.state, 'completed');
  t.is(restored.backendCheckpoint, 'native-turn-1');
});

/* eslint-enable no-await-in-loop */

test('targeted reads are detached snapshots and invalid transitions leave evidence unchanged', async t => {
  const { powers, store } = fixture();
  const journal = makeTurnJournal(powers);
  const id = await journal.begin(options);
  await journal.dispatch(id);
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
  t.is(store.size, 3);
  await journal.append(id, { type: 'tool-result', callId: 'a', result: 'ok' });
  t.is(before.tools[0].settled, undefined);
  t.true((await journal.get(id)).tools[0].settled);
  await journal.append(id, { type: 'finish', state: 'completed' });
  const next = await journal.begin(options);
  await journal.dispatch(next);
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
  await journal.dispatch(id);
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
  let readyFinished = false;
  const ready = journal.assertReady().then(() => {
    readyFinished = true;
  });
  await Promise.resolve();
  t.false(readFinished);
  t.false(readyFinished);
  t.is(store.size, 2);
  release();
  await intent;
  t.is((await read).tools[0].callId, 'a');
  await ready;
  t.true(readyFinished);
  await journal.append(id, { type: 'tool-result', callId: 'a', result: 'ok' });
  t.is((await journal.get(id)).tools[0].result, 'ok');
});

test('lost result acknowledgement poisons prepared writer and revival reads committed result', async t => {
  const f = fixture();
  const journal = makeTurnJournal(f.powers);
  const id = await journal.begin(options);
  await journal.dispatch(id);
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

test('readiness preserves unresolved outcomes without synthesizing migration records', async t => {
  const { powers } = fixture();
  const pending = await makeTurnJournal(powers).begin(options);
  const journal = makeTurnJournal(powers);
  await journal.assertReady();
  t.deepEqual(
    (await journal.list()).map(record => record.turnId),
    [pending],
  );
  t.is((await journal.get(pending)).state, 'outcome-unknown');
  const before = await journal.status();
  await t.throwsAsync(journal.resolve('legacy-import', 'Checked'), {
    message: /Unknown turn journal turn/,
  });
  await t.throwsAsync(journal.resolve(pending, '   '), {
    message: /Resolution note must not be blank/,
  });
  t.deepEqual(await journal.status(), before);
  await journal.resolve(pending, 'No external effects occurred');
  await journal.assertReady();
  const revived = makeTurnJournal(powers);
  await revived.assertReady();
  t.is((await revived.get(pending)).resolution, 'No external effects occurred');
  t.not(await revived.begin(options), pending);
});

test('resolution acknowledgement loss poisons readiness while revival keeps the resolution', async t => {
  const f = fixture();
  const pending = await makeTurnJournal(f.powers).begin(options);
  const journal = makeTurnJournal(f.powers);
  f.fail();
  await t.throwsAsync(journal.resolve(pending, 'External effects checked'), {
    message: /Lost acknowledgement/,
  });
  await t.throwsAsync(journal.assertReady(), { message: /uncertain storage/ });
  const revived = makeTurnJournal(f.powers);
  await revived.assertReady();
  t.is((await revived.get(pending)).resolution, 'External effects checked');
});

test('empty input and backend-default model are valid, optional usage is omitted', async t => {
  const { powers } = fixture();
  const journal = makeTurnJournal(powers);
  const id = await journal.begin({
    input: '',
    backendId: 'direct',
    modelId: '',
  });
  await journal.dispatch(id);
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
  const first = makeTurnJournal(powers);
  const id = await first.begin(options);
  await first.dispatch(id);
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
  await journal.dispatch(id);
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
  await journal.dispatch(id);
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
  await journal.dispatch(id);
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
  t.is(store.size, 7);
});

test('revival preserves unknown outcomes while new work and explicit resolution remain independent', async t => {
  const { powers } = fixture();
  const first = makeTurnJournal(powers);
  const id = await first.begin(options);
  await first.dispatch(id);
  await first.append(id, {
    type: 'tool-intent',
    callId: 'a',
    name: 'exec',
    args: {},
  });
  const journal = makeTurnJournal(powers);
  await journal.assertReady();
  const next = await journal.begin(options);
  await journal.dispatch(next);
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
  await journal.dispatch(id);
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
  const recovered = makeTurnJournal(f.powers);
  await t.throwsAsync(recovered.assertReady(), {
    message: /missing or malformed/,
  });
  await t.throwsAsync(recovered.list(), { message: /uncertain storage/ });
  await t.throwsAsync(recovered.assertReady(), {
    message: /uncertain storage/,
  });
});

test('invalid or excessive values never persist capabilities or partial events', async t => {
  const { powers, store } = fixture();
  const journal = makeTurnJournal(powers);
  const id = await journal.begin(options);
  await journal.dispatch(id);
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
  t.is(store.size, 2);
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
  await journal.dispatch(id);
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
    // eslint-disable-next-line no-await-in-loop
    await journal.dispatch(id);
    ids.push(id);
    // eslint-disable-next-line no-await-in-loop
    await journal.append(id, {
      type: 'finish',
      state: 'completed',
      output: `out ${i}`,
    });
  }
  // 120 events and a snapshot at 64. Every event is still there — the
  // transcript is kept until the session is removed — but a revival reads
  // the snapshot and only the 56 events after it.
  const events = [...store.keys()].filter(name =>
    name.startsWith('floot-turn-event-'),
  );
  const snapshots = [...store.keys()].filter(name =>
    name.startsWith('floot-turn-snapshot-'),
  );
  t.is(snapshots.length, 1);
  t.is(events.length, 120);
  const expected = await journal.list();
  t.is(expected.length, 40);
  reads.length = 0;
  const revived = makeTurnJournal(powers);
  t.deepEqual(await revived.list(), expected);
  const replayed = reads.filter(name => name.startsWith('floot-turn-event-'));
  t.is(replayed.length, 56);
  t.true(replayed.every(name => BigInt(name.slice(-20)) > 64n));
  t.like(await revived.status(), {
    usedEvents: '120',
    retainedTurns: 40,
    archivedTurns: 0,
  });
  // A turn pending at the snapshot is recovered as outcome-unknown, and a
  // later event still settles it.
  const pending = await revived.begin(options);
  await revived.dispatch(pending);
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
    await journal.begin(options).then(async id => {
      await journal.dispatch(id);
      await journal.append(id, { type: 'finish', state: 'completed' });
    });
  }
  // Snapshots at 64, 128 and 192 have superseded each other; put a stale
  // copy back as a crash before its removal would leave it.
  const [newest] = [...store.keys()].filter(name =>
    name.startsWith('floot-turn-snapshot-'),
  );
  t.is(newest, 'floot-turn-snapshot-00000000000000000192');
  const stale = { ...store.get(newest), through: '64', records: [] };
  store.set('floot-turn-snapshot-00000000000000000064', harden(stale));
  const revived = makeTurnJournal(powers);
  t.is((await revived.list()).length, 64);
  // The next snapshot clears the stale one.
  for (let i = 0; i < 32; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await revived.begin(options).then(async id => {
      await revived.dispatch(id);
      await revived.append(id, { type: 'finish', state: 'completed' });
    });
  }
  t.deepEqual(
    [...store.keys()].filter(name => name.startsWith('floot-turn-snapshot-')),
    ['floot-turn-snapshot-00000000000000000256'],
  );
});

test('settled turns beyond the retained window are archived; unresolved ones never are', async t => {
  const { powers, store } = fixture();
  const journal = makeTurnJournal(powers);
  // One unresolved turn at the very start, then enough settled turns to push
  // the window.
  const unknown = await journal.begin(options);
  await journal.dispatch(unknown);
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
    await journal.begin(options).then(async id => {
      await journal.dispatch(id);
      await journal.append(id, {
        type: 'finish',
        state: 'completed',
        output: `${i}`,
      });
    });
  }
  const { retainedTurns, archivedTurns } = await journal.status();
  t.is(retainedTurns + archivedTurns, 301);
  // The window is enforced at snapshot points, so up to a snapshot's worth of
  // turns (64 events, two per turn here) may sit above it between them.
  t.true(
    Number(retainedTurns) <= 256 + 1 + 32,
    'the window, the unresolved turn, and at most one snapshot interval',
  );
  t.true(Number(archivedTurns) > 0);
  const live = await journal.list();
  t.truthy(
    live.find(record => record.turnId === unknown),
    'unresolved stays in front',
  );
  const archived = await journal.listArchived();
  t.is(archived.length, archivedTurns);
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
  await revived.resolve(unknown, 'Operator reviewed unknown effect');
  for (let index = 0; index < 40; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    const id = await revived.begin(options);
    // eslint-disable-next-line no-await-in-loop
    await revived.dispatch(id);
    // eslint-disable-next-line no-await-in-loop
    await revived.append(id, { type: 'finish', state: 'completed' });
  }
  const later = await revived.listArchived();
  t.true(
    Number(later.findIndex(turn => turn.turnId === unknown)) >=
      Number(archived.length),
    'late-resolved old turn appears in a later publication, not turn-ID order',
  );
  const paged = [];
  let cursor = (await revived.readView()).archiveCursor;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const page = await revived.listArchivedPage(cursor);
    paged.push(...page.records);
    if (page.next === null) break;
    cursor = page.next;
  }
  t.deepEqual(paged, later);
});

test('archive pages pin a read view across growth and reconstruction', async t => {
  t.timeout(20_000);
  const f = fixture();
  const journal = makeTurnJournal(f.powers);
  /** @param {number} count */
  const finish = async count => {
    for (let index = 0; index < count; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      const id = await journal.begin(options);
      // eslint-disable-next-line no-await-in-loop
      await journal.append(id, {
        type: 'finish',
        state: 'failed',
        error: 'failed',
      });
    }
  };
  await finish(400);
  const view = await journal.readView();
  const expected = await journal.listArchived();
  f.reads.length = 0;
  const first = await journal.listArchivedPage(view.archiveCursor);
  t.is(f.reads.length, 1, 'one chunk lookup');
  t.truthy(first.next);
  await finish(80);
  const revived = makeTurnJournal(f.powers);
  const records = [...first.records];
  let cursor = first.next;
  while (cursor !== null) {
    // eslint-disable-next-line no-await-in-loop
    const page = await revived.listArchivedPage(cursor);
    records.push(...page.records);
    cursor = page.next;
  }
  t.deepEqual(records, expected, 'continuation excludes later publications');
  t.is(
    records.length + view.retained.length,
    400,
    'captured partition loses no turns',
  );
  t.is(
    new Set([...records, ...view.retained].map(turn => turn.turnId)).size,
    400,
  );
  t.true(
    Number((await revived.status()).archivedTurns) > Number(view.archivedTurns),
  );
  for (const invalid of [
    '',
    '-1:2',
    '0:9999999999999999999999',
    '2:1',
    '00:1',
    '1:1:1',
    '0:1.5',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(revived.listArchivedPage(invalid), {
      message: /Invalid.*cursor/,
    });
  }
  const chunkName = [...f.store.keys()].find(name =>
    name.startsWith('floot-turn-archive-'),
  );
  f.store.set(
    chunkName,
    harden({ version: 1, records: Array(257).fill(null) }),
  );
  await t.throwsAsync(revived.listArchivedPage(), {
    message: /Invalid.*chunk/,
  });
});

test('archive pages never publish an uncounted chunk after failed snapshot', async t => {
  t.timeout(20_000);
  const f = fixture();
  const journal = makeTurnJournal(f.powers);
  t.deepEqual(await journal.listArchivedPage(), { records: [], next: null });
  for (let index = 0; index < 277; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    const id = await journal.begin(options);
    // eslint-disable-next-line no-await-in-loop
    await journal.dispatch(id);
    // eslint-disable-next-line no-await-in-loop
    await journal.append(id, { type: 'finish', state: 'completed' });
  }
  f.refuseSnapshots();
  await t.throwsAsync(journal.begin(options), { message: /Snapshot refused/ });
  t.true(
    [...f.store.keys()].some(name => name.startsWith('floot-turn-archive-')),
  );
  await t.throwsAsync(journal.listArchivedPage(), { message: /unavailable/ });
  const revived = makeTurnJournal(f.powers);
  t.deepEqual(await revived.listArchivedPage(), { records: [], next: null });
  t.is((await revived.readView()).retained.length, 278);
});
