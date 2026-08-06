// @ts-check
// The text-to-speech server object as a daemon-managed *unconfined* caplet.
//
// Symmetric to audio-server-caplet.js (STT), but the other direction: it takes
// a stream of reply text and returns a stream of synthesized audio bytes:
//
//   ttsServer.synthesize(textReader) -> audioReader
//
// textReader yields the reply wire shape this caplet cares about (APPEND
// deltas, like the floot converse reply — NOT the STT replace wire):
//   { type: 'delta', text } | { type: 'end' } | { type: 'abort', reason }
// The caller feeds reply deltas as they stream from the LLM; for replay of a
// finished message it feeds the whole text as a single delta then end. We never
// consume a 'final' event so a caller can't double-speak the same words.
//
// audioReader yields:
//   { type: 'phase', phase } |
//   { type: 'bytes', b64, sampleRate } |   // raw s16le mono PCM, base64
//   { type: 'end' } | { type: 'abort', reason }
// 'bytes' events stream as piper produces audio — the browser schedules each
// back-to-back, so chunk framing carries no meaning (a sentence may span
// several events). Raw PCM (not WAV/mp3) so the browser builds an AudioBuffer
// directly with no decode and we avoid an ffmpeg hop.
//
// One piper process serves the WHOLE reply: sentences are written to its stdin
// as the chunker emits them and raw PCM streams out continuously. Spawning a
// process per sentence (the previous design) paid a full ONNX model load per
// sentence — several hundred ms to seconds of dead air between sentences.
//
// Self-contained on purpose (the daemon worker is plain Node, no tsx): mirrors
// src/tts/piper-tts.ts + sentence-chunker.ts reduced to what synthesize needs.
// A separate object from the STT caplet so the two are independently swappable.
// See [[project-voice-space-m2]] and §11 of docs/endo-daemon-integration.md.

/* global Buffer */
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

// `synthesize` is synchronous (returns the audio reader immediately, then
// streams), so it is guarded with `M.call`. Guards are permissive — the daemon
// path is not runtime-tested here.
const TtsServerInterface = M.interface('TtsServer', {
  synthesize: M.call(M.any()).optional(M.record()).returns(M.remotable()),
  getConfiguration: M.call().returns(M.record()),
  help: M.call().returns(M.string()),
});

const PIPER_DEFAULTS = harden({
  speed: 1,
  noiseScale: 0.667,
  noiseW: 0.8,
  sentenceSilence: 0.2,
});

/** @param {string} id */
const voiceDisplayName = id => {
  const match = /^(en_[A-Z]{2})-(.+)-(low|medium|high)$/.exec(id);
  if (!match) return id.replace(/[_-]+/g, ' ');
  const [, locale, speaker, quality] = match;
  let localeName = locale.replace('_', ' ');
  if (locale === 'en_US') localeName = 'English (US)';
  if (locale === 'en_GB') localeName = 'English (UK / Europe)';
  return `${localeName} — ${speaker.replace(/_/g, ' ')} (${quality})`;
};

// ── Minimal sentence chunker (plain JS port of sentence-chunker.ts) ──────────
const MIN_CHUNK_LENGTH = 10;
const ABBREVIATIONS = harden(
  new Set(['St', 'Dr', 'Mr', 'Mrs', 'Ms', 'Prof', 'vs', 'etc', 'Jr', 'Sr']),
);

// Strip the markdown that would otherwise be read aloud as punctuation noise.
const stripMarkdown = text =>
  `${text}`
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> text
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1') // bold/italic
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/^\s*>\s?/gm, '') // blockquotes
    .replace(/^\s*[-*+]\s+/gm, ''); // bullet markers

const isAbbrev = (text, i) => {
  const m = text.slice(0, i).match(/([A-Za-z]+)$/);
  return m !== null && ABBREVIATIONS.has(m[1]);
};
const isListMarker = (text, i) => {
  const before = text.slice(0, i);
  const linePrefix = before.slice(before.lastIndexOf('\n') + 1);
  return /^\d+$/.test(linePrefix);
};
const isBoundary = (text, i) => {
  const c = text[i];
  if (c === '\n') return true;
  if (c !== '.' && c !== '!' && c !== '?') return false;
  const next = text[i + 1];
  if (next === undefined || !/\s/.test(next)) return false;
  if (c === '.' && (isListMarker(text, i) || isAbbrev(text, i))) return false;
  return true;
};

