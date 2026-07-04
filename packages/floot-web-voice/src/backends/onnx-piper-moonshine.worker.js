// @ts-check
/* eslint-env worker */
// ─────────────────────────────────────────────────────────────────────────────
// BACKEND B — onnx-piper-moonshine WEB WORKER
// ─────────────────────────────────────────────────────────────────────────────
//
// All ONNX model load + inference for Backend B runs HERE, off the main thread.
// The main-thread exos (onnx-piper-moonshine.js) post requests to this worker
// and receive results back over `postMessage`; the channel writers in
// ../wire.js then marshal those results onto the CapTP wire.
//
// Two resident pipelines, warmed once and kept across turns:
//   * STT — Moonshine ONNX (encoder + merged decoder ORT sessions) over
//     accumulated 16 kHz mono Float32 PCM, producing cumulative transcripts.
//   * TTS — a Piper voice `.onnx` + companion `.onnx.json`, fed phoneme ids
//     (espeak-ng IPA -> phoneme_id_map), producing raw s16le PCM per sentence.
//
// EXECUTION PROVIDER
// ------------------
// ORT is configured to prefer the 'webgpu' execution provider with a 'wasm'
// fallback. Threaded WASM needs cross-origin isolation (SharedArrayBuffer); we
// detect it and cap `numThreads` to 1 when it is unavailable so single-threaded
// WASM still works (just slower).
//
// This module is loaded as `{ type: 'module' }`, so it uses static ESM imports.
// `onnxruntime-web` and the phonemizer are resolved by the bundler/host. They
// are NOT dependencies of this package yet — see the REPORT in the PR.

// NOTE: these specifiers will not resolve under `node --check` (syntax-only) or
// until the deps are added to package.json; that is expected for Backend B.
// eslint-disable-next-line import/no-unresolved
import * as ort from 'onnxruntime-web';
// The phonemizer: a browser espeak-ng (IPA) wrapper. `phonemize(text, lang)`
// resolves IPA phoneme strings. See the phonemization TODO below.
// eslint-disable-next-line import/no-unresolved
import { phonemize } from 'phonemizer';

// Pure helpers live in the main-thread module so node tests can cover them
// WITHOUT importing onnxruntime-web; the worker reuses them here.
import {
  bytesToBase64,
  floatToPcm16,
  phonemesToIds,
} from './onnx-piper-moonshine.js';

// ─────────────────────────────────────────────────────────────────────────────
// Defaults — all overridable via the worker `init` message (configurable base
// URLs so the models can be self-hosted same-origin for cross-origin isolation,
// or pulled from the HF hub).
// ─────────────────────────────────────────────────────────────────────────────

// Where the ORT WASM/threading artifacts live. Same-origin hosting is strongly
// preferred so they load under COEP: require-corp.
const DEFAULT_ORT_WASM_PATHS =
  'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/';

// Moonshine ONNX export (encoder + merged decoder + tokenizer). Same model
// FAMILY the server caplet drives, just the ONNX export through ORT.
const DEFAULT_STT_BASE =
  'https://huggingface.co/onnx-community/moonshine-base-ONNX/resolve/main';
// Quantized variants are ~4x smaller and ample for on-device transcription on a
// Pixel 10 Fold. Drop the `_quantized` suffix for full precision.
const DEFAULT_STT_ENCODER = 'onnx/encoder_model_quantized.onnx';
const DEFAULT_STT_DECODER = 'onnx/decoder_model_merged_quantized.onnx';
const DEFAULT_STT_TOKENIZER = 'tokenizer.json';

// A Piper voice. The companion config is `${voice}.json` (Piper ships the JSON
// alongside the `.onnx`). en_US-lessac-medium is a common default voice.
const DEFAULT_TTS_VOICE =
  'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx';

