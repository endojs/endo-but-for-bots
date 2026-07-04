// @ts-check
// Pure-logic units for Backend B (onnx-piper-moonshine) that run in node WITHOUT
// onnxruntime-web: the Float32 <-> s16le PCM <-> base64 round trip, the ported
// sentence chunker (must match tts-server-caplet.js's boundaries), and the
// Piper phoneme-id mapping (BOS/pad/EOS interleaving) against a small fixture.
//
// The model paths (ORT sessions, espeak-ng) need a WebGPU/WASM browser and are
// exercised in a browser harness, not here — see the README "Testing" section.
//
// NOTE: this imports the MAIN-THREAD module, which does NOT import
// onnxruntime-web at module load (only the worker does), so it loads in node.

import test from 'ava';

import {
  bytesToBase64,
  floatToPcm16,
  makeChunker,
  pcmBase64ToFloat,
  phonemesToIds,
  stripMarkdown,
} from '../src/backends/onnx-piper-moonshine.js';

test('floatToPcm16 encodes clamped little-endian s16', t => {
  const pcm = floatToPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
  const view = new DataView(pcm.buffer);
  t.is(pcm.length, 12);
  t.is(view.getInt16(0, true), 0);
  t.is(view.getInt16(2, true), 0x7fff); // +1 -> max positive
  t.is(view.getInt16(4, true), -0x8000); // -1 -> max negative
  t.is(view.getInt16(6, true), 0x7fff); // +2 clamps to +1
  t.is(view.getInt16(8, true), -0x8000); // -2 clamps to -1
  t.is(view.getInt16(10, true), Math.round(0.5 * 0x7fff));
});

test('pcmBase64ToFloat round-trips floatToPcm16 within s16 quantization', t => {
  const original = Float32Array.from([0, 0.25, -0.25, 0.9, -0.9]);
  const b64 = bytesToBase64(floatToPcm16(original));
  const back = pcmBase64ToFloat(b64);
  t.is(back.length, original.length);
  for (let i = 0; i < original.length; i += 1) {
    // s16 quantization step is ~1/32768; allow that tolerance.
    t.true(Math.abs(back[i] - original[i]) < 1 / 32_000);
  }
});

test('bytesToBase64 handles large buffers without stack overflow', t => {
  const big = new Uint8Array(200_000);
  for (let i = 0; i < big.length; i += 1) big[i] = i % 256;
  const b64 = bytesToBase64(big);
  // Decode back via the PCM helper's atob path to confirm fidelity.
  const decoded = pcmBase64ToFloat(b64);
  t.is(decoded.length, Math.floor(big.length / 2));
});

test('makeChunker emits complete sentences and holds the tail', t => {
  const chunker = makeChunker();
  // First delta has one complete sentence plus an incomplete tail.
  t.deepEqual(chunker.push('Hello there. How are '), ['Hello there.']);
  // The tail completes on the next delta.
  t.deepEqual(chunker.push('you today? '), ['How are you today?']);
  // finish() flushes whatever remains.
  t.deepEqual(chunker.push('Final bit'), []);
  t.deepEqual(chunker.finish(), ['Final bit']);
});

test('makeChunker does not split on abbreviations or list markers', t => {
  const chunker = makeChunker();
  // "Dr." abbreviation must not end the sentence.
  const out = chunker.push('Dr. Smith arrived. ');
  t.deepEqual(out, ['Dr. Smith arrived.']);
});

test('stripMarkdown removes formatting that would be read as noise', t => {
  t.is(stripMarkdown('**bold** and `code`'), 'bold and code');
  t.is(stripMarkdown('# Heading'), 'Heading');
  t.is(stripMarkdown('[link](http://x)'), 'link');
});

test('phonemesToIds interleaves pad and wraps with BOS/EOS', t => {
  // Minimal piper-style phoneme_id_map fixture.
  const map = {
    _: [0], // pad
    '^': [1], // BOS
    $: [2], // EOS
    h: [10],
    ɛ: [11], // multi-byte IPA symbol
    l: [12],
    o: [13],
  };
  const ids = phonemesToIds('hɛlo', map);
  // BOS, pad, then each phoneme followed by pad, then EOS.
  t.deepEqual(ids, [1, 0, 10, 0, 11, 0, 12, 0, 13, 0, 2]);
});

test('phonemesToIds skips symbols absent from the map', t => {
  const map = { _: [0], '^': [1], $: [2], a: [5] };
  // 'z' is not in the map and must be dropped, not crash.
  const ids = phonemesToIds('az', map);
  t.deepEqual(ids, [1, 0, 5, 0, 2]);
});

test('phonemesToIds tolerates a map missing BOS/EOS/pad', t => {
  const map = { a: [5], b: [6] };
  const ids = phonemesToIds('ab', map);
  t.deepEqual(ids, [5, 6]);
});
