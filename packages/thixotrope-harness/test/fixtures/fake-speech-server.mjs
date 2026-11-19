// @ts-check
/**
 * The fake speech server (M11; `designs/m11-interfaces.md` appendix B): an
 * HTTP server of the OpenAI audio API's shape on 127.0.0.1 and a free port,
 * never another address. No real provider, no real key: it keeps the
 * SHA-256 of each `Authorization` header, never the value.
 *
 *   const server = await startFakeSpeechServer();
 *   // the settings' baseUrl: server.baseUrl (`http://127.0.0.1:<port>/v1`)
 *   server.setModes(['429']); // the next request answers 429, then normal
 *   server.requests(); // [{ path, mode, authorizationSha256, ... }]
 *   await server.close();
 *
 * Run as a script (`node test/fixtures/fake-speech-server.mjs`) it prints
 * its port on stdout and serves until killed.
 *
 * Routes:
 * - `POST /v1/audio/transcriptions` (multipart): answers
 *   `{ "text": "final <bytes>" }`, `<bytes>` the PCM bytes of the WAV in the
 *   `file` part (its `data` chunk). Recorded: `model`, `language`,
 *   `responseFormat`, `pcmBytes`, `wavRate`.
 * - `POST /v1/audio/speech` (JSON `{ model, input, voice, speed,
 *   response_format }`): streams 24 kHz s16le mono PCM, 100 ms of a 440 Hz
 *   tone per 10 characters of `input` (at least one block), scaled by
 *   `1 / speed`, in chunks of `chunkBytes` (default 4,800: 100 ms).
 *   Recorded: `json`.
 *
 * Modes, taken per request from the `x-fake-mode` header, else from the
 * queue `setModes` fills (one entry per request; `normal` when empty):
 * `normal`, `401`, `403`, `429`, `500` (status with a body carrying
 * `SPEECH_BODY_MARKER`), `hang` (no answer; recorded `closed` when the
 * client goes away), `slow-body` (speech: each chunk after `slowMs`,
 * default 50; transcription: the JSON in two parts `slowMs` apart),
 * `stall-body` (speech: the first chunk, then nothing), `huge-json`
 * (transcription: a 100 KB JSON answer), `bad-json` (an answer that does
 * not parse), `empty-body` (speech: 200 with no PCM), `odd-chunks` (speech:
 * chunks of an odd number of bytes).
 *
 * Node only (tests and perf).
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** Text in every error body: a test finds it in no failure text, event or log line. */
export const SPEECH_BODY_MARKER = 'FAKE-SPEECH-BODY-do-not-show';

/** Sample rate of the speech answers. */
export const FAKE_SPEECH_RATE = 24_000;

/** @param {string} text */
export const sha256Of = text => createHash('sha256').update(text).digest('hex');

/**
 * PCM the speech route answers for `input` at `speed` (s16le mono).
 * @param {string} input
 * @param {number} [speed]
 */
export const fakeSpeechPcm = (input, speed = 1) => {
  const blocks = Math.max(1, Math.ceil(input.length / 10));
  const samples = Math.round((blocks * FAKE_SPEECH_RATE) / 10 / speed);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1)
    pcm.writeInt16LE(
      Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / FAKE_SPEECH_RATE)),
      i * 2,
    );
  return pcm;
};

/**
 * The `data` chunk of a WAV, and its sample rate.
 * @param {Uint8Array} wav
 */
const wavData = wav => {
  const bytes = Buffer.from(wav);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF') return undefined;
  let at = 12;
  let rate;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ') rate = bytes.readUInt32LE(at + 12);
    if (id === 'data')
      return { pcmBytes: Math.min(size, bytes.length - at - 8), rate };
    at += 8 + size;
  }
  return undefined;
};

/**
 * @typedef {object} RecordedSpeechRequest
 * @property {string} path
 * @property {string} mode
 * @property {string | undefined} authorizationSha256
 * @property {number} at `Date.now()` when the request head arrived
 * @property {boolean} closed the client went away before the answer ended
 * @property {boolean} completed
 * @property {string} [model]
 * @property {string} [language]
 * @property {string} [responseFormat]
 * @property {number} [pcmBytes]
 * @property {number} [wavRate]
 * @property {any} [json]
 */

