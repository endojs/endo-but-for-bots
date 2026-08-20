// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/far';

import {
  classifyStreamingBody,
  FRAME_BYTES,
  generateByteFrames,
  makeFramedBytesReader,
} from '../src/byte-frames.js';
import { makeHttpClientAndControl } from '../src/http-client.js';

const ORIGIN = 'https://upload.example.com';

/**
 * Collect whatever `fetch` was handed as a body: a streamed body arrives as an
 * async iterable of frames, a resident one as a string or `Uint8Array`.
 *
 * @param {unknown} body
 * @returns {Promise<{ bytes: Uint8Array, frames: number[] }>}
 */
const collectBody = async body => {
  await null;
  if (typeof body === 'string') {
    return { bytes: new TextEncoder().encode(body), frames: [] };
  }
  if (body instanceof Uint8Array) {
    return { bytes: body, frames: [] };
  }
  /** @type {Uint8Array[]} */
  const chunks = [];
  /** @type {number[]} */
  const frames = [];
  for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (body)) {
    chunks.push(chunk);
    frames.push(chunk.byteLength);
  }
  const total = frames.reduce((sum, n) => sum + n, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, frames };
};

/**
 * A `fetch` seam that records what it was asked to send and answers 200.
 *
 * `peak` is the largest number of body bytes this seam ever held at once. A
 * streamed body is consumed frame by frame, so the peak stays at one frame no
 * matter how large the body is; that is the property the bound is for.
 */
const makeRecordingFetch = () => {
  /** @type {{ bytes: Uint8Array, frames: number[], duplex?: string } | undefined} */
  let sent;
  let peak = 0;
  /**
   * @param {string} _url
   * @param {any} [options]
   * @returns {Promise<any>}
   */
  const fetch = async (_url, options = {}) => {
    await null;
    const body = /** @type {any} */ (options).body;
    /** @type {Uint8Array[]} */
    const chunks = [];
    /** @type {number[]} */
    const frames = [];
    if (typeof body === 'string' || body instanceof Uint8Array) {
      const { bytes } = await collectBody(body);
      peak = Math.max(peak, bytes.byteLength);
      sent = { bytes, frames };
    } else if (body !== undefined) {
      for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (
        body
      )) {
        peak = Math.max(peak, chunk.byteLength);
        chunks.push(chunk);
        frames.push(chunk.byteLength);
      }
      const total = frames.reduce((sum, n) => sum + n, 0);
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      sent = {
        bytes,
        frames,
        duplex: /** @type {any} */ (options).duplex,
      };
    }
    return harden({
      status: 200,
      statusText: 'OK',
      ok: true,
      headers: {},
      url: `${ORIGIN}/upload`,
      body: {
        getReader: () => {
          let done = false;
          return {
            read: async () => {
              await null;
              if (done) return { done: true, value: undefined };
              done = true;
              return { done: false, value: new TextEncoder().encode('ok') };
            },
            releaseLock: () => {},
          };
        },
      },
    });
  };
  return {
    fetch,
    sent: () => sent,
    peak: () => peak,
  };
};

test('byte framing splits a buffer into fixed-size frames', async t => {
  const bytes = new Uint8Array(FRAME_BYTES * 2 + 7).fill(0x61);
  /** @type {number[]} */
  const sizes = [];
  for await (const frame of generateByteFrames(bytes)) {
    sizes.push(frame.byteLength);
  }
  t.deepEqual(sizes, [FRAME_BYTES, FRAME_BYTES, 7]);
});

test('byte framing honours a caller-chosen frame size', async t => {
  /** @type {number[]} */
  const sizes = [];
  for await (const frame of generateByteFrames(new Uint8Array(5), 2)) {
    sizes.push(frame.byteLength);
  }
  t.deepEqual(sizes, [2, 2, 1]);
});

test('a bytes reader is recognized as a streaming body, a buffer is not', t => {
  t.is(
    classifyStreamingBody(makeFramedBytesReader(new Uint8Array(4))),
    'reader',
  );
  t.is(classifyStreamingBody('text'), 'none');
  t.is(classifyStreamingBody(new Uint8Array(4)), 'none');
  t.is(classifyStreamingBody(undefined), 'none');
  t.is(classifyStreamingBody({ nope: true }), 'none');
});

