// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { makeReplyFold } from '../src/reply-fold.js';

/** A fresh status, as a daemon turn and a browser turn record both start. */
const fresh = () => ({
  phase: 'thinking',
  streamingText: '',
  messages: [],
  error: null,
  usage: null,
});

/**
 * The corpus: one turn's worth of reply events, with text around a tool
 * round whose two calls settle out of order, a thinking block that grows
 * across two events, a usage report, and a clean end.
 */
const corpus = harden([
  { type: 'phase', phase: 'thinking' },
  {
    type: 'thinking',
    id: 'thinking-1',
    text: 'Plan ',
    startedAt: 1,
    truncated: false,
  },
  {
    type: 'thinking',
    id: 'thinking-1',
    text: 'first.',
    startedAt: 1,
    endedAt: 2,
    truncated: false,
  },
  { type: 'delta', text: 'Let me ' },
  { type: 'delta', text: 'look.' },
  { type: 'tool_call', id: 'c1', name: 'read', args: '{"path":"a"}' },
  { type: 'tool_call', id: 'c2', name: 'read', args: '{"path":"b"}' },
  { type: 'tool_result', id: 'c2', name: 'read', result: 'B' },
  { type: 'tool_result', id: 'c1', name: 'read', result: 'A' },
  { type: 'phase', phase: 'answering' },
  { type: 'delta', text: 'Done' },
  { type: 'final', text: 'Done.' },
  {
    type: 'usage',
    turns: 3,
    incompleteTurns: 0,
    inputTokens: 10,
    outputTokens: 4,
  },
  { type: 'end' },
]);

/** Fold every event of `events` into a fresh status. */
const foldAll = (events, options) => {
  const fold = makeReplyFold(options);
  const status = fresh();
  let terminal;
  for (const event of events) {
    terminal = fold.apply(status, event) ?? terminal;
  }
  fold.finish(status);
  return { status, terminal };
};

test('a turn folds into finished messages with text split at the tool round and results paired by id', t => {
  const { status, terminal } = foldAll(corpus);
  t.deepEqual(status.messages, [
    {
      role: 'thinking',
      id: 'thinking-1',
      text: 'Plan first.',
      thinking: { startedAt: 1, endedAt: 2, truncated: false },
    },
    { role: 'assistant', text: 'Let me look.' },
    { role: 'tool', id: 'c1', name: 'read', args: '{"path":"a"}', result: 'A' },
    { role: 'tool', id: 'c2', name: 'read', args: '{"path":"b"}', result: 'B' },
    { role: 'assistant', text: 'Done.' },
  ]);
  t.is(status.streamingText, '');
  t.is(status.phase, 'answering');
  t.is(status.error, null);
  t.deepEqual(status.usage, {
    turns: 3,
    incompleteTurns: 0,
    inputTokens: 10,
    outputTokens: 4,
  });
  t.deepEqual(terminal, { type: 'end' });
});

/** The corpus cut short by a failure, after text has started streaming. */
const aborted = harden([
  ...corpus.slice(0, 10),
  { type: 'abort', reason: 'provider gone' },
]);

for (const [name, events] of [
  ['a completed turn', corpus],
  ['an aborted turn', aborted],
]) {
  test(`a view that adopts a snapshot mid-turn converges with one that applied every event of ${name}`, t => {
    for (let cut = 0; cut <= events.length; cut += 1) {
      // The daemon's view: the events up to the cut, then a snapshot of it,
      // frozen the way one arrives over the wire.
      const source = makeReplyFold();
      const status = fresh();
      for (const event of events.slice(0, cut)) source.apply(status, event);
      const snapshot = harden({
        phase: status.phase,
        streamingText: status.streamingText,
        messages: status.messages.map(message => ({ ...message })),
        error: status.error,
        usage: status.usage ? { ...status.usage } : null,
      });
      // The browser's view: adopt the snapshot, then the events after it.
      const viewer = makeReplyFold();
      const held = fresh();
      viewer.adopt(held, snapshot);
      for (const event of events.slice(cut)) viewer.apply(held, event);
      viewer.finish(held);
      // The daemon's own end state, for comparison.
      for (const event of events.slice(cut)) source.apply(status, event);
      source.finish(status);
      t.deepEqual(held, status, `cut at ${cut}`);
    }
  });
}

