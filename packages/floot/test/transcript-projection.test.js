// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { pairToolCalls } from '@endo/hosted-agent/transcript-records.js';

import {
  projectTranscript,
  recoverTurnTranscript,
  transcriptToProviderMessages,
} from '../src/transcript-projection.js';

test('provider projection pairs repeated IDs and preserves full tool arguments', t => {
  const args = JSON.stringify({ text: 'x'.repeat(9000) });
  const messages = transcriptToProviderMessages([
    { kind: 'tool-call', id: 'same', name: 'first', args },
    { kind: 'tool-result', id: 'same', content: 'first result' },
    { kind: 'tool-call', id: 'same', name: 'second', args: '{}' },
    { kind: 'tool-result', id: 'same', content: 'second result' },
    { kind: 'tool-call', id: 'pending', name: 'third', args: '{}' },
  ]);
  t.is(messages[0].tool_calls[0].function.arguments, args);
  t.not(messages[0].tool_calls[0].id, messages[2].tool_calls[0].id);
  t.is(messages[1].content, 'first result');
  t.is(messages[3].content, 'second result');
  t.regex(messages[5].content, /outcome unknown; do not automatically retry/);
});

test('provider projection does not settle an earlier turn with a reused native ID', t => {
  const messages = transcriptToProviderMessages([
    { kind: 'message', role: 'user', content: 'First turn' },
    { kind: 'tool-call', id: 'same', name: 'first', args: '{}' },
    { kind: 'message', role: 'user', content: 'Second turn' },
    { kind: 'tool-call', id: 'same', name: 'second', args: '{}' },
    { kind: 'tool-call', id: 'parallel', name: 'parallel', args: '{}' },
    { kind: 'tool-result', id: 'parallel', content: 'parallel result' },
    { kind: 'tool-result', id: 'same', content: 'second result' },
  ]);
  const results = messages.filter(message => message.role === 'tool');
  t.regex(results[0].content, /outcome unknown; do not automatically retry/);
  t.is(results[1].content, 'second result');
  t.is(results[2].content, 'parallel result');
});

const call = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: args },
});

test('failed transcript recovers full executor evidence and terminal error', async t => {
  const args = JSON.stringify({ code: 'x'.repeat(14_934) });
  const turn = {
    turnId: '7',
    state: 'failed',
    input: 'draw a ship',
    error: 'Bounded reader queue capacity exceeded',
    activity: [],
    tools: [
      {
        callId: 'floot-tool-1',
        name: 'exec',
        args: args.slice(0, 100),
        argsRef: 'args',
        result: 'Created pirate ship scene',
        settled: true,
      },
    ],
  };
  const records = await recoverTurnTranscript(
    [
      { role: 'user', content: turn.input },
      { role: 'assistant', content: 'Drawing it.' },
    ],
    turn,
    async ref => {
      t.is(ref, 'args');
      return args;
    },
  );
  const { pairs } = pairToolCalls(records);
  t.is(pairs.length, 1);
  t.is(pairs[0].call.args, args);
  t.is(pairs[0].result?.content, 'Created pirate ship scene');
  t.like(records.at(-1), {
    kind: 'message',
    content: '[Floot turn failed: Bounded reader queue capacity exceeded]',
  });
  t.true(
    records.some(
      record =>
        record.kind === 'message' &&
        record.content.includes('position relative'),
    ),
  );
});

test('recovery settles the unanswered call of a repeated id and keeps the other answer', async t => {
  const turn = {
    turnId: '1',
    state: 'failed',
    input: 'go',
    activity: [],
    tools: [
      { callId: 'h', name: 'exec', args: '{}', result: 'y', settled: true },
    ],
  };
  const records = await recoverTurnTranscript(
    [
      { role: 'user', content: 'go' },
      { role: 'assistant', tool_calls: [call('c', 'exec', '{}')] },
      { role: 'tool', tool_call_id: 'c', content: 'x' },
      { role: 'assistant', tool_calls: [call('c', 'exec', '{}')] },
    ],
    turn,
    async () => '',
  );
  t.deepEqual(
    records
      .filter(record => record.kind === 'tool-result')
      .map(record => record.content),
    ['x', 'y'],
  );
  t.deepEqual(
    pairToolCalls(records).pairs.map(pair => pair.result?.content),
    ['x', 'y'],
  );
});

