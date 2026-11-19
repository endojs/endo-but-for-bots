// @ts-check
// The speech view of a turn (resources/agent-host/impl/speech/turn-view.js;
// designs/m11-interfaces.md section 7, acceptance 4, probes "a third view on
// one session" and "a reply of 1 MiB with no punctuation"). Node adapter
// tests over the real channel registry and Live service, a Session made with
// the real guard, and a staged final in a real blob store read through the
// real Content; no vat.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { interfaces, methodNames } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import { makeChannelRegistry } from '../../resources/agent-host/impl/channels.js';
import { makeContent } from '../../resources/agent-host/impl/content.js';
import { makeLive } from '../../resources/agent-host/impl/live-service.js';
import {
  audioLimits,
  speechTexts,
} from '../../resources/agent-host/impl/speech/audio-protocol.js';
import { makeSpeechText } from '../../resources/agent-host/impl/speech/speech-text.js';
import { openTurnView } from '../../resources/agent-host/impl/speech/turn-view.js';
import { makeTimers } from '../../resources/agent-host/impl/timers.js';
import { makeTestBlobs } from './_m1b-blobs.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { makeExo } = /** @type {GuestGlobals} */ (globalThis);

const timers = makeTimers();

const usage = harden({
  inputTokens: 1,
  outputTokens: 2,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
  context: { usedTokens: 3, windowTokens: 1000 },
  turns: 1,
  incompleteTurns: 0,
});

/** A Session presence made with the product's guard (every method inert). */
const makeSession = () =>
  makeExo(
    'Session',
    /** @type {any} */ (interfaces.Session),
    Object.fromEntries(
      /** @type {any} */ (methodNames).Session.map(
        (/** @type {string} */ method) => [method, () => undefined],
      ),
    ),
  );

/**
 * One session's channel with a publisher the test drives, the incarnation's
 * Live and Content.
 * @param {Parameters<typeof makeChannelRegistry>[0]} [registryOptions]
 */
const makeWorld = registryOptions => {
  const blobs = makeTestBlobs();
  const registry = makeChannelRegistry(registryOptions);
  const live = makeLive({ channels: registry });
  const content = makeContent({ store: blobs.store });
  const session = makeSession();
  const channel = registry.channelFor(session);
  let rev = 0;
  /** @param {any[]} events */
  const publish = events => {
    rev += 1;
    channel.publisher.publish(harden({ rev, events }));
  };
  /**
   * @param {string} turnId
   * @param {string} text
   * @param {number} [round]
   */
  const delta = (turnId, text, round = 0) =>
    channel.publishDelta(harden({ type: 'delta', turnId, round, text }));
  return { blobs, live, content, session, channel, publish, delta };
};

/** Let the channel's microtask fan-out and the view's reads run. */
const settle = () => timers.delay(5);

/**
 * A TurnTextSink that records what it hears, feeding a SpeechText too.
 */
const makeSink = () => {
  /** @type {any[]} */
  const heard = [];
  const speech = makeSpeechText();
  /** @type {string[]} */
  const sentences = [];
  let maxPending = 0;
  /** @type {(value: any) => void} */
  let resolveOver = () => {};
  /** @type {Promise<any>} */
  const over = new Promise(resolve => {
    resolveOver = resolve;
  });
  const sink = harden({
    /** @param {string} text */
    text: text => {
      heard.push(text);
      sentences.push(...speech.push(text));
      maxPending = Math.max(maxPending, speech.pendingUnits());
    },
    lineBreak: () => {
      heard.push('<br>');
      sentences.push(...speech.lineBreak());
    },
    end: () => {
      heard.push('<end>');
      sentences.push(...speech.finish());
      resolveOver('end');
    },
    /** @param {string} reason */
    abort: reason => {
      heard.push(`<abort ${reason}>`);
      resolveOver(reason);
    },
  });
  return { sink, heard, sentences, over, maxPending: () => maxPending };
};

/**
 * @param {ReturnType<typeof makeWorld>} world
 * @param {string} turnId
 * @param {ReturnType<typeof makeSink>} sink
 * @param {Parameters<typeof openTurnView>[0]['limits']} [viewLimits]
 */