test('a streamed request body larger than one frame arrives intact and bounded', async t => {
  const recorder = makeRecordingFetch();
  const { client } = makeHttpClientAndControl({
    fetch: recorder.fetch,
    allowedOrigins: [ORIGIN],
    maxRequestBytes: 1024 * 1024,
  });

  // Two full frames and a remainder, with a per-byte pattern so a reordered
  // or dropped frame cannot pass as intact.
  const size = FRAME_BYTES * 2 + 1234;
  const payload = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    payload[i] = i % 251;
  }

  const response = await E(client).fetch(`${ORIGIN}/upload`, {
    method: 'POST',
    body: makeFramedBytesReader(payload),
  });
  t.is(await E(response).status(), 200);

  const sent = recorder.sent();
  t.truthy(sent);
  t.deepEqual(
    Array.from(/** @type {Uint8Array} */ (sent?.bytes)),
    Array.from(payload),
    'every byte of the streamed body arrives, in order',
  );
  t.deepEqual(
    sent?.frames,
    [FRAME_BYTES, FRAME_BYTES, 1234],
    'the body crosses the boundary in fixed-size frames, not as one value',
  );
  t.is(sent?.duplex, 'half', 'a streamed body is declared half-duplex');
  t.is(
    recorder.peak(),
    FRAME_BYTES,
    'no more than one frame is resident at a time',
  );
});

test('an over-limit streamed request body fails closed mid-stream', async t => {
  const recorder = makeRecordingFetch();
  const { client } = makeHttpClientAndControl({
    fetch: recorder.fetch,
    allowedOrigins: [ORIGIN],
    maxRequestBytes: FRAME_BYTES + 1,
  });

  const payload = new Uint8Array(FRAME_BYTES * 4).fill(0x62);
  await t.throwsAsync(
    E(client).fetch(`${ORIGIN}/upload`, {
      method: 'POST',
      body: makeFramedBytesReader(payload),
    }),
    { message: /exceeds maxRequestBytes/ },
  );
  t.is(
    recorder.peak(),
    FRAME_BYTES,
    'the refusal lands after one frame, not after the whole body is resident',
  );
});

test('an over-limit resident request body is refused before the request is dialed', async t => {
  let dialed = 0;
  /** @returns {Promise<any>} */
  const fetch = async () => {
    dialed += 1;
    throw new Error('should not be reached');
  };
  const { client } = makeHttpClientAndControl({
    fetch,
    allowedOrigins: [ORIGIN],
    maxRequestBytes: 16,
  });

  await t.throwsAsync(
    E(client).fetch(`${ORIGIN}/upload`, {
      method: 'POST',
      body: 'x'.repeat(17),
    }),
    { message: /exceeds maxRequestBytes/ },
  );
  t.is(dialed, 0);
});

test('a resident request body inside the cap is sent unframed', async t => {
  const recorder = makeRecordingFetch();
  const { client } = makeHttpClientAndControl({
    fetch: recorder.fetch,
    allowedOrigins: [ORIGIN],
    maxRequestBytes: 1024,
  });
  await E(client).fetch(`${ORIGIN}/upload`, { method: 'POST', body: 'hello' });
  t.deepEqual(
    Array.from(/** @type {Uint8Array} */ (recorder.sent()?.bytes)),
    Array.from(new TextEncoder().encode('hello')),
  );
  t.deepEqual(recorder.sent()?.frames, []);
});

test('the request byte cap is inspectable and adjustable from the control facet', async t => {
  const recorder = makeRecordingFetch();
  const { client, control } = makeHttpClientAndControl({
    fetch: recorder.fetch,
    allowedOrigins: [ORIGIN],
    maxRequestBytes: 64,
  });
  t.is((await E(control).inspect()).maxRequestBytes, 64);

  await t.throwsAsync(
    E(client).fetch(`${ORIGIN}/upload`, {
      method: 'POST',
      body: 'y'.repeat(65),
    }),
    { message: /exceeds maxRequestBytes/ },
  );

  await E(control).setMaxRequestBytes(128);
  t.is((await E(control).inspect()).maxRequestBytes, 128);
  const response = await E(client).fetch(`${ORIGIN}/upload`, {
    method: 'POST',
    body: 'y'.repeat(65),
  });
  t.is(await E(response).status(), 200);

  await t.throwsAsync(E(control).setMaxRequestBytes(0), {
    message: /positive safe integer/,
  });
});

test('the policy snapshot carries the request byte cap', async t => {
  const recorder = makeRecordingFetch();
  /** @type {any[]} */
  const snapshots = [];
  const { control } = makeHttpClientAndControl({
    fetch: recorder.fetch,
    allowedOrigins: [ORIGIN],
    maxRequestBytes: 4096,
    onPolicyChange: snapshot => snapshots.push(snapshot),
  });
  await E(control).setMaxRequestBytes(8192);
  await null;
  await null;
  t.is(snapshots.at(-1)?.policy.maxRequestBytes, 8192);
});
