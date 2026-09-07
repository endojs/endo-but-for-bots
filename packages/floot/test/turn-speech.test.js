// @ts-check
// The spoken view of a daemon-owned turn (src/turn-speech.js): what reaches a
// TtsServer's text wire for a given sequence of turn-view events, and how the
// branch comes and goes with its audio consumer.
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { Far } from '@endo/far';

import { makeSessionTurn } from '../src/session-turn.js';
import { speakTurn } from '../src/turn-speech.js';

// A TtsServer stand-in: records each synthesize() call's text reader and
// options, and hands back a distinct audio reader per call.
const makeFakeTts = () => {
  /** @type {any[]} */
  const textReaders = [];
  /** @type {object[]} */
  const options = [];
  const ttsServer = Far('FakeTtsServer', {
    synthesize(/** @type {any} */ textReader, /** @type {object} */ opts) {
      textReaders.push(textReader);
      options.push(opts);
      return Far(`AudioReader${textReaders.length}`, {});
    },
  });
  return { ttsServer, textReaders, options };
};

// A turn view the test drives, standing in for FlootTurn.watch(); `closed`
// reports whether the speech branch let go of it.
const makeDrivenView = () => {
  const view = makeBufferedReader();
  let closed = false;
  view.setOnClose(() => {
    closed = true;
  });
  return { view, closed: () => closed };
};

const emptyStatus = harden({
  phase: 'thinking',
  streamingText: '',
  messages: [],
  done: false,
  error: null,
  usage: null,
});

/**
 * Read a text wire to completion.
 *
 * @param {any} reader
 * @returns {Promise<any[]>}
 */
const collect = async reader => {
  const events = [];
  for await (const event of iterateReader(reader)) events.push(event);
  return events;
};

/**
 * Turn the microtask queue until `predicate` holds; closing a channel reaches
 * the party at the other end of it a few turns later.
 *
 * @param {() => boolean} predicate
 */