const open = (world, turnId, sink, viewLimits) =>
  openTurnView({
    live: world.live,
    content: world.content,
    session: world.session,
    turnId,
    sink: sink.sink,
    ...(viewLimits === undefined ? {} : { limits: viewLimits }),
  });

test('acceptance 4: a live turn of two rounds with a tool call', async t => {
  const world = makeWorld();
  t.teardown(world.blobs.cleanup);
  world.publish([{ type: 'turn-start', turnId: 't1', input: 'hi', at: 1 }]);
  const sink = makeSink();
  const view = await open(world, 't1', sink);
  t.truthy(view);
  world.publish([{ type: 'phase', turnId: 't1', phase: 'thinking' }]);
  world.delta('t1', 'Let me check ');
  world.delta('t1', 'the file. One');
  world.publish([
    { type: 'phase', turnId: 't1', phase: 'using tools' },
    { type: 'tool_call', turnId: 't1', id: 'c0', name: 'echo', args: '{}' },
  ]);
  world.publish([
    {
      type: 'tool_result',
      turnId: 't1',
      id: 'c0',
      name: 'echo',
      result: 'secret tool output.',
      failed: false,
    },
  ]);
  world.delta('t2', 'another turn is never spoken. ');
  world.delta('t1', 'Done: ', 1);
  world.delta('t1', 'a and b', 1);
  world.publish([
    // The final restates the round and adds the unspoken rest.
    { type: 'final', turnId: 't1', text: 'Done: a and b. All good.' },
    { type: 'usage', turnId: 't1', ...usage },
    { type: 'end', turnId: 't1', status: 'completed' },
  ]);
  t.is(await sink.over, 'end');
  t.deepEqual(sink.heard, [
    'Let me check ',
    'the file. One',
    '<br>',
    'Done: ',
    'a and b',
    '. All good.',
    '<end>',
  ]);
  t.deepEqual(sink.sentences, [
    'Let me check the file.',
    'One',
    'Done: a and b.',
    'All good.',
  ]);
  await settle();
  t.is(world.channel.subscriberCount(), 0, 'the subscription is released');
});

test('a view opened mid-turn speaks the snapshot, then the deltas', async t => {
  const world = makeWorld();
  t.teardown(world.blobs.cleanup);
  world.publish([{ type: 'turn-start', turnId: 't1', input: 'hi', at: 1 }]);
  world.delta('t1', 'Earlier answer.');
  world.publish([
    { type: 'tool_call', turnId: 't1', id: 'c0', name: 'echo', args: '{}' },
  ]);
  world.delta('t1', 'Hel', 1);
  await settle();
  const sink = makeSink();
  await open(world, 't1', sink);
  world.delta('t1', 'lo there.', 1);
  world.publish([{ type: 'final', turnId: 't1', text: 'Hello there.' }]);
  world.publish([{ type: 'end', turnId: 't1', status: 'completed' }]);
  t.is(await sink.over, 'end');
  t.deepEqual(sink.heard, ['Earlier answer.\nHel', 'lo there.', '<end>']);
});

test('the last finished turn replays to the end; an older or unstarted turn is not live', async t => {
  const world = makeWorld();
  t.teardown(world.blobs.cleanup);
  const before = makeSink();
  await t.throwsAsync(() => open(world, 't1', before), {
    message: speechTexts.turnNotLive,
  });
  world.publish([{ type: 'turn-start', turnId: 't1', input: 'hi', at: 1 }]);
  world.delta('t1', 'First reply.');
  world.publish([{ type: 'end', turnId: 't1', status: 'completed' }]);
  world.publish([{ type: 'turn-start', turnId: 't2', input: 'again', at: 2 }]);
  world.delta('t2', 'Second reply, all of it.');
  world.publish([
    { type: 'abort', turnId: 't2', reason: 'the provider failed' },
  ]);
  await settle();
  const older = makeSink();
  await t.throwsAsync(() => open(world, 't1', older), {
    message: speechTexts.turnNotLive,
  });
  t.deepEqual(older.heard, []);
  const last = makeSink();
  await open(world, 't2', last);
  t.is(await last.over, 'end', 'a closing abort counts as the end');
  // The fold closed the aborted turn's text into a message.
  t.deepEqual(last.heard, ['Second reply, all of it.\n', '<end>']);
  await settle();
  t.is(world.channel.subscriberCount(), 0);
});