test('an abort is the terminal event and records its reason; streamed text still becomes a message', t => {
  const fold = makeReplyFold();
  const status = fresh();
  fold.apply(status, { type: 'delta', text: 'Half an ans' });
  const terminal = fold.apply(status, {
    type: 'abort',
    reason: 'provider gone',
  });
  t.deepEqual(terminal, { type: 'abort', reason: 'provider gone' });
  t.is(status.error, 'provider gone');
  fold.finish(status);
  t.deepEqual(status.messages, [{ role: 'assistant', text: 'Half an ans' }]);
});

test('a thinking block that has not ended carries no end time; one that has does', t => {
  const fold = makeReplyFold();
  const status = fresh();
  fold.apply(status, {
    type: 'thinking',
    id: 't',
    text: 'a',
    startedAt: 5,
    truncated: false,
  });
  t.false('endedAt' in (status.messages[0].thinking ?? {}));
  fold.apply(status, {
    type: 'thinking',
    id: 't',
    text: 'b',
    startedAt: 5,
    endedAt: 9,
    truncated: true,
  });
  t.deepEqual(status.messages, [
    {
      role: 'thinking',
      id: 't',
      text: 'ab',
      thinking: { startedAt: 5, endedAt: 9, truncated: true },
    },
  ]);
});

test('a result for a call the fold never saw is ignored; an empty result is a result', t => {
  const fold = makeReplyFold();
  const status = fresh();
  fold.apply(status, {
    type: 'tool_result',
    id: 'ghost',
    name: 'x',
    result: 'never',
  });
  fold.apply(status, { type: 'tool_call', id: 'c', name: 'x', args: '{}' });
  fold.apply(status, { type: 'tool_result', id: 'c', name: 'x', result: '' });
  t.deepEqual(status.messages, [
    { role: 'tool', id: 'c', name: 'x', args: '{}', result: '' },
  ]);
  // Adopted as a snapshot, the settled call is not pending again.
  const viewer = makeReplyFold();
  const held = fresh();
  viewer.adopt(held, { ...status, messages: status.messages });
  viewer.apply(held, {
    type: 'tool_result',
    id: 'c',
    name: 'x',
    result: 'late',
  });
  t.is(held.messages[0].result, '');
});

test('usage is held as the caller projects it, from events and from a snapshot alike', t => {
  const projectUsage = reported => ({
    turns: reported.turns,
    incompleteTurns: reported.incompleteTurns,
    tokens: (reported.inputTokens || 0) + (reported.outputTokens || 0),
  });
  const { status } = foldAll(corpus, { projectUsage });
  t.deepEqual(status.usage, { turns: 3, incompleteTurns: 0, tokens: 14 });
  const viewer = makeReplyFold({ projectUsage });
  const held = fresh();
  viewer.adopt(held, {
    ...fresh(),
    usage: { turns: 1, inputTokens: 2, outputTokens: 3 },
  });
  t.deepEqual(held.usage, { turns: 1, incompleteTurns: undefined, tokens: 5 });
  viewer.adopt(held, fresh());
  t.is(held.usage, null);
});

test('final replaces the streaming text; whitespace-only text is not a message', t => {
  const fold = makeReplyFold();
  const status = fresh();
  fold.apply(status, { type: 'delta', text: '  ' });
  fold.apply(status, { type: 'tool_call', id: 'c', name: 'x', args: '{}' });
  fold.apply(status, { type: 'delta', text: 'draft' });
  fold.apply(status, { type: 'final', text: 'final answer' });
  fold.finish(status);
  t.deepEqual(status.messages, [
    { role: 'tool', id: 'c', name: 'x', args: '{}', result: null },
    { role: 'assistant', text: 'final answer' },
  ]);
});
