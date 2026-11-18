// @ts-check
// W5.3 seams in the real session (designs/m5-interfaces.md 2.4.1, 2.8):
// the label map seeded from endowments, the object tools in a real round
// (settled without a macrotask: the issuing crank), S1 tools re-read every
// round, S2 the per-turn note (inline joined, staged two-part, next turn
// none), S3 `onClaim` with the queue entry and `TurnStarted.attachments`,
// S4 `ToolContext.runtime`, the M5 `Session` guard's forwards; the
// adapter's `systemTextOf` joins a two-part system; a sealed segment and
// the projection carry `TurnStarted.attachments` (assumption 3); and the
// M1b QC shape, a round of 256 `store` calls, settles with 64 stored.
import './_m1a-prelude.js';

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { shapes, textOf } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { RETIRED_TEXT } from '../../guest/lib/retired.js';
import { makeQueue } from '../../guest/session/queue.js';
import { runtimeParts } from '../../guest/session/runtime-parts.js';
import { makeSession } from '../../guest/session/session.js';
import { toolTable } from '../../guest/session/tool-table.js';
import { turnHooks } from '../../guest/session/turn-hooks.js';
import { systemTextOf } from '../../resources/agent-host/impl/providers/round.js';
import { projectRecords } from '../../resources/agent-host/impl/projection.js';
import {
  decodeRecord,
  encodeRecord,
  readSegment,
  segmentName,
  writeSegment,
} from '../../resources/agent-host/impl/archive/segment.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makePromiseKit, matches } = /** @type {GuestGlobals} */ (
  globalThis
);

const drain = () => new Promise(resolve => setImmediate(resolve));
/** Let microtasks run, but no macrotask (a crank's own continuation). */
const microtasks = async (n = 500) => {
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
};

const AT = 1_700_000_000_000;
let serial = 0;
const requestId = () => {
  serial += 1;
  return `${AT}-00000000-0000-4000-8000-${`${serial}`.padStart(12, '0')}`;
};
const usage = harden({
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});

/**
 * The real session over in-memory fakes (as `_m2-queue-session.js`), with
 * M5's session options and services passed through.
 * @param {object} [options]
 * @param {any} [options.services] extra SessionServices fields
 * @param {any} [options.config] extra SessionConfig fields
 * @param {any} [options.sessionOptions]
 */
const makeM5Session = async ({
  services = {},
  config = {},
  sessionOptions = {},
} = {}) => {
  /** @type {any[]} */
  const rounds = [];
  const publisher = Far('LivePublisher', { publish: () => {} });
  const endpoint = Far('Endpoint', {
    holdTurn: () => makePromiseKit().promise,
    releaseTurn: () => {},
    startRound: (/** @type {any} */ req) => {
      rounds.push(req);
    },
    cancelRound: () => {},
    armDeadline: () => {},
    disarm: () => {},
  });
  const ports = harden({ endpoint, publisher, tools: harden([]), since: AT });
  const backend = Far('Backend', {
    describe: () => harden({ kind: 'scripted', label: 'fake' }),
    open: () => ports,
  });
  const host = Far('SessionHostFacet', {
    liveChannel: () => Far('LivePublisher', { publish: () => {} }),
  });
  const rowReporter = Far('RowReporter', { changed: () => {} });
  const made = makeSession(
    {
      config: harden({
        key: 's1',
        title: 'm5 test',
        backendTitle: 'fake',
        modelId: 'scripted',
        preset: harden({ label: 'chat-only' }),
        createdAt: AT,
        userInitiated: true,
        ...config,
      }),
      services: harden({ backend, host, ...services }),
      rowReporter,
    },
    harden(sessionOptions),
  );
  await drain();
  return {
    ...made,
    rounds,
    last: () => rounds[rounds.length - 1],
    /** @param {string} text */
    submit: async text => {
      const receipt = made.session.enqueueOnce(
        harden({ text }),
        requestId(),
        AT,
      );
      await drain();
      return receipt;
    },
    /**
     * Answer the last round with these tool calls (none: final).
     * @param {{ name: string, args: string }[]} [calls]
     * @param {string} [text]
     */
    answer: (calls = [], text = 'ok') => {
      const req = rounds[rounds.length - 1];
      req.sink.dispatching(req.round);
      req.sink.roundFinal(
        harden({
          round: req.round,
          text,
          toolCalls: harden(
            calls.map((c, i) => harden({ callId: `c${i}`, ...c })),
          ),
          usage,
          at: AT + 1,
        }),
      );
    },
  };
};

/** @param {any} req */
const resultsIn = req =>
  req.append.filter((/** @type {any} */ r) => r.kind === 'tool-result');