test('a live abort ends the view', async t => {
  const world = makeWorld();
  t.teardown(world.blobs.cleanup);
  world.publish([{ type: 'turn-start', turnId: 't1', input: 'hi', at: 1 }]);
  const sink = makeSink();
  await open(world, 't1', sink);
  world.delta('t1', 'Partial');
  world.publish([{ type: 'abort', turnId: 't1', reason: 'cancelled' }]);
  t.is(await sink.over, 'end');
  t.deepEqual(sink.heard, ['Partial', '<end>']);
});

test('finals: only one is spoken whole, a restated one adds nothing, a revised one is left to the transcript', async t => {
  const world = makeWorld();
  t.teardown(world.blobs.cleanup);
  world.publish([{ type: 'turn-start', turnId: 't1', input: 'hi', at: 1 }]);
  const sink = makeSink();
  await open(world, 't1', sink);
  // A round with only a final.
  world.publish([
    { type: 'final', turnId: 't1', text: 'Only a final answer.' },
  ]);
  // The same final again adds nothing.
  world.publish([
    { type: 'final', turnId: 't1', text: 'Only a final  answer.' },
  ]);
  world.publish([
    { type: 'tool_call', turnId: 't1', id: 'c0', name: 'echo', args: '{}' },
  ]);
  world.delta('t1', 'Hi', 1);
  world.publish([{ type: 'final', turnId: 't1', text: 'Something else.' }]);
  world.publish([{ type: 'end', turnId: 't1', status: 'completed' }]);
  t.is(await sink.over, 'end');
  t.deepEqual(sink.heard, ['Only a final answer.', '<br>', 'Hi', '<end>']);
});

test('a staged final is read through Content: whole, or its unspoken rest', async t => {
  const world = makeWorld();
  t.teardown(world.blobs.cleanup);
  const long = `${'Word after word. '.repeat(3000)}The end.`;
  t.true(long.length > limits.blobPageBytes, 'more than one page');
  const whole = await world.blobs.store.stage(long);
  const rest = await world.blobs.store.stage(`Hi there. ${long}`);
  world.publish([{ type: 'turn-start', turnId: 't1', input: 'hi', at: 1 }]);
  const sink = makeSink();
  await open(world, 't1', sink);
  world.publish([{ type: 'final', turnId: 't1', text: whole }]);
  world.publish([
    { type: 'tool_call', turnId: 't1', id: 'c0', name: 'echo', args: '{}' },
  ]);
  world.delta('t1', 'Hi ', 1);
  world.delta('t1', 'there.', 1);
  world.publish([{ type: 'final', turnId: 't1', text: rest }]);
  world.publish([{ type: 'end', turnId: 't1', status: 'completed' }]);
  t.is(await sink.over, 'end');
  const collapsed = long.replace(/\s+/g, ' ').trim();
  t.deepEqual(sink.heard, [
    collapsed,
    '<br>',
    'Hi ',
    'there.',
    ` ${collapsed}`,
    '<end>',
  ]);
});

test('probe: a third view on one session is refused; closing one frees its place', async t => {
  const world = makeWorld();
  t.teardown(world.blobs.cleanup);
  world.publish([{ type: 'turn-start', turnId: 't1', input: 'hi', at: 1 }]);
  t.is(audioLimits.speakViewsPerSession, 2);
  const first = await open(world, 't1', makeSink());
  const second = await open(world, 't1', makeSink());
  await t.throwsAsync(() => open(world, 't1', makeSink()), {
    message: speechTexts.tooManyViews,
  });
  await settle();
  t.is(
    world.channel.subscriberCount(),
    2,
    'the refused view subscribed nothing',
  );
  // Another session has its own count.
  const other = makeWorld();
  t.teardown(other.blobs.cleanup);
  other.publish([{ type: 'turn-start', turnId: 't1', input: 'hi', at: 1 }]);
  await open(other, 't1', makeSink());
  first.close();
  second.close();
  // A turn-not-live open gives its place back.
  await t.throwsAsync(() => open(world, 'old', makeSink()), {
    message: speechTexts.turnNotLive,
  });
  await open(world, 't1', makeSink());
  await open(world, 't1', makeSink());
  await settle();
  t.is(world.channel.subscriberCount(), 2);
});

