// @ts-check
import '@endo/init';
import test from 'ava';
import { createHash } from 'node:crypto';
import {
  canonicalAuditJson,
  makeAuditJournal,
  makeStoredAuditJournal,
} from '../src/audit-journal.js';

const prefix = 'codex-audit-session';
const nameOf = n => `${prefix}-${String(n).padStart(20, '0')}`;
const fixture = () => {
  const values = new Map();
  const reads = [];
  let fail;
  const powers = harden({
    list: async () => [...values.keys()],
    has: async name => values.has(name),
    lookup: async name => {
      reads.push(name);
      return values.get(name);
    },
    storeValue: async (value, name) => {
      if (fail === 'before') throw Error('write failed');
      values.set(name, value);
      if (fail === 'after') throw Error('write uncertain');
    },
  });
  const open = () =>
    makeStoredAuditJournal(powers, {
      journalId: 'journal',
      sessionId: 'session',
    }).writer;
  return {
    values,
    reads,
    open,
    fail: mode => {
      fail = mode;
    },
  };
};

test('required diagnostics serialize concurrent appends and reconstruct twice', async t => {
  const f = fixture();
  const first = f.open();
  await Promise.all([
    first.append('intent', { callId: 'x' }),
    first.append('result', { result: 'ok' }),
  ]);
  await f.open().append('cold-one');
  await f.open().append('cold-two');
  t.deepEqual(
    [...f.values.values()].map(entry => entry.sequence),
    [0n, 1n, 2n, 3n],
  );
  t.deepEqual(
    [...f.values.values()].map(entry => entry.kind),
    ['intent', 'result', 'cold-one', 'cold-two'],
  );
  t.deepEqual(
    f.reads,
    [nameOf(1), nameOf(2)],
    'only the last payload is loaded per reconstruction',
  );
  t.deepEqual(f.values.get(nameOf(0)), {
    version: 2,
    journalId: 'journal',
    sessionId: 'session',
    sequence: 0n,
    at: f.values.get(nameOf(0)).at,
    kind: 'intent',
    payload: { callId: 'x' },
  });
});

for (const phase of ['before', 'after']) {
  test(`uncertain ${phase} write fences queued work; cold writer never overwrites landed entry`, async t => {
    const f = fixture();
    const writer = f.open();
    await writer.append('first');
    f.fail(phase);
    const error = await t.throwsAsync(writer.append('uncertain'));
    f.fail(undefined);
    t.is(await t.throwsAsync(writer.append('forbidden')), error);
    t.is(f.values.size, phase === 'after' ? 2 : 1);
    await f.open().append('reconstructed');
    const entries = [...f.values.values()];
    t.deepEqual(
      entries.map(entry => entry.kind),
      phase === 'after'
        ? ['first', 'uncertain', 'reconstructed']
        : ['first', 'reconstructed'],
    );
    t.deepEqual(
      entries.map(entry => entry.sequence),
      phase === 'after' ? [0n, 1n, 2n] : [0n, 1n],
    );
  });
}

test('an append already queued behind a failed write cannot run', async t => {
  const f = fixture();
  const writer = f.open();
  f.fail('after');
  const outcomes = await Promise.allSettled([
    writer.append('uncertain'),
    writer.append('queued'),
  ]);
  t.deepEqual(
    outcomes.map(result => result.status),
    ['rejected', 'rejected'],
  );
  t.is(f.values.size, 1);
  t.is(f.values.get(nameOf(0)).kind, 'uncertain');
});

for (const damage of [
  'gap',
  'malformed-name',
  'version',
  'session',
  'journal',
  'sequence',
  'extra-field',
]) {
  test(`reconstruction refuses ${damage} before writing`, async t => {
    const f = fixture();
    await f.open().append('first');
    const entry = f.values.get(nameOf(0));
    if (damage === 'gap') {
      f.values.delete(nameOf(0));
      f.values.set(nameOf(1), { ...entry, sequence: 1n });
    } else if (damage === 'malformed-name')
      f.values.set(`${prefix}-bad`, entry);
    else
      f.values.set(nameOf(0), {
        ...entry,
        ...(damage === 'version' ? { version: 1, previousHash: 'old' } : {}),
        ...(damage === 'session' ? { sessionId: 'other' } : {}),
        ...(damage === 'journal' ? { journalId: 'other' } : {}),
        ...(damage === 'sequence' ? { sequence: 9n } : {}),
        ...(damage === 'extra-field' ? { extra: true } : {}),
      });
    const before = canonicalAuditJson(harden([...f.values.entries()]));
    await t.throwsAsync(f.open().append('refused'), {
      message: /Diagnostic sequence gap|Invalid diagnostic/,
    });
    t.is(canonicalAuditJson(harden([...f.values.entries()])), before);
  });
}

test('complete large UTF8 fields retain content-addressed storage without a lifetime ceiling', async t => {
  const f = fixture();
  const text = '猫'.repeat(30_000);
  const writer = f.open();
  await writer.append('result', { result: text });
  await writer.append('result', { result: text });
  const first = f.values.get(nameOf(0)).payload.result;
  t.is(first.bytes, new TextEncoder().encode(text).length);
  t.is(first.ref, `sha256:${createHash('sha256').update(text).digest('hex')}`);
  t.deepEqual(f.values.get(nameOf(1)).payload.result, first);
  const blobs = [...f.values].filter(([name]) => name.includes('-content-'));
  t.is(blobs.length, 1);
  t.is(blobs[0][1], text);
  for (let i = 0; i < 300; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await writer.append('more', { result: 'x'.repeat(4096) });
  }
  await f.open().append('after-blob');
  t.is(f.values.get(nameOf(302)).kind, 'after-blob');
});

test('content failure fences the writer before an entry can reference missing bytes', async t => {
  const f = fixture();
  const writer = f.open();
  f.fail('before');
  await t.throwsAsync(writer.append('large', { result: 'x'.repeat(70_000) }));
  f.fail(undefined);
  await t.throwsAsync(writer.append('later'));
  t.is(f.values.size, 0);
});

test('no content store, oversized entries, and capability payloads refuse required writes', async t => {
  const entries = [];
  const open = options =>
    makeAuditJournal({
      journalId: 'j',
      sessionId: 's',
      readPosition: async () => ({ nextSequence: 0n }),
      appendEntry: async entry => {
        entries.push(entry);
      },
      ...options,
    }).writer;
  await t.throwsAsync(
    open({ inlineBytes: 4 }).append('x', { result: 'large' }),
    { message: /stores no content/ },
  );
  await t.throwsAsync(open({ maxEntryBytes: 20 }).append('x'), {
    message: /exceeded/,
  });
  await t.throwsAsync(open({}).append('x', { cap: Promise.resolve() }), {
    message: /copy records/,
  });
  t.is(entries.length, 0);
});
