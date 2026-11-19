// @ts-check
/**
 * Voice data-path perf (`designs/m11-interfaces.md` 14.1; W11.9): the
 * speech host of one adapter incarnation in this process (`AH/speech/
 * host.js` with the real `speechKinds`, so the real `process` engines over
 * the fake engines `test/fixtures/fake-stt.mjs` and `fake-tts.mjs`), the
 * `/audio` route on a real gateway server on loopback, Node `WebSocket`
 * clients as pages, and the real channel registry and `Live` for the speech
 * view. No supervisor: audio never reaches a vat (D-M11-1), so the rows
 * measure the adapter's own path.
 *
 * - `speech.audioForward`: an AUDIO frame sent by the client to the fake
 *   engine reading its `stream_audio` line (socket, route, base64 and JSON,
 *   the pipe), at real-time pacing (one 85 ms block every 85 ms) for one
 *   window. Budget median <= 1 ms, p99 <= 3 ms.
 * - `speech.audioForward.load`: the same with 16 utterances at once (8
 *   ports of 2). Budget p99 <= 5 ms.
 * - `speech.partialRelay`: the fake engine writing a partial line to the
 *   client reading its EVENT frame (from the first window). Budget median
 *   <= 2 ms.
 * - `speech.firstAudio`: a delta completing the first sentence published
 *   in the session's channel to the first PCM frame at the client (the
 *   fake TTS answers at once; the warm spare is in use after the first
 *   playback). Budget median <= 20 ms, p99 <= 50 ms.
 * - `speech.engineRespawn`: the fake speech-in engine SIGKILLed to the next
 *   utterance's first partial (the engine respawned and ready). Budget
 *   median <= 100 ms.
 * - `stt.*` `[real-moonshine]`, `tts.firstAudio` `[real-piper]`,
 *   `provider.*` `[real-provider]`: owner runs, reported as skipped rows.
 *
 * Cross-process times (the engine's log and this process) are wall times
 * with a sub-millisecond fraction (`performance.timeOrigin +
 * performance.now()` in both processes of one machine).
 *
 * Windows: VOICE_WINDOW_MS (default 60,000) per row, scaled by
 * PERF_WINDOW_SCALE; five rows, about 5.5 minutes.
 *
 *   node perf/voice.perf.mjs            # exclusive (recorded numbers)
 *   node perf/voice.perf.mjs --shared   # a smoke during a unit
 */
import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import url from 'node:url';

import { runWindow, windowFields, windowMs } from './_window.mjs';

await import('../scripts/_init.mjs');
await import('../test/unit/_m1a-prelude.js');
const { emit, runPerf, stats } = await import('./_harness.mjs');
const { E } = await import('@endo/far');
const { makeVoiceStub, makeHostContext, openAudioSocket } =
  await import('../test/adapter/_speech-host.js');
const { makeGatewayServer } =
  await import('../resources/agent-host/impl/gateway/server.js');
const { makeSpeechHost } =
  await import('../resources/agent-host/impl/speech/host.js');
const { speechKinds } =
  await import('../resources/agent-host/impl/speech/kinds.js');
const { makeAudioRoute } =
  await import('../resources/agent-host/impl/speech/route.js');
const { makeSpeechText } =
  await import('../resources/agent-host/impl/speech/speech-text.js');
const { openTurnView } =
  await import('../resources/agent-host/impl/speech/turn-view.js');
const { frameKinds } =
  await import('../resources/agent-host/impl/speech/audio-protocol.js');
const { makeChannelRegistry } =
  await import('../resources/agent-host/impl/channels.js');
const { makeLive } =
  await import('../resources/agent-host/impl/live-service.js');
const { BLOCK_BYTES, makeClip } =
  await import('../test/fixtures/voice-clip.mjs');
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
const { interfaces, methodNames } = await import('../guest/lib/interfaces.js');
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { makeExo } = /** @type {GuestGlobals} */ (globalThis);

