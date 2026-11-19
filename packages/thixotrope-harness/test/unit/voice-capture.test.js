// @ts-check
// Microphone capture (designs/m11-interfaces.md section 9; R5-3, R5-44,
// R5-68): the worklet's resampler and processor in Node, its registration
// in a worklet-like scope, and `openCapture` over fake media devices, a
// fake AudioContext and a fake AudioWorkletNode.
import test from '@endo/ses-ava/prepare-endo.js';

import {
  CAPTURE_WORKLET_PATH,
  sttFormat,
} from '../../resources/agent-host/impl/speech/audio-protocol.js';
import {
  CAPTURE_PROCESSOR_NAME,
  makeCaptureProcessor,
  makeCaptureResampler,
} from '../../resources/agent-host/impl/speech/capture-worklet.js';
import { captureFailureOf, openCapture } from '../../ui/src/voice/capture.js';
import {
  captureBlockSamples,
  captureConstraints,
} from '../../ui/src/voice/endpointing-defaults.js';

const QUANTUM = 128;

/**
 * Feed `total` samples of `value` in render quanta.
 *
 * @param {{ push: (input: Float32Array) => void }} resampler
 * @param {number} total
 * @param {(i: number) => number} valueAt
 */
const feed = (resampler, total, valueAt) => {
  for (let at = 0; at < total; at += QUANTUM) {
    const quantum = new Float32Array(Math.min(QUANTUM, total - at));
    for (let i = 0; i < quantum.length; i += 1) quantum[i] = valueAt(at + i);
    resampler.push(quantum);
  }
};

/** @param {number} inRate */
const collect = inRate => {
  /** @type {Array<{ samples: Int16Array, rms: number }>} */
  const blocks = [];
  const resampler = makeCaptureResampler({
    inRate,
    outRate: sttFormat.sampleRate,
    blockSamples: captureBlockSamples,
    onBlock: (pcm, rms) => blocks.push({ samples: new Int16Array(pcm), rms }),
  });
  return { resampler, blocks };
};

test('48 kHz averages down to 16 kHz in 1,360-sample blocks across quanta', t => {
  const { resampler, blocks } = collect(48_000);
  feed(resampler, 3 * captureBlockSamples - 1, () => 0.5);
  t.is(blocks.length, 0);
  feed(resampler, 1, () => 0.5);
  t.is(blocks.length, 1);
  t.is(blocks[0].samples.length, captureBlockSamples);
  t.is(blocks[0].samples.byteLength, sttFormat.blockBytes);
  t.true(blocks[0].samples.every(s => s === 16_383));
  t.true(Math.abs(blocks[0].rms - 0.5) < 1e-6);
  // a ramp: each output is the mean of its three inputs
  const ramp = collect(48_000);
  feed(ramp.resampler, 3 * captureBlockSamples, i => (i % 3) / 4);
  t.true(ramp.blocks[0].samples.every(s => s === Math.trunc(0.25 * 32_767)));
});

test('44.1 kHz loses no sample over one second; 8 kHz is repeated up', t => {
  const { resampler, blocks } = collect(44_100);
  feed(resampler, 44_100 * 2, () => 0.1);
  // two seconds is 32,000 samples: 23 whole blocks (31,280)
  t.is(blocks.length, Math.floor(32_000 / captureBlockSamples));
  const up = collect(8000);
  feed(up.resampler, captureBlockSamples / 2, i => (i % 2 ? -1 : 1));
  t.is(up.blocks.length, 1);
  t.deepEqual(
    [...up.blocks[0].samples.subarray(0, 4)],
    [32_767, 32_767, -32_768, -32_768],
  );
  t.is(up.blocks[0].rms, 1);
});

test('samples outside [-1, 1] are clamped', t => {
  const { resampler, blocks } = collect(16_000);
  feed(resampler, captureBlockSamples, i => (i % 2 ? -3 : 3));
  t.is(blocks[0].samples[0], 32_767);
  t.is(blocks[0].samples[1], -32_768);
  t.throws(() =>
    makeCaptureResampler({
      inRate: 0,
      outRate: 16_000,
      blockSamples: 1,
      onBlock: () => {},
    }),
  );
});

