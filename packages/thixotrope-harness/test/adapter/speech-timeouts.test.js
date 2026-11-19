// @ts-check
// The audio path's own timeouts and port bound (`AH/speech/host.js`,
// `route.js`; designs/m11-interfaces.md 4, 5.4, D-M11-10, acceptance 10,
// probe "65 openAudio without sockets" of 14.2): a socket with no HELLO is
// closed `helloDeadline` after `helloMs`; a token not used within
// `tokenMs` is refused and its port forgotten; the 65th `openAudio`
// without sockets is refused `tooManyPorts`, and after `tokenMs` every
// waiting port is forgotten. The host's timeouts are its options (the only
// test lever, contract 3.3); the engine timeouts (`sttIdleMs`,
// `engineTimeoutMs`, `synthTimeoutMs`) are the engines' and are proved in
// their own tests. In-test engines; no supervisor.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { setTimeout as delay } from 'node:timers/promises';

import {
  audioCloseCodes,
  audioLimits,
  speechTexts,
} from '../../resources/agent-host/impl/speech/audio-protocol.js';
import { makeSpeechHost } from '../../resources/agent-host/impl/speech/host.js';
import { makeSpeechText } from '../../resources/agent-host/impl/speech/speech-text.js';
import {
  makeHostContext,
  makeInTestKinds,
  makeVoiceStub,
  openAudioSocket,
  processSettings,
  serveAudio,
} from './_speech-host.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @param {import('ava').ExecutionContext} t
 * @param {{ helloMs?: number, tokenMs?: number }} timeouts
 */
const world = async (t, timeouts) => {
  const stub = makeVoiceStub(processSettings());
  const { kinds } = makeInTestKinds();
  const { context } = makeHostContext({ voice: stub.voice });
  const host = makeSpeechHost({
    context,
    kinds,
    pipeline: harden({
      makeSpeechText,
      openTurnView: async () => harden({ close: () => {} }),
    }),
    options: { timeouts },
  });
  t.teardown(() => host.stop());
  const served = await serveAudio(t, { hostNow: () => host });
  const socket = () =>
    openAudioSocket({ port: served.server.port, origin: served.origin });
  return { host, socket };
};

test('a socket with no HELLO is closed helloDeadline after helloMs', async t => {
  const { socket } = await world(t, { helloMs: 150 });
  const page = await socket();
  const started = Date.now();
  const closed = await page.whenClosed();
  t.is(closed.code, audioCloseCodes.helloDeadline);
  t.is(closed.reason, speechTexts.helloDeadline);
  t.true(Date.now() - started >= 120);
});

test('an unused token expires after tokenMs: refused, its port forgotten', async t => {
  const { host, socket } = await world(t, { tokenMs: 150 });
  const { port, token } = await E(host.speech).openAudio();
  t.is((await E(host.speech).status()).ports, 1);
  await delay(250);
  t.is((await E(host.speech).status()).ports, 0);
  const page = await socket();
  page.hello(token);
  t.is((await page.whenClosed()).code, audioCloseCodes.tokenRefused);
  await t.throwsAsync(() => E(port).transcribe(), {
    message: speechTexts.portClosed,
  });
});

test('the 65th openAudio without sockets is refused; after tokenMs all are forgotten', async t => {
  const { host } = await world(t, { tokenMs: 300 });
  for (let i = 0; i < audioLimits.ports; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await E(host.speech).openAudio();
  }
  await t.throwsAsync(() => E(host.speech).openAudio(), {
    message: speechTexts.tooManyPorts,
  });
  t.is((await E(host.speech).status()).ports, audioLimits.ports);
  await delay(450);
  t.is((await E(host.speech).status()).ports, 0);
  const again = await E(host.speech).openAudio();
  t.regex(again.token, /^[0-9a-f]{64}$/);
});
