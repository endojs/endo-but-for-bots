// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  HeaderRejectedError,
  MethodNotAllowedError,
  OriginNotAllowedError,
  RateLimitError,
  RevokedError,
  assertHeadersSafe,
  checkOriginAllowed,
  limitRequestBytes,
  limitResponseBytes,
  makeHttpConfinement,
  makeRateLimiter,
  makeRequestSignal,
  normalizeMethod,
  parseAllowedOrigins,
  residentBodyByteLength,
  resolveRedirect,
} from '../src/http-confine.js';

/** @import { FetchLike } from '../src/types.js' */

/**
 * @param {Array<string | Uint8Array>} chunks
 * @param {object} [options]
 * @param {(reason?: unknown) => void} [options.onCancel]
 */
const makeBody = (chunks, { onCancel = () => {} } = {}) =>
  harden({
    getReader: () => {
      let index = 0;
      return harden({
        read: async () => {
          if (index >= chunks.length) {
            return harden({ done: true });
          }
          const value = chunks[index];
          index += 1;
          return harden({ done: false, value });
        },
        cancel: async reason => {
          index = chunks.length;
          onCancel(reason);
        },
        releaseLock: () => {},
      });
    },
  });

test('parseAllowedOrigins normalizes http origins and rejects other schemes', t => {
  t.deepEqual(
    [...parseAllowedOrigins(['https://API.example.com:443/path?q=1'])],
    ['https://api.example.com'],
  );
  t.throws(() => parseAllowedOrigins(['file:///tmp/secret']));
  t.throws(() => parseAllowedOrigins(['not a url']));
});

test('checkOriginAllowed enforces exact origin matches', t => {
  const origins = parseAllowedOrigins(['https://api.example.com']);
  t.notThrows(() =>
    checkOriginAllowed('https://api.example.com/data', origins),
  );
  t.throws(
    () => checkOriginAllowed('https://api.example.com.evil/data', origins),
    { instanceOf: OriginNotAllowedError },
  );
});

test('normalizeMethod uppercases and validates against a closed set', t => {
  t.is(normalizeMethod('head'), 'HEAD');
  t.throws(() => normalizeMethod('POST'), {
    instanceOf: MethodNotAllowedError,
  });
  t.is(normalizeMethod('post', { allowedMethods: new Set(['POST']) }), 'POST');
});

test('assertHeadersSafe rejects CRLF and forbidden header names', t => {
  t.notThrows(() => assertHeadersSafe({ accept: 'application/json' }));
  t.throws(() => assertHeadersSafe({ host: 'internal.example.com' }), {
    instanceOf: HeaderRejectedError,
  });
  t.throws(() => assertHeadersSafe({ 'x-inject': 'ok\r\nHost: x' }), {
    instanceOf: HeaderRejectedError,
  });
});

test('makeRateLimiter uses the injected clock', t => {
  let clock = 1000;
  const limiter = makeRateLimiter({ maxPerMinute: 2, now: () => clock });
  limiter.take();
  limiter.take();
  t.is(limiter.remaining(), 0);
  t.throws(() => limiter.take(), { instanceOf: RateLimitError });
  clock += 60_001;
  t.is(limiter.remaining(), 2);
});

test('limitResponseBytes truncates at read time and marks exact fills', async t => {
  /** @type {unknown[]} */
  const cancelReasons = [];
  const limited = limitResponseBytes(
    makeBody(['abc'], {
      onCancel: reason => cancelReasons.push(reason),
    }),
    { maxBytes: 3 },
  );

  const bytes = await limited.stream;

  t.deepEqual([...bytes], [...new TextEncoder().encode('abc')]);
  t.true(limited.truncated());
  t.deepEqual(cancelReasons, ['maxResponseBytes exceeded']);
});

test('resolveRedirect only follows to allowlisted origins', t => {
  const origins = parseAllowedOrigins(['https://api.example.com']);
  t.is(resolveRedirect(harden({ status: 200 }), origins), 'follow');
  t.is(
    resolveRedirect(
      harden({
        status: 302,
        url: 'https://api.example.com/start',
        headers: { location: '/next' },
      }),
      origins,
    ),
    'follow',
  );
  t.is(
    resolveRedirect(
      harden({
        status: 302,
        url: 'https://api.example.com/start',
        headers: { location: 'https://evil.example.com/' },
      }),
      origins,
    ),
    'reject',
  );
});

test('makeRequestSignal aborts for cancellation and disposes timeout', async t => {
  /** @type {(reason?: never) => void} */
  let cancel = () => {};
  const cancellation = /** @type {Promise<never>} */ (
    new Promise((_, reject) => {
      cancel = reject;
    })
  );
  const { signal, dispose } = makeRequestSignal({
    timeoutMs: 10_000,
    cancellation,
  });
  t.true(signal instanceof AbortSignal);
  cancel();
  await Promise.resolve();
  t.true(signal.aborted);
  dispose();
});