// Moonshine special token ids (from its tokenizer / generation config). The
// decoder starts from BOS and stops at EOS.
const MOONSHINE_BOS_TOKEN_ID = 1;
const MOONSHINE_EOS_TOKEN_ID = 2;
// Moonshine emits at most ~6 tokens per second of audio; cap generation so a
// noisy buffer cannot loop unbounded.
const MOONSHINE_MAX_TOKENS_PER_SECOND = 6;
const MOONSHINE_SAMPLE_RATE = 16_000;
// moonshine-base decoder shape (config.json): hidden_size 416 / 8 heads.
const MOONSHINE_KV_HEADS = 8;
const MOONSHINE_HEAD_DIM = 52;

// ─────────────────────────────────────────────────────────────────────────────
// ORT environment + EP selection.
// ─────────────────────────────────────────────────────────────────────────────

let epReady = false;
/** @type {string[]} */
let executionProviders = ['wasm'];

const configureOrt = ({ wasmPaths, preferWebGPU }) => {
  if (epReady) return;
  ort.env.wasm.wasmPaths = wasmPaths || DEFAULT_ORT_WASM_PATHS;
  // Threaded WASM requires SharedArrayBuffer (cross-origin isolation). Without
  // it, cap to single-threaded so instantiation still succeeds.
  const isolated = globalThis.crossOriginIsolated === true;
  const hardwareThreads =
    /** @type {any} */ (globalThis.navigator)?.hardwareConcurrency || 1;
  ort.env.wasm.numThreads = isolated ? Math.min(4, hardwareThreads) : 1;
  ort.env.wasm.simd = true;
  // Prefer WebGPU, fall back to WASM. ORT tries providers left-to-right.
  executionProviders = preferWebGPU ? ['webgpu', 'wasm'] : ['wasm'];
  epReady = true;
};

/**
 * @param {ArrayBuffer} modelBytes
 * @returns {Promise<import('onnxruntime-web').InferenceSession>}
 */
const makeSession = async modelBytes => {
  try {
    return await ort.InferenceSession.create(modelBytes, {
      executionProviders,
      graphOptimizationLevel: 'all',
    });
  } catch (err) {
    // WebGPU EP can fail to initialize on some adapters even when the API is
    // present; fall back to plain WASM rather than failing the whole pipeline.
    if (executionProviders[0] === 'webgpu') {
      return ort.InferenceSession.create(modelBytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    }
    throw err;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Fetch + cache. Weights are large (tens–hundreds of MB), so fetch each URL
// once and persist it. The Cache API survives reloads and is available in
// workers; OPFS is an alternative for very large blobs.
//
// TODO(caching): wire OPFS (`navigator.storage.getDirectory()`) for blobs that
// exceed Cache API quotas on some Android builds, and add an explicit cache
// version/bust keyed on the model URL.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_NAME = 'endo-floot-web-voice-onnx-v1';

/**
 * @param {string} url
 * @returns {Promise<ArrayBuffer>}
 */
const fetchCached = async url => {
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return await hit.arrayBuffer();
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    // Tee: store one copy, return the other as bytes.
    await cache.put(url, res.clone());
    return await res.arrayBuffer();
  } catch {
    // Cache API unavailable (e.g. opaque storage partition) — fetch directly.
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    return res.arrayBuffer();
  }
};

/**
 * @param {string} url
 * @returns {Promise<any>}
 */
const fetchJsonCached = async url => {
  const bytes = await fetchCached(url);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)));
};

// ─────────────────────────────────────────────────────────────────────────────
// STT — Moonshine.
// ─────────────────────────────────────────────────────────────────────────────

/** @type {{ encoder: any, decoder: any, tokenizer: any } | null} */
let sttPipeline = null;

/**
 * Decode token ids to text using the Moonshine tokenizer.json vocab. We use a
 * minimal byte-level/SentencePiece-agnostic decode: map ids -> tokens via the
 * tokenizer model vocab, join, and clean the metaspace marker (▁). This avoids
 * pulling a full tokenizer dependency for the common case.
 *
 * TODO(tokenizer): for full fidelity across punctuation/byte-fallback, consider
 * `@huggingface/transformers`'s AutoTokenizer here instead of the hand decode.
 *
 * @param {number[]} ids
 * @param {any} tokenizer parsed tokenizer.json
 * @returns {string}
 */
