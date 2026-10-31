// @ts-check
// spell-out-exempt: `ok` is the platform Response field under test.
import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { makeCancelKit } from '@endo/cancel';
import { encodeUtf8 } from '@endo/utf8/encode.js';
import { decodeUtf8 } from '@endo/utf8/decode.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { thawedBytes } from '@endo/immutable-arraybuffer';

import { make, makeFetch } from '../src/index.js';

/**
 * A fake transport that records each call and answers with `chunks` as the
 * body. `readerCancelled` resolves when the body reader is cancelled.
 *
 * @param {object} [options]
 * @param {string[] | null} [options.chunks]
 * @param {Iterable<[string, string]> | Record<string, string>} [options.headers]
 * @param {Promise<unknown>} [options.pending] - hold the response until settled
 */
const makeTransport = ({ chunks = ['ok'], headers = {}, pending } = {}) => {
  /** @type {Array<{ url: string, options: any }>} */
  const calls = [];
  const { promise: readerCancelled, resolve: markCancelled } = makePromiseKit();
  /** @type {any} */
  const transport = async (url, options) => {
    calls.push({ url, options });
    await pending;
    const encoded = (chunks || []).map(chunk => encodeUtf8(chunk));
    return {
      status: 200,
      statusText: 'OK',
      headers,
      url,
      body:
        chunks === null
          ? null
          : {
              getReader: () => ({
                read: async () =>
                  encoded.length > 0
                    ? { done: false, value: encoded.shift() }
                    : { done: true },
                cancel: async () => markCancelled(undefined),
              }),
            },
    };
  };
  return { transport, calls, readerCancelled };
};

/** @param {any} reader */
const readAll = async reader => {
  let text = '';
  for await (const chunk of iterateReader(reader)) {
    text += decodeUtf8(thawedBytes(/** @type {Uint8Array} */ (chunk)));
  }
  return text;
};

test('fetch relays the request and returns a passable response', async t => {
  const { transport, calls } = makeTransport({
    chunks: ['hel', 'lo'],
    headers: [
      ['Content-Type', 'text/plain'],
      ['X-Thing', '1'],
    ],
  });
  const fetch = makeFetch({ fetch: transport });

  const response = await E(fetch).fetch('https://example.com/a', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'payload',
    redirect: 'manual',
  });

  t.is(calls.length, 1);
  t.is(calls[0].url, 'https://example.com/a');
  t.is(calls[0].options.method, 'POST');
  t.is(calls[0].options.body, 'payload');
  t.is(calls[0].options.redirect, 'manual');
  t.deepEqual(calls[0].options.headers, { 'content-type': 'text/plain' });
  t.is(calls[0].options.signal, undefined);

  t.is(response.status, 200);
  t.true(response.ok);
  t.deepEqual(response.headers, {
    'content-type': 'text/plain',
    'x-thing': '1',
  });
  t.is(await readAll(response.body), 'hello');
});

test('a null-body response has a null body', async t => {
  const { transport } = makeTransport({ chunks: null });
  const response = await E(makeFetch({ fetch: transport })).fetch(
    'https://example.com/',
    { method: 'HEAD' },
  );
  t.is(response.body, null);
});

test('cancelling the cancelled token aborts the transport request', async t => {
  const { promise: pending, resolve: release } = makePromiseKit();
  const { transport, calls } = makeTransport({ pending });
  const { cancelled, cancel } = makeCancelKit();

  const responseP = E(makeFetch({ fetch: transport })).fetch(
    'https://example.com/',
    { cancelled },
  );
  await null;
  await null;
  t.is(calls.length, 1);
  const { signal } = calls[0].options;
  t.false(signal.aborted);
  cancel(Error('stop'));
  await cancelled.catch(() => {});
  t.true(signal.aborted);
  release(undefined);
  await responseP;
});

test('closing the body reader early cancels the transport reader', async t => {
  const { transport, readerCancelled } = makeTransport({
    chunks: ['a', 'b', 'c'],
  });
  const response = await E(makeFetch({ fetch: transport })).fetch(
    'https://example.com/',
  );
  const iterator = iterateReader(/** @type {any} */ (response.body));
  const first = await iterator.next();
  t.false(first.done);
  await iterator.return(undefined);
  await readerCancelled;
  t.pass();
});

test('the interface guard rejects a non-string body and an unknown redirect mode', async t => {
  const { transport, calls } = makeTransport();
  const fetch = makeFetch({ fetch: transport });
  await t.throwsAsync(() =>
    E(fetch).fetch('https://example.com/', {
      body: /** @type {any} */ ({ object: true }),
    }),
  );
  await t.throwsAsync(() =>
    E(fetch).fetch('https://example.com/', {
      redirect: /** @type {any} */ ('sideways'),
    }),
  );
  t.is(calls.length, 0);
});

test('make() returns the Fetch capability over the injected transport', async t => {
  const { transport, calls } = makeTransport({ chunks: ['hi'] });
  const fetch = make(undefined, undefined, { env: {}, fetch: transport });
  t.regex(await E(fetch).help(), /Not for guests/);
  const response = await E(fetch).fetch('https://example.com/');
  t.is(await readAll(response.body), 'hi');
  t.is(calls.length, 1);
});
