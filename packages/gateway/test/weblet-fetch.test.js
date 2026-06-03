// @ts-check

/**
 * @file Phase-11b weblet-fetch unit tests.
 *
 * Exercises the pure `fetchWebletResponse` module in isolation: a
 * stub `serveWeblet` power feeds canned `ServeWebletResult`s and
 * the test asserts on the resulting status / headers / body
 * shape. Integration with the live `node:http` listener lives in
 * `http-listener.test.js`.
 */

import '@endo/init/debug.js';

import test from 'ava';
import { Far } from '@endo/far';

import {
  CONTENT_ADDRESSED_CACHE_CONTROL,
  INTERNAL_SERVER_ERROR_BODY,
  fetchWebletResponse,
  normalizeWebletPath,
} from '../index.js';

/** @import { Reader } from '@endo/stream' */

/**
 * Build a Far-tagged reader that yields the given chunks then `done`.
 * Mirrors the shape a daemon-side CAS adapter would hand back.
 *
 * @param {ReadonlyArray<Uint8Array>} chunks
 * @returns {Reader<Uint8Array>}
 */
const makeReaderFromChunks = chunks => {
  let i = 0;
  return /** @type {Reader<Uint8Array>} */ (
    /** @type {unknown} */ (
      Far('StubReader', {
        next: async () => {
          if (i >= chunks.length) {
            return harden({ done: true, value: undefined });
          }
          const value = chunks[i];
          i += 1;
          return harden({ done: false, value });
        },
        return: async () => {
          i = chunks.length;
          return harden({ done: true, value: undefined });
        },
        throw: async err => {
          i = chunks.length;
          throw err;
        },
      })
    )
  );
};

const FORMULA_ID = 'c'.repeat(64);

test('normalizeWebletPath maps "/" to /index.html', t => {
  t.is(normalizeWebletPath('/'), '/index.html');
});

test('normalizeWebletPath maps "" to /index.html', t => {
  t.is(normalizeWebletPath(''), '/index.html');
});

test('normalizeWebletPath preserves a regular path', t => {
  t.is(normalizeWebletPath('/static/app.js'), '/static/app.js');
});

test('normalizeWebletPath collapses leading double slashes', t => {
  t.is(normalizeWebletPath('//foo'), '/foo');
  t.is(normalizeWebletPath('///foo/bar'), '/foo/bar');
});

test('normalizeWebletPath preserves a trailing slash', t => {
  t.is(normalizeWebletPath('/dir/'), '/dir/');
});

test('200 maps to status + ETag + Cache-Control + body reader', async t => {
  const bytes = new TextEncoder().encode('<html>hi</html>');
  const response = await fetchWebletResponse({
    webletFormulaId: FORMULA_ID,
    pathSuffix: '/index.html',
    serveWeblet: async ({ webletFormulaId, pathSuffix }) => {
      t.is(webletFormulaId, FORMULA_ID);
      t.is(pathSuffix, '/index.html');
      return harden({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        etag: 'sha256-abc',
        size: bytes.byteLength,
        body: makeReaderFromChunks([bytes]),
      });
    },
  });
  t.is(response.status, 200);
  /** @type {Record<string, string>} */
  const headers = Object.fromEntries(response.headers);
  t.is(headers['content-type'], 'text/html; charset=utf-8');
  t.is(headers.etag, 'sha256-abc');
  t.is(headers['cache-control'], CONTENT_ADDRESSED_CACHE_CONTROL);
  t.is(headers['content-length'], String(bytes.byteLength));
  t.truthy(response.body);
});

test('bare-root request normalizes to /index.html before invoking the adapter', async t => {
  let seenPath = '';
  const response = await fetchWebletResponse({
    webletFormulaId: FORMULA_ID,
    pathSuffix: '/',
    serveWeblet: async ({ pathSuffix }) => {
      seenPath = pathSuffix;
      return harden({
        status: 200,
        contentType: 'text/html',
        etag: 'sha256-root',
        body: makeReaderFromChunks([new Uint8Array(0)]),
      });
    },
  });
  t.is(seenPath, '/index.html');
  t.is(response.status, 200);
});

