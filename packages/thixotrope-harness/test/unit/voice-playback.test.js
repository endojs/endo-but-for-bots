// @ts-check
// Gapless playback (designs/m11-interfaces.md section 9; R5-43, R5-44,
// R5-48): the scheduler over a fake AudioContext whose clock the test
// moves. Chunks play back to back at their own rates; a new track or stop()
// silences the old one; audible() follows the scheduled end.
import test from '@endo/ses-ava/prepare-endo.js';

import { defaultPlaybackSampleRate } from '../../resources/agent-host/impl/speech/audio-protocol.js';
import { decodePcm, makePlayer } from '../../ui/src/voice/playback.js';

/** An AudioContext stand-in with a settable clock. */
const makeFakeContext = () => {
  /** @type {any[]} */
  const sources = [];
  const context = {
    currentTime: 0,
    state: 'suspended',
    resumes: 0,
    destination: { node: 'destination' },
    sources,
    resume() {
      context.resumes += 1;
      context.state = 'running';
      return Promise.resolve();
    },
    /**
     * @param {number} channels
     * @param {number} frames
     * @param {number} sampleRate
     */
    createBuffer(channels, frames, sampleRate) {
      const data = new Float32Array(frames);
      return {
        channels,
        sampleRate,
        duration: frames / sampleRate,
        getChannelData: () => data,
      };
    },
    createBufferSource() {
      /** @type {any} */
      const source = {
        buffer: undefined,
        startAt: undefined,
        stopped: false,
        connectedTo: undefined,
        onended: null,
        /** @param {any} node */
        connect(node) {
          source.connectedTo = node;
        },
        /** @param {number} at */
        start(at) {
          source.startAt = at;
        },
        stop() {
          source.stopped = true;
        },
      };
      sources.push(source);
      return source;
    },
    /**
     * Move the clock and end every source whose audio is over.
     *
     * @param {number} seconds
     */
    advance(seconds) {
      context.currentTime += seconds;
      for (const source of sources) {
        const end = Number(source.startAt) + Number(source.buffer.duration);
        if (!source.stopped && !source.ended && end <= context.currentTime) {
          source.ended = true;
          source.onended?.();
        }
      }
    },
  };
  return context;
};

/** @param {number} samples */
const silence = samples => new Uint8Array(samples * 2);

test('s16le decodes to [-1, 1)', t => {
  const bytes = Uint8Array.of(0x00, 0x80, 0xff, 0x7f, 0x00, 0x00, 0x00, 0x40);
  const into = new Float32Array(4);
  t.is(decodePcm(bytes, into), 4);
  t.deepEqual([...into], [-1, 32_767 / 32_768, 0, 0.5]);
});

test('chunks are scheduled back to back at their own rates', async t => {
  const context = makeFakeContext();
  /** @type {boolean[]} */
  const changes = [];
  const player = makePlayer({
    makeContext: () => context,
    onChange: playing => changes.push(playing),
  });
  await player.unlock();
  t.is(context.resumes, 1);
  t.is(context.state, 'running');
  await player.unlock();
  t.is(context.resumes, 1);

  context.currentTime = 10;
  const track = player.begin();
  track.pcm(22_050, silence(2205)); // 0.1 s
  track.pcm(16_000, silence(800)); // 0.05 s
  track.pcm(0, silence(defaultPlaybackSampleRate / 10)); // 0 means 22,050 Hz
  const [a, b, c] = context.sources;
  t.is(a.startAt, 10);
  t.is(a.buffer.sampleRate, 22_050);
  t.is(b.startAt, 10.1);
  t.is(b.buffer.sampleRate, 16_000);
  t.true(Math.abs(c.startAt - 10.15) < 1e-9);
  t.is(c.buffer.sampleRate, defaultPlaybackSampleRate);
  t.is(a.connectedTo, context.destination);
  t.true(player.audible());
  t.true(player.playing());
  t.deepEqual(changes, [true]);

  // the clock passes the end: the next chunk starts now, not in the past
  context.advance(1);
  t.false(player.audible());
  t.false(player.playing());
  t.deepEqual(changes, [true, false]);
  track.pcm(22_050, silence(2205));
  t.is(context.sources[3].startAt, 11);
  t.true(player.playing());
});

test('an odd byte is carried to the next chunk; an empty chunk schedules nothing', t => {
  const context = makeFakeContext();
  const player = makePlayer({ makeContext: () => context });
  const track = player.begin();
  track.pcm(16_000, Uint8Array.of(0x00, 0x40, 0x00));
  t.is(context.sources.length, 1);
  t.is(context.sources[0].buffer.getChannelData().length, 1);
  track.pcm(16_000, Uint8Array.of(0x40));
  t.is(context.sources.length, 2);
  t.deepEqual([...context.sources[1].buffer.getChannelData()], [0.5]);
  track.pcm(16_000, new Uint8Array(0));
  t.is(context.sources.length, 2);
});

test('a new track stops the previous one; stop() silences and drops later PCM', t => {
  const context = makeFakeContext();
  const player = makePlayer({ makeContext: () => context });
  const first = player.begin();
  first.pcm(22_050, silence(22_050));
  first.pcm(22_050, silence(22_050));
  const second = player.begin();
  t.false(first.current());
  t.true(second.current());
  t.true(context.sources.every(s => s.stopped));
  first.pcm(22_050, silence(100));
  t.is(context.sources.length, 2);
  // the new track starts at once, not after the stopped audio
  second.pcm(22_050, silence(100));
  t.is(context.sources[2].startAt, 0);
  player.stop();
  t.true(context.sources[2].stopped);
  t.false(second.current());
  t.false(player.audible());
  t.false(player.playing());
  second.pcm(22_050, silence(100));
  t.is(context.sources.length, 3);
});

test('without Web Audio the player stays silent', async t => {
  const player = makePlayer({
    makeContext: () => {
      throw Error('no Web Audio');
    },
  });
  await player.unlock();
  const track = player.begin();
  track.pcm(22_050, silence(100));
  t.false(player.audible());
  t.false(player.playing());
});
