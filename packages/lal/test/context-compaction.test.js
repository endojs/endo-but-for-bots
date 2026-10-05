// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import {
  planContextCompaction,
  summarizeContext,
} from '../providers/context-compaction.js';

/** @returns {any[]} */
const dialogue = () => [
  { role: 'system', content: 'rules' },
  { role: 'user', content: 'old task '.repeat(500) },
  { role: 'assistant', content: 'completed details '.repeat(500) },
  { role: 'user', content: 'recent' },
  {
    role: 'assistant',
    content: '',
    responsesOutput: {
      model: 'luna',
      items: [{ type: 'reasoning', encrypted_content: 'opaque' }],
    },
    tool_calls: [
      { id: 'call', function: { name: 'runCommand', arguments: '{}' } },
    ],
  },
  { role: 'tool', tool_call_id: 'call', content: 'exit 1', failed: true },
  { role: 'user', content: 'continue' },
];

test('keeps complete recent protocol groups and summarizes only older completed work', async t => {
  const messages = dialogue();
  const plan = planContextCompaction(messages, { force: true });
  if (!plan) throw Error('Expected forced plan');
  t.deepEqual(plan.retained, messages.slice(3));
  const checkpoint = await summarizeContext(plan, async context => {
    t.deepEqual(context[0], messages[0]);
    t.true(context[1].content.includes(messages[1].content));
    t.true(context[1].content.includes(messages[2].content));
    t.true(context[1].content.includes('## Constraints and decisions'));
    t.true(context[1].content.includes('### Blockers and failures'));
    t.true(context[1].content.includes('## Paths and references'));
    t.true(
      context[1].content.includes('previous summary; newer evidence wins'),
    );
    return { message: { role: 'assistant', content: 'old work completed' } };
  });
  t.is(checkpoint.context[0].role, 'system');
  t.is(checkpoint.context[1].role, 'assistant');
  t.deepEqual(checkpoint.context.slice(2), messages.slice(3));
  t.true(
    checkpoint.context[3].responsesOutput.items[0].encrypted_content ===
      'opaque',
  );
});

test('unknown capacity does not become a fake automatic limit', t => {
  t.is(planContextCompaction(dialogue(), { usedTokens: 1_000_000 }), undefined);
  t.truthy(planContextCompaction(dialogue(), { windowTokens: 10_000 }));
  t.is(planContextCompaction(dialogue(), { windowTokens: 100_000 }), undefined);
});

test('does not split or conceal unresolved tool evidence', t => {
  for (const prefix of [
    [{ role: 'assistant', content: '', tool_calls: [{ id: 'x' }] }],
    [{ role: 'tool', content: 'lost', tool_call_id: 'missing' }],
    [{ role: 'tool', content: 'unresolved', outcomeUnknown: true }],
  ]) {
    const messages = dialogue();
    messages.splice(3, 0, ...prefix);
    t.throws(() => planContextCompaction(messages, { force: true }), {
      message: /Compaction|compaction/,
    });
  }
});

test('settled failures can be summarized, and ordinary unknown prose is not an unresolved outcome', t => {
  const messages = dialogue();
  messages.splice(
    3,
    0,
    { role: 'assistant', content: 'unknown route', tool_calls: [{ id: 'x' }] },
    { role: 'tool', tool_call_id: 'x', content: 'known failure', failed: true },
  );
  t.truthy(planContextCompaction(messages, { force: true }));
});

test('rejects tool-producing, empty, cancelled and non-reducing summaries', async t => {
  const plan = planContextCompaction(dialogue(), { force: true });
  for (const message of [
    { role: 'assistant', content: '' },
    { role: 'assistant', content: 'tool', tool_calls: [{ id: 'x' }] },
    { role: 'assistant', content: 'expands '.repeat(3000) },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      summarizeContext(plan, async () => ({ message })),
      {
        message: /Invalid compaction|did not reduce/,
      },
    );
  }
  const controller = new AbortController();
  await t.throwsAsync(
    summarizeContext(
      plan,
      async () => {
        controller.abort(Error('cancelled'));
        return { message: { role: 'assistant', content: 'summary' } };
      },
      controller.signal,
    ),
    { message: /cancelled/ },
  );
});

test('reports oversized instructions and tools instead of silently dropping them', t => {
  t.throws(() => planContextCompaction(dialogue(), { windowTokens: 50 }), {
    message: /instructions and tools/,
  });
  t.throws(
    () =>
      planContextCompaction(dialogue(), {
        windowTokens: 20_000,
        tools: [{ description: 'schema'.repeat(3000) }],
      }),
    { message: /instructions and tools/ },
  );
});

test('a smaller summary must still leave model headroom with tools and tail', async t => {
  const plan = planContextCompaction(
    [{ role: 'user', content: 'run tests' }, ...toolGroup(0), ...toolGroup(1)],
    { windowTokens: 24_000 },
  );
  await t.throwsAsync(
    summarizeContext(plan, async () => ({
      message: { role: 'assistant', content: 'summary '.repeat(2200) },
    })),
    { message: /summary and tail exceed/ },
  );
});

/**
 * @param {number} index
 * @param {number} [size]
 * @returns {any[]}
 */