const makeChunker = () => {
  let buffer = '';
  const flush = () => {
    const rawParts = [];
    let start = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      if (!isBoundary(buffer, i)) continue; // eslint-disable-line no-continue
      let end = i + 1;
      while (end < buffer.length && /\s/.test(buffer[end])) end += 1;
      rawParts.push(buffer.slice(start, end));
      start = end;
      i = end - 1;
    }
    const tail = buffer.slice(start);
    const chunks = [];
    let pending = '';
    for (const part of rawParts) {
      const trimmed = stripMarkdown(part).trim();
      if (!trimmed) continue; // eslint-disable-line no-continue
      const combined = pending ? `${pending} ${trimmed}` : trimmed;
      if (combined.length >= MIN_CHUNK_LENGTH) {
        chunks.push(combined);
        pending = '';
      } else {
        pending = combined;
      }
    }
    buffer = pending ? [pending, tail].filter(Boolean).join(' ') : tail;
    return chunks;
  };
  return harden({
    push: text => {
      buffer += text;
      return flush();
    },
    finish: () => {
      const trimmed = stripMarkdown(buffer).trim();
      buffer = '';
      return trimmed ? [trimmed] : [];
    },
  });
};

// ── Minimal audio-side stream channel (Far StreamReader) ─────────────────────
// onClose fires when the consumer stops pulling (return/throw) so the producer
// (piper) can be aborted — otherwise an interrupted replay keeps synthesizing
// every remaining sentence with no one to receive the audio.
const makeAudioChannel = onClose => {
  const { push, reader, isClosed } = makeBufferedReader({ onClose });
  const writer = {
    bytes: (b64, sampleRate) => push({ type: 'bytes', b64, sampleRate }),
    setPhase: phase => push({ type: 'phase', phase: `${phase}` }),
    end: () => push({ type: 'end' }),
    abort: reason => push({ type: 'abort', reason: `${reason}` }),
  };
  return harden({ writer, reader, isClosed });
};