/**
 * @param {{ chunkBytes?: number, slowMs?: number }} [options]
 */
export const startFakeSpeechServer = async ({
  chunkBytes = 4800,
  slowMs = 50,
} = {}) => {
  /** @type {string[]} */
  let modes = [];
  /** @type {RecordedSpeechRequest[]} */
  const recorded = [];
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  const handle = async (req, res) => {
    const header = req.headers['x-fake-mode'];
    const mode =
      (typeof header === 'string' ? header : undefined) ??
      modes.shift() ??
      'normal';
    const auth = req.headers.authorization;
    /** @type {RecordedSpeechRequest} */
    const record = {
      path: req.url ?? '',
      mode,
      authorizationSha256: auth === undefined ? undefined : sha256Of(auth),
      at: Date.now(),
      closed: false,
      completed: false,
    };
    recorded.push(record);
    res.on('close', () => {
      if (!record.completed) record.closed = true;
    });
    /** @type {Buffer[]} */
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const body = Buffer.concat(parts);
    const done = () => {
      record.completed = true;
    };
    if (/^(401|403|429|500)$/.test(mode)) {
      res.writeHead(Number(mode), { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: SPEECH_BODY_MARKER } }));
      done();
      return;
    }
    if (mode === 'hang') return;
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      done();
      return;
    }
    if (record.path === '/v1/audio/transcriptions') {
      const form = await new Response(body, {
        headers: { 'content-type': req.headers['content-type'] ?? '' },
      }).formData();
      const file = form.get('file');
      const data =
        file instanceof Blob
          ? wavData(new Uint8Array(await file.arrayBuffer()))
          : undefined;
      record.model = String(form.get('model'));
      record.language = String(form.get('language'));
      record.responseFormat = String(form.get('response_format'));
      record.pcmBytes = data?.pcmBytes;
      record.wavRate = data?.rate;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (mode === 'huge-json') {
        res.end(JSON.stringify({ text: 'x'.repeat(100_000) }));
      } else if (mode === 'bad-json') {
        res.end('{"text": ');
      } else {
        const answer = JSON.stringify({ text: `final ${data?.pcmBytes ?? -1}` });
        if (mode === 'slow-body') {
          res.write(answer.slice(0, 5));
          await sleep(slowMs);
          if (record.closed) return;
        }
        res.end(mode === 'slow-body' ? answer.slice(5) : answer);
      }
      done();
      return;
    }
    if (record.path === '/v1/audio/speech') {
      const json = JSON.parse(body.toString('utf8'));
      record.json = json;
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.flushHeaders();
      if (mode === 'empty-body') {
        res.end();
        done();
        return;
      }
      const pcm = fakeSpeechPcm(String(json.input), Number(json.speed) || 1);
      const step = mode === 'odd-chunks' ? 4801 : chunkBytes;
      for (let at = 0; at < pcm.length; at += step) {
        if (record.closed) return;
        if (mode === 'slow-body' && at > 0) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(slowMs);
          if (record.closed) return;
        }
        const ok = res.write(pcm.subarray(at, at + step));
        if (mode === 'stall-body') return;
        if (!ok)
          // eslint-disable-next-line no-await-in-loop
          await new Promise(resolve => {
            res.once('drain', resolve);
            res.once('close', resolve);
          });
      }
      res.end();
      done();
      return;
    }
    res.writeHead(404).end();
    done();
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const { port } = /** @type {import('node:net').AddressInfo} */ (
    server.address()
  );
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    /** The settings' `baseUrl`. */
    baseUrl: `http://127.0.0.1:${port}/v1`,
    /** @param {string[]} next the modes of the next requests, in order */
    setModes: next => {
      modes = [...next];
    },
    /** @returns {RecordedSpeechRequest[]} */
    requests: () => recorded.map(entry => ({ ...entry })),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(() => resolve(undefined)));
    },
  };
};

/** @typedef {Awaited<ReturnType<typeof startFakeSpeechServer>>} FakeSpeechServer */

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startFakeSpeechServer();
  process.stdout.write(`${server.port}\n`);
}
