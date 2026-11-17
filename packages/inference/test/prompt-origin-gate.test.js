// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { makePromptOriginGate } from '../src/prompt-origin-gate.js';
import { makeRecordingBackend, makeRequest } from './_fixtures.js';

/** @import { InferResult } from '../src/types.js' */

/** @type {InferResult} */
const ok = harden({ type: 'ok', text: 'done' });

test('a root-authored request reaches the wrapped backend', async t => {
  const { backend, requests } = makeRecordingBackend(ok);
  const gate = makePromptOriginGate(backend);
  const request = makeRequest({ promptOrigin: 'root-authored' });
  t.deepEqual(await gate.infer(request), ok);
  t.is(requests.length, 1);
  t.is(requests[0].prompt, request.prompt);
});

for (const promptOrigin of [
  'guest-influenced',
  undefined,
  'Root-Authored',
  '',
]) {
  test(`origin ${JSON.stringify(promptOrigin)} is refused before the backend`, async t => {
    const { backend, requests } = makeRecordingBackend(ok);
    const gate = makePromptOriginGate(backend);
    const request =
      promptOrigin === undefined
        ? makeRequest()
        : makeRequest({ promptOrigin });
    t.deepEqual(await gate.infer(request), { type: 'needs-containment' });
    t.is(requests.length, 0);
  });
}

test('the gate describes the wrapped backend', t => {
  const { backend } = makeRecordingBackend(ok, {
    provider: 'anthropic',
    kind: 'claude-cli',
    version: '2.1.278',
  });
  t.deepEqual(makePromptOriginGate(backend).describe(), {
    provider: 'anthropic',
    kind: 'claude-cli',
    version: '2.1.278',
  });
});

test('other tags from the wrapped backend pass through unchanged', async t => {
  /** @type {InferResult} */
  const needsAuth = harden({ type: 'needs-auth' });
  const { backend } = makeRecordingBackend(needsAuth);
  const gate = makePromptOriginGate(backend);
  t.is(
    await gate.infer(makeRequest({ promptOrigin: 'root-authored' })),
    needsAuth,
  );
});
