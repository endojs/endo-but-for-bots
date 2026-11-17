// @ts-check
// M1b W1b.1: staging in the scripted provider and echo
// (resources/agent-host/impl/providers/scripted.js, tools/echo.js;
// designs/m1b-interfaces.md sections 3.2, 5.2-5.4 and 6.4). Node, a fake
// TurnSink with `progress`, real files.
import '../unit/_m1a-prelude.js';

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import {
  m1bInterfaces,
  m1bShapes,
  shapes,
  texts,
  textOf,
} from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { messageBytes } from '../../guest/lib/bounded.js';
/* eslint-enable import/no-relative-packages */
import { makeEndpoint } from '../../resources/agent-host/impl/endpoint.js';
import { makeTimers } from '../../resources/agent-host/impl/timers.js';
import {
  makeScriptedProvider,
  tailText,
} from '../../resources/agent-host/impl/providers/scripted.js';
import { makeEchoTool } from '../../resources/agent-host/impl/tools/echo.js';
import { makeComposer } from '../../resources/agent-host/impl/composer.js';
import { makeChannelRegistry } from '../../resources/agent-host/impl/channels.js';
import {
  blobsUntil,
  FIXED_REQUEST_ID,
  filesIn,
  makeFakeSession,
  makeTestBlobs,
  partsIn,
  runRoundFor,
} from './_m1b-blobs.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, makeExo, matches } = /** @type {GuestGlobals} */ (globalThis);

const timers = makeTimers();

/**
 * @param {() => boolean} predicate
 * @param {number} [ms]
 */
const until = async (predicate, ms = 5000) => {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > ms) throw Error('timed out waiting');
    // eslint-disable-next-line no-await-in-loop
    await timers.delay(5);
  }
};

const makeFakeTurn = () => {
  /** @type {any[]} */
  const finals = [];
  /** @type {any[]} */
  const failures = [];
  /** @type {any[]} */
  const progress = [];
  const turn = makeExo('Turn', m1bInterfaces.Turn, {
    getStatus: () =>
      harden({ turnId: 't1', state: 'running', round: 0, at: 0 }),
    cancel: () => undefined,
    whenFinished: async () =>
      harden({ turnId: 't1', state: 'running', round: 0, at: 0 }),
    resolve: () => undefined,
    getContent: () => harden({ records: [] }),
  });
  // The M1b guard checks every message as a vat would.
  const sink = makeExo('TurnSink', m1bInterfaces.TurnSink, {
    dispatching: () => true,
    roundFinal: (/** @type {any} */ r) => {
      finals.push(r);
    },
    roundFailed: (/** @type {any} */ f) => {
      failures.push(f);
    },
    deadline: () => undefined,
    progress: (/** @type {any} */ p) => {
      progress.push(p);
      return true;
    },
  });
  return { turn, sink, finals, failures, progress };
};

/**
 * @param {any} script
 * @param {{ input?: any }} [options]
 */
const run = async (script, { input = 'hi' } = {}) => {
  const blobs = makeTestBlobs();
  /** @type {any[]} */
  const log = [];
  const provider = makeScriptedProvider({
    label: 'scripted',
    script: harden(script),
    timers,
    log: (kind, fields = {}) => log.push({ kind, ...fields }),
    blobs: blobs.store,
  });
  const endpoint = makeEndpoint({
    provider,
    channel: harden({ publishDelta: () => {} }),
    timers,
  });
  const fake = makeFakeTurn();
  void E(endpoint).holdTurn(fake.turn);
  E.sendOnly(endpoint).startRound(
    harden({
      turn: fake.turn,
      sink: fake.sink,
      turnId: 't1',
      round: 0,
      base: { count: 0, epoch: 0 },
      append: [{ kind: 'turn-started', turnId: 't1', input, at: 1 }],
      tools: [],
      options: { modelId: 'm' },
    }),
  );
  await until(() => fake.finals.length + fake.failures.length > 0);
  return { ...fake, blobs, log };
};

