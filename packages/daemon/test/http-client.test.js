// @ts-nocheck
import test from '@endo/ses-ava/prepare-endo.js';

import { makeHttpClientKit } from '../src/http-client.js';

const textEncoder = new TextEncoder();

/**
 * Build a ReadableStream that emits the supplied chunks (each a
 * string, encoded as UTF-8 bytes) one at a time, in order.  Records
 * which chunks were actually emitted before the consumer cancels
 * the stream so tests can assert that streaming truncation abandons
 * the upstream early.
 *
 * @param {string[]} chunks
 */
const makeChunkedBody = chunks => {
  const emitted = [];
  let cancelled = false;
  let cancelReason;
  let i = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[i];
      i += 1;
      emitted.push(chunk);
      controller.enqueue(textEncoder.encode(chunk));
    },
    cancel(reason) {
      cancelled = true;
      cancelReason = reason;
    },
  });
  return {
    stream,
    inspect: () => ({ emitted, cancelled, cancelReason }),
  };
};

/**
 * Create a mock fetch function that records calls and returns
 * configurable responses.  When `chunks` is supplied the response
 * body is exposed as a ReadableStream (so the production
 * streaming reader can exercise it); otherwise the body is the
 * single-chunk encoding of `text`.
 *
 * @param {object} [responseOverrides]
 * @param {number} [responseOverrides.status]
 * @param {string} [responseOverrides.statusText]
 * @param {boolean} [responseOverrides.ok]
 * @param {string} [responseOverrides.text]
 * @param {string[]} [responseOverrides.chunks]
 * @param {Record<string, string>} [responseOverrides.headers]
 */
const makeMockFetch = (responseOverrides = {}) => {
  const calls = [];
  const {
    status = 200,
    statusText = 'OK',
    ok = true,
    text = '{"result":"mock"}',
    chunks,
    headers = { 'content-type': 'application/json' },
  } = responseOverrides;

  const bodySpec = chunks !== undefined ? makeChunkedBody(chunks) : null;

  const mockFetch = async (url, opts) => {
    calls.push({ url, opts });
    const body =
      bodySpec !== null
        ? bodySpec.stream
        : new ReadableStream({
            start(controller) {
              controller.enqueue(textEncoder.encode(text));
              controller.close();
            },
          });
    return {
      status,
      statusText,
      ok,
      body,
      headers: new Map(Object.entries(headers)),
    };
  };
  return {
    mockFetch,
    calls,
    inspectBody: () => (bodySpec !== null ? bodySpec.inspect() : null),
  };
};

test('fetch to allowed origin succeeds', async t => {
  const { mockFetch, calls } = makeMockFetch();
  const { client } = makeHttpClientKit({
    allowedOrigins: ['https://api.example.com'],
    fetchFn: mockFetch,
  });

  const response = await client.fetch('https://api.example.com/data');
  t.is(response.status, 200);
  t.is(response.ok, true);
  t.is(response.text, '{"result":"mock"}');
  t.is(calls.length, 1);
  t.is(calls[0].url, 'https://api.example.com/data');
});

test('fetch to disallowed origin throws', async t => {
  const { mockFetch } = makeMockFetch();
  const { client } = makeHttpClientKit({
    allowedOrigins: ['https://api.example.com'],
    fetchFn: mockFetch,
  });

  await t.throwsAsync(() => client.fetch('https://evil.example.com/steal'), {
    message: /not in the allowlist/,
  });
});

test('fetch with options passes method, headers, body', async t => {
  const { mockFetch, calls } = makeMockFetch();
  const { client } = makeHttpClientKit({
    allowedOrigins: ['https://api.example.com'],
    fetchFn: mockFetch,
  });

  await client.fetch('https://api.example.com/post', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"key":"value"}',
  });

  t.is(calls[0].opts.method, 'POST');
  t.deepEqual(calls[0].opts.headers, { 'content-type': 'application/json' });
  t.is(calls[0].opts.body, '{"key":"value"}');
});

test('allowedOrigins returns the current allowlist', t => {
  const { mockFetch } = makeMockFetch();
  const { client } = makeHttpClientKit({
    allowedOrigins: ['https://a.com', 'https://b.com'],
    fetchFn: mockFetch,
  });

  const origins = client.allowedOrigins();
  t.true(origins.includes('https://a.com'));
  t.true(origins.includes('https://b.com'));
});

test('control setAllowedOrigins updates the allowlist', async t => {
  const { mockFetch } = makeMockFetch();
  const { client, control } = makeHttpClientKit({
    allowedOrigins: ['https://old.com'],
    fetchFn: mockFetch,
  });

  // Old origin works
  await client.fetch('https://old.com/api');

  // Update origins
  control.setAllowedOrigins(['https://new.com']);

  // Old origin now blocked
  await t.throwsAsync(() => client.fetch('https://old.com/api'), {
    message: /not in the allowlist/,
  });

  // New origin works
  await client.fetch('https://new.com/api');
  t.pass();
});

test('control revoke makes client inert', async t => {
  const { mockFetch } = makeMockFetch();
  const { client, control } = makeHttpClientKit({
    allowedOrigins: ['https://api.example.com'],
    fetchFn: mockFetch,
  });

  // Works before revoke
  await client.fetch('https://api.example.com/ok');

  control.revoke();

  await t.throwsAsync(() => client.fetch('https://api.example.com/ok'), {
    message: /revoked/,
  });
});