test('endowments seed the label map; the object tools run in the issuing crank', async t => {
  const notes = Far('Notes', {});
  const s = await makeM5Session({
    services: { endowments: [{ label: 'notes', value: notes }] },
  });
  await s.submit('hi');
  // W5.7's `adopt` is a session-site entry too; the inspecting tools need
  // an exec vat (none here).
  t.deepEqual(
    s.last().tools.map((/** @type {any} */ d) => d.name),
    ['list', 'lookup', 'store', 'remove', 'adopt'],
  );
  s.answer([
    { name: 'store', args: '{"value":{"n":1},"petName":"x"}' },
    { name: 'lookup', args: '{"petName":"x"}' },
    { name: 'list', args: '{}' },
    { name: 'remove', args: '{"petName":"x"}' },
    { name: 'lookup', args: '{"petName":"nope"}' },
  ]);
  const before = s.rounds.length;
  await microtasks();
  t.is(s.rounds.length, before + 1, 'round 1 sent without a macrotask');
  const results = resultsIn(s.last());
  t.deepEqual(
    results.map((/** @type {any} */ r) => [r.name, r.result, r.failed]),
    [
      ['store', 'Stored value under "x"', false],
      ['lookup', '{"n":1}', false],
      ['list', JSON.stringify(['notes', 'x'], null, 2), false],
      ['remove', 'Removed "x"', false],
      ['lookup', textOf.errorResult(textOf.unknownLabel('nope')), true],
    ],
  );
});

test('a seed with a reserved or taken label fails make', async t => {
  const notes = Far('Notes', {});
  await t.throwsAsync(
    makeM5Session({
      services: { endowments: [{ label: 'user', value: notes }] },
    }),
    { message: textOf.reservedLabel('user') },
  );
  await t.throwsAsync(
    makeM5Session({
      services: {
        endowments: [
          { label: 'a', value: notes },
          { label: 'a', value: notes },
        ],
      },
    }),
    { message: textOf.labelTaken('a') },
  );
});

test('S1: the tool set is read again at every round; S4: the runtime reaches tools', async t => {
  let offer = false;
  /** @type {any[]} */
  const contexts = [];
  const late = harden({
    name: 'late',
    site: 'guest',
    describe: () =>
      harden({ name: 'late', description: 'late', parameters: '{}' }),
    available: () => true,
    execute: async (
      /** @type {any} */ _r,
      /** @type {any} */ _p,
      /** @type {any} */ context,
    ) => {
      contexts.push(context);
      return harden({ status: 'ok', text: 'ran' });
    },
  });
  /** @type {any[]} */
  const runtimes = [];
  const source = (
    /** @type {any} */ _p,
    /** @type {any} */ _s,
    /** @type {any} */ runtime,
  ) => {
    runtimes.push(runtime);
    return offer ? harden([late]) : harden([]);
  };
  const s = await makeM5Session({
    sessionOptions: { toolSources: [source] },
  });
  await s.submit('hi');
  t.false(s.last().tools.some((/** @type {any} */ d) => d.name === 'late'));
  offer = true;
  s.answer([{ name: 'list', args: '{}' }]);
  await drain();
  t.true(s.last().tools.some((/** @type {any} */ d) => d.name === 'late'));
  s.answer([{ name: 'late', args: '{}' }]);
  await drain();
  t.is(contexts.length, 1);
  const { runtime } = contexts[0];
  t.truthy(runtime.labels);
  t.is(typeof runtime.labels.list, 'function');
  t.is(runtime.session.queue !== undefined, true);
  t.true(
    runtimes.every(r => r === runtime),
    'one runtime per session',
  );
  t.deepEqual(
    resultsIn(s.last()).map((/** @type {any} */ r) => r.result),
    ['ran'],
  );
});