test('a 1 MiB reply is staged; progress checkpoints stage the text so far and replace each other', async t => {
  const chunk = 'r'.repeat(65_536);
  const r = await run({
    turns: [
      {
        rounds: [
          { chunks: Array.from({ length: 16 }, () => ({ text: chunk })) },
        ],
      },
    ],
  });
  t.teardown(r.blobs.cleanup);
  const [result] = r.finals;
  t.true(matches(result, shapes.RoundResult));
  t.is(result.text.bytes, 1_048_576);
  t.is(result.text.preview, 'r'.repeat(limits.messagePreviewUnits));
  t.is(await r.blobs.store.read(result.text.blob), chunk.repeat(16));
  t.true(messageBytes(result) <= limits.roundResultBytes);
  // One checkpoint at a time; each is the whole text so far.
  t.true(r.progress.length >= 1);
  for (const p of r.progress) {
    t.true(matches(p, m1bShapes.Progress));
    t.is(p.tail, 'r'.repeat(limits.messagePreviewUnits));
    t.is(p.partial.bytes % 65_536, 0);
  }
  const last = r.progress[r.progress.length - 1];
  if (last.partial.bytes === 1_048_576) {
    t.is(
      last.partial.blob,
      result.text.blob,
      'the reply reuses the checkpoint',
    );
  }
});

test('tool-call args over inlineBytes are staged; then the largest until the round fits roundResultBytes; native context always', async t => {
  const big = JSON.stringify({ text: 'a'.repeat(9000) });
  const mid = JSON.stringify({ text: 'b'.repeat(6000) });
  const r = await run({
    turns: [
      {
        rounds: [
          {
            chunks: [{ text: 'ok' }],
            toolCalls: [
              { name: 'echo', args: big },
              { name: 'echo', args: mid },
              { name: 'echo', args: mid },
              { name: 'echo', args: mid },
              { name: 'echo', code: { text: 'return 1;' } },
            ],
            nativeContext: 'opaque',
          },
        ],
      },
    ],
  });
  t.teardown(r.blobs.cleanup);
  const [result] = r.finals;
  t.true(matches(result, shapes.RoundResult));
  t.is(result.text, 'ok');
  const [first, ...rest] = result.toolCalls;
  t.is(first.args.bytes, big.length);
  t.is(first.args.preview.length, limits.toolPreviewUnits);
  t.is(await r.blobs.store.read(first.args.blob), big);
  // 3 x 6 KB inline would be 18 KB + more: at least one is staged.
  t.true(
    rest.slice(0, 3).some((/** @type {any} */ c) => typeof c.args !== 'string'),
  );
  t.true(messageBytes(result) <= limits.roundResultBytes);
  t.is(rest[3].args, JSON.stringify({ code: 'return 1;' }));
  t.is(result.nativeContext.preview, '');
  t.is(await r.blobs.store.read(result.nativeContext.blob), 'opaque');
});

test('more than maxCallsPerMessage calls fail the round with the frame-limit text', async t => {
  const r = await run({
    turns: [
      {
        rounds: [
          {
            toolCalls: Array.from(
              { length: limits.maxCallsPerMessage + 1 },
              () => ({
                name: 'echo',
              }),
            ),
          },
        ],
      },
    ],
  });
  t.teardown(r.blobs.cleanup);
  t.is(r.failures[0].reason, texts.frameLimit);
  t.true(r.log.some(line => line.kind === 'frame-limit'));
});

test('a scripted error with a long partial sends it staged', async t => {
  const r = await run({
    turns: [
      {
        rounds: [
          {
            chunks: [{ text: '€', repeat: 20_000 }],
            error: 'scripted failure',
          },
        ],
      },
    ],
  });
  t.teardown(r.blobs.cleanup);
  const [failure] = r.failures;
  t.true(matches(failure, shapes.RoundFailure));
  t.is(failure.partial.bytes, 60_000);
  t.is(await r.blobs.store.read(failure.partial.blob), '€'.repeat(20_000));
});

