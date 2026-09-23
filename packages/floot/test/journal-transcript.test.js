// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import { makeTurnJournal } from '../src/turn-journal.js';
import { transcriptIndex } from '../src/journal-transcript.js';

const fixture = () => {
  const values = new Map();
  const writes = [];
  const reads = [];
  let failAt;
  let storeBeforeFailure = false;
  const powers = Far('TranscriptStorage', {
    list: () => harden([...values.keys()]),
    lookup: name => {
      reads.push(name);
      return values.get(name);
    },
    storeValue: (value, name) => {
      writes.push(name);
      if (name === failAt && !storeBeforeFailure)
        throw Error('publication failed');
      if (values.has(name)) throw Error('overwrite refused');
      values.set(name, value);
      if (name === failAt) throw Error('acknowledgement lost');
    },
    remove: name => values.delete(name),
  });
  return {
    powers,
    values,
    writes,
    reads,
    fail: (name, after = false) => {
      failAt = name;
      storeBeforeFailure = after;
    },
  };
};
const options = harden({ input: 'go', backendId: 'opencode', modelId: 'free' });
const message = content =>
  harden({ kind: 'message', role: 'assistant', content });

test('completion seals the exact frontier and survives a snapshot', async t => {
  const { powers, values, writes } = fixture();
  const journal = makeTurnJournal(powers);
  const id = await journal.begin(options);
  for (let index = 0; index < 61; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await journal.recordTranscript(id, `${index}`, message('text'));
  }
  await t.throwsAsync(journal.completeTranscript(id, '60'), {
    message: /frontier/,
  });
  await journal.completeTranscript(id, '61');
  await t.throwsAsync(journal.recordTranscript(id, '61', message('late')), {
    message: /already complete/,
  });
  await journal.append(id, { type: 'finish', state: 'completed' });
  const revived = makeTurnJournal(powers);
  t.true((await revived.get(id)).transcriptComplete);
  const count = writes.length;
  await revived.completeTranscript(id, '61');
  t.is(writes.length, count);
  const name = [...values.keys()].find(key =>
    key.startsWith('floot-turn-snapshot-'),
  );
  const snapshot = JSON.parse(JSON.stringify(values.get(name)));
  snapshot.records[0].transcriptEndSequence = id;
  values.set(name, harden(snapshot));
  await t.throwsAsync(makeTurnJournal(powers).get(id), {
    message: /completion order/,
  });
});

test('ordered transcript survives snapshots and full-content duplicate comparison', async t => {
  const { powers, writes } = fixture();
  const journal = makeTurnJournal(powers);
  const id = await journal.begin(options);
  const large = message('a'.repeat(9000));
  await journal.recordTranscript(id, '0', large);
  await journal.append(id, {
    type: 'observed-tool-call',
    callId: 'c',
    name: 'read',
    args: '{}',
  });
  for (let index = 1; index < 63; index += 1) {
    // Exercise the snapshot boundary inside one still-active turn.
    // eslint-disable-next-line no-await-in-loop
    await journal.recordTranscript(id, `${index}`, message(`${index}`));
  }
  await journal.append(id, {
    type: 'observed-tool-result',
    callId: 'c',
    result: 'ok',
  });
  await journal.append(id, { type: 'finish', state: 'completed' });
  const before = await journal.get(id);
  t.is(before.transcript[0].sequence, '2');
  t.is(before.transcript[1].sequence, '4');
  t.true(writes.some(name => name.startsWith('floot-turn-snapshot-')));
  const revived = makeTurnJournal(powers);
  t.deepEqual(await revived.get(id), before);
  t.deepEqual(await revived.readTranscriptRecord(id, '0'), large);
  const count = writes.length;
  await revived.recordTranscript(id, '0', large);
  t.is(writes.length, count);
  await t.throwsAsync(
    revived.recordTranscript(id, '0', message(`${'a'.repeat(8999)}b`)),
    { message: /Conflicting/ },
  );
  await t.throwsAsync(revived.recordTranscript(id, '63', message('late')), {
    message: /terminal/,
  });
  t.is(writes.length, count);
});

