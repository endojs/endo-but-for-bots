// @ts-check
// The `/audio` socket of the speech host (`AH/speech/route.js`,
// `host.js`, `playback.js`; designs/m11-interfaces.md 4, acceptance 1, 11,
// 17, probes of 14.2): a Node `WebSocket` client against
// `makeGatewayServer` with the route. HELLO and READY; an utterance's
// cumulative partials, its final after END, ABORT and the socket closing;
// a too-large AUDIO frame aborts its stream only; a message over 1 MiB
// closes 1009; malformed frames close `protocol`; wrong, used and second
// tokens close `tokenRefused` (1,000 of them, no port left); a foreign
// Origin is refused 403; replay of inline and Blob pieces; speak, its
// replacement by a newer playback and the page's ABORT; a page that does
// not read PCM pauses synthesis. In-test engines (`_speech-host.js`); no
// supervisor.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { Buffer } from 'node:buffer';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import { interfaces } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { gatewayTexts } from '../../resources/agent-host/impl/gateway/protocol.js';
import {
  AUDIO_PATH,
  audioCloseCodes,
  frameKinds,
  sttFormat,
  speechTexts,
} from '../../resources/agent-host/impl/speech/audio-protocol.js';
import { makeSpeechHost } from '../../resources/agent-host/impl/speech/host.js';
import { encodeFrame } from '../../resources/agent-host/impl/speech/route.js';
import { makeSpeechText } from '../../resources/agent-host/impl/speech/speech-text.js';
import {
  makeHostContext,
  makeInTestKinds,
  makeVoiceStub,
  openAudioSocket,
  processSettings,
  serveAudio,
  settle,
} from './_speech-host.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, makeExo } = /** @type {GuestGlobals} */ (globalThis);

/**
 * A `Content` with the real guard whose Blobs are texts of this test.
 * @param {Map<any, string>} blobs
 */
const makeContent = blobs =>
  makeExo('Content', /** @type {any} */ (interfaces.Content), {
    /**
     * @param {any} blob
     * @param {{ offset: number, maxBytes: number }} range
     */
    read: async (blob, { offset, maxBytes }) => {
      const text = blobs.get(blob) ?? '';
      const next = Math.min(text.length, offset + maxBytes);
      return harden({
        text: text.slice(offset, next),
        next,
        done: next === text.length,
      });
    },
  });

/**
 * A host with in-test engines, a stand-in speech view (the view is
 * `turn-view.js`'s subject) and a served `/audio` route.
 * @param {import('ava').ExecutionContext} t
 * @param {object} [options]
 * @param {Parameters<typeof makeInTestKinds>[0]} [options.modes]
 * @param {Record<string, number>} [options.limits]
 * @param {Record<string, number>} [options.serverLimits]
 */
const world = async (t, { modes, limits, serverLimits } = {}) => {
  const stub = makeVoiceStub(processSettings());
  const { kinds, seen } = makeInTestKinds(modes);
  /** @type {Map<any, string>} */
  const blobs = new Map();
  const { context } = makeHostContext({
    voice: stub.voice,
    content: makeContent(blobs),
  });
  /** @type {{ sink: any, turnId: string, closed: number }[]} */
  const views = [];
  const pipeline = harden({
    makeSpeechText,
    /** @param {any} options */
    openTurnView: async ({ sink, turnId }) => {
      const view = { sink, turnId, closed: 0 };
      views.push(view);
      if (turnId === 'old') throw Error(speechTexts.turnNotLive);
      return harden({
        close: () => {
          view.closed += 1;
        },
      });
    },
  });
  const host = makeSpeechHost({
    context,
    kinds,
    pipeline,
    ...(limits === undefined ? {} : { options: { limits } }),
  });
  t.teardown(() => host.stop());
  const served = await serveAudio(t, {
    hostNow: () => host,
    ...(serverLimits === undefined ? {} : { limits: serverLimits }),
  });
  const { port } = served.server;
  const open = async () => {
    const grant = await E(host.speech).openAudio();
    const socket = await openAudioSocket({ port, origin: served.origin });
    t.teardown(() => socket.close());
    socket.hello(grant.token);
    const ready = await socket.ready();
    return { ...grant, socket, ready };
  };
  return { host, served, seen, blobs, views, open, stub };
};

