#!/usr/bin/env node
// @ts-check
/**
 * A fake speech-in engine (`designs/m11-interfaces.md` appendix B): it
 * speaks the Moonshine daemon's JSON-lines protocol
 * (`AH/speech/engine-protocol.js` `sttProcessMessages`) without a model.
 *
 *   node fake-stt.mjs [--mode <mode>] [--pid-file <path>] [--log <path>]
 *
 * - Prints `{"event":"ready"}` once (after `slow-ready=<ms>` if given).
 * - Per stream: a partial `"<bytes so far> bytes"` each time another 0.5 s
 *   of audio (16,000 bytes) arrived; at `stream_stop` the final
 *   `"final <bytes>"`. Each `stream_audio` frame drops its own trailing odd
 *   byte, as Moonshine's `pcm_to_floats` does, so the byte counts show what
 *   the adapter sent.
 * - `--pid-file`: appends this process's pid and a newline at start (a
 *   respawn adds a line).
 * - `--log`: appends one JSON line per message received:
 *   `{ type, stream, pcmBytes? }` (decoded byte lengths only, never audio).
 * - `--clock` (with `--log`): each line also carries `at`, the monotonic time
 *   in ms (comparable across processes on one machine) when its input chunk arrived, and each
 *   partial written adds `{ type: 'partial', stream, at }` (perf rows
 *   `speech.audioForward` and `speech.partialRelay`).
 * - Exits at end of standard input (D-M11-15), except in `hang-after`.
 *
 * Modes: `normal`; `hang-after=<n>` after `n` received lines it stops
 * reading standard input and writes nothing more (a hung engine: its pipe
 * fills, and it only dies by a signal); `crash-at-start` exits 3 before
 * ready; `slow-ready=<ms>`; `flood-line` answers the first `stream_audio`
 * with a 10 MiB line; `error-on-stop` answers `stream_stop` with an
 * `error` reply.
 *
 * Plain Node (no SES): it is a stand-in for an external program.
 */
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { Buffer } from 'node:buffer';

const PARTIAL_BYTES = 16_000;

/** @param {string} name */
const argOf = name => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

const mode = argOf('--mode') ?? 'normal';
const pidFile = argOf('--pid-file');
const logFile = argOf('--log');
const clock = process.argv.includes('--clock');
/** Machine monotonic time in milliseconds. */
const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6;
const numberAfter = (/** @type {string} */ prefix) =>
  mode.startsWith(prefix) ? Number(mode.slice(prefix.length)) : undefined;
const hangAfter = numberAfter('hang-after=');
const slowReady = numberAfter('slow-ready=') ?? 0;

if (pidFile) appendFileSync(pidFile, `${process.pid}\n`);
if (mode === 'crash-at-start') process.exit(3);

/** @param {unknown} record */
const send = record => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};
/** @param {Record<string, unknown>} entry */
const logEntry = entry => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};

/** @type {Map<string, { bytes: number, reported: number }>} */
const streams = new Map();
let received = 0;
let flooded = false;
let hung = false;

/**
 * @param {Record<string, any>} req
 * @param {number | undefined} at when its chunk arrived (`--clock`)
 */
const handle = (req, at) => {
  const { type, stream } = req;
  const stamp = at === undefined ? {} : { at };
  if (type === 'stream_audio') {
    let bytes = Buffer.from(String(req.pcm ?? ''), 'base64').length;
    if (bytes % 2) bytes -= 1;
    logEntry({ type, stream, pcmBytes: bytes, ...stamp });
    if (mode === 'flood-line' && !flooded) {
      flooded = true;
      process.stdout.write(`${'x'.repeat(10 * 1024 * 1024)}\n`);
      return;
    }
    const state = streams.get(stream);
    if (state === undefined) return;
    state.bytes += bytes;
    if (state.bytes - state.reported >= PARTIAL_BYTES) {
      state.reported = state.bytes;
      if (clock) logEntry({ type: 'partial', stream, at: monotonicMs() });
      send({ stream, partial: `${state.bytes} bytes` });
    }
    return;
  }
  logEntry({ type, stream, ...stamp });
  if (type === 'stream_start') {
    streams.set(stream, { bytes: 0, reported: 0 });
  } else if (type === 'stream_stop') {
    const state = streams.get(stream);
    streams.delete(stream);
    if (mode === 'error-on-stop') {
      send({ stream, error: 'fake failure' });
    } else if (state === undefined) {
      send({ stream, error: 'unknown stream' });
    } else {
      send({ stream, text: `final ${state.bytes}` });
    }
  } else if (type === 'stream_abort') {
    streams.delete(stream);
  }
};

let pending = '';
/** @param {string} chunk */
const onData = chunk => {
  if (hung) return;
  const at = clock ? monotonicMs() : undefined;
  pending += chunk;
  let nl = pending.indexOf('\n');
  while (nl !== -1) {
    const line = pending.slice(0, nl).trim();
    pending = pending.slice(nl + 1);
    if (line) {
      received += 1;
      try {
        handle(JSON.parse(line), at);
      } catch {
        // keep serving, as Moonshine does
      }
      if (hangAfter !== undefined && received >= hangAfter) {
        hung = true;
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        // Stay alive with nothing to do until a signal arrives.
        setInterval(() => {}, 60_000);
        return;
      }
    }
    nl = pending.indexOf('\n');
  }
};

setTimeout(() => {
  send({ event: 'ready' });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);
  process.stdin.on('end', () => {
    if (!hung) process.exit(0);
  });
}, slowReady);
