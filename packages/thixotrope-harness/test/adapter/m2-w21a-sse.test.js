// @ts-check
// M2 W2.1a: the SSE parser (resources/agent-host/impl/providers/sse.js) and
// token usage (guest/lib/token-usage.js). Node only.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import {
  parseSse,
  SseError,
  sseErrors,
} from '../../resources/agent-host/impl/providers/sse.js';
/* eslint-disable import/no-relative-packages */
import {
  addUsage,
  emptyUsage,
  tokenCount,
  usageFromAnthropic,
  usageFromOpenRouter,
} from '../../guest/lib/token-usage.js';
import { shapes } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */

const { matches } = /** @type {any} */ (globalThis);

const encoder = new TextEncoder();

/**
 * @param {Array<string | Uint8Array>} pieces
 * @param {Parameters<typeof parseSse>[1]} [options]
 */
const parse = async (pieces, options) => {
  const out = [];
  for await (const event of parseSse(
    pieces.map(p => (typeof p === 'string' ? encoder.encode(p) : p)),
    options,
  )) {
    out.push(event);
  }
  return out;
};

test('events dispatch on a blank line whatever the chunk boundaries', async t => {
  const text =
    ': keep-alive\n\ndata: {"a":1}\n\nevent: ping\ndata: x\ndata: y\n\ndata:nospace\n\ndata: [DONE]\n\n';
  const whole = await parse([text]);
  t.deepEqual(whole, [
    { data: '{"a":1}' },
    { event: 'ping', data: 'x\ny' },
    { data: 'nospace' },
    { data: '[DONE]' },
  ]);
  // Every split point, one byte at a time, and in two halves.
  t.deepEqual(await parse([...text]), whole);
  for (let cut = 1; cut < text.length; cut += 7) {
    // eslint-disable-next-line no-await-in-loop
    t.deepEqual(await parse([text.slice(0, cut), text.slice(cut)]), whole);
  }
});

test('CRLF, CR and LF all end lines, also when CRLF is split across chunks', async t => {
  const expected = [{ data: 'a' }, { data: 'b' }, { data: 'c' }];
  t.deepEqual(await parse(['data: a\r\n\r\ndata: b\r\rdata: c\n\n']), expected);
  t.deepEqual(
    await parse(['data: a\r', '\n\r', '\ndata: b\r', '\r', 'data: c\n', '\n']),
    expected,
  );
  // A CR that ends the stream is a line end.
  t.deepEqual(await parse(['data: z\r\r']), [{ data: 'z' }]);
});

test('ignored fields, a field without a colon, and a multi-byte character split across chunks', async t => {
  const bytes = encoder.encode('id: 7\nretry: 10\ndata\ndata: é\u{1F600}\n\n');
  const at = bytes.length - 5;
  t.deepEqual(await parse([bytes.slice(0, at), bytes.slice(at)]), [
    { data: '\né\u{1F600}' },
  ]);
});

test('a stream cut inside an event, invalid UTF-8 and oversize lines or events fail with fixed texts', async t => {
  /** @param {Promise<unknown>} p @param {string} message */
  const fails = async (p, message) => {
    const error = await t.throwsAsync(p);
    t.true(error instanceof SseError);
    t.is(error?.message, message);
  };
  await fails(parse(['data: {"partial":']), sseErrors.truncated);
  await fails(parse(['data: a\n']), sseErrors.truncated);
  await fails(
    parse([new Uint8Array([0x64, 0x61, 0xff, 0x0a])]),
    sseErrors.invalidUtf8,
  );
  await fails(
    parse(['data: ', 'x'.repeat(100), 'y'.repeat(100)], { maxLineUnits: 150 }),
    sseErrors.lineTooLong,
  );
  await fails(
    parse(['data: aaaa\ndata: bbbb\ndata: cccc\n\n'], { maxEventUnits: 10 }),
    sseErrors.eventTooLarge,
  );
  // Trailing blank text after the last event is fine.
  t.deepEqual(await parse(['data: a\n\n', '\n']), [{ data: 'a' }]);
});

test('a 4 MiB line in 64 KiB chunks parses in linear time', async t => {
  const line = `data: ${'q'.repeat(4 * 1024 * 1024)}\n\n`;
  const bytes = encoder.encode(line);
  /** @type {Uint8Array[]} */
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 65_536)
    chunks.push(bytes.slice(i, i + 65_536));
  const t0 = performance.now();
  const events = await parse(chunks);
  const ms = performance.now() - t0;
  t.is(events.length, 1);
  t.is(events[0].data.length, 4 * 1024 * 1024);
  t.true(ms < 2000, `took ${ms} ms`);
});

test('token usage: OpenRouter counts are made disjoint; Anthropic counts are kept; sums keep the newer reading', t => {
  const a = usageFromOpenRouter({
    prompt_tokens: 100,
    completion_tokens: 40,
    prompt_tokens_details: { cached_tokens: 30 },
    completion_tokens_details: { reasoning_tokens: 10 },
  });
  t.deepEqual(a, {
    inputTokens: 70,
    outputTokens: 30,
    cachedInputTokens: 30,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 10,
    context: { usedTokens: 140, windowTokens: 0 },
  });
  t.true(matches(a, shapes.Usage));
  const b = usageFromAnthropic(
    {
      input_tokens: 5,
      output_tokens: 6,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 8,
    },
    200_000,
  );
  t.deepEqual(b, {
    inputTokens: 5,
    outputTokens: 6,
    cachedInputTokens: 7,
    cacheWriteInputTokens: 8,
    reasoningOutputTokens: 0,
    context: { usedTokens: 26, windowTokens: 200_000 },
  });
  t.true(matches(b, shapes.Usage));
  const sum = addUsage(b, a);
  t.is(sum.inputTokens, 75);
  t.deepEqual(sum.context, { usedTokens: 140, windowTokens: 200_000 });
  t.deepEqual(usageFromOpenRouter(null), emptyUsage());
  t.deepEqual(
    usageFromOpenRouter({ prompt_tokens: -3, completion_tokens: 'x' }),
    emptyUsage(),
  );
  t.is(tokenCount('12'), 12);
  t.is(tokenCount(true), 0);
  t.is(tokenCount(2.9), 2);
});