test('transcript rejects invalid input before storing content or events', async t => {
  const { powers, writes } = fixture();
  const journal = makeTurnJournal(powers);
  const id = await journal.begin(options);
  for (const ordinal of ['1', '00', '-1', '1e0', '65536']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      journal.recordTranscript(id, ordinal, message('x'.repeat(9000))),
    );
  }
  await t.throwsAsync(journal.recordTranscript('unknown', '0', message('x')), {
    message: /Unknown/,
  });
  await t.throwsAsync(
    journal.recordTranscript(id, '0', {
      kind: 'compaction',
      summary: 's',
      retainedTail: [{ kind: 'tool-call', id: 'c', name: 'r', args: '{}' }],
    }),
    { message: /settled/ },
  );
  t.is(writes.length, 1);
  const revived = makeTurnJournal(powers);
  await t.throwsAsync(revived.recordTranscript(id, '0', message('late')), {
    message: /recovered turn/,
  });
  t.is(writes.length, 1);
});

test('transcript aggregate bound is retained across snapshot reconstruction', async t => {
  const { powers, writes } = fixture();
  const journal = makeTurnJournal(powers);
  const id = await journal.begin(options);
  const large = message('x'.repeat(8 * 1024 * 1024));
  await journal.recordTranscript(id, '0', large);
  await t.throwsAsync(journal.recordTranscript(id, '1', large), {
    message: /content bound/,
  });
  for (let index = 1; index < 63; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await journal.recordTranscript(id, `${index}`, message('small'));
  }
  const revived = makeTurnJournal(powers);
  const count = writes.length;
  await revived.recordTranscript(id, '0', large);
  t.is((await revived.get(id)).transcript.length, 63);
  t.is(writes.length, count);
  t.throws(() => transcriptIndex('65536', 65_536), { message: /count bound/ });
  t.is(transcriptIndex('65535', 65_536), 65_535);
});

for (const [where, after] of [
  ['content', false],
  ['content', true],
  ['event', false],
  ['event', true],
]) {
  test(`transcript fences uncertain ${where} publication (stored=${after})`, async t => {
    const { powers, values, fail } = fixture();
    const journal = makeTurnJournal(powers);
    const id = await journal.begin(options);
    const target =
      where === 'content'
        ? 'floot-turn-content-00000000000000000002-payload'
        : 'floot-turn-event-00000000000000000002';
    fail(target, after);
    const checkpoint = harden({
      kind: 'compaction',
      summary: 's'.repeat(9000),
    });
    await t.throwsAsync(journal.recordTranscript(id, '0', checkpoint));
    await t.throwsAsync(journal.assertReady(), {
      message: /uncertain storage/,
    });
    const revived = makeTurnJournal(powers);
    const record = await revived.get(id);
    if (after && where === 'event') {
      t.is(record.transcript.length, 1);
      t.is(record.transcript[0].kind, 'compaction');
      await revived.recordTranscript(id, '0', checkpoint);
    } else {
      t.is(record.transcript, undefined);
    }
    if (where === 'event')
      t.true(values.has('floot-turn-content-00000000000000000002-payload'));
  });
}

test('reconstruction rejects corrupt transcript snapshot indexes and budgets', async t => {
  const { powers, values } = fixture();
  const journal = makeTurnJournal(powers);
  const id = await journal.begin(options);
  await journal.recordTranscript(id, '0', message('a'.repeat(9000)));
  for (let index = 1; index < 63; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await journal.recordTranscript(id, `${index}`, message('small'));
  }
  const name = [...values.keys()].find(key =>
    key.startsWith('floot-turn-snapshot-'),
  );
  const original = values.get(name);
  const corruptions = [
    record => {
      record.transcript[0].payloadRef = null;
    },
    record => {
      record.transcript[0].payloadRef = false;
    },
    record => {
      record.transcript[0].payloadRef.chars = 8192;
    },
    record => {
      record.transcript[0].ordinal = '1';
    },
    record => {
      record.transcript[0].sequence = record.turnId;
    },
    record => {
      record.transcriptChars = 0;
    },
    record => {
      record.transcript[0].payloadRef.chars = 16 * 1024 * 1024;
    },
    record => {
      record.transcript[0].payload = 'short preview';
    },
    record => {
      record.transcript[1].payload = '{}';
    },
  ];
  for (const corrupt of corruptions) {
    const snapshot = JSON.parse(JSON.stringify(original));
    corrupt(snapshot.records[0]);
    values.set(name, harden(snapshot));
    const revived = makeTurnJournal(powers);
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(revived.get(id));
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(revived.assertReady(), {
      message: /uncertain storage/,
    });
  }
});

