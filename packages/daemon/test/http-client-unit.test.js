// @ts-nocheck

import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/far';
import {
  makeHttpClient,
  makeHttpController,
  parseAllowedOrigin,
  parseAllowedOrigins,
} from '../src/http-client.js';

// The daemon http-client module is the integration layer over the landed
// `@endo/exo-http-client` capability (PR #566), which owns the confinement
// core (`@endo/http-confine`).  These unit tests pin the integration
// contract: mint-time allowlist validation, the controller allowlist
// holder, the Phase-1 GET-class guard the daemon layers on top, and the
// `fetch()` -> `request({url,method?,headers?})` response adaptation.  The
// confinement itself (rate limits, byte caps, redirect defense, TOFU) is
// tested exhaustively in the http-confine / exo-http-client suites.

// A `fetch` result compatible with `@endo/http-confine`, whose response
// body must expose a streaming `getReader()` so the byte-cap limiter can
// read it.  Plain-object headers are read via `Object.entries` by the
// confinement's header/redirect helpers.
const makeBodyStream = text => {
  const bytes = new TextEncoder().encode(text);
  return {
    getReader() {
      let sent = false;
      // `cancel` / `releaseLock` are optional per the confinement's
      // reader contract; omit them so this stub stays a minimal
      // single-chunk source.
      return {
        async read() {
          if (sent) {
            return { done: true, value: undefined };
          }
          sent = true;
          return { done: false, value: bytes };
        },
      };
    },
  };
};

const makeFetchResponse = ({
  status = 200,
  statusText = 'OK',
  ok = true,
  headers = {},
  body = '',
  url = '',
} = {}) => ({
  status,
  statusText,
  ok,
  headers,
  url,
  body: makeBodyStream(body),
});

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
  // Spy fetch — should never be called when the confined client's policy
  // gate rejects the origin.  A denied request must not consume fetch (or,
  // in the landed capability, the rate budget).
  let fetchCalls = 0;
  const fetch = () => {
    fetchCalls += 1;
    throw new Error('fetch must not be invoked for a disallowed origin');
  };
  const client = makeHttpClient(controller, { fetch });
  await t.throwsAsync(E(client).request({ url: 'https://evil.example.com/' }), {
    message: /not in the allowed-origin list/,
  });
  // Regression evidence: the policy gate prevents fetch from running for
  // disallowed origins.  Bypassing the check would increment fetchCalls.
  t.is(fetchCalls, 0, 'fetch must not be reached when policy rejects');
});

test('makeHttpClient.request invokes fetch for allowed origins', async t => {
  const controller = makeHttpController({
    allowedOrigins: ['https://api.example.com'],
  });
  let lastUrl;
  let lastInit;
  const fetchSpy = async (input, init) => {
    lastUrl = input;
    lastInit = init;
    return makeFetchResponse({
      headers: { 'content-type': 'text/plain' },
      body: 'body',
      url: input,
    });
  };
  const client = makeHttpClient(controller, { fetch: fetchSpy });
  const response = await E(client).request({
    url: 'https://api.example.com/x',
  });
  t.is(lastUrl, 'https://api.example.com/x');
  // The landed confinement passes `redirect: 'manual'` so the allowed-to-
  // disallowed redirect SSRF vector is resolved by the confinement, never
  // followed blindly by the platform.
  t.is(lastInit.redirect, 'manual', 'request must use redirect: manual');
  t.is(response.status, 200);
  t.is(response.body, 'body');
  t.is(response.headers['content-type'], 'text/plain');
});

test('makeHttpClient rejects construction without a fetch power', async t => {
  const controller = makeHttpController({
    allowedOrigins: ['https://api.example.com'],
  });
  await t.throwsAsync(makeHttpClient(controller, { fetch: undefined }), {
    message: /requires a fetch power/,
  });
});

// ── Adversarial coverage: Phase 1 surface ───────────────────────────

test('Phase 1 rejects methods beyond GET-class (POST/PUT/DELETE/PATCH)', async t => {
  // Pin the design's "GET-class verbs only" Phase 1 invariant.  The landed
  // capability admits a wider method set, so the daemon integration layer
  // pins the read-only bound before delegating.  Regression evidence: a
  // fetch spy that increments on call would observe a bypass if this guard
  // regressed.
  const controller = makeHttpController({
    allowedOrigins: ['https://api.example.com'],
  });
  let fetchCalls = 0;
  const fetch = () => {
    fetchCalls += 1;
    throw new Error('fetch must not be invoked for non-GET methods');
  };
  const client = makeHttpClient(controller, { fetch });
  await null; // jessie: safe-await-separator
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      E(client).request({ url: 'https://api.example.com/', method }),
      { message: /Phase 1 http-client admits GET-class verbs only/ },
      `${method} must be rejected before reaching fetch`,
    );
  }
  t.is(fetchCalls, 0, 'fetch must not be reached for any non-GET method');
});

test('Phase 1 admits HEAD as a GET-class verb alongside GET', async t => {
  const controller = makeHttpController({
    allowedOrigins: ['https://api.example.com'],
  });
  const methodsSeen = [];
  const fetch = async (_url, init) => {
    methodsSeen.push(init.method);
    return makeFetchResponse({ url: 'https://api.example.com/' });
  };
  const client = makeHttpClient(controller, { fetch });
  await E(client).request({ url: 'https://api.example.com/' }); // default GET
  await E(client).request({
    url: 'https://api.example.com/',
    method: 'HEAD',
  });
  t.deepEqual(methodsSeen, ['GET', 'HEAD']);
});

test('Phase 1 rejects javascript:/file:/data: at request time (origin is null)', async t => {
  // A defense-in-depth check: even though such schemes are rejected at
  // allowlist-construction time (parseAllowedOrigin enforces http/https
  // only), a request URL with one of these schemes parses to
  // `.origin === 'null'`, which can never appear on the allowlist, so the
  // confined client denies it before reaching fetch.
  const controller = makeHttpController({
    allowedOrigins: ['https://api.example.com'],
  });
  let fetchCalls = 0;
  const fetch = () => {
    fetchCalls += 1;
    throw new Error('fetch must not be invoked');
  };
  const client = makeHttpClient(controller, { fetch });
  // Assemble these strings rather than write them literally so the
  // test source itself does not trip `no-script-url` lint.
  await null; // jessie: safe-await-separator
  for (const url of [
    `${'javascript'}:alert(1)`,
    `${'file'}:///etc/passwd`,
    `${'data'}:text/plain,hello`,
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(E(client).request({ url }));
  }
  t.is(fetchCalls, 0);
});

test('Allowlist match is exact: trailing dot in request URL does not match no-dot allowlist', async t => {
  // `new URL('https://example.com.').origin === 'https://example.com.'`
  // (the trailing dot is preserved), so an allowlist of
  // `https://example.com` does not match `https://example.com.`.  Pin
  // this so a refactor that "normalizes" trailing dots does not widen
  // the allowlist behind the host's back.
  const controller = makeHttpController({
    allowedOrigins: ['https://example.com'],
  });
  let fetchCalls = 0;
  const fetch = () => {
    fetchCalls += 1;
    throw new Error('fetch must not be invoked');
  };
  const client = makeHttpClient(controller, { fetch });
  await t.throwsAsync(E(client).request({ url: 'https://example.com./x' }), {
    message: /not in the allowed-origin list/,
  });
  t.is(fetchCalls, 0);
});
