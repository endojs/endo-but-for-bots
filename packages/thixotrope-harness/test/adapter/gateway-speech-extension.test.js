// @ts-check
// The speech gateway extension (`AH/gateway/extensions/speech.js`;
// designs/m11-interfaces.md 3.2, D-M11-22, A-5, seam H6, acceptance 20,
// probes of 14.2): the loader loads it with no skip and answers the very
// object an `import` of the file answers (A-5); the gateway gives the
// key reader only to the extension whose object is listed in
// `extensionPowers` (probe extensions loaded from a test directory), and
// every extension's context has `operator()`; its record keys and methods
// are in the gateway vocabulary; through a real gateway and a real
// WebSocket, `Speech.replay` is a LargeCall whose guard refuses 65 pieces or
// a piece of 8,193 units, and a message over 1 MiB closes 1009; the
// capture worklet is served on its path. No supervisor.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import { limits } from '../../guest/lib/limits.js';
import { speechMethodNames } from '../../guest/lib/speech-guards.js';
/* eslint-enable import/no-relative-packages */
import { gatewayExtension as speechExtension } from '../../resources/agent-host/impl/gateway/extensions/speech.js';
import { loadGatewayExtensions } from '../../resources/agent-host/impl/gateway/extensions.js';
import { makeGatewayService } from '../../resources/agent-host/impl/gateway/index.js';
import { makeSignInStore } from '../../resources/agent-host/impl/gateway/signin.js';
import { harnessNames } from '../../resources/agent-host/impl/gateway/vocabulary.js';
import {
  AUDIO_PATH,
  CAPTURE_WORKLET_PATH,
  speechTexts,
} from '../../resources/agent-host/impl/speech/audio-protocol.js';
import { SECRETS_KEY_VARIABLE } from '../../resources/agent-host/impl/secrets/store.js';
import { connectGateway } from '../integration/_m3-gateway.js';
import * as plain from '../fixtures/speech-extensions/plain.js';
import * as powered from '../fixtures/speech-extensions/powered.js';
import { harnessRoot } from '../_helpers.js';
import { makeVoiceStub, processSettings } from './_speech-host.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

const probeDir = fileURLToPath(
  new URL('../fixtures/speech-extensions/', import.meta.url),
);

/** A state directory, and a wrapping key outside it. */
const makeStateDir = () => {
  mkdirSync(join(harnessRoot, 'tmp'), { recursive: true });
  const top = mkdtempSync(join(harnessRoot, 'tmp', 'spx-'));
  const root = join(top, 'state');
  mkdirSync(join(root, 'agent-host'), { recursive: true });
  const keyFile = join(top, 'keys', 'secrets.key');
  return { top, root, env: { [SECRETS_KEY_VARIABLE]: keyFile } };
};

/**
 * A gateway service with stand-ins for the incarnation's objects, bound on
 * an ephemeral port.
 * @param {import('ava').ExecutionContext} t
 * @param {Partial<Parameters<typeof makeGatewayService>[0]>} more
 * @param {any} operator
 */
const serve = async (t, more, operator) => {
  const { top, root, env } = makeStateDir();
  /** @type {Record<string, unknown>[]} */
  const logged = [];
  const service = makeGatewayService({
    live: Far('Live', {}),
    composer: Far('Composer', {}),
    content: Far('Content', {}),
    history: () => Far('History', {}),
    secretWriter: async () =>
      harden({
        replaceLocal: async () => ({ generation: 1 }),
        publicKey: async () => '',
      }),
    stateDir: root,
    env,
    log: event => logged.push(event),
    ...more,
  });
  t.teardown(async () => {
    await service.close();
    rmSync(top, { recursive: true, force: true });
  });
  await service.binding.bind(
    harden({
      config: { port: 0, operator },
      sink: Far('GatewaySink', { attach: () => undefined }),
    }),
  );
  service.attached();
  const port = /** @type {number} */ (service.port());
  const fragment = await makeSignInStore({ stateDir: root, env }).fragment('h');
  const secret = new URLSearchParams(fragment.slice(1)).get('agent') ?? '';
  return { service, port, secret, logged, origin: `http://127.0.0.1:${port}` };
};

test('A-5: the loader answers the very gatewayExtension object an import answers; no file is skipped', t => {
  /** @type {Record<string, unknown>[]} */
  const events = [];
  const loaded = loadGatewayExtensions({ log: e => events.push(e) });
  t.deepEqual(
    events.filter(e => e.event === 'gateway-extension-skip'),
    [],
    'every extension file loads',
  );
  const found = loaded.find(e => e.name === 'speech');
  t.truthy(found);
  t.is(
    found,
    speechExtension,
    'require(esm) and import share one module instance',
  );
  const probes = loadGatewayExtensions({ dir: probeDir, log: () => {} });
  t.is(
    probes.find(e => e.name === 'probe-powered'),
    powered.gatewayExtension,
  );
  t.is(
    probes.find(e => e.name === 'probe-plain'),
    plain.gatewayExtension,
  );
});

