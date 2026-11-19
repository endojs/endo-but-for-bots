// @ts-check
// Speech in, `process` kind (`AH/speech/stt-process.js`;
// designs/m11-interfaces.md 6.2, acceptance 1, 2 and 10, the probes of
// 14.2): cumulative partials then a final, odd bytes, abort, one resident
// engine across utterances, respawn after a kill, start failures and their
// pacing, error replies, the engine timeout (audio and END), the idle
// timeout, the utterance length bound, the engine backlog bound and stop.
// The engine is `test/fixtures/fake-stt.mjs`; `[real-moonshine]` cases run
// only with THIX_HARNESS_REAL_SPEECH=moonshine.
import test from '@endo/ses-ava/test.js';

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { makeProcessSttEngine } from '../../resources/agent-host/impl/speech/stt-process.js';
import { speechTexts } from '../../resources/agent-host/impl/speech/audio-protocol.js';

const FAKE_STT = fileURLToPath(
  new URL('../fixtures/fake-stt.mjs', import.meta.url),
);
const MOONSHINE = fileURLToPath(
  new URL(
    '../../resources/agent-host/impl/speech/engines/moonshine_daemon.py',
    import.meta.url,
  ),
);
const BLOCK = 2720;

/** @param {number} n */
const pcmOf = n => new Uint8Array(n).fill(1);

/**
 * @param {() => boolean} condition
 * @param {number} ms
 */
const waitFor = async (condition, ms) => {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) return false;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return true;
};

/** @param {number} pid */
const isAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * A fake engine with its pid file and receive log in a fresh directory.
 * @param {import('ava').ExecutionContext} t
 * @param {string} mode
 * @param {import('../../resources/agent-host/impl/speech/stt-process.js').ProcessSttOptions} [options]
 */
