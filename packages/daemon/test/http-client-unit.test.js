// @ts-nocheck

import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/far';
import {
  makeHttpClient,
  makeHttpController,
  parseAllowedOrigin,
  parseAllowedOrigins,
} from '../src/http-client.js';

test('parseAllowedOrigin normalizes to URL.origin', t => {
  t.is(
    parseAllowedOrigin('https://api.example.com/path?q=1'),
    'https://api.example.com',
    'origin should drop path/query',
  );
  t.is(
    parseAllowedOrigin('http://example.com:8080'),
    'http://example.com:8080',
    'origin preserves explicit non-default ports',
  );
});

test('parseAllowedOrigin rejects non-http(s) schemes at config time', t => {
  t.throws(() => parseAllowedOrigin('file:///etc/passwd'), {
    message: /must use http: or https:/,
  });
  t.throws(() => parseAllowedOrigin('ftp://example.com'), {
    message: /must use http: or https:/,
  });
});

test('parseAllowedOrigin rejects unparseable strings', t => {
  t.throws(() => parseAllowedOrigin('not a url'), {
    message: /does not parse as a URL/,
  });
});

test('parseAllowedOrigins rejects an empty input', t => {
  t.throws(() => parseAllowedOrigins([]), {
    message: /At least one allowed origin/,
  });
});

test('parseAllowedOrigins deduplicates equivalent entries', t => {
  const origins = parseAllowedOrigins([
    'https://api.example.com/a',
    'https://api.example.com/b',
    'https://other.example.com',
  ]);
  t.deepEqual(
    [...origins],
    ['https://api.example.com', 'https://other.example.com'],
  );
});

test('makeHttpController.inspect returns the live allowlist', async t => {
  const controller = makeHttpController({
    allowedOrigins: ['https://api.example.com'],
  });
  const policy = await E(controller).inspect();
  t.deepEqual([...policy.allowedOrigins], ['https://api.example.com']);
});

test('makeHttpClient.request rejects URLs outside the allowlist', async t => {
  const controller = makeHttpController({
    allowedOrigins: ['https://api.example.com'],
  });
  // Spy fetch — should never be called when the policy check fails.
  let fetchCalls = 0;
  const fetch = () => {
    fetchCalls += 1;
    throw new Error('fetch must not be invoked for a disallowed origin');
  };
  const client = makeHttpClient(controller, { fetch });
  await t.throwsAsync(E(client).request({ url: 'https://evil.example.com/' }), {
    message: /not in the allowlist/,
  });
  // Regression evidence: a working policy gate prevents fetch from
  // running for disallowed origins.  Bypassing the check (e.g.
  // returning before assertOriginAllowed) would increment fetchCalls.
  t.is(fetchCalls, 0, 'fetch must not be reached when policy rejects');
});

test('makeHttpClient.request invokes fetch for allowed origins', async t => {
  const controller = makeHttpController({
    allowedOrigins: ['https://api.example.com'],
  });
  let lastUrl;
  let lastInit;
  const fakeResponse = {
    status: 200,
    statusText: 'OK',
    ok: true,
    // The exo iterates headers via .entries(); a Map exposes that
    // method natively, which matches the WHATWG Fetch Headers shape.
    headers: new Map([['content-type', 'text/plain']]),
    text: async () => 'body',
  };
  const fetchSpy = async (input, init) => {
    lastUrl = input;
    lastInit = init;
    return fakeResponse;
  };
  const client = makeHttpClient(controller, { fetch: fetchSpy });
  const response = await E(client).request({
    url: 'https://api.example.com/x',
  });
  t.is(lastUrl, 'https://api.example.com/x');
  t.is(lastInit.redirect, 'manual', 'request must use redirect: manual');
  t.is(response.status, 200);
  t.is(response.body, 'body');
  t.is(response.headers['content-type'], 'text/plain');
});

test('makeHttpClient rejects construction without a fetch power', t => {
  const controller = makeHttpController({
    allowedOrigins: ['https://api.example.com'],
  });
  t.throws(() => makeHttpClient(controller, { fetch: undefined }), {
    message: /requires a fetch power/,
  });
});