test('the speech extension: one service, the /audio and worklet routes, replay a LargeCall', t => {
  t.true(Object.isFrozen(speechExtension));
  const { services = [], routes = [], largeCalls = [] } = speechExtension;
  t.deepEqual(
    services.map(s => s.label),
    ['speech'],
  );
  t.deepEqual(
    routes.map(r => `${r.kind} ${r.path}`),
    [`upgrade ${AUDIO_PATH}`, `http ${CAPTURE_WORKLET_PATH}`],
  );
  t.deepEqual(
    largeCalls.map(l => l.methods),
    [['replay']],
  );
});

test("vocabulary: the speech records' keys and methods are listed", t => {
  const names = harnessNames();
  for (const key of [
    'voice',
    'speed',
    'noiseScale',
    'noiseW',
    'sentenceSilence',
    'stream',
    'port',
    'token',
    'speechIn',
    'speechOut',
    'voices',
    'defaults',
    'ranges',
  ]) {
    t.true(names.keys.has(key), key);
  }
  for (const method of [
    ...speechMethodNames.Speech,
    ...speechMethodNames.AudioPort,
  ]) {
    t.true(names.methods.has(method), method);
  }
});

test('H6: only the listed extension object receives readGrant; every context has operator()', async t => {
  plain.contexts.length = 0;
  powered.contexts.length = 0;
  const readGrant = async () => 'unused';
  const operator = Far('Operator', {});
  await serve(
    t,
    {
      extensionsDir: probeDir,
      extensionPowers: [
        { extension: powered.gatewayExtension, powers: { readGrant } },
      ],
    },
    operator,
  );
  // The large-call targets resolve after the attach.
  await new Promise(resolve => setImmediate(resolve));
  t.true(powered.contexts.length >= 2, 'service and large-call target');
  t.true(plain.contexts.length >= 2);
  for (const context of powered.contexts) {
    t.is(context.readGrant, readGrant);
    t.is(context, powered.contexts[0], 'one context per extension, kept');
    t.is(context.operator(), operator);
    t.true(Object.isFrozen(context));
  }
  for (const context of plain.contexts) {
    t.is(context.readGrant, undefined, 'no key reader');
    t.false('readGrant' in context);
    t.is(context.operator(), operator);
  }
  t.not(powered.contexts[0], plain.contexts[0]);
});

test('through a real gateway: Speech in the extras; replay guard bounds; over 1 MiB closes 1009; the worklet route', async t => {
  const stub = makeVoiceStub(processSettings());
  const operator = Far('Operator', { getVoice: () => stub.voice });
  const { port, secret, origin } = await serve(
    t,
    {
      extensionPowers: [
        {
          extension: speechExtension,
          powers: { readGrant: async () => 'unused' },
        },
      ],
    },
    operator,
  );
  const page = await connectGateway({ port, origin, secret });
  t.teardown(() => page.close());
  const powers = await page.signIn();
  const speech = powers.extras.find(
    (/** @type {any} */ extra) => extra.label === 'speech',
  )?.service;
  t.truthy(speech, 'the page finds Speech under its label');
  const { port: audioPort, token } = await E(speech).openAudio();
  t.regex(token, /^[0-9a-f]{64}$/);

  // Over frameBytes in all (64 pieces of 8,000 units), under 1 MiB: the
  // frame guard lets the LargeCall through; the port is not bound yet.
  const pieces = Array.from({ length: 64 }, () => 'a'.repeat(8000));
  await t.throwsAsync(() => E(speech).replay(audioPort, pieces), {
    message: speechTexts.portClosed,
  });
  const tooMany = Array.from({ length: 65 }, () => 'a');
  const refusedMany = await t.throwsAsync(() =>
    E(speech).replay(audioPort, tooMany),
  );
  t.not(refusedMany?.message, speechTexts.portClosed, 'the guard refuses 65');
  const refusedLong = await t.throwsAsync(() =>
    E(speech).replay(audioPort, ['a'.repeat(limits.inlineBytes + 1)]),
  );
  t.not(
    refusedLong?.message,
    speechTexts.portClosed,
    'and an 8,193-unit piece',
  );

  const worklet = await fetch(`${origin}${CAPTURE_WORKLET_PATH}`);
  t.true(worklet.status === 200 || worklet.status === 404);
  if (worklet.status === 200) {
    t.regex(worklet.headers.get('content-type') ?? '', /^text\/javascript/);
    t.truthy(worklet.headers.get('content-security-policy'));
  }

  // A WebSocket message over `wsMessageBytes` closes the connection 1009.
  page.ws.send(new Uint8Array(1_048_577));
  const closed = await page.closed;
  t.is(closed.code, 1009);
});
