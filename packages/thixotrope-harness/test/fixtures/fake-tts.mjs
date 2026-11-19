#!/usr/bin/env node
// @ts-check
/**
 * A fake speech-out engine standing in for Piper
 * (`designs/m11-interfaces.md` appendix B): Piper's flags
 * (`AH/speech/engine-protocol.js` `piperFlags`) and its raw output, without
 * a model.
 *
 *   node fake-tts.mjs [--mode <mode>] [--pid-file <path>] [--log <path>]
 *     --model <voice>.onnx --output-raw --length-scale <x> --noise-scale <x>
 *     --noise-w <x> --sentence-silence <x>
 *
 * - Reads the sample rate from `<voice>.onnx.json` (`audio.sample_rate`)
 *   and exits 2 when it cannot.
 * - Per standard-input line (one sentence): `--length-scale`-scaled 100 ms
 *   of a 440 Hz s16le tone per 10 characters (at least one block), written
 *   to standard output in one write, as Piper writes a sentence's audio.
 * - `--pid-file`: appends this process's pid and a newline at start.
 * - `--log`: appends one JSON line at start (`{ type: 'start', pid, voice,
 *   lengthScale, noiseScale, noiseW, sentenceSilence }`) and one per line
 *   received (`{ type: 'sentence', pid, index, text, bytes }`). `index`
 *   counts the sentences of every process that logged to the same file, so
 *   `hang-on` names one sentence of a playback even across a respawn.
 * - Exits at end of standard input once its output is written (D-M11-15),
 *   except in `hang-on`.
 *
 * Modes: `normal`; `hang-on=<index>` at that sentence it stops reading and
 * writing (a hung engine; it dies only by a signal); `crash-at-start` exits
 * 3 at once; `slow-ms=<n>` waits `n` ms before each sentence's audio.
 *
 * Plain Node (no SES): it is a stand-in for an external program.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { Buffer } from 'node:buffer';

/** @param {string} name */
const argOf = name => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

const mode = argOf('--mode') ?? 'normal';
const pidFile = argOf('--pid-file');
const logFile = argOf('--log');
const numberAfter = (/** @type {string} */ prefix) =>
  mode.startsWith(prefix) ? Number(mode.slice(prefix.length)) : undefined;
const hangOn = numberAfter('hang-on=');
const slowMs = numberAfter('slow-ms=') ?? 0;

if (pidFile) appendFileSync(pidFile, `${process.pid}\n`);
if (mode === 'crash-at-start') process.exit(3);

const model = argOf('--model') ?? '';
const lengthScale = Number(argOf('--length-scale') ?? '1');
/** @type {number} */
let sampleRate;
try {
  sampleRate = JSON.parse(readFileSync(`${model}.json`, 'utf8')).audio
    .sample_rate;
} catch {
  process.exit(2);
}
if (!Number.isInteger(sampleRate) || sampleRate <= 0) process.exit(2);

/** @param {Record<string, unknown>} entry */
const logEntry = entry => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};

/** Sentences other processes logged to the same file. */
const loggedBefore = () =>
  logFile && existsSync(logFile)
    ? readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(line => line.includes('"type":"sentence"')).length
    : 0;

logEntry({
  type: 'start',
  pid: process.pid,
  voice: model.split('/').pop(),
  lengthScale,
  noiseScale: Number(argOf('--noise-scale')),
  noiseW: Number(argOf('--noise-w')),
  sentenceSilence: Number(argOf('--sentence-silence')),
});

/** @param {string} text */
const toneOf = text => {
  const blocks = Math.max(1, Math.ceil(text.length / 10));
  const samples = Math.round(blocks * 0.1 * sampleRate * lengthScale);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(
      8000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate),
    );
    pcm.writeInt16LE(value, i * 2);
  }
  return pcm;
};

let hung = false;
/** Output in order: each sentence's audio after the previous one's. */
let chain = Promise.resolve();

/** @param {string} text */
const sentence = text => {
  const index = loggedBefore();
  const pcm = toneOf(text);
  logEntry({ type: 'sentence', pid: process.pid, index, text, bytes: pcm.length });
  if (index === hangOn) {
    hung = true;
    process.stdin.pause();
    process.stdin.removeAllListeners('data');
    // Stay alive with nothing to do until a signal arrives.
    setInterval(() => {}, 60_000);
    return;
  }
  chain = chain.then(
    () =>
      new Promise(resolve => {
        setTimeout(() => process.stdout.write(pcm, () => resolve(undefined)), slowMs);
      }),
  );
};

let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (hung) return;
  pending += chunk;
  let nl = pending.indexOf('\n');
  while (nl !== -1 && !hung) {
    const line = pending.slice(0, nl).trim();
    pending = pending.slice(nl + 1);
    if (line) sentence(line);
    nl = pending.indexOf('\n');
  }
});
process.stdin.on('end', () => {
  if (hung) return;
  void chain.then(() => process.exit(0));
});