/** An `AudioWorkletProcessor` stand-in: a port the test reads. */
class FakeProcessorBase {
  constructor() {
    /** @type {Array<[any, any[]]>} */
    this.posted = [];
    this.port = {
      /** @type {any} */
      onmessage: undefined,
      /**
       * @param {any} message
       * @param {any[]} transfer
       */
      postMessage: (message, transfer) => this.posted.push([message, transfer]),
    };
  }
}

test('the processor posts blocks with their buffer transferred and stops on request', t => {
  const Processor = makeCaptureProcessor(FakeProcessorBase, 16_000);
  const processor = /** @type {any} */ (
    new Processor({ processorOptions: { outRate: 16_000, blockSamples: 4 } })
  );
  t.true(processor.process([[Float32Array.of(0.5, 0.5, 0.5)]]));
  t.is(processor.posted.length, 0);
  t.true(processor.process([[Float32Array.of(0.5)]]));
  t.is(processor.posted.length, 1);
  const [message, transfer] = processor.posted[0];
  t.true(message.pcm instanceof ArrayBuffer);
  t.is(message.pcm.byteLength, 8);
  t.deepEqual(transfer, [message.pcm]);
  t.true(Math.abs(message.rms - 0.5) < 1e-6);
  // no input connected yet: keep running, post nothing
  t.true(processor.process([[]]));
  t.true(processor.process([]));
  processor.port.onmessage({ data: 'stop' });
  t.false(processor.process([[Float32Array.of(0.5, 0.5, 0.5, 0.5)]]));
  t.is(processor.posted.length, 1);
  // defaults when the node passes no options
  const plain = /** @type {any} */ (new Processor());
  t.true(plain.process([[new Float32Array(captureBlockSamples)]]));
  t.is(plain.posted.length, 1);
});

test('in a worklet scope the file registers its processor by name', async t => {
  const scope = /** @type {any} */ (globalThis);
  /** @type {Array<[string, any]>} */
  const registered = [];
  scope.registerProcessor = (
    /** @type {string} */ name,
    /** @type {any} */ cls,
  ) => registered.push([name, cls]);
  scope.AudioWorkletProcessor = FakeProcessorBase;
  scope.sampleRate = 48_000;
  try {
    const specifier = new URL(
      '../../resources/agent-host/impl/speech/capture-worklet.js?worklet-scope',
      import.meta.url,
    ).href;
    const loading = import(specifier);
    await loading;
  } finally {
    delete scope.registerProcessor;
    delete scope.AudioWorkletProcessor;
    delete scope.sampleRate;
  }
  t.is(registered.length, 1);
  t.is(registered[0][0], CAPTURE_PROCESSOR_NAME);
  const processor = new registered[0][1]({
    processorOptions: { outRate: 16_000, blockSamples: 2 },
  });
  processor.process([[new Float32Array(6)]]);
  t.is(processor.posted.length, 1);
});

