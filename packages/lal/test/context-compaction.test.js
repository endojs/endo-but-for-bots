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
    t.deepEqual(context.slice(0, -1), messages.slice(0, 3));
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

test('reports an oversized tail instead of silently dropping it', t => {
  t.throws(() => planContextCompaction(dialogue(), { windowTokens: 50 }), {
    message: /retained tail/,
  });
});

test('a smaller summary must still leave model headroom with tools and tail', async t => {
  const plan = planContextCompaction(dialogue(), { windowTokens: 2000 });
  await t.throwsAsync(
    summarizeContext(plan, async () => ({
      message: { role: 'assistant', content: 'summary '.repeat(300) },
    })),
    { message: /summary and tail exceed/ },
  );
});