test('S2, S3: onClaim sees the entry; the note joins every round of that turn only', async t => {
  /** @type {any[]} */
  const claimed = [];
  const hooks = harden({
    ...turnHooks,
    onClaim: harden([
      (/** @type {any} */ { active, item }) => {
        claimed.push(item);
        if (item?.attachments !== undefined) {
          active.systemNote = textOf.mentionLine(
            1,
            item.attachments.map((/** @type {any} */ a) => a.label),
          );
        }
      },
    ]),
  });
  // A queue whose entries carry attachments (W5.7 builds that; here the
  // first entry is given two by a wrapper).
  const notes = Far('Notes', {});
  const calc = Far('Calc', {});
  /** @type {WeakMap<any, any>} */
  const originals = new WeakMap();
  let attachOnce = true;
  const wrapQueue = (/** @type {any} */ options) => {
    const queue = makeQueue(options);
    return harden({
      ...queue,
      first: () => {
        const item = queue.first();
        if (item === undefined || !attachOnce) return item;
        const augmented = harden({
          ...item,
          attachments: harden([
            { label: 'notes', value: notes },
            { label: 'calc', value: calc },
          ]),
        });
        originals.set(augmented, item);
        return augmented;
      },
      claim: (/** @type {any} */ item, /** @type {string} */ turnId) => {
        attachOnce = false;
        return queue.claim(originals.get(item) ?? item, turnId);
      },
    });
  };
  const s = await makeM5Session({
    config: { systemPrompt: 'You are helpful.' },
    sessionOptions: { hooks, makeQueue: wrapQueue },
  });
  await s.submit('look');
  const note = textOf.mentionLine(1, ['notes', 'calc']);
  t.is(claimed.length, 1);
  t.deepEqual(
    claimed[0].attachments.map((/** @type {any} */ a) => a.label),
    ['notes', 'calc'],
  );
  const round0 = s.last();
  t.is(round0.system, `You are helpful.\n\n${note}`);
  const started = round0.append.find(
    (/** @type {any} */ r) => r.kind === 'turn-started',
  );
  t.deepEqual(started.attachments, ['notes', 'calc']);
  t.true(matches(started, shapes.TurnStarted));
  t.false('value' in started, 'labels only');
  s.answer([{ name: 'list', args: '{}' }]);
  await drain();
  t.is(s.last().round, 1);
  t.is(s.last().system, `You are helpful.\n\n${note}`, 'every round');
  s.answer();
  await drain();
  await s.submit('next');
  t.is(s.last().system, 'You are helpful.', 'the next turn carries no note');
  t.is(claimed[1].attachments, undefined);
  const started2 = s
    .last()
    .append.find((/** @type {any} */ r) => r.kind === 'turn-started');
  t.false('attachments' in started2);
});

test('S2: a staged prompt, or a joined text over inlineBytes, goes as two parts', async t => {
  const hooks = harden({
    ...turnHooks,
    onClaim: harden([
      (/** @type {any} */ { active }) => {
        active.systemNote = 'NOTE';
      },
    ]),
  });
  const staged = harden({
    blob: Far('Blob', {}),
    preview: 'You are',
    bytes: 9000,
    digest: 'd'.repeat(64),
  });
  const s1 = await makeM5Session({
    config: { systemPrompt: staged },
    sessionOptions: { hooks },
  });
  await s1.submit('a');
  t.deepEqual(s1.last().system, [staged, 'NOTE']);
  t.true(matches(s1.last(), shapes.RoundRequest));
  const long = 'x'.repeat(limits.inlineBytes - 2);
  const s2 = await makeM5Session({
    config: { systemPrompt: long },
    sessionOptions: { hooks },
  });
  await s2.submit('a');
  t.deepEqual(s2.last().system, [long, 'NOTE']);
  const s3 = await makeM5Session({ sessionOptions: { hooks } });
  await s3.submit('a');
  t.is(s3.last().system, 'NOTE', 'no stored prompt: the note alone');
});

test('systemTextOf joins a two-part system, each part read as before', async t => {
  const blob = Far('Blob', {});
  const blobs = /** @type {any} */ ({
    read: async (/** @type {any} */ b) => {
      if (b !== blob) throw Error('unknown blob');
      return 'STAGED PROMPT';
    },
  });
  const staged = harden({ blob, preview: 'S', bytes: 13 });
  t.is(await systemTextOf(undefined, blobs, {}), undefined);
  t.is(await systemTextOf('plain', blobs, {}), 'plain');
  t.is(await systemTextOf(staged, blobs, {}), 'STAGED PROMPT');
  t.is(
    await systemTextOf(harden(['prompt', 'note']), blobs, {}),
    'prompt\n\nnote',
  );
  t.is(
    await systemTextOf(harden([staged, 'note']), blobs, {}),
    'STAGED PROMPT\n\nnote',
  );
  await t.throwsAsync(
    systemTextOf(
      harden([harden({ blob: Far('Blob', {}), preview: '', bytes: 1 }), 'n']),
      blobs,
      {},
    ),
  );
});