/** Fake media devices, context and worklet node, recording what happened. */
const makeFakeAudio = () => {
  /** @type {string[]} */
  const log = [];
  /** @type {any} */
  let answer;
  const tracks = [
    {
      stopped: false,
      stop() {
        tracks[0].stopped = true;
      },
    },
  ];
  const stream = { getTracks: () => tracks };
  /** @type {any[]} */
  const nodes = [];
  /** @param {string} name */
  const node = name => {
    const made = {
      name,
      /** @type {any[]} */
      connections: [],
      disconnected: false,
      /** @param {any} to */
      connect(to) {
        made.connections.push(to);
      },
      disconnect() {
        made.disconnected = true;
      },
    };
    nodes.push(made);
    return made;
  };
  const context = {
    state: 'suspended',
    sampleRate: 48_000,
    destination: { name: 'destination' },
    closed: false,
    resume() {
      context.state = 'running';
      log.push('resume');
      return Promise.resolve();
    },
    close() {
      context.closed = true;
      return Promise.resolve();
    },
    audioWorklet: {
      failWith: /** @type {Error | undefined} */ (undefined),
      /** @param {string} url */
      addModule(url) {
        log.push(`addModule ${url}`);
        const failing = context.audioWorklet.failWith;
        return failing ? Promise.reject(failing) : Promise.resolve();
      },
    },
    createMediaStreamSource: () => node('source'),
    createGain: () => Object.assign(node('gain'), { gain: { value: 1 } }),
  };
  const mediaDevices = {
    /** @type {any[]} */
    asked: [],
    /** @param {{ audio: object }} constraints */
    getUserMedia(constraints) {
      log.push('getUserMedia');
      mediaDevices.asked.push(constraints);
      return new Promise((resolve, reject) => {
        answer = { resolve: () => resolve(stream), reject };
      });
    },
  };
  /** @type {any[]} */
  const worklets = [];
  /**
   * An `AudioWorkletNode` stand-in (called with `new`).
   *
   * @param {any} ctx
   * @param {string} name
   * @param {any} options
   */
  const makeWorkletNode = (ctx, name, options) => {
    /** @type {any[]} */
    const portMessages = [];
    const made = Object.assign(node('worklet'), {
      context: ctx,
      processorName: name,
      options,
      portMessages,
      port: {
        /** @type {any} */
        onmessage: undefined,
        /** @param {any} message */
        postMessage: (/** @type {any} */ message) => portMessages.push(message),
      },
    });
    worklets.push(made);
    return made;
  };
  const FakeWorkletNode = /** @type {any} */ (
    function FakeWorkletNode(
      /** @type {any} */ ctx,
      /** @type {string} */ name,
      /** @type {any} */ options,
    ) {
      return makeWorkletNode(ctx, name, options);
    }
  );
  return {
    log,
    tracks,
    nodes,
    context,
    mediaDevices,
    worklets,
    FakeWorkletNode,
    grant: () => answer.resolve(),
    /** @param {string} name */
    refuse: name => answer.reject(Object.assign(Error('refused'), { name })),
    makeContext: () => {
      log.push('context');
      return context;
    },
  };
};

test('openCapture asks inside the tap, loads the worklet and delivers blocks', async t => {
  const audio = makeFakeAudio();
  /** @type {Array<[number[], number]>} */
  const blocks = [];
  const capture = openCapture({
    onBlock: (pcm, rms) => blocks.push([[...pcm], rms]),
    mediaDevices: audio.mediaDevices,
    makeContext: audio.makeContext,
    WorkletNode: audio.FakeWorkletNode,
    secure: true,
  });
  // synchronously, before any await: the gesture is still in effect
  t.deepEqual(audio.log, ['getUserMedia', 'context']);
  t.deepEqual(audio.mediaDevices.asked, [{ audio: { ...captureConstraints } }]);
  t.is(capture.inputRate, 48_000);
  audio.grant();
  await capture.started;
  t.deepEqual(audio.log, [
    'getUserMedia',
    'context',
    'resume',
    `addModule ${CAPTURE_WORKLET_PATH}`,
  ]);
  const [worklet] = audio.worklets;
  t.is(worklet.processorName, CAPTURE_PROCESSOR_NAME);
  t.deepEqual(worklet.options.processorOptions, {
    outRate: sttFormat.sampleRate,
    blockSamples: captureBlockSamples,
  });
  const source = audio.nodes.find(n => n.name === 'source');
  const gain = audio.nodes.find(n => n.name === 'gain');
  t.deepEqual(source.connections, [worklet]);
  t.is(worklet.connections[0], gain);
  t.is(gain.gain.value, 0);
  t.deepEqual(gain.connections, [audio.context.destination]);

  worklet.port.onmessage({
    data: { pcm: Uint8Array.of(1, 2, 3, 4).buffer, rms: 0.25 },
  });
  t.deepEqual(blocks, [[[1, 2, 3, 4], 0.25]]);

  capture.stop();
  capture.stop();
  t.true(audio.tracks[0].stopped);
  t.true(audio.nodes.every(n => n.disconnected));
  t.deepEqual(worklet.portMessages, ['stop']);
  await Promise.resolve();
  t.true(audio.context.closed);
  worklet.port.onmessage({
    data: { pcm: Uint8Array.of(5, 6).buffer, rms: 0.5 },
  });
  t.is(blocks.length, 1);
  t.is(capture.inputRate, 0);
});

