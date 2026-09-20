// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';

import { makeProviderBrokerGrant } from '../src/provider-broker.js';
import { makeProviderFetchTransport } from '../src/provider-transport.js';

/**
 * The broker over the real transport: how a response ended decides whether
 * its settlement is complete, and a provider that names some usage in its
 * first event must not make a response cut short read as one that ran.
 */

const policy = harden({
  origin: 'https://api.example.test',
  routes: [{ method: 'POST', path: '/v1/messages' }],
  models: ['allowed'],
  maxConcurrentRequests: 4,
  maxRequestBytes: 1000n,
  maxResponseBytes: 100_000n,
});
const request = harden({
  method: 'POST',
  path: '/v1/messages',
  body: '{"model":"allowed","stream":true}',
});
const START =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}\n\n';
const DELTA =
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":90}}\n\n';

/**
 * @param {import('ava').ExecutionContext} t
 * @param {'reset' | 'deadline' | 'end'} how
 */
const run = async (t, how) => {
  let expire = () => {};
  const encoder = new TextEncoder();
  const transport = makeProviderFetchTransport({
    fetch: /** @type {any} */ (
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(START));
              if (how === 'reset') {
                setTimeout(() => controller.error(Error('ECONNRESET')), 20);
              }
              if (how === 'end') {
                controller.enqueue(encoder.encode(DELTA));
                controller.close();
              }
            },
          }),
        )
    ),
    timeoutMs: 1000,
    maxRequestBytes: 1000n,
    maxResponseBytes: 100_000n,
    setTimer: callback => {
      expire = callback;
      return undefined;
    },
    clearTimer: () => {},
  });
  t.teardown(transport.dispose);
  const grant = makeProviderBrokerGrant(policy, {
    secret: Far('secret', { readBase64: async () => btoa('canary-secret') }),
    transport: transport.transport,
  });
  const response = await E(grant.endpoint).requestByteStream(request);
  const reader = iterateBytesReader(response.reader, { buffer: 0 });
  await reader.next();
  if (how === 'deadline') setTimeout(() => expire(), 20);
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const step = await reader.next().catch(() => ({ done: true }));
    if (step.done) break;
  }
  return response.usage;
};

test('a stream the upstream reset mid-way is cut short, whatever it had said of its cost', async t => {
  const usage = await run(t, 'reset');
  t.like(usage, { began: true, complete: false });
  // What it had said is kept, for a meter to set against its reservation.
  t.is(usage.usage.inputTokens, 25);
});

test('a stream cut by the deadline is cut short', async t => {
  t.like(await run(t, 'deadline'), { began: true, complete: false });
});

test('a stream read to its end is complete, with all it said', async t => {
  const usage = await run(t, 'end');
  t.like(usage, { began: true, complete: true });
  t.is(usage.usage.outputTokens, 90);
});
