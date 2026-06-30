// @ts-check
// Pure-logic unit tests for the transformers-webgpu backend. These cover only
// the parts that run in plain node WITHOUT importing the heavy model libraries
// (@huggingface/transformers, kokoro-js) — those live exclusively in
// transformers-webgpu.worker.js, which this test never imports. On-device model
// behaviour (actual STT/TTS, WebGPU execution) requires a browser harness and is
// out of scope here (see README "Testing").
//
// What is covered:
//   - Float32 -> s16le PCM -> base64 -> Float32 round-trip (the wire encode the
//     TTS path emits and the STT path decodes), including clamping.
//   - The ported sentence chunker (makeChunker) matches the caplet's behaviour.

import test from 'ava';

import {
  float32ToPcmBase64,
  makeChunker,
  pcmBase64ToFloat32,
} from '../src/backends/transformers-webgpu.js';

// atob/btoa exist on modern node globals; assert so the test fails loudly rather
// than throwing an opaque ReferenceError if run on an ancient runtime.
test('environment provides atob/btoa', t => {
  t.is(typeof atob, 'function');
  t.is(typeof btoa, 'function');
});

test('float32 -> pcm base64 -> float32 round-trips within quantization error', t => {
  const input = Float32Array.from([0, 0.5, -0.5, 1, -1, 0.25, -0.25]);
  const b64 = float32ToPcmBase64(input);
  t.is(typeof b64, 'string');
  const out = pcmBase64ToFloat32(b64);
  t.is(out.length, input.length);
  for (let i = 0; i < input.length; i += 1) {
    // s16 quantization step is ~1/32768; allow a little more than one step.
    t.true(
      Math.abs(out[i] - input[i]) < 1.5 / 32_768,
      `sample ${i}: ${out[i]} vs ${input[i]}`,
    );
  }
});

test('float32 -> pcm clamps out-of-range samples to [-1, 1]', t => {
  const input = Float32Array.from([2, -2, 5, -5]);
  const out = pcmBase64ToFloat32(float32ToPcmBase64(input));
  // +2 clamps to +1 -> 32767/32768 ≈ 0.99997; -2 clamps to -1 -> exactly -1.
  t.true(out[0] > 0.999 && out[0] <= 1);
  t.is(out[1], -1);
  t.true(out[2] > 0.999 && out[2] <= 1);
  t.is(out[3], -1);
});

test('pcmBase64ToFloat32 handles empty input', t => {
  t.is(pcmBase64ToFloat32('').length, 0);
});

test('float32ToPcmBase64 handles empty input', t => {
  t.is(float32ToPcmBase64(new Float32Array(0)), '');
});

test('a base64 PCM frame decodes to the expected sample count', t => {
  // 1600 samples = 100 ms @ 16 kHz; 2 bytes each.
  const samples = new Float32Array(1600);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin((i / 1600) * Math.PI * 2) * 0.5;
  }
  const decoded = pcmBase64ToFloat32(float32ToPcmBase64(samples));
  t.is(decoded.length, 1600);
});

// ── Chunker (ported from tts-server-caplet.js) ───────────────────────────────

test('chunker emits complete sentences and holds the tail', t => {
  const chunker = makeChunker();
  // No boundary yet -> nothing emitted, text buffered.
  t.deepEqual(chunker.push('Hello there'), []);
  // A sentence boundary (period + space) unlocks the first sentence.
  t.deepEqual(chunker.push('. How are you'), ['Hello there.']);
  // finish() flushes the buffered remainder.
  t.deepEqual(chunker.finish(), ['How are you']);
});

test('chunker does not split on abbreviations or list markers', t => {
  const chunker = makeChunker();
  // "Dr." is an abbreviation -> not a boundary; the whole thing stays pending
  // until a real boundary arrives.
  const out = chunker.push('See Dr. Smith now. ');
  t.deepEqual(out, ['See Dr. Smith now.']);
});

test('chunker strips markdown noise before emitting', t => {
  const chunker = makeChunker();
  chunker.push('Here is **bold** and `code`. ');
  const flushed = chunker.finish();
  // finish() returns the trailing remainder; the first sentence already emitted
  // on push. Verify by re-running with everything in one finish.
  const c2 = makeChunker();
  c2.push('Here is **bold** and `code`.');
  t.deepEqual(c2.finish(), ['Here is bold and code.']);
  t.deepEqual(flushed, []);
});

test('chunker coalesces sub-minimum fragments until long enough', t => {
  const chunker = makeChunker();
  // "Hi." (3 chars) is below MIN_CHUNK_LENGTH (10) so it is held and combined
  // with the next sentence.
  const first = chunker.push('Hi. ');
  t.deepEqual(first, []);
  // The held fragment "Hi." is re-buffered (the trailing space was consumed as
  // the boundary whitespace), so when the next sentence completes they combine
  // without an inserted space — matching the caplet chunker exactly.
  const second = chunker.push('This is a longer sentence. ');
  t.deepEqual(second, ['Hi.This is a longer sentence.']);
});

test('chunker treats newlines as boundaries', t => {
  const chunker = makeChunker();
  const out = chunker.push('First line is long\nSecond');
  t.deepEqual(out, ['First line is long']);
  t.deepEqual(chunker.finish(), ['Second']);
});