test('a staged turn input selects its script turn by the full text', async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const long = 'L'.repeat(9000);
  const staged = await blobs.store.stage(long);
  // The run helper makes its own store; stage the input in that one.
  const r = await (async () => {
    const provider = makeScriptedProvider({
      label: 'scripted',
      script: harden({
        turns: [
          { input: long, rounds: [{ chunks: [{ text: 'matched' }] }] },
          { rounds: [{ chunks: [{ text: 'default' }] }] },
        ],
      }),
      timers,
      blobs: blobs.store,
    });
    const endpoint = makeEndpoint({
      provider,
      channel: harden({ publishDelta: () => {} }),
      timers,
    });
    const fake = makeFakeTurn();
    void E(endpoint).holdTurn(fake.turn);
    E.sendOnly(endpoint).startRound(
      harden({
        turn: fake.turn,
        sink: fake.sink,
        turnId: 't1',
        round: 0,
        base: { count: 0, epoch: 0 },
        append: [{ kind: 'turn-started', turnId: 't1', input: staged, at: 1 }],
        tools: [],
        options: { modelId: 'm' },
      }),
    );
    await until(() => fake.finals.length > 0);
    return fake;
  })();
  t.is(r.finals[0].text, 'matched');
});

test('echo: staged args are read; failed outcomes over inlineBytes are staged as the complete Error text', async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const echo = makeEchoTool({ timers, blobs: blobs.store });
  const args = await blobs.store.stage(
    JSON.stringify({ text: 'k'.repeat(9000) }),
    {
      previewUnits: limits.toolPreviewUnits,
    },
  );
  const ok = await E(echo).execute(harden({ opId: 'o', args }));
  t.is(ok.status, 'ok');
  t.is(await blobs.store.read(ok.text.blob), 'k'.repeat(9000));
  // An unexpected key quoted in the error text makes it long.
  const badKey = 'q'.repeat(9000);
  const failed = await E(echo).execute(
    harden({ opId: 'o', args: JSON.stringify({ [badKey]: 1 }) }),
  );
  t.is(failed.status, 'failed');
  const failedText = await blobs.store.read(failed.text.blob);
  t.true(failedText.startsWith('Error: Unexpected argument'));
  t.is(
    failedText,
    textOf.errorResult(
      textOf.unexpectedArgument(badKey, 'echo', [
        'text',
        'delayMs',
        'bytes',
        'data',
      ]),
    ),
  );
});

test('tailText keeps whole surrogate pairs', t => {
  t.is(tailText('ab😀', 2), '😀');
  t.is(tailText('ab😀', 1), '');
  t.is(tailText('abc', 5), 'abc');
});

test('channels fold staged fields as their previews and deliver the StagedText unchanged', async t => {
  const channel = makeChannelRegistry().channelFor(Far('Session', {}));
  const blob = Far('Blob', {});
  const input = harden({ blob, preview: 'question', bytes: 9000 });
  const args = harden({ blob, preview: '{"text":', bytes: 9000 });
  const result = harden({ blob, preview: 'answer', bytes: 40_000 });
  const final = harden({ blob, preview: 'reply', bytes: 1_048_576 });
  channel.publisher.publish(
    harden({
      rev: 1,
      events: [
        { type: 'turn-start', turnId: 't1', input, at: 1 },
        { type: 'tool_call', turnId: 't1', id: 'o1', name: 'echo', args },
        {
          type: 'tool_result',
          turnId: 't1',
          id: 'o1',
          name: 'echo',
          result,
          failed: false,
        },
        { type: 'final', turnId: 't1', text: final },
        { type: 'end', turnId: 't1', status: 'completed' },
      ],
    }),
  );
  const subscription = channel.subscribe();
  const [snapshot] = (await E(subscription).next()).deliveries;
  const { messages } = snapshot.event.turn.status;
  t.true(matches(snapshot, shapes.Delivery));
  t.like(messages[0], { role: 'tool', args: '{"text":', result: 'answer' });
  t.like(messages[1], { role: 'assistant', text: 'reply' });
  const live = channel.subscribe(0);
  channel.publisher.publish(
    harden({
      rev: 2,
      events: [{ type: 'turn-start', turnId: 't2', input, at: 2 }],
    }),
  );
  const batch = await E(live).next();
  const start = batch.deliveries.find(
    (/** @type {any} */ d) => d.event.type === 'turn-start',
  );
  t.is(start.event.input, input, 'delivered with the StagedText');
});