test('recovery matches repeated observations and executions one to one', async t => {
  const tool = { name: 'exec', args: '{}', result: 'ok', settled: true };
  const turn = {
    turnId: '1',
    state: 'completed',
    input: 'go',
    activity: [
      { ...tool, callId: 'a' },
      { ...tool, callId: 'b' },
    ],
    tools: [
      { ...tool, callId: 'x' },
      { ...tool, callId: 'y' },
    ],
  };
  const messages = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      tool_calls: [call('a', 'exec', '{}'), call('b', 'exec', '{}')],
    },
    { role: 'tool', tool_call_id: 'a', content: 'ok' },
    { role: 'tool', tool_call_id: 'b', content: 'ok' },
  ];
  t.deepEqual(
    await recoverTurnTranscript(messages, turn, async () => ''),
    projectTranscript(messages),
  );
  const recovered = await recoverTurnTranscript([], turn, async () => '');
  t.is(pairToolCalls(recovered).pairs.length, 2);
});

test('an interrupted call remains unanswered unless durable evidence settles it', async t => {
  const tool = { callId: 'a', name: 'exec', args: '{}' };
  const turn = {
    turnId: '1',
    state: 'outcome-unknown',
    input: 'go',
    activity: [tool],
    tools: [],
  };
  const messages = [
    { role: 'user', content: 'go' },
    { role: 'assistant', tool_calls: [call('a', 'exec', '{}')] },
  ];
  t.is(
    pairToolCalls(await recoverTurnTranscript(messages, turn, async () => ''))
      .unanswered.length,
    1,
  );
  const settled = await recoverTurnTranscript(
    messages,
    {
      ...turn,
      tools: [{ ...tool, callId: 'x', settled: true, result: 'done' }],
    },
    async () => '',
  );
  t.is(pairToolCalls(settled).pairs[0].result?.content, 'done');
});

test('reordered observations settle native identities, not identical arguments', async t => {
  const messages = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      tool_calls: [
        call('a', 'exec', '{}'),
        call('b', 'exec', '{}'),
        call('c', 'exec', '{}'),
      ],
    },
  ];
  const base = { name: 'exec', args: '{}', settled: true };
  const turn = {
    turnId: '1',
    input: 'go',
    state: 'outcome-unknown',
    activity: [
      { ...base, callId: 'b', result: 'second' },
      { ...base, callId: 'a', result: 'first' },
      { ...base, callId: 'c', settled: false },
    ],
    tools: [
      { ...base, callId: 'x', result: 'second' },
      { ...base, callId: 'y', result: 'first' },
    ],
  };
  const { pairs, unanswered } = pairToolCalls(
    await recoverTurnTranscript(messages, turn, async () => ''),
  );
  t.deepEqual(
    pairs.map(pair => [pair.call.id, pair.result?.content]),
    [
      ['a', 'first'],
      ['b', 'second'],
      ['c', undefined],
    ],
  );
  t.is(unanswered.length, 1);
});