test('HELLO answers READY; an utterance: listening, cumulative partials, END, final, end; the odd byte dropped', async t => {
  const { open, seen } = await world(t);
  const { port, socket, ready } = await open();
  t.deepEqual(ready, {
    speechIn: true,
    speechOut: true,
    sampleRate: sttFormat.sampleRate,
    audioFrameBytes: 65_536,
  });
  const { stream } = await E(port).transcribe();
  t.is(stream % 2, 1, 'utterances are odd');
  await socket.event(stream, 'phase');
  const block = new Uint8Array(sttFormat.blockBytes);
  socket.send(frameKinds.audio, stream, block);
  socket.send(frameKinds.audio, stream, block);
  socket.send(
    frameKinds.audio,
    stream,
    new Uint8Array(sttFormat.blockBytes + 1),
  );
  await socket.until(() =>
    socket.eventsOf(stream).filter(e => e.type === 'partial').length === 3
      ? true
      : undefined,
  );
  socket.send(frameKinds.end, stream);
  const final = await socket.event(stream, 'final');
  t.is(final.text, `final ${3 * sttFormat.blockBytes}`);
  await socket.event(stream, 'end');
  const events = socket.eventsOf(stream);
  t.deepEqual(
    events.map(e => (e.type === 'phase' ? `phase ${e.phase}` : e.type)),
    [
      'phase listening',
      'partial',
      'partial',
      'partial',
      'phase transcribing',
      'final',
      'end',
    ],
  );
  t.deepEqual(
    events.filter(e => e.type === 'partial').map(e => e.text),
    ['2720 bytes', '5440 bytes', '8160 bytes'],
    'each partial is the whole text so far',
  );
  t.deepEqual(seen.utteranceLog, [
    'audio 2720',
    'audio 2720',
    'audio 2721',
    'end',
  ]);
});

test('ABORT, and the socket closing, abort the utterance; the port is forgotten', async t => {
  const { open, seen, host } = await world(t);
  const first = await open();
  const one = await E(first.port).transcribe();
  first.socket.send(frameKinds.abort, one.stream);
  await settle();
  t.deepEqual(seen.utteranceLog, ['abort']);
  const two = await E(first.port).transcribe();
  t.not(two.stream, one.stream);
  first.socket.send(frameKinds.audio, two.stream, new Uint8Array(4));
  await settle();
  first.socket.close();
  await first.socket.whenClosed();
  await settle();
  t.deepEqual(seen.utteranceLog, ['abort', 'audio 4', 'abort']);
  const status = await E(host.speech).status();
  t.is(status.ports, 0);
  t.is(status.streams, 0);
  await t.throwsAsync(() => E(first.port).transcribe(), {
    message: speechTexts.portClosed,
  });
});

test('an AUDIO frame over audioFrameBytes aborts its utterance only; a message over 1 MiB closes 1009', async t => {
  const { open } = await world(t);
  const { port, socket } = await open();
  const { stream } = await E(port).transcribe();
  socket.send(frameKinds.audio, stream, new Uint8Array(65_537));
  const aborted = await socket.event(stream, 'abort');
  t.is(aborted.reason, speechTexts.frameTooLarge);
  // Late frames of the stream the server ended are ignored.
  socket.send(frameKinds.audio, stream, new Uint8Array(2));
  const again = await E(port).transcribe();
  socket.send(frameKinds.end, again.stream);
  await socket.event(again.stream, 'final');
  t.is(socket.closed(), undefined, 'the socket stays');
  socket.ws.send(new Uint8Array(1_048_577));
  const closed = await socket.whenClosed();
  t.is(closed.code, 1009);
});