test('a capture stopped while the prompt is open releases the tracks when they come', async t => {
  const audio = makeFakeAudio();
  const capture = openCapture({
    onBlock: () => {},
    mediaDevices: audio.mediaDevices,
    makeContext: audio.makeContext,
    WorkletNode: audio.FakeWorkletNode,
    secure: true,
  });
  capture.stop();
  await Promise.resolve();
  t.true(audio.context.closed);
  t.false(audio.tracks[0].stopped);
  audio.grant();
  await capture.started;
  t.true(audio.tracks[0].stopped);
  t.is(audio.worklets.length, 0);
  t.false(audio.log.includes(`addModule ${CAPTURE_WORKLET_PATH}`));
});

test('failures reject with a reason and release what was taken', async t => {
  const insecure = makeFakeAudio();
  const refusedHere = openCapture({
    onBlock: () => {},
    mediaDevices: insecure.mediaDevices,
    makeContext: insecure.makeContext,
    WorkletNode: insecure.FakeWorkletNode,
    secure: false,
  });
  await t.throwsAsync(refusedHere.started, { message: 'insecure' });
  t.deepEqual(insecure.log, []);

  const noDevices = openCapture({
    onBlock: () => {},
    mediaDevices: /** @type {any} */ ({}),
    WorkletNode: makeFakeAudio().FakeWorkletNode,
    secure: true,
  });
  await t.throwsAsync(noDevices.started, { message: 'unsupported' });

  const denied = makeFakeAudio();
  const refusing = openCapture({
    onBlock: () => {},
    mediaDevices: denied.mediaDevices,
    makeContext: denied.makeContext,
    WorkletNode: denied.FakeWorkletNode,
    secure: true,
  });
  denied.refuse('NotAllowedError');
  const error = await t.throwsAsync(refusing.started);
  t.is(/** @type {any} */ (error).reason, 'denied');
  await Promise.resolve();
  t.true(denied.context.closed);

  const noWorklet = makeFakeAudio();
  noWorklet.context.audioWorklet.failWith = Error('blocked by CSP');
  const loading = openCapture({
    onBlock: () => {},
    mediaDevices: noWorklet.mediaDevices,
    makeContext: noWorklet.makeContext,
    WorkletNode: noWorklet.FakeWorkletNode,
    secure: true,
  });
  noWorklet.grant();
  const unsupported = await t.throwsAsync(loading.started);
  t.is(/** @type {any} */ (unsupported).reason, 'unsupported');
  t.true(noWorklet.tracks[0].stopped);

  const noContext = makeFakeAudio();
  const contextless = openCapture({
    onBlock: () => {},
    mediaDevices: noContext.mediaDevices,
    makeContext: () => {
      throw Error('no Web Audio');
    },
    WorkletNode: noContext.FakeWorkletNode,
    secure: true,
  });
  const noAudio = await t.throwsAsync(contextless.started);
  t.is(/** @type {any} */ (noAudio).reason, 'unsupported');
  noContext.grant();
  await new Promise(resolve => setTimeout(resolve, 0));
  t.true(noContext.tracks[0].stopped);
});

test('DOM error names map to failure reasons', t => {
  t.is(captureFailureOf({ name: 'NotAllowedError' }), 'denied');
  t.is(captureFailureOf({ name: 'SecurityError' }), 'denied');
  t.is(captureFailureOf({ name: 'NotFoundError' }), 'notFound');
  t.is(captureFailureOf({ name: 'OverconstrainedError' }), 'notFound');
  t.is(captureFailureOf({ name: 'NotReadableError' }), 'unreadable');
  t.is(captureFailureOf({ name: 'AbortError' }), 'unreadable');
  t.is(captureFailureOf(Error('x')), 'failed');
  t.is(captureFailureOf(undefined), 'failed');
});