const decodeTokens = (ids, tokenizer) => {
  const vocab = tokenizer?.model?.vocab;
  /** @type {Map<number, string>} */
  const idToTok = new Map();
  if (Array.isArray(vocab)) {
    // SentencePiece form: [[token, score], ...]
    vocab.forEach(([tok], i) => idToTok.set(i, tok));
  } else if (vocab && typeof vocab === 'object') {
    // BPE form: { token: id }
    for (const [tok, id] of Object.entries(vocab)) idToTok.set(Number(id), tok);
  }
  let text = '';
  for (const id of ids) {
    if (id === MOONSHINE_BOS_TOKEN_ID || id === MOONSHINE_EOS_TOKEN_ID)
      continue; // eslint-disable-line no-continue
    const tok = idToTok.get(id);
    if (tok === undefined) continue; // eslint-disable-line no-continue
    text += tok;
  }
  // SentencePiece metaspace (▁) -> space; trim leading marker.
  return text.replace(/▁/g, ' ').replace(/\s+/g, ' ').trim();
};

const loadStt = async cfg => {
  if (sttPipeline) return sttPipeline;
  const base = cfg.sttBase || DEFAULT_STT_BASE;
  const [encBytes, decBytes, tokenizer] = await Promise.all([
    fetchCached(`${base}/${cfg.sttEncoder || DEFAULT_STT_ENCODER}`),
    fetchCached(`${base}/${cfg.sttDecoder || DEFAULT_STT_DECODER}`),
    fetchJsonCached(`${base}/${cfg.sttTokenizer || DEFAULT_STT_TOKENIZER}`),
  ]);
  const [encoder, decoder] = await Promise.all([
    makeSession(encBytes),
    makeSession(decBytes),
  ]);
  sttPipeline = { encoder, decoder, tokenizer };
  return sttPipeline;
};

/**
 * Run Moonshine over a Float32 PCM buffer and return the transcript text.
 * Encoder -> autoregressive merged-decoder loop with KV cache.
 *
 * @param {Float32Array} samples 16 kHz mono.
 * @param {() => boolean} isAborted poll for cancellation between decode steps.
 * @returns {Promise<string>}
 */
const runMoonshine = async (samples, isAborted) => {
  const { encoder, decoder, tokenizer } = await loadStt({});
  const Tensor = ort.Tensor;

  // Encoder: [batch=1, samples].
  const inputValues = new Tensor('float32', samples, [1, samples.length]);
  const encOut = await encoder.run({ input_values: inputValues });
  // The encoder's single output is the hidden-state sequence regardless of its
  // exported name.
  const encoderHiddenStates =
    encOut.last_hidden_state || encOut[Object.keys(encOut)[0]];

  const maxTokens = Math.max(
    8,
    Math.ceil(
      (samples.length / MOONSHINE_SAMPLE_RATE) *
        MOONSHINE_MAX_TOKENS_PER_SECOND,
    ),
  );

  // Seed past_key_values empty tensors for the merged decoder's first pass.
  // moonshine-base: 8 layers, 8 KV heads, head_dim 52 (hidden_size 416 / 8).
  // The encoder-cross KV (".encoder.") has the encoder seq length, but on the
  // use_cache_branch=false pass the merged decoder recomputes all KV, so a
  // zero-length seq placeholder of the correct rank/head-dim is accepted for
  // every past input regardless of self/cross.
  const decoderInputNames = decoder.inputNames;
  /** @type {Record<string, any>} */
  const emptyPast = {};
  for (const name of decoderInputNames) {
    if (name.startsWith('past_key_values.')) {
      emptyPast[name] = new Tensor('float32', new Float32Array(0), [
        1,
        MOONSHINE_KV_HEADS,
        0,
        MOONSHINE_HEAD_DIM,
      ]);
    }
  }

  /** @type {number[]} */
  const generated = [MOONSHINE_BOS_TOKEN_ID];
  let past = emptyPast;
  let useCache = false;

  for (let step = 0; step < maxTokens; step += 1) {
    if (isAborted()) break;
    // On the first pass feed the whole prefix; afterwards only the last token.
    const inputIds = useCache
      ? [generated[generated.length - 1]]
      : generated.slice();
    /** @type {Record<string, any>} */
    const feeds = {
      input_ids: new Tensor('int64', BigInt64Array.from(inputIds.map(BigInt)), [
        1,
        inputIds.length,
      ]),
      encoder_hidden_states: encoderHiddenStates,
      ...past,
    };
    if (decoderInputNames.includes('use_cache_branch')) {
      // ORT bool tensors take a Uint8Array (1/0), not a JS boolean array.
      feeds.use_cache_branch = new Tensor(
        'bool',
        Uint8Array.from([useCache ? 1 : 0]),
        [1],
      );
    }
    // eslint-disable-next-line no-await-in-loop
    const out = await decoder.run(feeds);
    const logits = out.logits;
    const vocabSize = Number(logits.dims[logits.dims.length - 1]);
    const data = /** @type {Float32Array} */ (logits.data);
    // argmax over the last position's logits row.
    const offset = (Number(logits.dims[1]) - 1) * vocabSize;
    let best = 0;
    let bestVal = -Infinity;
    for (let v = 0; v < vocabSize; v += 1) {
      const val = data[offset + v];
      if (val > bestVal) {
        bestVal = val;
        best = v;
      }
    }
    if (best === MOONSHINE_EOS_TOKEN_ID) break;
    generated.push(best);
    // Roll present.* outputs back into past_key_values.* for the next step.
    /** @type {Record<string, any>} */
    const nextPast = {};
    for (const key of Object.keys(out)) {
      if (key.startsWith('present.')) {
        nextPast[`past_key_values.${key.slice('present.'.length)}`] = out[key];
      }
    }
    past = nextPast;
    useCache = true;
  }

  return decodeTokens(generated, tokenizer);
};

