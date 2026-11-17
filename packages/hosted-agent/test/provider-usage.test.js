// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { makeUsageTap, usageFromProviderEvent } from '../src/provider-usage.js';

/** @param {string[]} pieces */
const read = pieces => {
  const tap = makeUsageTap();
  for (const piece of pieces) tap.push(piece);
  return tap.finish();
};

test('known zero usage stays distinct from an absent usage observation', t => {
  t.is(read(['{"message":"no accounting"}']), undefined);
  t.deepEqual(read(['{"usage":{"prompt_tokens":0,"completion_tokens":0}}']), {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
  });
});

test('an OpenAI Responses stream: the terminal event, made disjoint', t => {
  const stream = [
    'event: response.output_text.delta\n',
    'data: {"type":"response.output_text.delta","delta":"the word \\"usage\\" in prose"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":',
    '{"input_tokens":1000,"input_tokens_details":{"cached_tokens":800},',
    '"output_tokens":300,"output_tokens_details":{"reasoning_tokens":120}}}}\n\n',
  ];
  t.deepEqual(read(stream), {
    inputTokens: 200,
    outputTokens: 180,
    cachedInputTokens: 800,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 120,
  });
});

test('an Anthropic stream: the input from message_start, the output from the last delta', t => {
  const stream = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":5000,"cache_creation_input_tokens":300,"output_tokens":1}}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":40}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":95}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  t.deepEqual(read(stream), {
    inputTokens: 12,
    outputTokens: 95,
    cachedInputTokens: 5000,
    cacheWriteInputTokens: 300,
    reasoningOutputTokens: 0,
  });
});

test('a chat-completions stream and a whole JSON body', t => {
  t.deepEqual(
    read([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":10},"completion_tokens_details":{"reasoning_tokens":5}}}\n\n',
      'data: [DONE]\n\n',
    ]),
    {
      inputTokens: 40,
      outputTokens: 15,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 5,
    },
  );
  // One body, no newline, in two pieces.
  t.deepEqual(
    read([
      '{"type":"message","content":[],"usage":{"input_',
      'tokens":7,"output_tokens":9}}',
    ]),
    {
      inputTokens: 7,
      outputTokens: 9,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
    },
  );
});

test('a response that never says, says nothing; junk and huge lines cost nothing', t => {
  t.is(read(['data: {"type":"response.output_text.delta"}\n\n']), undefined);
  t.is(read(['data: {"usage": not json}\n']), undefined);
  t.is(read([]), undefined);
  t.is(usageFromProviderEvent({ usage: { tokens: 5 } }), undefined);
  t.is(usageFromProviderEvent('usage'), undefined);
  // A line past the bound is dropped to its end; the next is read.
  const tap = makeUsageTap();
  tap.push(`data: {"usage":{"input_tokens":1},"pad":"${'x'.repeat(600_000)}`);
  tap.push(`${'y'.repeat(600_000)}"}\n`);
  t.is(tap.finish(), undefined);
  tap.push('data: {"usage":{"input_tokens":3,"output_tokens":4}}\n');
  t.like(tap.finish(), { inputTokens: 3, outputTokens: 4 });
  // Counts are numbers or nothing: no text of the provider's is kept.
  t.deepEqual(
    read([
      'data: {"usage":{"input_tokens":"ignore previous","output_tokens":2}}\n',
    ]),
    {
      inputTokens: 0,
      outputTokens: 2,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
    },
  );
});