const until = async predicate => {
  await null;
  for (let tries = 0; tries < 100; tries += 1) {
    if (predicate()) return;
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  throw Error('the expected state never arrived');
};

test('speaks what the snapshot holds, then the deltas, and ends with the turn', async t => {
  const { ttsServer, textReaders, options } = makeFakeTts();
  const { view } = makeDrivenView();
  const audio = await speakTurn({
    watch: () => view.reader,
    ttsServer,
    ttsOptions: { voice: 'alba', speed: 1.2 },
  });
  t.truthy(audio);
  t.deepEqual(options, [{ voice: 'alba', speed: 1.2 }]);

  // A view opened mid-turn: one assistant message already completed before a
  // tool round, and the next one still streaming.
  view.push({
    type: 'snapshot',
    status: {
      ...emptyStatus,
      messages: [
        { role: 'assistant', text: 'Earlier answer.' },
        { role: 'tool', id: 't1', name: 'Read', args: '{}', result: 'x' },
      ],
      streamingText: 'Hel',
    },
  });
  view.push({ type: 'delta', text: 'lo.' });
  view.push({ type: 'phase', phase: 'using tools' });
  view.push({ type: 'tool_call', id: 't2', name: 'Read', args: '{}' });
  view.push({ type: 'tool_result', id: 't2', name: 'Read', result: 'y' });
  view.push({ type: 'delta', text: 'Done.' });
  view.push({ type: 'final', text: 'Done.' });
  view.push({ type: 'usage', inputTokens: 1, outputTokens: 1, turns: 1 });
  view.push({ type: 'end' });

  t.deepEqual(await collect(textReaders[0]), [
    // The completed message ends on a newline so no sentence straddles it and
    // the streaming text; that text is left open for the deltas to extend.
    { type: 'delta', text: 'Earlier answer.\nHel' },
    { type: 'delta', text: 'lo.' },
    // A tool round ends the message; the text after it is a new one.
    { type: 'delta', text: '\n' },
    { type: 'delta', text: 'Done.' },
    { type: 'end' },
  ]);
});

test('a final with no deltas is spoken; one that restates them is not', async t => {
  const { ttsServer, textReaders } = makeFakeTts();
  const only = makeDrivenView();
  await speakTurn({ watch: () => only.view.reader, ttsServer });
  only.view.push({ type: 'snapshot', status: emptyStatus });
  only.view.push({ type: 'final', text: 'Only a final answer.' });
  only.view.push({ type: 'end' });
  t.deepEqual(await collect(textReaders[0]), [
    { type: 'delta', text: 'Only a final answer.' },
    { type: 'end' },
  ]);

  const extended = makeDrivenView();
  await speakTurn({ watch: () => extended.view.reader, ttsServer });
  extended.view.push({ type: 'snapshot', status: emptyStatus });
  extended.view.push({ type: 'delta', text: 'Hi' });
  extended.view.push({ type: 'final', text: 'Hi there.' });
  extended.view.push({ type: 'end' });
  t.deepEqual(await collect(textReaders[1]), [
    { type: 'delta', text: 'Hi' },
    { type: 'delta', text: ' there.' },
    { type: 'end' },
  ]);

  // A final that revises what streamed cannot be unsaid; it is left to the
  // transcript rather than spoken twice.
  const revised = makeDrivenView();
  await speakTurn({ watch: () => revised.view.reader, ttsServer });
  revised.view.push({ type: 'snapshot', status: emptyStatus });
  revised.view.push({ type: 'delta', text: 'Hi' });
  revised.view.push({ type: 'final', text: 'Something else.' });
  revised.view.push({ type: 'end' });
  t.deepEqual(await collect(textReaders[2]), [
    { type: 'delta', text: 'Hi' },
    { type: 'end' },
  ]);
});

test('a turn abort aborts the text wire', async t => {
  const { ttsServer, textReaders } = makeFakeTts();
  const { view } = makeDrivenView();
  await speakTurn({ watch: () => view.reader, ttsServer });
  view.push({ type: 'snapshot', status: emptyStatus });
  view.push({ type: 'delta', text: 'Partial' });
  view.push({ type: 'abort', reason: 'provider failed' });
  t.deepEqual(await collect(textReaders[0]), [
    { type: 'delta', text: 'Partial' },
    { type: 'abort', reason: 'provider failed' },
  ]);
});

test('the audio consumer hanging up closes the view, not the turn', async t => {
  const { ttsServer, textReaders } = makeFakeTts();
  const { view, closed } = makeDrivenView();
  await speakTurn({ watch: () => view.reader, ttsServer });
  view.push({ type: 'snapshot', status: emptyStatus });
  view.push({ type: 'delta', text: 'Hello' });
  const text = iterateReader(textReaders[0]);
  t.deepEqual((await text.next()).value, { type: 'delta', text: 'Hello' });
  t.false(closed());
  // What barge-in, mute, or a settings change looks like from here: the TTS
  // side stops pulling text once nobody pulls its audio.
  await text.return();
  await until(closed);
  t.true(closed());
});

test('synthesis that cannot start rejects and releases the view', async t => {
  const ttsServer = Far('BrokenTtsServer', {
    synthesize() {
      throw Error('Unknown TTS voice "nope".');
    },
  });
  const { view, closed } = makeDrivenView();
  await t.throwsAsync(
    () =>
      speakTurn({
        watch: () => view.reader,
        ttsServer,
        ttsOptions: { voice: 'nope' },
      }),
    { message: /Unknown TTS voice/ },
  );
  await until(closed);
  t.true(closed());
});

/**
 * A turn whose body is driven by the test, as in session-turn.test.js.
 */
const makeDrivenTurn = () => {
  /** @type {any} */
  let writer;
  /** @type {() => void} */
  let settle = () => {};
  const turn = makeSessionTurn({
    run: turnWriter => {
      writer = turnWriter;
      return new Promise(resolve => {
        settle = () => resolve(undefined);
      });
    },
  });
  return { turn, writer: () => writer, settle: () => settle() };
};

test('restarting speech on a live turn replays what was said and carries the rest', async t => {
  t.timeout(5000);
  const driven = makeDrivenTurn();
  const { ttsServer, textReaders, options } = makeFakeTts();

  await E(driven.turn).speak(ttsServer, harden({ voice: 'amy' }));
  driven.writer().delta('Hello');
  const first = iterateReader(textReaders[0]);
  t.deepEqual((await first.next()).value, { type: 'delta', text: 'Hello' });
  await until(() => textReaders.length === 1);

  // The user picks another voice mid-reply: the client asks for a fresh
  // spoken view and drops the first audio stream. The new view opens on a
  // snapshot that already carries the text spoken so far.
  await E(driven.turn).speak(ttsServer, harden({ voice: 'alba' }));
  await first.return();
  driven.writer().delta(' world');
  driven.writer().final('Hello world');
  driven.writer().end();
  driven.settle();
  await E(driven.turn).whenFinished();

  t.deepEqual(options, [{ voice: 'amy' }, { voice: 'alba' }]);
  t.deepEqual(await collect(textReaders[1]), [
    { type: 'delta', text: 'Hello' },
    { type: 'delta', text: ' world' },
    { type: 'end' },
  ]);
  // Speech neither kept the turn alive nor stopped it.
  t.like(await E(driven.turn).getStatus(), {
    done: true,
    error: null,
    messages: [{ role: 'assistant', text: 'Hello world' }],
  });
});

test('speaking a finished turn replays it', async t => {
  const driven = makeDrivenTurn();
  driven.writer().delta('All done.');
  driven.writer().end();
  driven.settle();
  await E(driven.turn).whenFinished();

  const { ttsServer, textReaders } = makeFakeTts();
  // A browser hands over the TtsServer as the promise it resolved itself.
  await E(driven.turn).speak(Promise.resolve(ttsServer));
  t.deepEqual(await collect(textReaders[0]), [
    { type: 'delta', text: 'All done.\n' },
    { type: 'end' },
  ]);
});