test('makeHttpConfinement rejects invalid falsy defense limits', t => {
  /** @type {FetchLike} */
  const fetch = url =>
    harden({
      status: 200,
      url,
      headers: {},
      body: makeBody(['ok']),
    });
  const seams = harden({ fetch, now: () => 1000 });

  t.throws(
    () =>
      makeHttpConfinement(
        {
          allowedOrigins: ['https://api.example.com'],
          maxRequestsPerMinute: 0,
        },
        seams,
      ),
    { message: /"maxPerMinute" must be a positive safe integer/ },
  );
  t.throws(
    () =>
      makeHttpConfinement(
        {
          allowedOrigins: ['https://api.example.com'],
          maxResponseBytes: 0,
        },
        seams,
      ),
    { message: /"maxResponseBytes" must be a positive safe integer/ },
  );
  t.throws(
    () =>
      makeHttpConfinement(
        {
          allowedOrigins: ['https://api.example.com'],
          timeoutMs: NaN,
        },
        seams,
      ),
    { message: /"timeoutMs" must be a positive safe integer/ },
  );
});

test('makeHttpConfinement composes rate, origin, fetch, redirect, and byte cap', async t => {
  let clock = 1000;
  /** @type {Array<{ url: string, options: Record<string, unknown> }>} */
  const calls = [];
  /** @type {FetchLike} */
  const fetch = (url, options) => {
    calls.push({
      url,
      options: /** @type {Record<string, unknown>} */ (options || {}),
    });
    return harden({
      status: 200,
      statusText: 'OK',
      ok: true,
      headers: {},
      url,
      body: makeBody(['abcdef']),
    });
  };
  const core = makeHttpConfinement(
    {
      allowedOrigins: ['https://api.example.com'],
      maxRequestsPerMinute: 1,
      maxResponseBytes: 3,
      allowedMethods: new Set(['GET', 'POST']),
    },
    { fetch, now: () => clock },
  );

  const response = await core.request({
    url: 'https://api.example.com/data',
    method: 'post',
  });
  t.true(response.truncated);
  t.is(new TextDecoder().decode(response.bytes), 'abc');
  t.is(calls[0].options.redirect, 'manual');
  t.is(calls[0].options.method, 'POST');
  t.true(calls[0].options.signal instanceof AbortSignal);

  await t.throwsAsync(
    () => core.request({ url: 'https://api.example.com/again' }),
    { instanceOf: RateLimitError },
  );
  clock += 60_001;
  await t.throwsAsync(
    () => core.request({ url: 'https://evil.example.com/' }),
    { instanceOf: OriginNotAllowedError },
  );

  core.revoke();
  await t.throwsAsync(
    () => core.request({ url: 'https://api.example.com/revoked' }),
    { instanceOf: RevokedError },
  );
});

test('makeHttpConfinement array mode owns allowlist mutators', async t => {
  /** @type {FetchLike} */
  const fetch = url =>
    harden({
      status: 200,
      url,
      headers: {},
      body: makeBody(['ok']),
    });
  const core = makeHttpConfinement(
    {
      allowedOrigins: ['https://api.example.com'],
      maxRequestsPerMinute: 10,
    },
    { fetch, now: () => 1000 },
  );

  await t.throwsAsync(
    () => core.request({ url: 'https://next.example.com/data' }),
    { instanceOf: OriginNotAllowedError },
  );
  core.addAllowedOrigin('https://next.example.com/path');
  t.deepEqual(core.allowedOrigins(), [
    'https://api.example.com',
    'https://next.example.com',
  ]);
  await t.notThrowsAsync(() =>
    core.request({ url: 'https://next.example.com/data' }),
  );

  core.removeAllowedOrigin('https://api.example.com/elsewhere');
  await t.throwsAsync(
    () => core.request({ url: 'https://api.example.com/data' }),
    { instanceOf: OriginNotAllowedError },
  );

  core.setAllowedOrigins(['https://reset.example.com']);
  t.deepEqual(core.inspect().allowedOrigins, ['https://reset.example.com']);
});

test('makeHttpConfinement thunk mode consults live allowlist authority', async t => {
  const authority = new Set(['https://api.example.com']);
  /** @type {FetchLike} */
  const fetch = url =>
    harden({
      status: 200,
      url,
      headers: {},
      body: makeBody(['ok']),
    });
  const core = makeHttpConfinement(
    {
      allowedOrigins: () => [...authority],
      maxRequestsPerMinute: 10,
    },
    { fetch, now: () => 1000 },
  );

  await t.notThrowsAsync(() =>
    core.request({ url: 'https://api.example.com/data' }),
  );

  authority.delete('https://api.example.com');
  authority.add('https://next.example.com');

  t.deepEqual(core.allowedOrigins(), ['https://next.example.com']);
  t.deepEqual(core.inspect().allowedOrigins, ['https://next.example.com']);
  await t.throwsAsync(
    () => core.request({ url: 'https://api.example.com/data' }),
    { instanceOf: OriginNotAllowedError },
  );
  await t.notThrowsAsync(() =>
    core.request({ url: 'https://next.example.com/data' }),
  );
});