test('malformed frames close the socket with protocol', async t => {
  const { open, served, host } = await world(t);
  const { port: serverPort } = served.server;

  // A frame before HELLO.
  const early = await openAudioSocket({
    port: serverPort,
    origin: served.origin,
  });
  early.send(frameKinds.audio, 1, new Uint8Array(2));
  t.is((await early.whenClosed()).code, audioCloseCodes.protocol);

  /**
   * @param {(page: Awaited<ReturnType<typeof open>>) => Promise<void> | void} act
   */
  const closesProtocol = async act => {
    const page = await open();
    await act(page);
    const closed = await page.socket.whenClosed();
    t.is(closed.code, audioCloseCodes.protocol);
  };
  await closesProtocol(({ socket }) => socket.send(0x7f, 1));
  await closesProtocol(({ socket }) => {
    const frame = encodeFrame(frameKinds.end, 1);
    frame[1] = 1;
    socket.ws.send(new Uint8Array(frame));
  });
  await closesProtocol(({ socket }) => socket.send(frameKinds.end, 9));
  await closesProtocol(({ socket, token }) => socket.hello(token));
  await closesProtocol(async ({ socket, port }) => {
    const { stream } = await E(port).transcribe();
    socket.send(frameKinds.end, stream);
    await socket.event(stream, 'end');
    socket.send(frameKinds.end, stream);
  });
  await closesProtocol(async ({ socket, port }) => {
    const { stream } = await E(port).transcribe();
    socket.send(frameKinds.end, stream);
    // AUDIO after the page's own END.
    socket.send(frameKinds.audio, stream, new Uint8Array(2));
  });
  await settle();
  t.is((await E(host.speech).status()).ports, 0);
});

test('tokens: wrong, used, and a second socket for a bound port are refused; 1,000 wrong tokens leave no port', async t => {
  const { open, served, host } = await world(t);
  const { port: serverPort } = served.server;
  const first = await open();

  const used = await openAudioSocket({
    port: serverPort,
    origin: served.origin,
  });
  used.hello(first.token);
  t.is((await used.whenClosed()).code, audioCloseCodes.tokenRefused);

  const grant = await E(host.speech).openAudio();
  const short = await openAudioSocket({
    port: serverPort,
    origin: served.origin,
  });
  short.send(
    frameKinds.hello,
    0,
    Buffer.from(grant.token, 'hex').subarray(0, 31),
  );
  t.is((await short.whenClosed()).code, audioCloseCodes.protocol);

  const before = (await E(host.speech).status()).ports;
  const wrong = 'ab'.repeat(32);
  for (let round = 0; round < 125; round += 1) {
    // eslint-disable-next-line no-await-in-loop
    const codes = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const page = await openAudioSocket({
          port: serverPort,
          origin: served.origin,
        });
        page.hello(wrong);
        return (await page.whenClosed()).code;
      }),
    );
    t.true(codes.every(code => code === audioCloseCodes.tokenRefused));
  }
  await settle();
  t.is((await E(host.speech).status()).ports, before, 'no port leaks');
  t.is(served.server.connections(), 1, 'only the first page is connected');
  const good = await open();
  t.truthy(good.ready, 'connection bounds hold and new pages still bind');
});

test('a foreign Origin is refused 403 on /audio', async t => {
  const { served } = await world(t);
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: served.server.port,
      path: AUDIO_PATH,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.alloc(16, 7).toString('base64'),
        Origin: 'http://elsewhere.invalid',
      },
    });
    request.on('response', response => {
      resolve(response.statusCode);
      response.resume();
    });
    request.on('upgrade', () => reject(Error('upgraded')));
    request.on('error', reject);
    request.end();
  });
  t.is(status, 403);
  t.is(gatewayTexts.originRefused, 'Origin not allowed');
});