const makeFake = (t, mode, options = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'thix-stt-'));
  const pidFile = join(dir, 'pids');
  const logFile = join(dir, 'received');
  /** @type {Record<string, unknown>[]} */
  const events = [];
  const engine = makeProcessSttEngine(
    {
      kind: 'process',
      command: [
        process.execPath,
        FAKE_STT,
        '--mode',
        mode,
        '--pid-file',
        pidFile,
        '--log',
        logFile,
      ],
      language: 'en',
    },
    { log: event => events.push(event), ...options },
  );
  t.teardown(async () => {
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const pids = () =>
    existsSync(pidFile)
      ? readFileSync(pidFile, 'utf8').trim().split('\n').map(Number)
      : [];
  /** @returns {Record<string, any>[]} */
  const received = () =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .trim()
          .split('\n')
          .map(line => JSON.parse(line))
      : [];
  return { engine, events, pids, received };
};

/** A sink that records every call and resolves when the utterance is over. */
const makeSink = () => {
  /** @type {[string, string?][]} */
  const calls = [];
  /** @type {(value: [string, string?]) => void} */
  let resolveDone = () => {};
  /** @type {Promise<[string, string?]>} */
  const done = new Promise(resolve => {
    resolveDone = resolve;
  });
  const sink = harden({
    /** @param {string} phase */
    phase: phase => {
      calls.push(['phase', phase]);
    },
    /** @param {string} text */
    partial: text => {
      calls.push(['partial', text]);
    },
    /** @param {string} text */
    final: text => {
      calls.push(['final', text]);
      resolveDone(['final', text]);
    },
    /** @param {string} reason */
    abort: reason => {
      calls.push(['abort', reason]);
      resolveDone(['abort', reason]);
    },
  });
  return { sink, calls, done };
};

test('partials are cumulative, the final follows END, a trailing odd byte is dropped', async t => {
  const { engine, received } = makeFake(t, 'normal');
  const { sink, calls, done } = makeSink();
  const utterance = engine.open(sink);
  for (let i = 0; i < 20; i += 1) utterance.audio(pcmOf(BLOCK));
  // Partials after END are dropped (as Endo's): wait for them first.
  t.true(
    await waitFor(
      () => calls.filter(([kind]) => kind === 'partial').length === 3,
      5000,
    ),
  );
  // A frame cut mid-sample, then its other half and a trailing odd byte.
  utterance.audio(pcmOf(3));
  utterance.audio(pcmOf(2));
  utterance.end();
  t.deepEqual(await done, ['final', `final ${20 * BLOCK + 4}`]);
  t.deepEqual(calls[0], ['phase', 'listening']);
  const partials = calls.filter(([kind]) => kind === 'partial');
  t.deepEqual(
    partials.map(([, text]) => text),
    ['16320 bytes', '32640 bytes', '48960 bytes'],
    'each partial is the whole text so far',
  );
  const transcribing = calls.findIndex(
    ([kind, value]) => kind === 'phase' && value === 'transcribing',
  );
  t.true(transcribing > 0 && transcribing < calls.length - 1);
  t.false(utterance.tooLong());
  const audio = received().filter(r => r.type === 'stream_audio');
  t.true(audio.every(r => r.pcmBytes % 2 === 0));
});

test('abort tells the engine and ends the sink silently', async t => {
  const { engine, received } = makeFake(t, 'normal');
  const { sink, calls } = makeSink();
  const utterance = engine.open(sink);
  utterance.audio(pcmOf(BLOCK));
  utterance.abort();
  utterance.audio(pcmOf(BLOCK));
  utterance.end();
  t.true(
    await waitFor(() => received().some(r => r.type === 'stream_abort'), 5000),
  );
  await new Promise(resolve => setTimeout(resolve, 50));
  t.deepEqual(calls, []);
  t.false(received().some(r => r.type === 'stream_stop'));
});

test('one resident engine serves utterances in turn and at once, each under its own id', async t => {
  const { engine, events, pids, received } = makeFake(t, 'normal');
  t.is(engine.state(), 'idle');
  for (let i = 1; i <= 3; i += 1) {
    const { sink, done } = makeSink();
    const utterance = engine.open(sink);
    utterance.audio(pcmOf(BLOCK * i));
    utterance.end();
    // eslint-disable-next-line no-await-in-loop
    t.deepEqual(await done, ['final', `final ${BLOCK * i}`]);
  }
  const a = makeSink();
  const b = makeSink();
  const ua = engine.open(a.sink);
  const ub = engine.open(b.sink);
  ua.audio(pcmOf(100));
  ub.audio(pcmOf(200));
  ub.end();
  ua.end();
  t.deepEqual(await a.done, ['final', 'final 100']);
  t.deepEqual(await b.done, ['final', 'final 200']);
  t.is(engine.state(), 'ready');
  t.is(pids().length, 1, 'one process for every utterance');
  t.is(events.filter(e => e.event === 'speech-engine-ready').length, 1);
  const starts = received().filter(r => r.type === 'stream_start');
  t.is(new Set(starts.map(r => r.stream)).size, 5);
});

test('a killed engine fails its utterance and is respawned on the next', async t => {
  const { engine, pids } = makeFake(t, 'normal');
  await engine.warm();
  t.is(engine.state(), 'ready');
  const { sink, done } = makeSink();
  const utterance = engine.open(sink);
  utterance.audio(pcmOf(BLOCK));
  process.kill(pids()[0], 'SIGKILL');
  t.deepEqual(await done, ['abort', speechTexts.engineFailed]);
  t.is(engine.state(), 'idle');
  const next = makeSink();
  const again = engine.open(next.sink);
  again.audio(pcmOf(BLOCK));
  again.end();
  t.deepEqual(await next.done, ['final', `final ${BLOCK}`]);
  t.is(pids().length, 2);
});

test('a start failure aborts with engineUnavailable and pacing holds the next start', async t => {
  const { engine, pids } = makeFake(t, 'crash-at-start', {
    restart: { failuresInWindow: 3, windowMs: 60_000, backoffMs: 60_000 },
  });
  for (let i = 0; i < 3; i += 1) {
    const { sink, done } = makeSink();
    engine.open(sink).audio(pcmOf(BLOCK));
    // eslint-disable-next-line no-await-in-loop
    t.deepEqual(await done, ['abort', speechTexts.engineUnavailable]);
  }
  t.is(engine.state(), 'failed');
  const { sink, done } = makeSink();
  engine.open(sink);
  t.deepEqual(await done, ['abort', speechTexts.engineUnavailable]);
  t.is(pids().length, 3, 'no fourth start while the pacing holds');
  await engine.warm();
  t.is(pids().length, 3);
});

test('an error reply aborts with engineFailed and the engine keeps serving', async t => {
  const { engine, events, pids } = makeFake(t, 'error-on-stop');
  const { sink, done } = makeSink();
  const utterance = engine.open(sink);
  utterance.audio(pcmOf(BLOCK));
  utterance.end();
  t.deepEqual(await done, ['abort', speechTexts.engineFailed]);
  const failed = events.filter(e => e.event === 'speech-engine-failed');
  t.is(failed.length, 1);
  t.false(
    JSON.stringify(failed).includes('fake failure'),
    'engine text is never logged',
  );
  t.is(engine.state(), 'ready');
  t.is(pids().length, 1);
});

test('an engine silent while audio flows times out and is restarted on next use', async t => {
  // Lines: stream_start, stream_audio, then nothing is read.
  const { engine, pids, events } = makeFake(t, 'hang-after=2', {
    timeouts: { engineTimeoutMs: 300 },
  });
  await engine.warm();
  const { sink, done } = makeSink();
  const utterance = engine.open(sink);
  const started = Date.now();
  // 1.02 s of audio: the timer runs from the frame that completes 1 s.
  for (let i = 0; i < 12; i += 1) utterance.audio(pcmOf(BLOCK));
  t.deepEqual(await done, ['abort', speechTexts.engineTimeout]);
  t.true(Date.now() - started >= 280);
  t.true(events.some(e => e.event === 'speech-engine-timeout'));
  const hung = pids()[0];
  t.true(
    await waitFor(() => !isAlive(hung), 5000),
    'the hung engine is killed',
  );
  t.true(await waitFor(() => engine.state() === 'idle', 2000));

  const quiet = makeFake(t, 'hang-after=2', {
    timeouts: { engineTimeoutMs: 300 },
  });
  await quiet.engine.warm();
  const second = makeSink();
  const short = quiet.engine.open(second.sink);
  short.audio(pcmOf(BLOCK));
  await new Promise(resolve => setTimeout(resolve, 400));
  t.deepEqual(
    second.calls,
    [['phase', 'listening']],
    'under 1 s of audio: no timer',
  );
  short.end();
  t.deepEqual(
    await second.done,
    ['abort', speechTexts.engineTimeout],
    'END starts the timer',
  );

  // The first engine is respawned for the next utterance (which reads two
  // lines, start and stop, before it hangs again).
  const next = makeSink();
  engine.open(next.sink).end();
  t.deepEqual(await next.done, ['final', 'final 0']);
  t.is(pids().length, 2);
});

test('an utterance without audio for sttIdleMs is abandoned', async t => {
  const { engine, received } = makeFake(t, 'normal', {
    timeouts: { sttIdleMs: 200 },
  });
  const { sink, done } = makeSink();
  const utterance = engine.open(sink);
  utterance.audio(pcmOf(BLOCK));
  t.deepEqual(await done, ['abort', speechTexts.sttIdle]);
  t.true(
    await waitFor(() => received().some(r => r.type === 'stream_abort'), 5000),
  );
});

test('an utterance at its length bound is ended by the engine and the final follows', async t => {
  const { engine, received } = makeFake(t, 'normal', {
    limits: { utteranceBytes: 10_000 },
  });
  const { sink, calls, done } = makeSink();
  const utterance = engine.open(sink);
  for (let i = 0; i < 6; i += 1) utterance.audio(pcmOf(BLOCK));
  t.deepEqual(await done, ['final', 'final 10000']);
  t.true(utterance.tooLong());
  t.true(calls.some(([k, v]) => k === 'phase' && v === 'transcribing'));
  utterance.end();
  t.is(received().filter(r => r.type === 'stream_stop').length, 1);
});

test('a speech-in engine 3 MiB behind aborts the utterance with backlog', async t => {
  const { engine } = makeFake(t, 'hang-after=1', {
    timeouts: { engineTimeoutMs: 60_000 },
  });
  await engine.warm();
  const { sink, done } = makeSink();
  const utterance = engine.open(sink);
  const frame = pcmOf(65_536);
  for (let i = 0; i < 48; i += 1) utterance.audio(frame);
  t.deepEqual(await done, ['abort', speechTexts.backlog]);
});

test('stop aborts open utterances, ends the engine and refuses new ones', async t => {
  const { engine, pids } = makeFake(t, 'normal');
  const { sink, done } = makeSink();
  engine.open(sink).audio(pcmOf(BLOCK));
  await waitFor(() => engine.state() === 'ready', 5000);
  await engine.stop();
  t.deepEqual(await done, ['abort', speechTexts.serviceStopped]);
  t.false(isAlive(pids()[0]));
  const after = makeSink();
  engine.open(after.sink);
  t.deepEqual(await after.done, ['abort', speechTexts.serviceStopped]);
});

const realMoonshine =
  process.env.THIX_HARNESS_REAL_SPEECH === 'moonshine' ? test : test.skip;

realMoonshine('[real-moonshine] silence transcribes to a final', async t => {
  const engine = makeProcessSttEngine(
    {
      kind: 'process',
      command: ['uv', 'run', '--quiet', MOONSHINE, '--lang', 'en'],
      language: 'en',
    },
    { timeouts: { engineTimeoutMs: 30_000 } },
  );
  t.teardown(() => engine.stop());
  await engine.warm();
  t.is(engine.state(), 'ready');
  const { sink, done } = makeSink();
  const utterance = engine.open(sink);
  for (let i = 0; i < 12; i += 1) utterance.audio(new Uint8Array(BLOCK));
  utterance.end();
  const [kind] = await done;
  t.is(kind, 'final');
});