test('M1b QC (J-0393): a streamed 1 MiB reply writes bytes linear in its length and keeps no superseded checkpoint', async t => {
  // 1 KiB chunks: the reviewer's shape (34 MB written before the fix).
  const chunk = 'q'.repeat(1024);
  const r = await run({
    turns: [
      {
        rounds: [
          {
            chunks: Array.from({ length: 1024 }, () => ({
              text: chunk,
              delayMs: 1,
            })),
          },
        ],
      },
    ],
  });
  t.teardown(r.blobs.cleanup);
  const [result] = r.finals;
  t.is(result.text.bytes, 1_048_576);
  t.is(await r.blobs.store.read(result.text.blob), chunk.repeat(1024));
  // Wait for the last progress answer's discard.
  await until(() => r.progress.length > 0);
  await timers.delay(50);
  const stats = r.blobs.store.stats();
  const written = stats.stagedBytes;
  t.log({ checkpoints: r.progress.length, written, stats });
  t.true(
    written <= (limits.progressWriteFactor + 1) * 1_048_576,
    `${written} bytes staged for a 1 MiB reply`,
  );
  t.true(r.progress.length >= 3, 'checkpoints still come');
  // Every checkpoint but the one the session holds was deleted, and the
  // reply is that checkpoint: one file.
  t.is(stats.discarded, r.progress.length - 1);
  const last = r.progress[r.progress.length - 1];
  t.is(last.partial.blob, result.text.blob, 'the reply is the last checkpoint');
  const files = readdirSync(r.blobs.blobDir).filter(
    name => !name.endsWith('.part'),
  );
  t.is(files.length, 1, 'only the reply is on disk');
});

test('M1b QC (J-0393): a checkpoint the session refused keeps its file and the one it holds', async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const a = await blobs.store.stage('a'.repeat(9000));
  t.true(await blobs.store.discard(a.blob));
  t.false(await blobs.store.discard(a.blob), 'once');
  await t.throwsAsync(() => blobs.store.read(a.blob), {
    message: texts.blobUnknown,
  });
  t.is(blobs.store.stats().discarded, 1);
});

// ---- M1b follow-ups (J-9361). Serial: AVA runs a file's serial tests
// before its concurrent ones, so their fsyncs do not overlap the streamed
// checkpoint test above (its checkpoint count falls under fsync load).

test.serial(
  'M1b follow-ups (J-9361): a round that fails after staging its tool arguments leaves no file',
  async t => {
    const blobs = makeTestBlobs();
    t.teardown(blobs.cleanup);
    // 64 calls of 9,000-byte arguments: every one is staged, and the result
    // still does not fit roundResultBytes, so the round fails (frame limit)
    // and none of the 64 handles was sent.
    const args = JSON.stringify({ text: 'z'.repeat(9000) });
    const owner = Far('Session', {});
    const r = await runRoundFor(
      blobs.store,
      {
        turns: [
          {
            rounds: [
              {
                chunks: [{ text: 'calls' }],
                toolCalls: [{ name: 'echo', args, times: 64 }],
              },
            ],
          },
        ],
      },
      owner,
    );
    t.is(r.failures.length, 1);
    t.is(r.failures[0].reason, texts.frameLimit);
    await blobsUntil(() => blobs.store.stats().dropped >= 64);
    t.deepEqual(filesIn(blobs.blobDir), []);
    t.deepEqual(partsIn(blobs.blobDir), []);
    t.is(blobs.store.usage(owner).session, 0);
  },
);

