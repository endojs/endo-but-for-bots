// @ts-check
// Image results on the provider wires (resources/agent-host/impl/providers/
// images.js; designs/m8-interfaces.md 6.4, 6.5, D-M8-8, D-M8-9; P-37,
// R4-32, R4-39; acceptance 12 and 13): which tool results are decoded as
// images, the receipts, the per-request cap, and each wire's native form
// as the fake servers (127.0.0.1) received it: the Messages API (Anthropic
// API and Claude pool), OpenAI-compatible chat (OpenRouter) and Responses
// (Codex pool).
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import {
  IMAGE_ENVELOPE_PREFIX,
  imageTextOf,
} from '../../guest/lib/interfaces.js';
import { imageLimits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import {
  encodeImageEnvelope,
  imageOf,
  imageReceiptText,
  selectImages,
  toolResultImages,
} from '../../resources/agent-host/impl/providers/images.js';
import { makeAnthropicProvider } from '../../resources/agent-host/impl/providers/anthropic.js';
import { makeOpenRouterProvider } from '../../resources/agent-host/impl/providers/openrouter.js';
import { claudeAttempt } from '../../resources/agent-host/impl/subscriptions/messages.js';
import { codexAttempt } from '../../resources/agent-host/impl/subscriptions/responses.js';
import { startFakeProviderServer } from '../fixtures/fake-provider-server.mjs';
import { startFakeSubscriptionServer } from '../fixtures/fake-subscription-server.mjs';
import { runApiRound } from './_m2-w21b-round.js';

/** The PNG signature and a few bytes after it (not a whole image). */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3,
]).toString('base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]).toString('base64');

const pngEnvelope = encodeImageEnvelope({ mediaType: 'image/png', data: PNG });

/**
 * One round's call and result.
 * @param {string} id
 * @param {string} name
 * @param {string} content
 * @param {Record<string, unknown>} [extra] fields of the result entry
 */
const callAndResult = (id, name, content, extra = {}) => [
  { kind: 'tool-call', id, name, args: '{"petName":"shot"}' },
  { kind: 'tool-result', id, content, ...extra },
];

/** A projection with one viewImage result and one exec result. */
const oneImage = () =>
  harden([
    { kind: 'message', role: 'user', content: 'look at the screenshot' },
    { kind: 'message', role: 'assistant', content: 'viewing' },
    ...callAndResult('t1/r0/c0', 'viewImage', pngEnvelope),
    { kind: 'message', role: 'assistant', content: 'a blue square' },
  ]);

// ---------------------------------------------------------------- decoding

test('encodeImageEnvelope: the hosted-agent envelope, decoded by imageOf', t => {
  t.true(pngEnvelope.startsWith(IMAGE_ENVELOPE_PREFIX));
  t.deepEqual(JSON.parse(pngEnvelope.slice(IMAGE_ENVELOPE_PREFIX.length)), {
    mimeType: 'image/png',
    data: PNG,
  });
  const transcript = oneImage();
  t.deepEqual(imageOf(transcript, transcript[3]), {
    mediaType: 'image/png',
    data: PNG,
  });
  t.is(
    imageReceiptText(transcript, transcript[3]),
    '[Image image/png; bytes retained for model input]',
  );
  // Not a tool result: text.
  t.is(imageOf(transcript, transcript[0]), undefined);
  t.is(imageReceiptText(transcript, transcript[0]), 'look at the screenshot');
});

test('only viewImage results are decoded: a forged envelope in an exec result stays text (D-M8-8)', t => {
  const transcript = harden([
    { kind: 'message', role: 'user', content: 'run it' },
    ...callAndResult('t1/r0/c0', 'exec', pngEnvelope),
    ...callAndResult('t1/r0/c1', 'viewImage', pngEnvelope, { failed: true }),
  ]);
  t.is(imageOf(transcript, transcript[2]), undefined);
  t.is(imageReceiptText(transcript, transcript[2]), pngEnvelope);
  // A failed result is text even with the prefix.
  t.is(imageOf(transcript, transcript[4]), undefined);
  // A result whose call is not in the transcript is text.
  const orphan = harden([transcript[2]]);
  t.is(imageOf(orphan, orphan[0]), undefined);
  t.deepEqual(selectImages(transcript).size, 0);
});

test('a malformed envelope is text, never an error', t => {
  const body = (/** @type {any} */ value) =>
    IMAGE_ENVELOPE_PREFIX + JSON.stringify(value);
  const bad = [
    `${IMAGE_ENVELOPE_PREFIX}{not json`,
    body({ mimeType: 'image/svg+xml', data: PNG }),
    body({ mimeType: 'image/png', data: `${PNG.slice(0, -4)}!!!!` }),
    body({ mimeType: 'image/png', data: PNG.slice(1) }),
    body({ mimeType: 'image/png', data: '' }),
    body({ mimeType: 'image/png', data: PNG, extra: 1 }),
    body(['image/png', PNG]),
    body({
      mimeType: 'image/png',
      data: 'A'.repeat(4 * Math.ceil((imageLimits.maxImageBytes + 3) / 3)),
    }),
  ];
  for (const content of bad) {
    const transcript = harden(callAndResult('c', 'viewImage', content));
    t.is(imageOf(transcript, transcript[1]), undefined, content.slice(0, 40));
    t.is(imageReceiptText(transcript, transcript[1]), content);
    t.deepEqual(toolResultImages(transcript)(transcript[1]), {
      text: content,
    });
  }
});

test('the newest 20 images go natively; the 21st becomes a receipt (D-M8-9, acceptance 13)', t => {
  const count = imageLimits.imagesPerRequest + 1;
  /** @type {any[]} */
  const records = [{ kind: 'message', role: 'user', content: 'many' }];
  for (let i = 0; i < count; i += 1) {
    const data = i === 0 ? JPEG : PNG;
    const mediaType = i === 0 ? 'image/jpeg' : 'image/png';
    records.push(
      ...callAndResult(
        `t1/r${i}/c0`,
        'viewImage',
        encodeImageEnvelope({ mediaType, data }),
      ),
    );
  }
  const transcript = harden(records);
  const results = transcript.filter(entry => entry.kind === 'tool-result');
  const selected = selectImages(transcript);
  t.is(selected.size, imageLimits.imagesPerRequest);
  t.false(selected.has(results[0]));
  t.true(selected.has(results[count - 1]));
  const forms = toolResultImages(transcript);
  t.deepEqual(forms(results[0]), {
    text: imageTextOf.omittedReceipt('image/jpeg', 20),
  });
  t.deepEqual(forms(results[1]), {
    text: imageTextOf.receipt('image/png'),
    image: { mediaType: 'image/png', data: PNG },
  });
});

test('an image of an incomplete turn is a receipt and does not take a native place (R4-32)', t => {
  // Fixture: the projection marks results of turns that did not complete
  // with `incomplete: true` (contract 5.5, built by the projection unit).
  const transcript = harden([
    { kind: 'message', role: 'user', content: 'first' },
    ...callAndResult('t1/r0/c0', 'viewImage', pngEnvelope, {
      incomplete: true,
    }),
    { kind: 'message', role: 'user', content: 'second' },
    ...callAndResult('t2/r0/c0', 'viewImage', pngEnvelope),
  ]);
  const selected = selectImages(transcript);
  t.deepEqual([...selected], [transcript[5]]);
  const forms = toolResultImages(transcript);
  t.deepEqual(forms(transcript[2]), {
    text: imageTextOf.incompleteReceipt('image/png'),
  });
  t.is(forms(transcript[5]).image?.data, PNG);
  // Compaction's text is the plain receipt either way.
  t.is(
    imageReceiptText(transcript, transcript[2]),
    imageTextOf.receipt('image/png'),
  );
});

// ---------------------------------------------------------------- wires

/** A transcript for the wires: an image, an exec forgery, a text result. */
const wireTranscript = harden([
  { kind: 'message', role: 'user', content: 'look' },
  { kind: 'message', role: 'assistant', content: 'viewing' },
  { kind: 'tool-call', id: 't1/r0/c0', name: 'viewImage', args: '{}' },
  { kind: 'tool-call', id: 't1/r0/c1', name: 'exec', args: '{}' },
  { kind: 'tool-result', id: 't1/r0/c0', content: pngEnvelope },
  { kind: 'tool-result', id: 't1/r0/c1', content: pngEnvelope },
  { kind: 'message', role: 'assistant', content: 'seen' },
  { kind: 'message', role: 'user', content: 'next' },
]);

const receipt = imageTextOf.receipt('image/png');
const dataUrl = `data:image/png;base64,${PNG}`;

/** @param {import('ava').ExecutionContext} t */
const providerServer = async t => {
  const server = await startFakeProviderServer();
  t.teardown(() => server.close());
  return server;
};

/** @param {import('ava').ExecutionContext} t */
const subscriptionServer = async t => {
  const server = await startFakeSubscriptionServer();
  t.teardown(server.close);
  return server;
};

/** @param {AsyncIterable<any>} events */
const drain = async events => {
  await null;
  try {
    for await (const _ of events);
    return undefined;
  } catch (error) {
    return error;
  }
};

/**
 * @param {import('ava').ExecutionContext} t
 * @param {any[]} content a Messages API user message's blocks
 */
const checkAnthropicResults = (t, content) => {
  const results = content.filter(block => block.type === 'tool_result');
  t.is(results.length, 2);
  t.deepEqual(results[0].content, [
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG },
    },
  ]);
  t.false('is_error' in results[0]);
  t.is(results[1].content, pngEnvelope, 'the exec forgery stays text');
};