// ─────────────────────────────────────────────────────────────────────────────
// TTS — Piper.
// ─────────────────────────────────────────────────────────────────────────────

/** @type {{ session: any, config: any, sampleRate: number } | null} */
let ttsPipeline = null;

const loadTts = async cfg => {
  if (ttsPipeline) return ttsPipeline;
  const voiceUrl = cfg.ttsVoice || DEFAULT_TTS_VOICE;
  const [modelBytes, config] = await Promise.all([
    fetchCached(voiceUrl),
    fetchJsonCached(`${voiceUrl}.json`),
  ]);
  const sampleRate = config?.audio?.sample_rate;
  if (typeof sampleRate !== 'number' || sampleRate <= 0) {
    throw new Error(
      `piper voice config ${voiceUrl}.json missing audio.sample_rate`,
    );
  }
  const session = await makeSession(modelBytes);
  ttsPipeline = { session, config, sampleRate };
  return ttsPipeline;
};

/**
 * Synthesize one sentence -> raw s16le PCM bytes.
 *
 * @param {string} sentence
 * @returns {Promise<{ pcm: Uint8Array, sampleRate: number }>}
 */
const runPiper = async sentence => {
  const { session, config, sampleRate } = await loadTts({});
  const Tensor = ort.Tensor;

  // 1) text -> IPA phonemes. Piper's native pipeline runs espeak-ng in IPA mode
  // (`--ipa=2`); `phonemize()` is the browser espeak-ng wrapper.
  //
  // TODO(phonemizer): confirm `phonemizer`'s output matches espeak-ng `--ipa=2`
  // for the voice's `espeak.voice` (config.espeak?.voice, default 'en-us'),
  // including stress marks and word separators. If the chosen package returns
  // arrays-per-word, flatten with a space between words (Piper treats the word
  // separator as a phoneme present in phoneme_id_map). If it diverges, swap in
  // a wasm espeak-ng build that exposes `--ipa=2` directly. This is the one
  // boundary that cannot be fully validated without running espeak-ng here.
  const espeakVoice = config?.espeak?.voice || 'en-us';
  const phonemeChunks = await phonemize(sentence, espeakVoice);
  const phonemeText = Array.isArray(phonemeChunks)
    ? phonemeChunks.join(' ')
    : `${phonemeChunks}`;

  // 2) phonemes -> ids via the voice's phoneme_id_map (BOS/pad/EOS convention).
  const phonemeIdMap = config?.phoneme_id_map || {};
  const ids = phonemesToIds(phonemeText, phonemeIdMap);
  if (!ids.length) return { pcm: new Uint8Array(0), sampleRate };

  // 3) scales from the voice config (with Piper's documented defaults).
  const inf = config?.inference || {};
  const noiseScale =
    typeof inf.noise_scale === 'number' ? inf.noise_scale : 0.667;
  const lengthScale =
    typeof inf.length_scale === 'number' ? inf.length_scale : 1.0;
  const noiseW = typeof inf.noise_w === 'number' ? inf.noise_w : 0.8;

  const feeds = {
    input: new Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [
      1,
      ids.length,
    ]),
    input_lengths: new Tensor(
      'int64',
      BigInt64Array.from([BigInt(ids.length)]),
      [1],
    ),
    scales: new Tensor(
      'float32',
      Float32Array.from([noiseScale, lengthScale, noiseW]),
      [3],
    ),
  };
  const out = await session.run(feeds);
  // Single float output: [1, 1, T] or [1, T]. Flatten to mono Float32.
  const audio = out[session.outputNames[0]];
  const float = /** @type {Float32Array} */ (audio.data);
  return { pcm: floatToPcm16(float), sampleRate };
};