test('rate limiting enforces requests per minute', async t => {
  const { mockFetch } = makeMockFetch();
  const { client } = makeHttpClientKit({
    allowedOrigins: ['https://api.example.com'],
    maxRequestsPerMinute: 3,
    fetchFn: mockFetch,
  });

  await client.fetch('https://api.example.com/1');
  await client.fetch('https://api.example.com/2');
  await client.fetch('https://api.example.com/3');

  await t.throwsAsync(() => client.fetch('https://api.example.com/4'), {
    message: /Rate limit exceeded/,
  });
});

test('response truncation respects maxResponseBytes (single chunk)', async t => {
  const longText = 'x'.repeat(1000);
  const { mockFetch } = makeMockFetch({ text: longText });
  const { client } = makeHttpClientKit({
    allowedOrigins: ['https://api.example.com'],
    maxResponseBytes: 100,
    fetchFn: mockFetch,
  });

  const response = await client.fetch('https://api.example.com/big');
  t.is(response.text.length, 100);
  t.true(response.truncated);
  t.is(response.maxResponseBytes, 100);
});

test('response truncation aborts upstream before reading full body', async t => {
  // Five 200-byte chunks (1000 bytes total).  Cap at 250 bytes:
  // production code should accept chunk 1, accept the 50-byte prefix
  // of chunk 2, then cancel the upstream so chunks 3-5 never emit.
  const chunks = [
    'a'.repeat(200),
    'b'.repeat(200),
    'c'.repeat(200),
    'd'.repeat(200),
    'e'.repeat(200),
  ];
  const { mockFetch, inspectBody } = makeMockFetch({ chunks });
  const { client } = makeHttpClientKit({
    allowedOrigins: ['https://api.example.com'],
    maxResponseBytes: 250,
    fetchFn: mockFetch,
  });

  const response = await client.fetch('https://api.example.com/stream');
  t.is(
    response.text.length,
    250,
    'returned text is exactly the maxResponseBytes prefix',
  );
  t.true(response.truncated, 'truncated flag is surfaced to the caller');
  t.is(
    response.text,
    'a'.repeat(200) + 'b'.repeat(50),
    'the kept prefix is the first cap-bytes of the stream',
  );

  const inspect = inspectBody();
  t.true(
    inspect.cancelled,
    'reader.cancel() must propagate to the upstream stream',
  );
  t.deepEqual(
    inspect.emitted,
    ['a'.repeat(200), 'b'.repeat(200)],
    'only the first two chunks should be pulled before the cap halts ' +
      'the read; the remaining three chunks must never have been emitted, ' +
      'because a malicious origin could otherwise exhaust memory',
  );
});

test('truncated=false when response fits under the cap', async t => {
  const { mockFetch } = makeMockFetch({ text: 'short' });
  const { client } = makeHttpClientKit({
    allowedOrigins: ['https://api.example.com'],
    maxResponseBytes: 1000,
    fetchFn: mockFetch,
  });
  const response = await client.fetch('https://api.example.com/ok');
  t.is(response.text, 'short');
  t.false(response.truncated);
  t.is(response.maxResponseBytes, 1000);
});

test('control setMaxRequestsPerMinute validates', t => {
  const { mockFetch } = makeMockFetch();
  const { control } = makeHttpClientKit({
    allowedOrigins: [],
    fetchFn: mockFetch,
  });

  control.setMaxRequestsPerMinute(10);
  t.throws(() => control.setMaxRequestsPerMinute(0), {
    message: /must be >= 1/,
  });
});

test('control setMaxResponseBytes validates', t => {
  const { mockFetch } = makeMockFetch();
  const { control } = makeHttpClientKit({
    allowedOrigins: [],
    fetchFn: mockFetch,
  });

  control.setMaxResponseBytes(5000);
  t.throws(() => control.setMaxResponseBytes(0), {
    message: /must be >= 1/,
  });
});

test('fetch rejects non-HTTP protocols', async t => {
  const { mockFetch } = makeMockFetch();
  const { client } = makeHttpClientKit({
    allowedOrigins: ['ftp://files.example.com'],
    fetchFn: mockFetch,
  });

  await t.throwsAsync(() => client.fetch('ftp://files.example.com/data.csv'), {
    message: /Only HTTP and HTTPS/,
  });
});

test('help returns documentation', t => {
  const { mockFetch } = makeMockFetch();
  const { client, control } = makeHttpClientKit({
    allowedOrigins: ['https://api.example.com'],
    fetchFn: mockFetch,
  });

  t.true(client.help().includes('HttpClient'));
  t.true(client.help().includes('api.example.com'));
  t.true(control.help().includes('HttpClientControl'));
});

test('response includes headers', async t => {
  const { mockFetch } = makeMockFetch({
    headers: { 'x-custom': 'test-value' },
  });
  const { client } = makeHttpClientKit({
    allowedOrigins: ['https://api.example.com'],
    fetchFn: mockFetch,
  });

  const response = await client.fetch('https://api.example.com/data');
  t.is(response.headers['x-custom'], 'test-value');
});
