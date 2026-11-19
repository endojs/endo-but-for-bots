// @ts-check
/**
 * The `openai-audio` speech kind through the daemon (designs/m11-interfaces.md
 * 6.3, 10, 13 acceptance 15; W11.9): the voice provisioning step names the
 * key by its Secret's label and writes a `ReadGrant` with
 * `HarnessRoot.configureSpeech`; the speech extension reads the key through
 * the grant in the adapter per request (D-M11-22); the fake speech server on
 * 127.0.0.1 stands for the provider.
 *
 * 15. the fake server receives the grant's key as a bearer (it keeps only
 *     the header's SHA-256) for a transcription and a synthesis; a 401
 *     aborts the utterance with `engineFailed`; no event or failure text
 *     carries the key or the provider's body; after a clean stop
 *     `assertNoSecretInState` finds no encoding of the key under the state
 *     directory (logs included) and the supervisor's stderr holds none.
 *
 * `[real-provider]` (owner run): the same with a real provider and key.
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   corepack yarn test:integration test/integration/voice-provider.test.js
 */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

import {
  frameKinds,
  speechTexts,
} from '../../resources/agent-host/impl/speech/audio-protocol.js';
import { emit } from '../../perf/_harness.mjs';
import {
  SPEECH_BODY_MARKER,
  sha256Of,
  startFakeSpeechServer,
} from '../fixtures/fake-speech-server.mjs';
import { makeClip } from '../fixtures/voice-clip.mjs';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, round1, sliceTemplate } from './_m1a-slice.js';
import {
  assertNoSecretInState,
  makeTestSecretValue,
  replaceSealed,
} from './_m2-secrets.js';
import { serveGateway, useTestWrappingKey } from './_m3-gateway.js';
import {
  configureSpeech,
  openSpeechSocket,
  sendClip,
  speechOf,
} from './_voice-speech.js';

takeIntegrationLock(test, 'voice provider test');

const run = integrationEnabled ? test.serial : test.skip;

const KEY_LABEL = 'speech provider key';

run(
  '15: the key reaches the provider as a bearer through its grant and nowhere else; a 401 aborts with engineFailed',
  async t => {
    t.timeout(4 * 60_000);
    const t0 = performance.now();
    const server = await startFakeSpeechServer();
    t.teardown(() => server.close());
    const key = useTestWrappingKey('voice-provider');
    t.teardown(() => key.remove());
    const state = await startFromTemplate(await sliceTemplate(), {
      t,
      secretsKeyFile: key.file,
    });
    const slice = await makeSlice(state);
    const value = makeTestSecretValue('speech');
    const secrets = await E(slice.admin).getSecrets();
    const secret = await E(secrets).create(
      harden({ label: KEY_LABEL, description: 'voice provider test' }),
    );
    await replaceSealed(await E(secrets).openWriter(), secret, value);
    const step = await configureSpeech(
      state,
      harden({
        speechIn: {
          kind: 'openai-audio',
          baseUrl: server.baseUrl,
          model: 'fake-transcribe',
          keyLabel: KEY_LABEL,
        },
        speechOut: {
          kind: 'openai-audio',
          baseUrl: server.baseUrl,
          model: 'fake-speech',
          voices: ['alloy', 'echo'],
          defaultVoice: 'alloy',
          keyLabel: KEY_LABEL,
        },
      }),
    );
    t.false(step.skipped);
    const gateway = await serveGateway(state, { secretsKeyFile: key.file });
    const page = await gateway.connect();
    t.teardown(() => page.close());
    const speech = speechOf(page.powers);
    const configuration = await E(speech).configuration();
    t.true(configuration.speechIn);
    t.true(configuration.speechOut);
    t.deepEqual(
      configuration.voices.map((/** @type {any} */ v) => v.id),
      ['alloy', 'echo'],
    );
    const { socket, port, ready } = await openSpeechSocket(gateway, speech);
    t.like(ready, { speechIn: true, speechOut: true });

    // Speech in: a final from the provider.
    const s0 = performance.now();
    const { stream } = await E(port).transcribe();
    const clip = makeClip({ seconds: 1 });
    await sendClip(socket, stream, clip);
    socket.send(frameKinds.end, stream);
    const final = await socket.event(stream, 'final', 30_000);
    const finalMs = performance.now() - s0;
    t.is(final.text, `final ${clip.length}`);

    // Speech out: PCM per sentence from the provider.
    const p0 = performance.now();
    const replay = await E(speech).replay(
      port,
      harden(['Hello from the provider. A second sentence here.']),
    );
    await socket.event(replay.stream, 'end', 30_000);
    const speakMs = performance.now() - p0;
    t.true(Number(socket.pcmBytes(replay.stream)) > 0);

    // The bearer: the key read through the grant, per request.
    const bearer = sha256Of(`Bearer ${value}`);
    const requests = server.requests();
    t.true(requests.length >= 2);
    t.true(
      requests.every(
        (/** @type {any} */ r) => r.authorizationSha256 === bearer,
      ),
      'every request carried the grant key',
    );

    // A 401: the utterance aborts with engineFailed, no provider body.
    server.setModes(['401']);
    const refused = await E(port).transcribe();
    await sendClip(socket, refused.stream, makeClip({ seconds: 0.5 }));
    socket.send(frameKinds.end, refused.stream);
    const abort = await socket.event(refused.stream, 'abort', 30_000);
    t.is(abort.reason, speechTexts.engineFailed);
    const allEvents = socket.frames
      .filter((/** @type {any} */ f) => f.kind === frameKinds.event)
      .map((/** @type {any} */ f) => f.payload.toString('utf8'))
      .join('\n');
    t.false(allEvents.includes(value), 'no event carries the key');
    t.false(allEvents.includes(SPEECH_BODY_MARKER), 'nor a provider body');
    const status = await E(speech).status();
    t.false(JSON.stringify(status).includes(value));

    // After a clean stop: no encoding of the key in the state or stderr.
    socket.close();
    page.close();
    await state.stop();
    await assertNoSecretInState(t, state.root, {
      value,
      control: KEY_LABEL,
    });
    t.false(String(state.stderrTail()).includes(value), 'not in stderr');
    emit({
      check: 'voice-provider',
      finalMs: round1(finalMs),
      speakMs: round1(speakMs),
      requests: requests.length,
      totalMs: round1(performance.now() - t0),
      by: 'W11.9',
    });
  },
);