test('200 without size omits Content-Length but keeps other headers', async t => {
  const response = await fetchWebletResponse({
    webletFormulaId: FORMULA_ID,
    pathSuffix: '/x',
    serveWeblet: async () =>
      harden({
        status: 200,
        contentType: 'application/octet-stream',
        etag: 'sha256-no-size',
        body: makeReaderFromChunks([]),
      }),
  });
  t.is(response.status, 200);
  /** @type {Record<string, string | undefined>} */
  const headers = Object.fromEntries(response.headers);
  t.is(headers['content-length'], undefined);
  t.is(headers.etag, 'sha256-no-size');
});

test('200 with a negative size suppresses Content-Length and warns', async t => {
  /** @type {string[]} */
  const warnings = [];
  const response = await fetchWebletResponse({
    webletFormulaId: FORMULA_ID,
    pathSuffix: '/x',
    serveWeblet: async () =>
      harden({
        status: 200,
        contentType: 'application/octet-stream',
        etag: 'sha256-bad-size',
        size: -1,
        body: makeReaderFromChunks([]),
      }),
    logWarning: m => warnings.push(m),
  });
  t.is(response.status, 200);
  /** @type {Record<string, string | undefined>} */
  const headers = Object.fromEntries(response.headers);
  t.is(headers['content-length'], undefined);
  t.true(warnings.some(w => /negative size/.test(w)));
});

test('304 maps to status + ETag header with no body', async t => {
  const response = await fetchWebletResponse({
    webletFormulaId: FORMULA_ID,
    pathSuffix: '/index.html',
    ifNoneMatch: 'sha256-known',
    serveWeblet: async ({ ifNoneMatch }) => {
      t.is(ifNoneMatch, 'sha256-known');
      return harden({ status: 304, etag: 'sha256-known' });
    },
  });
  t.is(response.status, 304);
  /** @type {Record<string, string>} */
  const headers = Object.fromEntries(response.headers);
  t.is(headers.etag, 'sha256-known');
  t.is(response.body, undefined);
});

test('404 maps to status + path-bearing text body', async t => {
  const response = await fetchWebletResponse({
    webletFormulaId: FORMULA_ID,
    pathSuffix: '/missing.png',
    serveWeblet: async () => harden({ status: 404 }),
  });
  t.is(response.status, 404);
  t.regex(response.textBody || '', /Not Found: \/missing\.png/);
});

test('serveWeblet throw maps to 500 with fixed body and logged warning', async t => {
  /** @type {string[]} */
  const warnings = [];
  const response = await fetchWebletResponse({
    webletFormulaId: FORMULA_ID,
    pathSuffix: '/index.html',
    serveWeblet: async () => {
      throw new Error('cas read failed: connection refused');
    },
    logWarning: m => warnings.push(m),
  });
  t.is(response.status, 500);
  t.is(response.textBody, INTERNAL_SERVER_ERROR_BODY);
  t.true(
    warnings.some(w => /serveWeblet/.test(w) && /cas read failed/.test(w)),
  );
});

test('serveWeblet returning a non-object maps to 500 with logged warning', async t => {
  /** @type {string[]} */
  const warnings = [];
  const response = await fetchWebletResponse({
    webletFormulaId: FORMULA_ID,
    pathSuffix: '/',
    serveWeblet: async () => /** @type {any} */ ('not-a-result'),
    logWarning: m => warnings.push(m),
  });
  t.is(response.status, 500);
  t.true(warnings.some(w => /non-object result/.test(w)));
});