test('replay: inline and Blob pieces are spoken; PCM frames carry the rate; end', async t => {
  const { open, host, blobs, seen } = await world(t);
  const { port, socket } = await open();
  const blob = Far('Blob', {});
  blobs.set(blob, 'The staged part is read through Content. ');
  const { stream } = await E(host.speech).replay(port, [
    'First inline sentence here.',
    blob,
  ]);
  t.is(stream % 2, 0, 'playbacks are even');
  await socket.event(stream, 'end');
  t.deepEqual(seen.sentences, [
    'First inline sentence here.',
    'The staged part is read through Content.',
  ]);
  const pcm = socket.frames.filter(
    f => f.kind === frameKinds.pcm && f.stream === stream,
  );
  t.true(pcm.length >= 2);
  t.true(pcm.every(f => f.payload.readUInt32BE(0) === 22_050));
  t.is(
    socket.pcmBytes(stream),
    2 * seen.sentences.reduce((sum, s) => sum + s.length, 0),
  );
  t.is(socket.eventsOf(stream)[0].phase, 'synthesizing');
});

test('speak: the view feeds the playback; a newer one replaces it; the page ABORT stops synthesis, not the turn', async t => {
  const { open, views, seen } = await world(t);
  const { port, socket } = await open();
  const session = Far('Session', {});
  const first = await E(port).speak(session, 't1');
  const [view] = views;
  view.sink.text('Hello there, this is the reply. ');
  await settle();
  t.deepEqual(seen.sentences, ['Hello there, this is the reply.']);
  const second = await E(port).speak(session, 't1');
  const aborted = await socket.event(first.stream, 'abort');
  t.is(aborted.reason, speechTexts.replaced);
  t.is(view.closed, 1, 'the replaced view is closed');
  socket.send(frameKinds.abort, second.stream);
  await settle();
  t.is(views[1].closed, 1);
  t.is(seen.synthesisAborts, 2);
  t.is(
    socket.eventsOf(second.stream).filter(e => e.type === 'abort').length,
    0,
    'the page stopped it: no event',
  );
  await t.throwsAsync(() => E(port).speak(session, 'old'), {
    message: speechTexts.turnNotLive,
  });
  await settle();
  t.is(socket.closed(), undefined);
});

test('a page that never reads PCM pauses synthesis; the 8 MiB send bound is never reached', async t => {
  const { host, served, blobs, seen } = await world(t, {
    modes: { pcmPerUnit: 32 },
  });
  const grant = await E(host.speech).openAudio();
  // A raw client that reads the handshake, then stops reading.
  const raw = connect(served.server.port, '127.0.0.1');
  await new Promise(resolve => raw.once('connect', resolve));
  raw.write(
    [
      `GET ${AUDIO_PATH} HTTP/1.1`,
      `Host: 127.0.0.1:${served.server.port}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${Buffer.alloc(16, 3).toString('base64')}`,
      `Origin: ${served.origin}`,
      '',
      '',
    ].join('\r\n'),
  );
  /** @type {Buffer[]} */
  const received = [];
  const onData = (/** @type {Buffer} */ chunk) => received.push(chunk);
  raw.on('data', onData);
  t.teardown(() => raw.destroy());
  await delay(50);
  // HELLO, masked (all-zero mask).
  const hello = encodeFrame(
    frameKinds.hello,
    0,
    Buffer.from(grant.token, 'hex'),
  );
  raw.write(
    Buffer.concat([
      Buffer.from([0x82, 0x80 + hello.length, 0, 0, 0, 0]),
      hello,
    ]),
  );
  await delay(100);
  raw.off('data', onData);
  raw.pause();
  const blob = Far('Blob', {});
  // 2.5 Mi units: 80 MiB of PCM from the in-test engine, far over what
  // the kernel's socket buffers take.
  blobs.set(blob, 'Some words go here. '.repeat(131_072));
  void E(host.speech)
    .replay(grant.port, [blob])
    .catch(() => {});
  await delay(1500);
  const paused = seen.pcmBytes;
  await delay(500);
  t.true(paused > 0);
  t.is(seen.pcmBytes, paused, 'synthesis waits on the socket');
  t.true(paused < 80 * 1024 * 1024, 'not every byte was produced');
  const status = await E(host.speech).status();
  t.log({ pausedAt: paused });
  t.is(status.ports, 1, 'not closed by the send bound');
  t.is(status.streams, 1, 'the playback is paused, not over');
  t.is(raw.destroyed, false);
  // Reading again resumes it.
  raw.resume();
  await delay(1000);
  t.true(seen.pcmBytes > paused);
});