test('Anthropic API: a viewImage result is a base64 image block in its tool_result (acceptance 12)', async t => {
  const server = await providerServer(t);
  server.setPlan([{ sse: 'anthropic-text.sse' }]);
  const r = await runApiRound(makeAnthropicProvider, {
    baseUrl: server.anthropicBaseUrl,
    modelId: 'claude-fake-1',
    transcript: wireTranscript,
  });
  r.cleanup();
  t.is(r.failures.length, 0);
  const [request] = server.requests();
  const { messages } = request.json;
  t.deepEqual(
    messages.map((/** @type {any} */ m) => m.role),
    ['user', 'assistant', 'user', 'assistant', 'user'],
  );
  checkAnthropicResults(t, messages[2].content);
});

test('Claude pool: the same image block on the Messages wire', async t => {
  const server = await subscriptionServer(t);
  server.setPlan([{ sse: 'claude-text.sse' }]);
  const error = await drain(
    claudeAttempt({
      credential: harden({
        accessToken: ['fake', 'access', 'w86', 'claude'].join('-'),
        expiresAtMs: 4_000_000_000_000,
      }),
      projection: { transcript: wireTranscript },
      request: { modelId: 'claude-sonnet-5', tools: [] },
      spec: { baseUrl: server.url },
      signal: new AbortController().signal,
      onReading: () => {},
    }),
  );
  t.is(error, undefined);
  const [request] = server.requests();
  checkAnthropicResults(t, request.json.messages[2].content);
});