const here = path.dirname(url.fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', 'test', 'fixtures');
const WINDOW = windowMs('VOICE_WINDOW_MS', 60_000);
const BLOCK_MS = 85;
const LOAD_UTTERANCES = 16;
const VOICE = 'en_US-test-medium';

/** Wall time in ms with a sub-millisecond fraction. */
const wallNow = () => performance.timeOrigin + performance.now();

/**
 * Lines of a JSON-lines log (an empty list when it does not exist yet).
 * @param {string} file
 * @returns {any[]}
 */
const readLines = file => {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
};

/**
 * The engine-side entries of one type, per engine stream id, in order.
 * @param {any[]} lines
 * @param {string} type
 */
const byStream = (lines, type) => {
  /** @type {Map<string, number[]>} */
  const out = new Map();
  for (const line of lines) {
    if (line.type === type && typeof line.at === 'number') {
      const list = out.get(line.stream) ?? [];
      list.push(line.at);
      out.set(line.stream, list);
    }
  }
  return out;
};

/**
 * Engine stream ids in the order their `stream_start` was read.
 * @param {any[]} lines
 */
const streamOrder = lines =>
  lines.filter(line => line.type === 'stream_start').map(line => line.stream);

/** A Session presence with the product's guard (every method inert). */
const makeSession = () =>
  makeExo(
    'Session',
    /** @type {any} */ (interfaces.Session),
    Object.fromEntries(
      /** @type {any} */ (methodNames).Session.map(
        (/** @type {string} */ method) => [method, () => undefined],
      ),
    ),
  );

/**
 * A page: one port bound to one socket, with the arrival time of each
 * frame.
 * @param {any} speech
 * @param {number} port
 * @param {string} origin
 */
const openPage = async (speech, port, origin) => {
  const grant = await E(speech).openAudio();
  const socket = await openAudioSocket({ port, origin });
  /** @type {{ kind: number, stream: number, type?: string, at: number }[]} */
  const arrivals = [];
  /** @type {Set<() => void>} */
  const waiters = new Set();
  /**
   * The first arrival `match` accepts, waiting up to `ms` for it (this
   * listener's own wake-up: the socket helper's runs before it).
   * @param {(a: { kind: number, stream: number, type?: string, at: number }) => boolean} match
   * @param {number} [ms]
   */
  const arrival = (match, ms = 10_000) =>
    new Promise((resolve, reject) => {
      const look = () => {
        const found = arrivals.find(match);
        if (found === undefined) return;
        waiters.delete(look);
        clearTimeout(timer);
        resolve(found);
      };
      const timer = setTimeout(() => {
        waiters.delete(look);
        reject(Error('timed out waiting for an audio frame'));
      }, ms);
      waiters.add(look);
      look();
    });
  socket.ws.addEventListener('message', (/** @type {any} */ message) => {
    const at = wallNow();
    const bytes = Buffer.from(/** @type {ArrayBuffer} */ (message.data));
    const kind = bytes[0];
    const stream = bytes.readUInt16BE(2);
    /** @type {string | undefined} */
    let type;
    if (kind === frameKinds.event) {
      type = JSON.parse(bytes.subarray(4).toString('utf8')).type;
    }
    arrivals.push({ kind, stream, at, ...(type ? { type } : {}) });
    for (const waiter of [...waiters]) waiter();
  });
  socket.hello(grant.token);
  await socket.ready();
  /** Forget what arrived (between samples). */
  const clear = () => {
    arrivals.length = 0;
    socket.frames.length = 0;
  };
  return { socket, port: grant.port, arrivals, arrival, clear };
};

await runPerf('voice', async ({ root }) => {
  const stateDir = path.join(root, 'state');
  mkdirSync(path.join(stateDir, 'agent-host'), { recursive: true });
  const sttLog = path.join(root, 'stt.log');
  const sttPids = path.join(root, 'stt.pids');
  const settings = harden({
    speechIn: {
      kind: 'process',
      command: [
        process.execPath,
        path.join(fixtures, 'fake-stt.mjs'),
        '--log',
        sttLog,
        '--clock',
        '--pid-file',
        sttPids,
      ],
      language: 'en',
      warm: true,
    },
    speechOut: {
      kind: 'process',
      command: [process.execPath, path.join(fixtures, 'fake-tts.mjs')],
      voicesDir: path.join(fixtures, 'voices'),
      defaultVoice: VOICE,
    },
    revision: 1,
  });
  const stub = makeVoiceStub(settings);
  const registry = makeChannelRegistry();
  const live = makeLive({ channels: registry });
  const { context } = makeHostContext({ voice: stub.voice, live, stateDir });
  const host = makeSpeechHost({
    context,
    kinds: speechKinds,
    pipeline: harden({ openTurnView, makeSpeechText }),
  });
  const server = await makeGatewayServer({
    port: 0,
    routes: [makeAudioRoute({ hostNow: () => host })],
    staticHandler: () => false,
    onSocket: socket => socket.close(1000, 'not under test'),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  /** @type {Awaited<ReturnType<typeof openPage>>[]} */
  const pages = [];
  try {
    const page = await openPage(host.speech, server.port, origin);
    pages.push(page);
    const block = makeClip({
      seconds: 1,
      speechAtMs: [0],
      silenceAtMs: [],
    }).subarray(0, BLOCK_BYTES);

    // ---- speech.audioForward and speech.partialRelay: one utterance.
    /**
     * Stream `utterances` paced at one block per 85 ms for the window;
     * answer each utterance's send times and its stream number.
     * @param {{ page: any, stream: number }[]} utterances
     */
    const paced = async utterances => {
      /** @type {number[][]} */
      const sent = utterances.map(() => []);
      const t0 = performance.now();
      // Each utterance sends at its own phase of the 85 ms period, as
      // independent pages do.
      const step = BLOCK_MS / utterances.length;
      const w = await runWindow(
        async i => {
          for (const [k, u] of utterances.entries()) {
            const wait = t0 + i * BLOCK_MS + k * step - performance.now();

            if (wait > 0) await delay(wait);
            sent[k].push(wallNow());
            u.page.socket.send(frameKinds.audio, u.stream, block);
          }
          const wait = t0 + (i + 1) * BLOCK_MS - performance.now();
          if (wait > 0) await delay(wait);
        },
        { ms: WINDOW },
      );
      for (const u of utterances) u.page.socket.send(frameKinds.end, u.stream);
      await Promise.all(
        utterances.map(u => u.page.socket.event(u.stream, 'end', 20_000)),
      );
      return { sent, w };
    };

    /**
     * Open `n` utterances in order (the engine reads their starts in this
     * order), on `pagesFor(k)`.
     * @param {number} n
     * @param {(k: number) => any} pageFor
     */
    const openUtterances = async (n, pageFor) => {
      const out = [];
      for (let k = 0; k < n; k += 1) {
        const p = pageFor(k);

        const { stream } = await E(p.port).transcribe();

        await p.socket.event(stream, 'phase');
        out.push({ page: p, stream });
      }
      return out;
    };

    /**
     * Engine-read minus client-send per frame, utterance by utterance.
     * @param {number[][]} sent
     * @param {string[]} ids engine stream ids of these utterances, in order
     * @param {any[]} lines
     */
    const forwardSamples = (sent, ids, lines) => {
      const read = byStream(lines, 'stream_audio');
      /** @type {number[]} */
      const samples = [];
      let unmatched = 0;
      for (const [k, id] of ids.entries()) {
        const at = read.get(id) ?? [];
        unmatched += Math.abs(at.length - sent[k].length);
        for (let i = 0; i < Math.min(at.length, sent[k].length); i += 1) {
          samples.push(at[i] - sent[k][i]);
        }
      }
      return { samples, unmatched };
    };

    // The engine ready before any window (its first start is not a row).
    const half = makeClip({ seconds: 0.5, speechAtMs: [0], silenceAtMs: [] });
    {
      const { stream } = await E(page.port).transcribe();
      page.socket.send(frameKinds.audio, stream, half);
      await page.arrival(a => a.stream === stream && a.type === 'partial');
      page.socket.send(frameKinds.abort, stream);
      page.clear();
    }
    let lines = readLines(sttLog);
    const before = streamOrder(lines).length;
    const single = await openUtterances(1, () => page);
    const one = await paced(single);
    lines = readLines(sttLog);
    const ids1 = streamOrder(lines).slice(before, before + 1);
    const forward1 = forwardSamples(one.sent, ids1, lines);
    await stats('speech.audioForward', forward1.samples, {
      budget: { median: 1, p99: 3 },
      ...windowFields({ ...one.w, samples: forward1.samples }),
      extra: {
        frameBytes: BLOCK_BYTES,
        paceMs: BLOCK_MS,
        unmatched: forward1.unmatched,
      },
    });
    // Partials: engine write to the client's EVENT, pairwise per stream.
    const written = byStream(lines, 'partial').get(ids1[0]) ?? [];
    const relayed = page.arrivals
      .filter(a => a.stream === single[0].stream && a.type === 'partial')
      .map(a => a.at);
    const relay = written
      .slice(0, relayed.length)
      .map((at, i) => relayed[i] - at);
    await stats('speech.partialRelay', relay, {
      budget: { median: 2 },
      ...windowFields({ ...one.w, samples: relay }),
      extra: { partialEveryBytes: 16_000 },
    });

    // ---- speech.audioForward.load: 16 utterances on 8 ports.
    for (let p = 1; p < LOAD_UTTERANCES / 2; p += 1) {
      pages.push(await openPage(host.speech, server.port, origin));
    }
    const before16 = streamOrder(readLines(sttLog)).length;
    const many = await openUtterances(
      LOAD_UTTERANCES,
      k => pages[Math.floor(k / 2)],
    );
    const load = await paced(many);
    lines = readLines(sttLog);
    const ids16 = streamOrder(lines).slice(
      before16,
      before16 + LOAD_UTTERANCES,
    );
    const forward16 = forwardSamples(load.sent, ids16, lines);
    await stats('speech.audioForward.load', forward16.samples, {
      budget: { p99: 5 },
      ...windowFields({ ...load.w, samples: forward16.samples }),
      extra: {
        utterances: LOAD_UTTERANCES,
        ports: pages.length,
        unmatched: forward16.unmatched,
      },
    });
    for (const extra of pages.splice(1)) extra.socket.close();

    // ---- speech.firstAudio: a live delta to the first PCM frame.
    const session = makeSession();
    const channel = registry.channelFor(session);
    let rev = 0;
    /** @param {any[]} events */
    const publish = events => {
      rev += 1;
      channel.publisher.publish(harden({ rev, events }));
    };
    /**
     * One spoken turn: open the playback, publish the sentence, wait for
     * its first PCM frame; end the turn and wait for the stream's end.
     * @param {number} i
     */
    const spokenTurn = async i => {
      const turnId = `t${i}`;
      publish([{ type: 'turn-start', turnId, input: 'hi', at: i }]);
      const { stream } = await E(page.port).speak(session, turnId);
      const t0 = wallNow();
      channel.publishDelta(
        harden({ type: 'delta', turnId, round: 0, text: 'Hello there. ' }),
      );
      const first = /** @type {any} */ (
        await page.arrival(
          a => a.stream === stream && a.kind === frameKinds.pcm,
        )
      );
      publish([
        { type: 'final', turnId, text: 'Hello there.' },
        { type: 'end', turnId, status: 'completed' },
      ]);
      await page.arrival(a => a.stream === stream && a.type === 'end');
      page.clear();
      return first.at - t0;
    };
    const cold = await spokenTurn(0);
    const spoken = await runWindow(i => spokenTurn(i + 1), { ms: WINDOW });
    const firstAudio = spoken.results;
    await stats('speech.firstAudio', firstAudio, {
      budget: { median: 20, p99: 50 },
      ...windowFields({ ...spoken, samples: firstAudio }),
      extra: { coldMs: +cold.toFixed(3), spare: true },
    });

    // ---- speech.engineRespawn: SIGKILL to the next utterance's partial.
    /** The engine's pid now (the pid file's last line). */
    const enginePid = () => {
      const pids = readFileSync(sttPids, 'utf8').trim().split('\n');
      return Number(pids[pids.length - 1]);
    };
    /** @param {number} pid */
    const gone = pid => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };
    const respawned = await runWindow(
      async () => {
        const pid = enginePid();
        const t0 = wallNow();
        process.kill(pid, 'SIGKILL');
        while (!gone(pid)) {
          await delay(1);
        }
        // Let the adapter hear the exit before the next open.
        await delay(2);
        const { stream } = await E(page.port).transcribe();
        page.socket.send(frameKinds.audio, stream, half);
        const partial = /** @type {any} */ (
          await page.arrival(a => a.stream === stream && a.type === 'partial')
        );
        page.socket.send(frameKinds.abort, stream);
        page.clear();
        if (enginePid() === pid) throw Error('the engine was not respawned');
        return partial.at - t0;
      },
      { ms: WINDOW, max: 600 },
    );
    await stats('speech.engineRespawn', respawned.results, {
      budget: { median: 100 },
      ...windowFields({ ...respawned, samples: respawned.results }),
      extra: { measuredTo: 'first partial after respawn' },
    });

    // ---- owner runs.
    for (const [metric, tag] of [
      ['stt.partialLatency', '[real-moonshine]'],
      ['stt.finalLatency', '[real-moonshine]'],
      ['tts.firstAudio', '[real-piper]'],
      ['provider.final', '[real-provider]'],
      ['provider.firstPcm', '[real-provider]'],
    ]) {
      emit({ metric, skipped: `${tag} owner run`, pass: null });
    }
  } finally {
    for (const p of pages) p.socket.close();
    await host.stop();
    await server.close();
  }
});