// ── Minimal piper driver ─────────────────────────────────────────────────────
// One long-lived piper process per synthesize() call (per reply). Piper in
// --output-raw mode reads one utterance per stdin line and streams raw s16le
// PCM continuously, so the ONNX model loads once per reply instead of once per
// sentence — the previous per-sentence spawn put the model-load latency
// (hundreds of ms to seconds) into every inter-sentence gap. Sentences are
// written as they arrive; piper synthesizes them in order while earlier audio
// is already streaming out.
const makePiper = ({
  binary,
  modelPath,
  speed,
  noiseScale,
  noiseW,
  sentenceSilence,
  sampleRate,
}) => {
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let aborted = false;
  /** @type {(pcm: Buffer) => void} */
  let onChunk = () => {};
  // PCM samples are 2 bytes; a pipe read may split one across chunks. Forward
  // only even-length prefixes and carry the odd byte, or every later sample in
  // the stream would be misaligned (loud static).
  /** @type {Buffer | null} */
  let carry = null;
  /** @type {Promise<void> | null} */
  let exited = null;

  const ensureSpawned = () => {
    if (child || aborted) return;
    // length-scale stretches phoneme duration, so speed is its inverse.
    const proc = spawn(
      binary,
      [
        '--model',
        modelPath,
        '--output-raw',
        '--length-scale',
        String(1 / speed),
        '--noise-scale',
        String(noiseScale),
        '--noise-w',
        String(noiseW),
        '--sentence-silence',
        String(sentenceSilence),
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    child = proc;
    exited = new Promise((resolve, reject) => {
      let settled = false;
      const done = err => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(undefined);
      };
      proc.on('error', err => done(err));
      // stdin can emit EPIPE if piper exits/closes before consuming input (bad
      // model, or killed mid-write by abort()); without a handler Node
      // escalates it to an uncaught exception that tears down the worker.
      proc.stdin.on('error', () => {});
      proc.stdout.on('data', (/** @type {Buffer} */ c) => {
        if (aborted) return;
        const buf = carry ? Buffer.concat([carry, c]) : c;
        /** @type {number} */
        const evenLength = buf.length - (buf.length % 2);
        carry = evenLength < buf.length ? buf.subarray(evenLength) : null;
        if (evenLength > 0) onChunk(buf.subarray(0, evenLength));
      });
      proc.on('close', code => {
        if (aborted) {
          done(new Error('aborted'));
        } else if (code === 0) {
          done(null);
        } else {
          done(new Error(`piper exited with code ${code}`));
        }
      });
    });
    // A consumer that never awaits finish() (abort paths) must not surface an
    // unhandled rejection; finish() re-awaits the same promise for callers.
    exited.catch(() => {});
  };

  return {
    sampleRate,
    setOnChunk: cb => {
      onChunk = cb;
    },
    // Queue one sentence. Newlines cannot appear inside a sentence (each line
    // is one piper utterance); collapse any stray whitespace defensively.
    speak: text => {
      if (aborted) return;
      ensureSpawned();
      child?.stdin?.write(`${`${text}`.replace(/\s+/g, ' ').trim()}\n`);
    },
    // No more input: close stdin and resolve once piper has drained its queue
    // and exited (all audio already streamed through onChunk).
    finish: () => {
      if (!child) return Promise.resolve();
      child.stdin?.end();
      return /** @type {Promise<void>} */ (exited);
    },
    abort: () => {
      aborted = true;
      if (child && !child.killed) child.kill('SIGTERM');
    },
  };
};

// Read reply text deltas, chunk into sentences, and feed them to the single
// piper process; its PCM streams to the writer as it is produced, so sentence
// N plays while N+1 is still synthesizing (and later text is still arriving).
const pump = async (piper, textReader, writer) => {
  const chunker = makeChunker();
  writer.setPhase('synthesizing');
  piper.setOnChunk(pcm =>
    writer.bytes(pcm.toString('base64'), piper.sampleRate),
  );

  try {
    for await (const value of iterateReader(textReader, { buffer: 4 })) {
      if (value.type === 'delta') {
        for (const s of chunker.push(value.text)) piper.speak(s);
      } else if (value.type === 'end') {
        break;
      } else if (value.type === 'abort') {
        piper.abort();
        writer.abort(value.reason);
        return;
      }
    }
    for (const s of chunker.finish()) piper.speak(s);
    await piper.finish();
    writer.end();
  } catch (err) {
    piper.abort();
    writer.abort(err instanceof Error ? err.message : String(err));
  }
};

// Unconfined caplet entry point. env carries the piper wiring:
//   FLOOT_TTS_BINARY  piper binary (default "piper")
//   FLOOT_TTS_MODEL   absolute path to the .onnx voice (companion .onnx.json next to it)
//   FLOOT_TTS_SPEED   speech speed multiplier (default "1.0")
/**
 * @param {object} _powers
 * @param {any} context daemon caplet context (whenCancelled for teardown)
 * @param {{ env?: Record<string, string | undefined> }} [opts]
 */
export const make = async (_powers, context, { env = {} } = {}) => {
  const binary = env.FLOOT_TTS_BINARY || 'piper';
  const modelPath = env.FLOOT_TTS_MODEL;
  if (!modelPath) throw new Error('FLOOT_TTS_MODEL is required');
  // Speed drives piper's --length-scale (1/speed), so a non-positive or
  // non-finite value yields a nonsensical scale and piper fails obscurely.
  // Reject it up front with a capability-level error instead.
  let speed = PIPER_DEFAULTS.speed;
  if (env.FLOOT_TTS_SPEED !== undefined && env.FLOOT_TTS_SPEED !== '') {
    const parsed = Number(env.FLOOT_TTS_SPEED);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `FLOOT_TTS_SPEED must be a positive number, got "${env.FLOOT_TTS_SPEED}".`,
      );
    }
    speed = parsed;
  }

  const modelDir = dirname(modelPath);
  const defaultVoice = basename(modelPath, '.onnx');
  /** @type {Map<string, { id: string, name: string, modelPath: string, sampleRate: number }>} */
  const voicesById = new Map();
  /** @param {string} path */
  const addVoice = path => {
    const id = basename(path, '.onnx');
    const configPath = `${path}.json`;
    if (!existsSync(path) || !existsSync(configPath)) return;
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const sampleRate = config?.audio?.sample_rate;
    if (typeof sampleRate !== 'number' || sampleRate <= 0) {
      throw new Error(
        `piper voice config ${configPath} missing audio.sample_rate`,
      );
    }
    voicesById.set(
      id,
      harden({
        id,
        name: voiceDisplayName(id),
        modelPath: path,
        sampleRate,
      }),
    );
  };
  for (const name of readdirSync(modelDir).sort()) {
    if (name.endsWith('.onnx')) addVoice(join(modelDir, name));
  }
  addVoice(modelPath);
  if (!voicesById.has(defaultVoice)) {
    throw new Error(`Piper default voice is not readable: ${modelPath}`);
  }

  const ranges = harden({
    speed: harden({ min: 0.25, max: 4, step: 0.05 }),
    noiseScale: harden({ min: 0, max: 2, step: 0.05 }),
    noiseW: harden({ min: 0, max: 2, step: 0.05 }),
    sentenceSilence: harden({ min: 0, max: 5, step: 0.05 }),
  });
  const defaults = harden({
    voice: defaultVoice,
    speed,
    noiseScale: PIPER_DEFAULTS.noiseScale,
    noiseW: PIPER_DEFAULTS.noiseW,
    sentenceSilence: PIPER_DEFAULTS.sentenceSilence,
  });
  const configuration = harden({
    voices: [...voicesById.values()].map(({ id, name }) =>
      harden({ id, name }),
    ),
    defaults,
    ranges,
  });

  /**
   * @param {Record<string, unknown>} options
   * @param {'speed' | 'noiseScale' | 'noiseW' | 'sentenceSilence'} name
   */
  const numberOption = (options, name) => {
    const value =
      options[name] === undefined ? defaults[name] : Number(options[name]);
    const range = ranges[name];
    if (!Number.isFinite(value) || value < range.min || value > range.max) {
      throw new Error(
        `TTS ${name} must be between ${range.min} and ${range.max}, got "${options[name]}".`,
      );
    }
    return value;
  };

  // Abort any in-flight piper subprocesses when the caplet is cancelled (the
  // formula is removed or re-provisioned), so they don't leak.
  const pipers = new Set();
  if (context) {
    E(context)
      .whenCancelled()
      .catch(() => {
        for (const piper of pipers) piper.abort();
        pipers.clear();
      });
  }

  return makeExo('TtsServer', TtsServerInterface, {
    synthesize: (textReader, options = {}) => {
      const voiceId =
        options.voice === undefined ? defaultVoice : `${options.voice}`;
      const voice = voicesById.get(voiceId);
      if (!voice) {
        throw new Error(`Unknown TTS voice "${voiceId}".`);
      }
      const piper = makePiper({
        binary,
        modelPath: voice.modelPath,
        speed: numberOption(options, 'speed'),
        noiseScale: numberOption(options, 'noiseScale'),
        noiseW: numberOption(options, 'noiseW'),
        sentenceSilence: numberOption(options, 'sentenceSilence'),
        sampleRate: voice.sampleRate,
      });
      pipers.add(piper);
      // If the consumer stops pulling (replay interrupted), abort piper so it
      // doesn't keep synthesizing sentences no one will receive.
      const { writer, reader } = makeAudioChannel(() => piper.abort());
      // pump settles the writer on every path; guard the floating promise and
      // drop the piper from the live set once the turn ends.
      pump(piper, textReader, writer).finally(() => pipers.delete(piper));
      return reader;
    },
    getConfiguration: () => configuration,
    help: () =>
      'TtsServer: synthesize(textReader, options?) -> audioReader; getConfiguration() lists voices, defaults, and supported Piper controls.',
  });
};
harden(make);