test('close() stops the sink and releases the subscription; the turn goes on', async t => {
  const world = makeWorld();
  t.teardown(world.blobs.cleanup);
  world.publish([{ type: 'turn-start', turnId: 't1', input: 'hi', at: 1 }]);
  const sink = makeSink();
  const watcher = world.channel.subscribe();
  const view = await open(world, 't1', sink);
  world.delta('t1', 'Before close.');
  await settle();
  view.close();
  view.close();
  world.delta('t1', ' After close.');
  world.publish([{ type: 'end', turnId: 't1', status: 'completed' }]);
  await settle();
  t.deepEqual(sink.heard, ['Before close.']);
  t.is(world.channel.subscriberCount(), 1, 'only the other watcher is left');
  const snapshot = /** @type {any} */ (world.channel.snapshot());
  t.is(snapshot.turn?.settled, true, 'the turn finished regardless');
  t.truthy(watcher);
});

test('a subscription the channel drops aborts the view with turnNotFound', async t => {
  const world = makeWorld({ subscriberQueueLimit: 4 });
  t.teardown(world.blobs.cleanup);
  world.publish([{ type: 'turn-start', turnId: 't1', input: 'hi', at: 1 }]);
  const sink = makeSink();
  await open(world, 't1', sink);
  await settle();
  for (let i = 0; i < 10; i += 1) world.delta('t1', `${i} `);
  t.is(await sink.over, speechTexts.turnNotFound);
  t.is(sink.heard.at(-1), `<abort ${speechTexts.turnNotFound}>`);
});

test('the next turn starting before this one ended (a channel gap) ends the view', async t => {
  const world = makeWorld();
  t.teardown(world.blobs.cleanup);
  world.publish([{ type: 'turn-start', turnId: 't1', input: 'hi', at: 1 }]);
  const sink = makeSink();
  await open(world, 't1', sink);
  world.delta('t1', 'Some text.');
  world.publish([{ type: 'turn-start', turnId: 't2', input: 'next', at: 2 }]);
  world.delta('t2', 'Not this one.');
  t.is(await sink.over, 'end');
  t.deepEqual(sink.heard, ['Some text.', '<end>']);
});

test('probe: a reply of 1 MiB with no punctuation keeps the text backlog bounded', async t => {
  const world = makeWorld();
  t.teardown(world.blobs.cleanup);
  world.publish([{ type: 'turn-start', turnId: 't1', input: 'hi', at: 1 }]);
  const sink = makeSink();
  await open(world, 't1', sink);
  const chunk = 'abcdefgh '.repeat(1820); // about 16 KiB
  let sent = 0;
  while (sent < 1024 * 1024) {
    world.delta('t1', chunk);
    sent += chunk.length;
    // eslint-disable-next-line no-await-in-loop
    await settle();
  }
  world.publish([{ type: 'end', turnId: 't1', status: 'completed' }]);
  t.is(await sink.over, 'end');
  t.true(sink.sentences.length > 1000);
  t.true(sink.sentences.every(s => s.length <= audioLimits.sentenceUnits));
  t.true(sink.maxPending() <= audioLimits.sentenceUnits + chunk.length);
});

test('a round over its text bound makes its final add nothing', async t => {
  const world = makeWorld();
  t.teardown(world.blobs.cleanup);
  world.publish([{ type: 'turn-start', turnId: 't1', input: 'hi', at: 1 }]);
  const sink = makeSink();
  await open(world, 't1', sink, { sentenceBacklogUnits: 8 });
  world.delta('t1', 'Too long for the bound');
  world.publish([
    { type: 'final', turnId: 't1', text: 'Too long for the bound. Extra.' },
    { type: 'end', turnId: 't1', status: 'completed' },
  ]);
  t.is(await sink.over, 'end');
  t.deepEqual(sink.heard, ['Too long for the bound', '<end>']);
});