// ─────────────────────────────────────────────────────────────────────────────
// Worker message protocol.
//
// Main thread -> worker:
//   { type:'init', id, cfg }
//   { type:'stt', id, samples: Float32Array }          // run once over buffer
//   { type:'tts', id, sentence: string }               // synth one sentence
//   { type:'warm', id, which:'stt'|'tts' }             // load + dummy run
//   { type:'abort', id }                               // cooperative cancel
// Worker -> main thread:
//   { type:'ok', id, ...result }
//   { type:'error', id, message }
// ─────────────────────────────────────────────────────────────────────────────

/** Ids of requests the main thread has asked us to abort (cooperative). */
const aborted = new Set();

globalThis.onmessage = async event => {
  const msg = event.data;
  const { type, id } = msg || {};
  const reply = payload => globalThis.postMessage({ id, ...payload });
  try {
    if (type === 'init') {
      configureOrt(msg.cfg || {});
      reply({ type: 'ok' });
      return;
    }
    if (type === 'abort') {
      aborted.add(msg.targetId ?? id);
      reply({ type: 'ok' });
      return;
    }
    if (type === 'warm') {
      if (msg.which === 'stt') {
        await loadStt(msg.cfg || {});
        // Dummy run over 1s of silence so the first real utterance is fast.
        await runMoonshine(
          new Float32Array(MOONSHINE_SAMPLE_RATE),
          () => false,
        ).catch(() => {});
      } else {
        await loadTts(msg.cfg || {});
        await runPiper('Ready.').catch(() => {});
      }
      reply({ type: 'ok' });
      return;
    }
    if (type === 'stt') {
      const text = await runMoonshine(msg.samples, () => aborted.has(id));
      aborted.delete(id);
      reply({ type: 'ok', text });
      return;
    }
    if (type === 'tts') {
      // Cooperative abort: a sentence's ORT run is atomic, but if the consumer
      // aborted this request before or during synthesis, drop the audio (reply
      // empty) so the main thread never emits it.
      if (aborted.has(id)) {
        aborted.delete(id);
        reply({ type: 'ok', b64: '', sampleRate: 0 });
        return;
      }
      const { pcm, sampleRate } = await runPiper(msg.sentence);
      if (aborted.has(id)) {
        aborted.delete(id);
        reply({ type: 'ok', b64: '', sampleRate: 0 });
        return;
      }
      reply({ type: 'ok', b64: bytesToBase64(pcm), sampleRate });
      return;
    }
    reply({ type: 'error', message: `unknown message type ${type}` });
  } catch (err) {
    reply({
      type: 'error',
      message: /** @type {Error} */ (err)?.message || String(err),
    });
  }
};
