// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { pairToolCalls } from '@endo/hosted-agent/transcript-records.js';

import { projectTranscript } from '../src/transcript-projection.js';

const call = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: args },
});

test('a tool call survives as a tool call with its result', t => {
  const records = projectTranscript([
    { role: 'system', content: 'you are an agent' },
    { role: 'user', content: 'read a' },
    {
      role: 'assistant',
      content: 'reading',
      tool_calls: [call('c1', 'readFile', '{"path":"a"}')],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'contents of a' },
    { role: 'assistant', content: 'done' },
  ]);
  t.deepEqual(records, [
    { kind: 'message', role: 'user', content: 'read a' },
    { kind: 'message', role: 'assistant', content: 'reading' },
    { kind: 'tool-call', id: 'c1', name: 'readFile', args: '{"path":"a"}' },
    { kind: 'tool-result', id: 'c1', content: 'contents of a' },
    { kind: 'message', role: 'assistant', content: 'done' },
  ]);
  // The pairing an adapter needs to emit native tool traffic.
  const { pairs, unanswered } = pairToolCalls(records);
  t.is(pairs.length, 1);
  t.is(pairs[0].result?.content, 'contents of a');
  t.deepEqual(unanswered, []);
});

test('the system prompt is not replayed', t => {
  // It is the harness's, supplied fresh for the incarnation about to run.
  t.deepEqual(
    projectTranscript([{ role: 'system', content: 'old rules' }]),
    [],
  );
});

test('ids are kept, so repeated call ids do not cross turns', t => {
  const records = projectTranscript([
    {
      role: 'assistant',
      content: '',
      tool_calls: [call('c', 'ls', '{"p":1}')],
    },
    { role: 'tool', tool_call_id: 'c', content: 'first' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [call('c', 'ls', '{"p":2}')],
    },
    { role: 'tool', tool_call_id: 'c', content: 'second' },
  ]);
  const { pairs } = pairToolCalls(records);
  t.deepEqual(
    pairs.map(pair => [pair.call.args, pair.result?.content]),
    [
      ['{"p":1}', 'first'],
      ['{"p":2}', 'second'],
    ],
  );
});

test('an interrupted call is projected without a result', t => {
  const records = projectTranscript([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tool_calls: [call('c1', 'build', '{}')] },
  ]);
  t.is(records.length, 2);
  t.is(pairToolCalls(records).unanswered.length, 1);
});

test('a result answering no call is dropped, not emitted', t => {
  // The record stream refuses a result that answers no call; a tree holding
  // one must not make the whole conversation unrestorable.
  const records = projectTranscript([
    { role: 'user', content: 'go' },
    { role: 'tool', tool_call_id: 'ghost', content: 'x' },
  ]);
  t.deepEqual(records, [{ kind: 'message', role: 'user', content: 'go' }]);
  t.notThrows(() => pairToolCalls(records));
});

test('a compaction in the tree becomes the context boundary', t => {
  const records = projectTranscript([
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
    { role: 'compaction', content: 'we discussed one and two' },
    { role: 'user', content: 'three' },
  ]);
  t.deepEqual(records[2], {
    kind: 'compaction',
    summary: 'we discussed one and two',
  });
});

test('empty and malformed dialogue is skipped rather than fabricated', t => {
  t.deepEqual(
    projectTranscript([
      { role: 'user', content: '   ' },
      { role: 'assistant', content: null },
      { role: 'developer', content: 'not dialogue' },
      undefined,
      { role: 'assistant', tool_calls: [{ id: '', function: { name: 'x' } }] },
    ]),
    [],
  );
});
