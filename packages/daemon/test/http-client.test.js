import test from '@endo/ses-ava/prepare-endo.js';

import { makeHttpClientKit } from '../src/http-client.js';

/**
 * Create a mock fetch function that records calls and returns
 * configurable responses.
 *
 * @param {object} [responseOverrides]
 * @param {number} [responseOverrides.status]
 * @param {string} [responseOverrides.statusText]
 * @param {boolean} [responseOverrides.ok]
 * @param {string} [responseOverrides.text]
 * @param {Record<string, string>} [responseOverrides.headers]
 */
const makeMockFetch = (responseOverrides = {}) => {
  const calls = [];
  const {
    status = 200,
    statusText = 'OK',
    ok = true,
    text = '{"result":"mock"}',
    headers = { 'content-type': 'application/json' },
  } = responseOverrides;

  const mockFetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      status,
      statusText,
      ok,
      text: async () => text,
      headers: new Map(Object.entries(headers)),
    };
  };
  return { mockFetch, calls };
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

  await t.throwsAsync(
    () => client.fetch('https://evil.example.com/steal'),
    { message: /not in the allowlist/ },
  );
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

test('response truncation respects maxResponseBytes', async t => {
  const longText = 'x'.repeat(1000);
  const { mockFetch } = makeMockFetch({ text: longText });
  const { client } = makeHttpClientKit({
    allowedOrigins: ['https://api.example.com'],
    maxResponseBytes: 100,
    fetchFn: mockFetch,
  });

  const response = await client.fetch('https://api.example.com/big');
  t.is(response.text.length, 100);
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

  await t.throwsAsync(
    () => client.fetch('ftp://files.example.com/data.csv'),
    { message: /Only HTTP and HTTPS/ },
  );
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