test('Claude Endo MCP observations do not duplicate executor evidence', async t => {
  const args = [
    JSON.stringify({ code: 'x'.repeat(13_429) }),
    JSON.stringify({ code: 'y'.repeat(456) }),
  ];
  const results = ['Created pirate ship scene!!', 'a'.repeat(278)];
  const activity = args.map((text, index) => ({
    callId: `native-${index}`,
    name: 'mcp__endo__exec',
    args: text,
    result: results[index],
    settled: true,
  }));
  const messages = [
    { role: 'user', content: 'draw a scene' },
    ...activity.flatMap(tool => [
      {
        role: 'assistant',
        tool_calls: [call(tool.callId, tool.name, tool.args)],
      },
      { role: 'tool', tool_call_id: tool.callId, content: tool.result },
    ]),
  ];
  const turn = {
    turnId: '1',
    input: 'draw a scene',
    state: 'completed',
    activity,
    tools: activity.map((tool, index) => ({
      ...tool,
      callId: `executor-${index}`,
      name: 'exec',
    })),
  };
  const records = await recoverTurnTranscript(messages, turn, async () => '');
  t.deepEqual(records, projectTranscript(messages));
  t.is(pairToolCalls(records).pairs.length, 2);
  const unrelated = {
    ...turn,
    tools: [{ ...turn.tools[0], name: 'other_exec' }],
  };
  t.is(
    pairToolCalls(
      await recoverTurnTranscript(messages, unrelated, async () => ''),
    ).pairs.length,
    3,
  );
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

test("a second result for one call, and a result under an earlier turn's id, are dropped", t => {
  // The pairing is per turn and one to one on both sides of the record
  // stream; the projection emits only what that pairing can place, so a tree
  // holding a doubled or a late result still replays and restores.
  const records = projectTranscript([
    { role: 'user', content: 'one' },
    { role: 'assistant', content: '', tool_calls: [call('c1', 'read', '{}')] },
    { role: 'tool', tool_call_id: 'c1', content: 'first' },
    { role: 'tool', tool_call_id: 'c1', content: 'again' },
    { role: 'user', content: 'two' },
    { role: 'tool', tool_call_id: 'c1', content: 'late' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [call('c1', 'read', '{}'), call('c1', 'read', '{}')],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'second turn, first call' },
    { role: 'tool', tool_call_id: 'c1', content: 'second turn, second call' },
    { role: 'tool', tool_call_id: 'c1', content: 'a third answer' },
    { role: 'assistant', content: 'done' },
  ]);
  t.deepEqual(
    records
      .filter(record => record.kind === 'tool-result')
      .map(record => record.content),
    ['first', 'second turn, first call', 'second turn, second call'],
  );
  t.notThrows(() => pairToolCalls(records));
  const replay = transcriptToProviderMessages(records);
  t.deepEqual(
    replay.filter(message => message.role === 'tool').map(m => m.content),
    ['first', 'second turn, first call', 'second turn, second call'],
  );
});

test('projection refuses an incomplete checkpoint before dropping its later result', t => {
  t.throws(
    () =>
      projectTranscript([
        {
          role: 'compaction',
          content: 'summary',
          retainedTail: [
            { kind: 'tool-call', id: 'c', name: 'read', args: '{}' },
          ],
        },
        { role: 'tool', tool_call_id: 'c', content: 'known result' },
      ]),
    { message: /settled tool calls/ },
  );
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
  t.deepEqual(transcriptToProviderMessages(records), [
    { role: 'assistant', content: 'we discussed one and two' },
    { role: 'user', content: 'three' },
  ]);
});

test('provider replay selects only the last compaction and pairs tools inside it', t => {
  const records = projectTranscript([
    { role: 'user', content: 'superseded request' },
    { role: 'assistant', tool_calls: [call('same', 'old', '{}')] },
    { role: 'tool', tool_call_id: 'same', content: 'superseded result' },
    { role: 'compaction', content: 'superseded summary' },
    { role: 'assistant', tool_calls: [call('same', 'also-old', '{}')] },
    { role: 'compaction', content: 'current summary' },
    { role: 'user', content: 'continue' },
    { role: 'assistant', tool_calls: [call('same', 'current', '{"x":1}')] },
    { role: 'tool', tool_call_id: 'same', content: 'current result' },
    { role: 'assistant', tool_calls: [call('unknown', 'uncertain', '{}')] },
  ]);
  const before = JSON.stringify(records);
  const replay = transcriptToProviderMessages(records);
  t.deepEqual(replay.slice(0, 2), [
    { role: 'assistant', content: 'current summary' },
    { role: 'user', content: 'continue' },
  ]);
  t.deepEqual(
    replay
      .filter(message => message.tool_calls)
      .map(message => message.tool_calls[0].function.name),
    ['current', 'uncertain'],
  );
  const results = replay.filter(message => message.role === 'tool');
  t.is(results[0].content, 'current result');
  t.regex(results[1].content, /outcome unknown; do not automatically retry/);
  t.false(JSON.stringify(replay).includes('superseded'));
  t.is(JSON.stringify(records), before, 'stored history remains unchanged');
});

test('provider replay refuses a result whose call was superseded by compaction', t => {
  t.throws(
    () =>
      transcriptToProviderMessages([
        { kind: 'tool-call', id: 'old', name: 'old', args: '{}' },
        { kind: 'compaction', summary: 'boundary' },
        { kind: 'tool-result', id: 'old', content: 'late result' },
      ]),
    { message: /answers no call/ },
  );
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

test('direct-provider replay keeps the explicit tail after the summary', t => {
  t.deepEqual(
    transcriptToProviderMessages([
      { kind: 'message', role: 'user', content: 'superseded' },
      {
        kind: 'compaction',
        summary: 'head summary',
        retainedTail: [
          { kind: 'message', role: 'user', content: 'recent request' },
          { kind: 'tool-call', id: 'c', name: 'read', args: '{}' },
          {
            kind: 'tool-result',
            id: 'c',
            content: '[Old tool result content cleared]',
          },
        ],
      },
      { kind: 'message', role: 'user', content: 'continue' },
    ]),
    [
      { role: 'assistant', content: 'head summary' },
      { role: 'user', content: 'recent request' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'floot-history-2',
            type: 'function',
            function: { name: 'read', arguments: '{}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'floot-history-2',
        content: '[Old tool result content cleared]',
      },
      { role: 'user', content: 'continue' },
    ],
  );
});

test('a compaction segment reaches the tree in its own place', t => {
  // The shape `agent.js` writes for a `compaction` segment, projected back
  // out: a turn that compacted mid-way keeps the boundary between the text
  // that preceded it and the turn that followed.
  const records = projectTranscript([
    { role: 'user', content: 'a long conversation' },
    { role: 'assistant', content: 'working' },
    { role: 'compaction', content: 'summary of everything so far' },
    { role: 'assistant', content: 'continuing' },
  ]);
  t.deepEqual(
    records.map(record => record.kind),
    ['message', 'message', 'compaction', 'message'],
  );
});
