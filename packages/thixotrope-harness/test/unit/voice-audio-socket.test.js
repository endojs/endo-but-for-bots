// @ts-check
// The page's audio socket client (designs/m11-interfaces.md sections 4 and
// 5): frame encode and decode against audio-protocol.js, and the stream
// routing over a fake WebSocket: HELLO, READY, events before the stream's
// number, queued audio, END, ABORT, PCM, close codes and the bounds on what
// the client holds.
import test from '@endo/ses-ava/prepare-endo.js';

import {
  audioCloseCodes,
  audioLimits,
  FRAME_HEADER_BYTES,
  frameKinds,
  speechTexts,
} from '../../resources/agent-host/impl/speech/audio-protocol.js';
import {
  abortFrame,
  audioFrames,
  audioReconnectDelay,
  closeReasonOf,
  decodeFrame,
  decodeServerFrame,
  encodeFrame,
  endFrame,
  helloFrame,
  openAudioSocket,
  tokenBytesOf,
} from '../../ui/src/voice/audio-socket.js';
import { audioReconnectDelaysMs } from '../../ui/src/voice/endpointing-defaults.js';

const encoder = new TextEncoder();
// A token-shaped test value, built at run time.
const TOKEN = ['0a1b2c3d', '4e5f6071'].join('').repeat(4);

/** @param {object} record */
const json = record => encoder.encode(JSON.stringify(record));

/**
 * @param {number} rate
 * @param {Uint8Array} pcm
 */
const pcmPayload = (rate, pcm) => {
  const payload = new Uint8Array(4 + pcm.length);
  new DataView(payload.buffer).setUint32(0, rate);
  payload.set(pcm, 4);
  return payload;
};

const ready = {
  speechIn: true,
  speechOut: true,
  sampleRate: 16_000,
  audioFrameBytes: 65_536,
};

/** A WebSocket stand-in; `server*` methods play the gateway. */
const makeFakeSockets = () => {
  /** @type {any[]} */
  const sockets = [];
  class FakeWebSocket {
    /** @param {string} url */
    constructor(url) {
      this.url = url;
      /** @type {Uint8Array[]} */
      this.sent = [];
      this.bufferedAmount = 0;
      /** @type {{ code: number, reason?: string } | undefined} */
      this.closedWith = undefined;
      /** @type {any} */
      this.onopen = undefined;
      /** @type {any} */
      this.onmessage = undefined;
      /** @type {any} */
      this.onclose = undefined;
      /** @type {any} */
      this.onerror = undefined;
      sockets.push(this);
    }

    /** @param {Uint8Array} bytes */
    send(bytes) {
      this.sent.push(Uint8Array.from(bytes));
    }

    /**
     * @param {number} code
     * @param {string} [reason]
     */
    close(code, reason) {
      this.closedWith = { code, reason };
    }

    serverOpen() {
      this.onopen();
    }

    /** @param {Uint8Array} bytes */
    serverSend(bytes) {
      const copy = Uint8Array.from(bytes);
      this.onmessage({ data: copy.buffer });
    }

    /** @param {number} code */
    serverClose(code) {
      this.onclose({ code, reason: '' });
    }

    /** The client's frames after HELLO, decoded. */
    frames() {
      return this.sent.map(b => /** @type {any} */ (decodeFrame(b)));
    }
  }
  return { sockets, FakeWebSocket };
};

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * A socket past HELLO and READY.
 *
 * @param {(code: number, reason: string) => void} [onClose]
 */
const openReady = async (onClose = () => {}) => {
  const { sockets, FakeWebSocket } = makeFakeSockets();
  const socket = openAudioSocket({
    url: 'ws://127.0.0.1:1/audio',
    token: TOKEN,
    WebSocket: FakeWebSocket,
    onClose,
  });
  const ws = sockets[0];
  ws.serverOpen();
  ws.serverSend(encodeFrame(frameKinds.ready, 0, json(ready)));
  await socket.ready;
  ws.sent.length = 0;
  return { socket, ws };
};

/**
 * A promise and its resolver.
 *
 * @template T
 */