test('200 missing contentType maps to 500 (fail-closed on broken formula)', async t => {
  /** @type {string[]} */
  const warnings = [];
  const response = await fetchWebletResponse({
    webletFormulaId: FORMULA_ID,
    pathSuffix: '/x',
    serveWeblet: async () =>
      /** @type {any} */ (
        harden({
          status: 200,
          contentType: '',
          etag: 'sha256-bad',
          body: makeReaderFromChunks([]),
        })
      ),
    logWarning: m => warnings.push(m),
  });
  t.is(response.status, 500);
  t.true(warnings.some(w => /contentType/.test(w)));
});

test('200 missing etag maps to 500', async t => {
  const response = await fetchWebletResponse({
    webletFormulaId: FORMULA_ID,
    pathSuffix: '/x',
    serveWeblet: async () =>
      /** @type {any} */ (
        harden({
          status: 200,
          contentType: 'text/plain',
          etag: '',
          body: makeReaderFromChunks([]),
        })
      ),
  });
  t.is(response.status, 500);
});

test('200 missing body reader maps to 500', async t => {
  const response = await fetchWebletResponse({
    webletFormulaId: FORMULA_ID,
    pathSuffix: '/x',
    serveWeblet: async () =>
      /** @type {any} */ (
        harden({
          status: 200,
          contentType: 'text/plain',
          etag: 'sha256-x',
          // intentionally omit body
        })
      ),
  });
  t.is(response.status, 500);
});

test('304 missing etag maps to 500', async t => {
  const response = await fetchWebletResponse({
    webletFormulaId: FORMULA_ID,
    pathSuffix: '/x',
    ifNoneMatch: 'sha256-y',
    serveWeblet: async () => /** @type {any} */ (harden({ status: 304 })),
  });
  t.is(response.status, 500);
});

test('unsupported status surfaces as 500', async t => {
  /** @type {string[]} */
  const warnings = [];
  const response = await fetchWebletResponse({
    webletFormulaId: FORMULA_ID,
    pathSuffix: '/',
    serveWeblet: async () => /** @type {any} */ (harden({ status: 418 })),
    logWarning: m => warnings.push(m),
  });
  t.is(response.status, 500);
  t.true(warnings.some(w => /unsupported status/.test(w)));
});

test('forwarded request is threaded into the adapter args', async t => {
  /** @type {unknown} */
  let seenForwarded;
  const forwarded = harden({
    callerIp: '203.0.113.7',
    scheme: /** @type {'https'} */ ('https'),
    host: 'chat.example',
    trusted: true,
  });
  await fetchWebletResponse({
    webletFormulaId: FORMULA_ID,
    pathSuffix: '/',
    forwarded,
    serveWeblet: async args => {
      seenForwarded = args.forwarded;
      return harden({
        status: 200,
        contentType: 'text/html',
        etag: 'e',
        body: makeReaderFromChunks([]),
      });
    },
  });
  t.is(seenForwarded, forwarded);
});

test('rejects an empty webletFormulaId at the seam', async t => {
  await t.throwsAsync(
    () =>
      fetchWebletResponse({
        webletFormulaId: '',
        pathSuffix: '/',
        serveWeblet: async () => harden({ status: 404 }),
      }),
    { message: /non-empty webletFormulaId/ },
  );
});

test('rejects a missing serveWeblet power at the seam', async t => {
  await t.throwsAsync(
    () =>
      fetchWebletResponse({
        webletFormulaId: FORMULA_ID,
        pathSuffix: '/',
        serveWeblet: /** @type {any} */ (undefined),
      }),
    { message: /serveWeblet function power/ },
  );
});

test('ifNoneMatch is forwarded verbatim when present', async t => {
  /** @type {string | undefined} */
  let seen;
  await fetchWebletResponse({
    webletFormulaId: FORMULA_ID,
    pathSuffix: '/',
    ifNoneMatch: 'sha256-prev',
    serveWeblet: async args => {
      seen = args.ifNoneMatch;
      return harden({ status: 304, etag: 'sha256-prev' });
    },
  });
  t.is(seen, 'sha256-prev');
});