for (const storage of ['event', 'snapshot', 'archive']) {
  test(`kind index survives ${storage} without hydration and rejects missing or conflicting metadata`, async t => {
    const { powers, values, reads } = fixture();
    const journal = makeTurnJournal(powers);
    const id = await journal.begin(options);
    await journal.recordTranscript(id, '0', {
      kind: 'compaction',
      summary: 's'.repeat(9000),
    });
    await journal.append(id, { type: 'finish', state: 'completed' });
    const count = storage === 'archive' ? 300 : storage === 'snapshot' ? 32 : 0;
    for (let index = 0; index < count; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      const next = await journal.begin(options);
      // eslint-disable-next-line no-await-in-loop
      await journal.append(next, { type: 'finish', state: 'completed' });
    }
    const name =
      storage === 'event'
        ? 'floot-turn-event-00000000000000000002'
        : [...values.keys()].find(key =>
            key.startsWith(`floot-turn-${storage}-`),
          );
    const original = values.get(name);
    const read = async () => {
      const revived = makeTurnJournal(powers);
      return storage === 'archive'
        ? (await revived.listArchivedPage()).records.find(
            record => record.turnId === id,
          )
        : revived.get(id);
    };
    reads.length = 0;
    t.is((await read()).transcript[0].kind, 'compaction');
    t.false(reads.some(key => key.startsWith('floot-turn-content-')));
    for (const kind of [undefined, 'invalid', 'message']) {
      const value = JSON.parse(JSON.stringify(original));
      const entry =
        storage === 'event'
          ? value
          : value.records.find(record => record.turnId === id).transcript[0];
      if (kind === undefined) delete entry.kind;
      else entry.kind = kind;
      values.set(name, harden(value));
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(read, { message: /kind index/ });
    }
    values.set(name, original);
    t.is((await read()).transcript[0].kind, 'compaction');
  });
}

test('full external payload validation is lazy and checks canonical content and preview', async t => {
  const { powers, values } = fixture();
  const journal = makeTurnJournal(powers);
  const id = await journal.begin(options);
  await journal.recordTranscript(id, '0', message('a'.repeat(9000)));
  const entry = (await journal.get(id)).transcript[0];
  const original = values.get(entry.payloadRef.name);
  values.set(entry.payloadRef.name, original.replace('aaaa', 'bbbb'));
  const revived = makeTurnJournal(powers);
  t.is((await revived.get(id)).transcript.length, 1);
  await t.throwsAsync(revived.readTranscriptRecord(id, '0'), {
    message: /preview/,
  });
  values.set(entry.payloadRef.name, ' '.repeat(original.length));
  await t.throwsAsync(revived.readTranscriptRecord(id, '0'));
});

test('event replay rejects noncanonical inline transcript records', async t => {
  const { powers, values } = fixture();
  const journal = makeTurnJournal(powers);
  const id = await journal.begin(options);
  await journal.recordTranscript(id, '0', message('small'));
  const name = 'floot-turn-event-00000000000000000002';
  values.set(name, harden({ ...values.get(name), payload: '{}' }));
  const revived = makeTurnJournal(powers);
  await t.throwsAsync(revived.get(id));
  await t.throwsAsync(revived.assertReady(), { message: /uncertain storage/ });
});