const deferred = () => {
  /** @type {(value: T) => void} */
  let resolve = () => {};
  /** @type {(error: Error) => void} */
  let reject = () => {};
  /** @type {Promise<T>} */
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

test('frames are kind, reserved 0, big-endian stream, payload', t => {
  const frame = encodeFrame(frameKinds.audio, 300, Uint8Array.of(9, 8));
  t.deepEqual([...frame], [frameKinds.audio, 0, 0x01, 0x2c, 9, 8]);
  t.is(FRAME_HEADER_BYTES, 4);
  const decoded = decodeFrame(frame);
  t.is(decoded?.kind, frameKinds.audio);
  t.is(decoded?.stream, 300);
  t.deepEqual([...(decoded?.payload ?? [])], [9, 8]);
  t.is(decodeFrame(encodeFrame(frameKinds.end, 65_535))?.stream, 65_535);
  t.is(decodeFrame(Uint8Array.of(2, 0, 0)), undefined);
  t.is(decodeFrame(Uint8Array.of(2, 1, 0, 1)), undefined);
  t.deepEqual([...endFrame(7)], [frameKinds.end, 0, 0, 7]);
});

test('HELLO carries the 32 token bytes on stream 0', t => {
  const hello = decodeFrame(helloFrame(TOKEN));
  t.is(hello?.kind, frameKinds.hello);
  t.is(hello?.stream, 0);
  t.is(hello?.payload.length, audioLimits.tokenBytes);
  t.deepEqual(
    [...tokenBytesOf(TOKEN).subarray(0, 4)],
    [0x0a, 0x1b, 0x2c, 0x3d],
  );
  t.throws(() => tokenBytesOf('ab'));
  t.throws(() => tokenBytesOf('zz'.repeat(32)));
  t.throws(() => tokenBytesOf(/** @type {any} */ (undefined)));
});

test('AUDIO frames are split at the frame bound and keep whole samples', t => {
  const pcm = new Uint8Array(audioLimits.audioFrameBytes + 101);
  const frames = audioFrames(5, pcm).map(
    f => /** @type {any} */ (decodeFrame(f)),
  );
  t.is(frames.length, 2);
  t.is(frames[0].payload.length, audioLimits.audioFrameBytes);
  t.is(frames[1].payload.length, 100);
  t.true(frames.every(f => f.kind === frameKinds.audio && f.stream === 5));
  t.deepEqual(audioFrames(5, Uint8Array.of(1)), []);
});

test('ABORT reasons are cut at a character boundary', t => {
  const reason = 'é'.repeat(200);
  const frame = /** @type {any} */ (decodeFrame(abortFrame(3, reason)));
  t.is(frame.kind, frameKinds.abort);
  t.true(Number(frame.payload.length) <= audioLimits.reasonBytes);
  t.is(new TextDecoder().decode(frame.payload), 'é'.repeat(128));
  t.is(decodeFrame(abortFrame(3))?.payload.length, 0);
});

test('server frames decode; protocol breaks answer undefined', t => {
  t.deepEqual(
    decodeServerFrame(encodeFrame(frameKinds.ready, 0, json(ready))),
    {
      kind: 'ready',
      ready,
    },
  );
  t.deepEqual(
    decodeServerFrame(
      encodeFrame(frameKinds.event, 3, json({ type: 'partial', text: 'hi' })),
    ),
    { kind: 'event', stream: 3, event: { type: 'partial', text: 'hi' } },
  );
  const pcm = decodeServerFrame(
    encodeFrame(
      frameKinds.pcm,
      4,
      pcmPayload(22_050, Uint8Array.of(1, 2, 3, 4)),
    ),
  );
  t.is(pcm?.kind, 'pcm');
  t.is(/** @type {any} */ (pcm).sampleRate, 22_050);
  t.deepEqual([.../** @type {any} */ (pcm).pcm], [1, 2, 3, 4]);
  t.is(
    /** @type {any} */ (
      decodeServerFrame(
        encodeFrame(frameKinds.pcm, 4, pcmPayload(48_000, new Uint8Array(0))),
      )
    ).sampleRate,
    48_000,
  );

  const bad = [
    Uint8Array.of(frameKinds.event, 1, 0, 3),
    encodeFrame(0x7f, 3, json({ type: 'end' })),
    encodeFrame(frameKinds.audio, 3, Uint8Array.of(0, 0)),
    encodeFrame(frameKinds.ready, 3, json(ready)),
    encodeFrame(frameKinds.event, 0, json({ type: 'end' })),
    encodeFrame(frameKinds.event, 3, encoder.encode('{not json')),
    encodeFrame(frameKinds.event, 3, json([1])),
    encodeFrame(frameKinds.event, 3, json({ text: 'no type' })),
    encodeFrame(frameKinds.event, 3, Uint8Array.of(0xff, 0xfe)),
    encodeFrame(
      frameKinds.event,
      3,
      json({ type: 'partial', text: 'x'.repeat(audioLimits.eventBytes) }),
    ),
    encodeFrame(frameKinds.pcm, 4, Uint8Array.of(0, 0)),
    encodeFrame(frameKinds.pcm, 0, pcmPayload(16_000, Uint8Array.of(0, 0))),
    encodeFrame(
      frameKinds.pcm,
      4,
      pcmPayload(16_000, new Uint8Array(audioLimits.pcmFrameBytes + 2)),
    ),
  ];
  for (const frame of bad) t.is(decodeServerFrame(frame), undefined);
});

test('close codes map to the fixed texts; reconnect delays follow the table', t => {
  t.is(closeReasonOf(audioCloseCodes.helloDeadline), speechTexts.helloDeadline);
  t.is(closeReasonOf(audioCloseCodes.protocol), speechTexts.protocol);
  t.is(closeReasonOf(audioCloseCodes.tokenRefused), speechTexts.tokenRefused);
  t.is(
    closeReasonOf(audioCloseCodes.serviceStopped),
    speechTexts.serviceStopped,
  );
  t.is(closeReasonOf(audioCloseCodes.portClosed), speechTexts.portClosed);
  t.is(closeReasonOf(1006), speechTexts.portClosed);
  t.is(audioReconnectDelay(0), audioReconnectDelaysMs[0]);
  t.is(
    audioReconnectDelay(99),
    audioReconnectDelaysMs[audioReconnectDelaysMs.length - 1],
  );
});

test('the socket sends HELLO on open and resolves READY', async t => {
  const { sockets, FakeWebSocket } = makeFakeSockets();
  const socket = openAudioSocket({
    url: 'ws://127.0.0.1:1/audio',
    token: TOKEN,
    WebSocket: FakeWebSocket,
  });
  const ws = sockets[0];
  t.is(ws.url, 'ws://127.0.0.1:1/audio');
  t.is(ws.binaryType, 'arraybuffer');
  t.is(ws.sent.length, 0);
  ws.serverOpen();
  t.deepEqual(ws.sent[0], helloFrame(TOKEN));
  ws.serverSend(encodeFrame(frameKinds.ready, 0, json(ready)));
  const answered = await socket.ready;
  t.deepEqual(answered, ready);
  t.false(socket.closed());
});

test('an utterance: events before its number are held, audio queued, END after', async t => {
  const { socket, ws } = await openReady();
  const number = /** @type {ReturnType<typeof deferred<number>>} */ (
    deferred()
  );
  /** @type {any[]} */
  const events = [];
  const utterance = socket.utterance(number.promise, {
    onEvent: event => events.push(event),
  });
  utterance.send(Uint8Array.of(1, 2, 3, 4));
  utterance.send(Uint8Array.of(5, 6));
  utterance.end();
  // the server is faster than the CapTP answer
  ws.serverSend(
    encodeFrame(
      frameKinds.event,
      1,
      json({ type: 'phase', phase: 'listening' }),
    ),
  );
  t.is(ws.sent.length, 0);
  t.deepEqual(events, []);
  number.resolve(1);
  await tick();
  t.deepEqual(events, [{ type: 'phase', phase: 'listening' }]);
  const frames = ws.frames();
  t.deepEqual(
    frames.map(f => [f.kind, f.stream, f.payload.length]),
    [
      [frameKinds.audio, 1, 4],
      [frameKinds.audio, 1, 2],
      [frameKinds.end, 1, 0],
    ],
  );
  // after the number, audio goes out at once
  utterance.send(Uint8Array.of(7, 8));
  t.is(ws.frames().at(-1).kind, frameKinds.audio);
  ws.serverSend(
    encodeFrame(frameKinds.event, 1, json({ type: 'partial', text: 'he' })),
  );
  ws.serverSend(
    encodeFrame(frameKinds.event, 1, json({ type: 'final', text: 'hello' })),
  );
  ws.serverSend(encodeFrame(frameKinds.event, 1, json({ type: 'end' })));
  t.deepEqual(await utterance.done, { type: 'end' });
  t.deepEqual(
    events.map(e => e.type),
    ['phase', 'partial', 'final', 'end'],
  );
  // a late frame for the ended stream is dropped, and is not held
  ws.serverSend(
    encodeFrame(frameKinds.event, 1, json({ type: 'partial', text: 'x' })),
  );
  t.is(events.length, 4);
  const sentBefore = ws.sent.length;
  utterance.send(Uint8Array.of(1, 2));
  utterance.end();
  t.is(ws.sent.length, sentBefore);
});

test('aborting before the number sends only the ABORT', async t => {
  const { socket, ws } = await openReady();
  const number = /** @type {ReturnType<typeof deferred<number>>} */ (
    deferred()
  );
  const utterance = socket.utterance(number.promise);
  utterance.send(new Uint8Array(100));
  utterance.end();
  utterance.abort();
  t.deepEqual(await utterance.done, {
    type: 'abort',
    reason: speechTexts.stopped,
  });
  number.resolve(3);
  await tick();
  const frames = ws.frames();
  t.is(frames.length, 1);
  t.is(frames[0].kind, frameKinds.abort);
  t.is(frames[0].stream, 3);
});

test('queued audio over the backlog bound aborts the utterance', async t => {
  const { socket, ws } = await openReady();
  const number = /** @type {ReturnType<typeof deferred<number>>} */ (
    deferred()
  );
  const utterance = socket.utterance(number.promise);
  const block = new Uint8Array(64 * 1024);
  for (
    let sent = 0;
    sent <= audioLimits.sttBacklogBytes;
    sent += block.length
  ) {
    utterance.send(block);
  }
  t.deepEqual(await utterance.done, {
    type: 'abort',
    reason: speechTexts.backlog,
  });
  number.resolve(5);
  await tick();
  t.deepEqual(
    ws.frames().map(f => f.kind),
    [frameKinds.abort],
  );
});

test('a playback gets its PCM; stop sends ABORT and drops later PCM', async t => {
  const { socket, ws } = await openReady();
  /** @type {Array<[number, number[]]>} */
  const chunks = [];
  /** @type {any[]} */
  const events = [];
  // PCM before the number arrives is held and replayed in order
  ws.serverSend(
    encodeFrame(
      frameKinds.event,
      2,
      json({ type: 'phase', phase: 'synthesizing' }),
    ),
  );
  ws.serverSend(
    encodeFrame(frameKinds.pcm, 2, pcmPayload(22_050, Uint8Array.of(1, 0))),
  );
  const playback = socket.playback(Promise.resolve(2), {
    onEvent: event => events.push(event),
    onPcm: (rate, pcm) => chunks.push([rate, [...pcm]]),
  });
  await tick();
  ws.serverSend(
    encodeFrame(frameKinds.pcm, 2, pcmPayload(0, Uint8Array.of(2, 0))),
  );
  ws.serverSend(
    encodeFrame(
      frameKinds.event,
      2,
      json({ type: 'sentence-failed', index: 1 }),
    ),
  );
  t.deepEqual(chunks, [
    [22_050, [1, 0]],
    [0, [2, 0]],
  ]);
  playback.stop();
  t.deepEqual(await playback.done, {
    type: 'abort',
    reason: speechTexts.stopped,
  });
  const abort = ws.frames().at(-1);
  t.is(abort.kind, frameKinds.abort);
  t.is(abort.stream, 2);
  ws.serverSend(
    encodeFrame(frameKinds.pcm, 2, pcmPayload(22_050, Uint8Array.of(3, 0))),
  );
  t.is(chunks.length, 2);
  t.deepEqual(
    events.map(e => e.type),
    ['phase', 'sentence-failed', 'abort'],
  );
});

test('held frames are bounded: the oldest unclaimed stream is dropped and aborts when claimed', async t => {
  const { socket, ws } = await openReady();
  for (let s = 2; s <= 2 + 2 * audioLimits.streamsPerPort; s += 2) {
    ws.serverSend(
      encodeFrame(
        frameKinds.event,
        s,
        json({ type: 'phase', phase: 'synthesizing' }),
      ),
    );
  }
  const dropped = socket.playback(2);
  t.deepEqual(await dropped.done, {
    type: 'abort',
    reason: speechTexts.backlog,
  });
  t.is(ws.frames().at(-1).kind, frameKinds.abort);
  /** @type {any[]} */
  const events = [];
  socket.playback(4, { onEvent: e => events.push(e) });
  await tick();
  t.deepEqual(events, [{ type: 'phase', phase: 'synthesizing' }]);

  // bytes: PCM past pcmBufferedBytes for one unclaimed stream is dropped
  const big = new Uint8Array(audioLimits.pcmFrameBytes);
  for (let sent = 0; sent <= audioLimits.pcmBufferedBytes; sent += big.length) {
    ws.serverSend(encodeFrame(frameKinds.pcm, 40, pcmPayload(22_050, big)));
  }
  const late = socket.playback(40);
  t.deepEqual(await late.done, { type: 'abort', reason: speechTexts.backlog });
});

test('the server closing aborts every stream with the close text', async t => {
  /** @type {Array<[number, string]>} */
  const closes = [];
  const { socket, ws } = await openReady((code, reason) =>
    closes.push([code, reason]),
  );
  const utterance = socket.utterance(1);
  const playback = socket.playback(2);
  ws.serverClose(audioCloseCodes.serviceStopped);
  t.deepEqual(await utterance.done, {
    type: 'abort',
    reason: speechTexts.serviceStopped,
  });
  t.deepEqual(await playback.done, {
    type: 'abort',
    reason: speechTexts.serviceStopped,
  });
  t.true(socket.closed());
  t.deepEqual(closes, [[audioCloseCodes.serviceStopped, '']]);
  // a stream opened after the close aborts at once
  const after = socket.utterance(3);
  t.deepEqual(await after.done, {
    type: 'abort',
    reason: speechTexts.serviceStopped,
  });
});

test('a refused token rejects READY', async t => {
  const { sockets, FakeWebSocket } = makeFakeSockets();
  const socket = openAudioSocket({
    url: 'ws://127.0.0.1:1/audio',
    token: TOKEN,
    WebSocket: FakeWebSocket,
  });
  sockets[0].serverOpen();
  sockets[0].serverClose(audioCloseCodes.tokenRefused);
  await t.throwsAsync(socket.ready, { message: speechTexts.tokenRefused });
});

test('a malformed server frame closes the socket with the protocol code', async t => {
  const { socket, ws } = await openReady();
  ws.serverSend(Uint8Array.of(frameKinds.event, 9, 0, 1));
  t.is(ws.closedWith?.code, audioCloseCodes.protocol);
  ws.onmessage({ data: 'text frame' });
  t.false(socket.closed());
  ws.serverClose(audioCloseCodes.protocol);
  t.true(socket.closed());
});

test('a rejected stream call aborts with its text; close() ends the socket', async t => {
  const { socket, ws } = await openReady();
  const refused = socket.playback(
    Promise.reject(Error(speechTexts.speechOutOff)),
  );
  t.deepEqual(await refused.done, {
    type: 'abort',
    reason: speechTexts.speechOutOff,
  });
  const open = socket.utterance(1);
  ws.bufferedAmount = 1234;
  t.is(socket.bufferedBytes(), 1234);
  socket.close();
  t.is(ws.closedWith?.code, 1000);
  t.deepEqual(await open.done, {
    type: 'abort',
    reason: speechTexts.portClosed,
  });
});