test('makeHttpConfinement thunk mode resolves redirects against live allowlist', async t => {
  const authority = new Set(['https://api.example.com']);
  /** @type {FetchLike} */
  const fetch = url => {
    authority.delete('https://api.example.com');
    authority.add('https://redirect.example.com');
    return harden({
      status: 302,
      url,
      headers: { location: 'https://redirect.example.com/next' },
      body: makeBody([]),
    });
  };
  const core = makeHttpConfinement(
    {
      allowedOrigins: () => [...authority],
      maxRequestsPerMinute: 10,
    },
    { fetch, now: () => 1000 },
  );

  await t.notThrowsAsync(() =>
    core.request({ url: 'https://api.example.com/start' }),
  );
});

test('makeHttpConfinement thunk mode rejects origin mutators', t => {
  const core = makeHttpConfinement(
    {
      allowedOrigins: () => ['https://api.example.com'],
    },
    {
      fetch: () =>
        harden({
          status: 200,
          url: 'https://api.example.com/data',
          headers: {},
          body: makeBody([]),
        }),
      now: () => 1000,
    },
  );

  t.throws(() => core.setAllowedOrigins(['https://next.example.com']), {
    message: /externally owned/,
  });
  t.throws(() => core.addAllowedOrigin('https://next.example.com'), {
    message: /externally owned/,
  });
  t.throws(() => core.removeAllowedOrigin('https://api.example.com'), {
    message: /externally owned/,
  });
});

test('residentBodyByteLength measures what it can and declines what it cannot', t => {
  t.is(residentBodyByteLength(undefined), 0);
  t.is(residentBodyByteLength(null), 0);
  t.is(residentBodyByteLength('abc'), 3);
  // Measured in bytes, not code units.
  t.is(residentBodyByteLength('é'), 2);
  t.is(residentBodyByteLength(new Uint8Array(7)), 7);
  t.is(residentBodyByteLength(new ArrayBuffer(5)), 5);
  t.is(
    residentBodyByteLength(
      (async function* nope() {
        yield new Uint8Array(1);
      })(),
    ),
    undefined,
    'a streamed body has no knowable size, and says so',
  );
});

test('limitRequestBytes stops at the first frame past the cap', async t => {
  const chunk = new Uint8Array(4).fill(1);
  const offered = [];
  const source = (async function* generate() {
    for (let i = 0; i < 10; i += 1) {
      offered.push(i);
      yield chunk;
    }
  })();
  const limited = limitRequestBytes(source, { maxBytes: 10 });
  const seen = [];
  await t.throwsAsync(
    (async () => {
      for await (const frame of limited.frames) {
        seen.push(frame.byteLength);
      }
    })(),
    { message: /exceeds maxRequestBytes/ },
  );
  t.deepEqual(seen, [4, 4], 'two frames pass, the third crosses the cap');
  t.is(
    offered.length,
    3,
    'the source is not drained past the frame that failed',
  );
});

test('limitRequestBytes passes a body that fits, dropping empty frames', async t => {
  const source = (async function* generate() {
    yield new Uint8Array(0);
    yield new TextEncoder().encode('ab');
    yield new Uint8Array(0);
    yield new TextEncoder().encode('c');
  })();
  const limited = limitRequestBytes(source, { maxBytes: 8 });
  const seen = [];
  for await (const frame of limited.frames) {
    seen.push(new TextDecoder().decode(frame));
  }
  t.deepEqual(seen, ['ab', 'c']);
  t.is(limited.sent(), 3);
});

test('makeHttpConfinement refuses an over-limit resident body before dialing', async t => {
  let dialed = 0;
  const core = makeHttpConfinement(
    {
      allowedOrigins: ['https://api.example.com'],
      maxRequestBytes: 4,
    },
    {
      fetch: () => {
        dialed += 1;
        throw new Error('should not be reached');
      },
      now: () => 1000,
    },
  );
  t.is(core.inspect().maxRequestBytes, 4);
  await t.throwsAsync(
    core.request({
      url: 'https://api.example.com/upload',
      method: 'POST',
      body: 'abcde',
    }),
    { message: /exceeds maxRequestBytes/ },
  );
  t.is(dialed, 0);
});

test('makeHttpConfinement declares a streamed body half-duplex', async t => {
  /** @type {any} */
  let seen;
  const core = makeHttpConfinement(
    {
      allowedOrigins: ['https://api.example.com'],
      maxRequestBytes: 1024,
    },
    {
      fetch: (_url, options) => {
        seen = options;
        return harden({
          status: 200,
          url: 'https://api.example.com/upload',
          headers: {},
          body: makeBody([]),
        });
      },
      now: () => 1000,
    },
  );
  const source = (async function* generate() {
    yield new TextEncoder().encode('hello');
  })();
  await core.request({
    url: 'https://api.example.com/upload',
    method: 'POST',
    body: source,
  });
  t.is(seen.duplex, 'half');
  const frames = [];
  for await (const frame of seen.body) {
    frames.push(new TextDecoder().decode(frame));
  }
  t.deepEqual(frames, ['hello']);
});