/**
 * Turns of the disk check: 25 in the unit lane (under a second); the J-9361
 * measurement ran 1,000 (`BLOBS_DISK_TURNS=1000`, about 20 s of fsyncs,
 * which slows the other adapter tests running beside it).
 */
const DISK_TURNS = Number(process.env.BLOBS_DISK_TURNS ?? 25);

test.serial(
  'M1b follow-ups (J-9361): blob disk after many turns of mixed sizes (Composer, provider): every byte on disk is held',
  async t => {
    t.timeout(10 * 60_000);
    const blobs = makeTestBlobs();
    t.teardown(blobs.cleanup);
    const owner = Far('Session', {});
    const composer = makeComposer({ now: () => 7, blobs: blobs.store });
    const session = makeFakeSession();
    const refusing = makeFakeSession(() => {
      throw Error(texts.requestIdReused);
    });
    // Sizes in bytes, cycled per turn: most turns are small, some large.
    const inputSizes = [200, 9000, 600, 20_000, 1000, 64_000];
    const replySizes = [500, 12_000, 2000, 40_000, 800, 200_000];
    let referenced = 0;
    let refusedSubmissions = 0;
    const t0 = Date.now();
    for (let turn = 0; turn < DISK_TURNS; turn += 1) {
      const inputBytes = inputSizes[turn % inputSizes.length];
      const replyBytes =
        turn % 100 === 99 ? 1_048_576 : replySizes[turn % replySizes.length];
      // Every 25th submission is refused by the session (its file must go).
      const target = turn % 25 === 24 ? refusing : session;
      const input = `${turn} ${'i'.repeat(inputBytes)}`;
      try {
        // eslint-disable-next-line no-await-in-loop
        await E(composer).submit(target.session, input, FIXED_REQUEST_ID);
        if (Buffer.byteLength(input) > limits.inlineBytes)
          referenced += Buffer.byteLength(input);
      } catch {
        refusedSubmissions += 1;
      }
      const replyText = 'r'.repeat(replyBytes);
      const chunks =
        replyBytes > 64_000
          ? Array.from({ length: Math.ceil(replyBytes / 16_384) }, (_, i) => ({
              text: replyText.slice(i * 16_384, (i + 1) * 16_384),
            }))
          : [{ text: replyText }];
      // Every 10th round has a 20 KB tool argument.
      const toolCalls =
        turn % 10 === 3
          ? [
              {
                name: 'echo',
                args: JSON.stringify({ text: 'a'.repeat(20_000) }),
              },
            ]
          : [];
      // eslint-disable-next-line no-await-in-loop
      const r = await runRoundFor(
        blobs.store,
        { turns: [{ rounds: [{ chunks, toolCalls }] }] },
        owner,
        `t${turn}`,
      );
      const [final] = r.finals;
      if (typeof final.text === 'object') referenced += final.text.bytes;
      for (const call of final.toolCalls) {
        if (typeof call.args === 'object') referenced += call.args.bytes;
      }
    }
    const ms = Date.now() - t0;
    // Let the last discards land.
    await timers.delay(100);
    const files = filesIn(blobs.blobDir);
    const onDisk = files.reduce(
      (sum, name) => sum + statSync(join(blobs.blobDir, name)).size,
      0,
    );
    const stats = blobs.store.stats();
    const row = {
      metric: 'blobs.disk',
      turns: DISK_TURNS,
      files: files.length,
      onDiskBytes: onDisk,
      referencedBytes: referenced,
      unreferencedBytes: onDisk - referenced,
      parts: partsIn(blobs.blobDir).length,
      refusedSubmissions,
      stagedBytes: stats.stagedBytes,
      discarded: stats.discarded,
      sessionUsage: blobs.store.usage(owner).session,
      ms,
    };
    t.log(JSON.stringify(row));
    t.is(refusedSubmissions, Math.floor(DISK_TURNS / 25));
    t.is(onDisk, referenced, 'every byte on disk is held by a record');
    t.is(row.parts, 0);
  },
);