test('Session (M5 guard): a runtime without one of its four parts is refused at construction; grants and enqueueMessageOnce forward', async t => {
  // HR-SYN-23: a missing part is a construction error, never a model- or
  // caller-visible "not built yet".
  await t.throwsAsync(
    makeM5Session({ sessionOptions: { parts: harden([]) } }),
    {
      message: 'no runtime part powers',
    },
  );
  const withoutGrants = runtimeParts.filter(part => part.name !== 'grants');
  await t.throwsAsync(
    makeM5Session({ sessionOptions: { parts: harden(withoutGrants) } }),
    { message: 'no runtime part grants' },
  );
  const attachments = harden([{ label: 'notes', value: Far('Notes', {}) }]);
  const s = await makeM5Session();
  // The guard refuses 33 attachments before any part runs.
  t.throws(() =>
    s.session.enqueueMessageOnce(
      harden({ text: 'x' }),
      requestId(),
      AT,
      harden(Array(33).fill(attachments[0])),
    ),
  );
  const facet = Far('SessionGrants', {});
  /** @type {any[]} */
  const calls = [];
  const parts = harden([
    ...runtimeParts.filter(
      part => part.name !== 'grants' && part.name !== 'packages',
    ),
    { name: 'grants', make: () => harden({ facet }) },
    {
      name: 'packages',
      make: (/** @type {any} */ runtime) =>
        harden({
          enqueueMessageOnce: (/** @type {any[]} */ ...args) => {
            calls.push(args);
            return runtime.session.queue.enqueueOnce(args[0], args[1], args[2])
              .receipt;
          },
        }),
    },
  ]);
  const p = await makeM5Session({ sessionOptions: { parts } });
  t.is(p.session.grants(), facet);
  const id = requestId();
  const receipt = p.session.enqueueMessageOnce(
    harden({ text: 'x' }),
    id,
    AT,
    attachments,
  );
  t.is(receipt.requestId, id);
  t.is(calls.length, 1);
  t.is(calls[0][3][0].label, 'notes');
});

test('QC shape: a round of 256 store calls stores 64 and refuses the rest', async t => {
  const s = await makeM5Session();
  await s.submit('many');
  const calls = Array.from({ length: limits.maxCallsPerMessage }, (_, i) => ({
    name: 'store',
    args: `{"value":${i},"petName":"k${i}"}`,
  }));
  s.answer(calls);
  await drain();
  t.is(s.last().round, 1, 'the turn went on');
  // The round's records do not fit its request: read them through context.
  /** @type {any[]} */
  const records = [];
  let cursor;
  do {
    const page = /** @type {any} */ (
      cursor === undefined
        ? s.last().context.page()
        : s.last().context.page(cursor)
    );
    records.push(...page.records);
    cursor = page.next;
  } while (cursor !== undefined);
  const results = records.filter(r => r.kind === 'tool-result');
  t.is(results.length, limits.maxCallsPerMessage);
  t.is(
    results.filter((/** @type {any} */ r) => !r.failed).length,
    limits.maxCallsPerRound,
  );
  t.is(
    results.filter(
      (/** @type {any} */ r) =>
        r.result ===
        textOf.tooManyCalls(limits.maxCallsPerMessage, limits.maxCallsPerRound),
    ).length,
    limits.maxCallsPerMessage - limits.maxCallsPerRound,
  );
  s.answer([{ name: 'list', args: '' }]);
  await drain();
  const [list] = resultsIn(s.last());
  t.is(JSON.parse(list.result).length, limits.maxCallsPerRound);
});

test('a TurnStarted with attachments round-trips a sealed segment and the projection ignores it', async t => {
  const record = harden({
    kind: 'turn-started',
    turnId: 't1',
    input: 'look',
    at: 1,
    attachments: ['notes', 'calc'],
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'm5-w53-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const keyed = encodeRecord(record, () => undefined);
  const settled = {
    kind: 'turn-settled',
    turnId: 't1',
    status: 'completed',
    at: 2,
    final: 'done',
  };
  const written = await writeSegment(
    dir,
    {
      ordinal: 1,
      from: 0,
      to: 2,
      firstTurn: 1,
      turns: 1,
      bytes: 0,
      epoch: 0,
    },
    [keyed, settled],
    '',
  );
  t.is(written.file, segmentName(1, written.digest));
  const read = await readSegment(path.join(dir, written.file));
  const back = decodeRecord(read.records[0], () => {
    throw Error('no staged fields');
  });
  t.deepEqual(back, { ...record, attachments: [...record.attachments] });
  t.true(matches(harden(back), shapes.TurnStarted));
  const texts = new Map();
  const { attachments: _a, ...plain } = record;
  const withAttachments = projectRecords([record, settled], { texts });
  const without = projectRecords([plain, settled], { texts });
  t.deepEqual(
    JSON.parse(JSON.stringify(withAttachments.transcript)),
    JSON.parse(JSON.stringify(without.transcript)),
  );
});

test('a tool site "session" is as "guest" for retired breaks (never recovery)', async t => {
  const breaking = harden({
    name: 'breaking',
    site: 'session',
    describe: () =>
      harden({ name: 'breaking', description: 'b', parameters: '{}' }),
    available: () => true,
    execute: async () => {
      throw Error(`ocapn hub: ${RETIRED_TEXT}`);
    },
  });
  const s = await makeM5Session({
    sessionOptions: { toolTable: [...toolTable, breaking] },
  });
  await s.submit('x');
  s.answer([{ name: 'breaking', args: '{}' }]);
  await drain();
  const [result] = resultsIn(s.last());
  t.true(result.failed);
  t.is(s.last().round, 1, 'the turn went on');
});