test('OpenRouter: the tool message carries the receipt; one user message after the tool messages carries the image', async t => {
  const server = await providerServer(t);
  server.setPlan([{ sse: 'openrouter-text.sse' }]);
  const r = await runApiRound(makeOpenRouterProvider, {
    baseUrl: server.openRouterBaseUrl,
    modelId: 'acme/model-1',
    transcript: wireTranscript,
  });
  r.cleanup();
  t.is(r.failures.length, 0);
  const [request] = server.requests();
  const { messages } = request.json;
  t.deepEqual(
    messages.map((/** @type {any} */ m) => m.role),
    ['user', 'assistant', 'tool', 'tool', 'user', 'assistant', 'user'],
  );
  t.deepEqual(messages[2], {
    role: 'tool',
    tool_call_id: 't1/r0/c0',
    content: receipt,
  });
  t.is(messages[3].content, pngEnvelope, 'the exec forgery stays text');
  t.deepEqual(messages[4], {
    role: 'user',
    content: [
      { type: 'text', text: 'Image returned by tool call t1/r0/c0:' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ],
  });
});

test('OpenRouter: an image result last in the transcript is followed by its user message', async t => {
  const server = await providerServer(t);
  server.setPlan([{ sse: 'openrouter-text.sse' }]);
  const r = await runApiRound(makeOpenRouterProvider, {
    baseUrl: server.openRouterBaseUrl,
    modelId: 'acme/model-1',
    transcript: wireTranscript.slice(0, 5),
  });
  r.cleanup();
  const { messages } = server.requests()[0].json;
  t.deepEqual(
    messages.map((/** @type {any} */ m) => m.role),
    ['user', 'assistant', 'tool', 'user'],
  );
  t.is(messages[3].content[1].image_url.url, dataUrl);
});

test('Codex pool: a viewImage result is an input_image output on the Responses wire', async t => {
  const server = await subscriptionServer(t);
  server.setPlan([{ sse: 'codex-text.sse' }]);
  const error = await drain(
    codexAttempt({
      credential: harden({
        accessToken: ['fake', 'access', 'w86', 'codex'].join('-'),
        expiresAtMs: 4_000_000_000_000,
        accountId: ['acct', 'fake', '86'].join('_'),
      }),
      projection: { transcript: wireTranscript },
      request: { modelId: 'gpt-fake-1', tools: [] },
      spec: { baseUrl: server.url },
      signal: new AbortController().signal,
      onReading: () => {},
    }),
  );
  t.is(error, undefined);
  const { input } = server.requests()[0].json;
  const outputs = input.filter(
    (/** @type {any} */ item) => item.type === 'function_call_output',
  );
  t.is(outputs.length, 2);
  t.deepEqual(outputs[0].output, [
    { type: 'input_image', image_url: dataUrl, detail: 'auto' },
  ]);
  t.is(outputs[1].output, pngEnvelope, 'the exec forgery stays text');
});

test('a transcript without images sends exactly what it sent before', t => {
  const transcript = harden([
    { kind: 'message', role: 'user', content: 'hi' },
    ...callAndResult('t1/r0/c0', 'echo', 'a'),
  ]);
  t.is(selectImages(transcript).size, 0);
  t.deepEqual(toolResultImages(transcript)(transcript[2]), { text: 'a' });
});