const toolGroup = (index, size = 2500) => [
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: `a-${index}`,
        function: { name: 'exec', arguments: '{"command":"build"}' },
      },
      {
        id: `b-${index}`,
        function: { name: 'exec', arguments: '{"command":"test"}' },
      },
    ],
    responsesOutput: {
      model: 'luna',
      items: [{ type: 'reasoning', encrypted_content: `opaque-${index}` }],
    },
  },
  {
    role: 'tool',
    tool_call_id: `b-${index}`,
    content: `start-${index} ${'log '.repeat(size)} end-${index}`,
    failed: true,
  },
  { role: 'tool', tool_call_id: `a-${index}`, content: 'build complete' },
];

test('compacts within the first turn, keeping parallel tools, opaque tail and directive intact', async t => {
  const system = { role: 'system', content: 'rules' };
  const directive = {
    role: 'user',
    content: 'Install dependencies and run all tests; failures are fine.',
  };
  const groups = Array.from({ length: 8 }, (_, index) => toolGroup(index));
  const messages = [system, directive, ...groups.flat()];
  const plan = planContextCompaction(messages, { windowTokens: 40_000 });
  if (!plan) throw Error('Expected first-turn plan');
  t.deepEqual(plan.retained, [directive, ...groups[7]]);
  const checkpoint = await summarizeContext(plan, async request => {
    t.true(
      new TextEncoder().encode(JSON.stringify({ messages: request, tools: [] }))
        .length < 28_000,
    );
    t.false(JSON.stringify(request).includes('encrypted_content'));
    t.true(request[1].content.includes('characters omitted'));
    t.true(request[1].content.includes('start-0'));
    t.true(request[1].content.includes('end-0'));
    t.true(request[1].content.includes('failed'));
    return {
      message: {
        role: 'assistant',
        content:
          'Dependencies installed. Tests are still running; preserve failures.',
      },
    };
  });
  t.deepEqual(checkpoint.context, [
    system,
    { role: 'assistant', content: checkpoint.summary },
    directive,
    ...groups[7],
  ]);
  t.is(checkpoint.context.filter(message => message === directive).length, 1);
  t.true(messages[3].content.includes('log '.repeat(2500)));
});

test('an oversized completed tool group is summarized with bounded excerpts, not split', async t => {
  const messages = [
    { role: 'user', content: 'run tests' },
    ...toolGroup(0, 50_000),
  ];
  const plan = planContextCompaction(messages, { windowTokens: 12_000 });
  if (!plan) throw Error('Expected oversized-tool plan');
  t.deepEqual(plan.retained, [messages[0]]);
  let invoked = false;
  const checkpoint = await summarizeContext(plan, async request => {
    invoked = true;
    t.true(JSON.stringify(request).length < 8400);
    t.true(request[0].content.includes('start-0'));
    t.true(request[0].content.includes('end-0'));
    t.true(request[0].content.includes('"failed":true'));
    return {
      message: {
        role: 'assistant',
        content:
          'Build completed; tests failed. Inspect the durable log, do not rerun merely to reconstruct it.',
      },
    };
  });
  t.true(invoked);
  t.true(checkpoint.summary.includes('failed'));
  t.is(messages[2].content.length, 200_014);
});

test('force can start on the first tool round but not an unworked directive', t => {
  const input = { role: 'user', content: 'do work' };
  t.is(planContextCompaction([input], { force: true }), undefined);
  t.truthy(planContextCompaction([input, ...toolGroup(0)], { force: true }));
});

test('rejects unsafe evidence anywhere in the selected context', t => {
  const base = [{ role: 'user', content: 'work' }, ...toolGroup(0)];
  for (const suffix of [
    [{ role: 'assistant', content: '', tool_calls: [{ id: 'pending' }] }],
    [{ role: 'tool', content: 'orphan', tool_call_id: 'absent' }],
    toolGroup(1).map(message =>
      message.role === 'tool' ? { ...message, outcomeUnknown: true } : message,
    ),
  ]) {
    t.throws(
      () => planContextCompaction([...base, ...suffix], { force: true }),
      { message: /Compaction|compaction/ },
    );
  }
});

test('repeated compaction carries prior summaries forward and resets context occupancy', async t => {
  const directive = { role: 'user', content: 'complete the task' };
  const initial = [directive, ...toolGroup(0), ...toolGroup(1)];
  const first = await summarizeContext(
    planContextCompaction(initial, { windowTokens: 24_000 }),
    async () => ({
      message: { role: 'assistant', content: 'Earlier decisions must remain.' },
    }),
  );
  const expanded = [...first.context, ...toolGroup(2), ...toolGroup(3)];
  const second = await summarizeContext(
    planContextCompaction(expanded, { windowTokens: 24_000 }),
    async request => {
      t.true(request[0].content.includes(first.summary));
      return {
        message: {
          role: 'assistant',
          content: 'Earlier decisions remain; more tools completed.',
        },
      };
    },
  );
  t.is(second.retained.filter(message => message === directive).length, 1);
  t.is(
    planContextCompaction(second.context, { windowTokens: 24_000 }),
    undefined,
  );
});

test('oversized non-tool summary input fails before dispatch, and cancellation does too', async t => {
  const plan = planContextCompaction(dialogue(), { windowTokens: 2000 });
  let invoked = false;
  const invoke = async () => {
    invoked = true;
    return {};
  };
  await t.throwsAsync(summarizeContext(plan, invoke), {
    message: /summary input exceeds/,
  });
  t.false(invoked);
  const controller = new AbortController();
  controller.abort(Error('cancelled before summary'));
  await t.throwsAsync(summarizeContext(plan, invoke, controller.signal), {
    message: /cancelled before/,
  });
  t.false(invoked);
});
