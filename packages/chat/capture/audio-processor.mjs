// audio-processor.mjs — the SWAPPABLE audioProcessor capability.
//
// This is the whole point of the design: the capture service holds an
// `audioProcessor` as an endo `Far` object with a clean, stable interface and
// never knows (or cares) how the audio actually gets turned into text. Swapping
// the implementation is a one-liner in server.mjs (change which factory is
// imported / called). Everything downstream — the markdown note, the frontmatter
// `model:` field, the API response — flows from whatever this cap returns.
//
// INTERFACE (stable contract — do not break):
//   E(audioProcessor).process(bytes, { mime, filename, hint, text }) =>
//     { transcript: string, model: string, meta?: object }
//
//   - bytes:    Uint8Array of the raw audio (may be empty if a text-only capture)
//   - mime:     e.g. 'audio/m4a', 'audio/wav', 'audio/mpeg'  (best-effort)
//   - filename: original filename if known (best-effort)
//   - hint:     optional free-text hint from the client (e.g. a title)
//   - text:     optional already-typed text the client sent alongside/instead of
//               audio. A processor MAY fold this into the transcript.
//   returns transcript (markdown body), the model id used, and free-form meta.
//
// ---------------------------------------------------------------------------
// DEFAULT IMPL = STUB. It does NOT transcribe. It returns a pending marker so a
// capture is never lost — the audio is always saved by the caller, and the note
// records that transcription is pending. This is deliberate: a multimodal audio
// model is being spun up on ~/tinix by another agent RIGHT NOW; we must NOT
// assume it's ready, NOT contend for the GPU, and NOT block startup on it.
//
// ---------------------------------------------------------------------------
// HOW TO WIRE THE REAL PROCESSOR LATER (the documented seam):
//
//   Option A — whisper / OpenAI-compatible HTTP transcription endpoint
//   (e.g. faster-whisper-server, whisper.cpp server, or a vLLM/llama.cpp
//   multimodal-audio model exposing POST /v1/audio/transcriptions):
//
//     export const makeAudioProcessor = () =>
//       makeHttpWhisperProcessor({ url: 'http://127.0.0.1:9000/v1/audio/transcriptions',
//                                  model: 'whisper-1' });
//
//   makeHttpWhisperProcessor is provided below, ready to use — just flip the
//   export at the bottom of this file (one line) once the endpoint is live.
//
//   Option B — a multimodal audio LLM cap dialed over Noise (the same shape as
//   packages/ocapn-noise/imagegen-server.mjs, which vends a GPU cap over an
//   ocapn-noise TCP transport and STREAMS large blobs in 32766-byte chunks to
//   stay under the 65519-byte CapTP message ceiling — see memory
//   noise_captp_message_ceiling). For that path:
//     1. stand up an `audioGen`/`transcribe` exo on tinix behind a Noise node
//        (clone imagegen-server.mjs; E(transcribe).run({ audio }) -> { text }),
//     2. dial it here at startup (makeOcapnNoiseNetwork + makeTcpTransport,
//        connect, fetch the swissnum), keep the remote cap,
//     3. export a factory whose process() chunks `bytes` to the remote cap and
//        awaits the text. Because audio can exceed 65519 bytes, you MUST chunk
//        (a bytes-reader cap), exactly like imagegen-server streams PNGs.
//   The capture service is already async/E()-based, so dropping in a remote
//   `Far`/promise here needs no change to server.mjs beyond the import.
//
// Every consumer talks to this via E(...).process(...), so a local stub, a
// local HTTP processor, and a remote Noise cap are fully interchangeable.

import { Far } from '@endo/marshal';

const PENDING = '(transcription pending — audioProcessor not yet wired)';

// Known whisper mis-transcriptions of proper names in this household.
// Each entry is [regex, replacement]; applied to the raw whisper output only.
const DEFAULT_CORRECTIONS = harden([
  // "Kazimira" (operator's daughter) is consistently heard as Cosimira/Cosimera.
  [/\b[Cc]o[sz]imer[ao]\b/g, 'Kazimira'],
  // "Rovie" (the household rover robot) is heard as "Roe V" or "Roe-V".
  [/\b[Rr]oe[- ][Vv]\b/g, 'Rovie'],
  // "Kumavis" (colleague) is heard as Kumavas/Kumavus/Kumavis'.
  [/\bKuma[vw][aeiu]s\b/gi, 'Kumavis'],
]);

// NB: clone each pattern. Under SES the corrections table is hardened, which
// freezes the regex objects; String.replace with a /g regex resets `lastIndex`,
// and assigning to a frozen regex's lastIndex throws. A fresh RegExp is mutable.
const applyCorrections = (text, corrections) =>
  corrections.reduce((t, [pattern, replacement]) => t.replace(new RegExp(pattern.source, pattern.flags), replacement), text);

/**
 * STUB processor (default). Saves nothing itself (the caller persists audio);
 * just returns a pending marker, folding in any client-supplied text so a
 * text-only or text+audio capture still carries content.
 */
export const makeStubAudioProcessor = () =>
  Far('StubAudioProcessor', {
    async process(bytes, opts = {}) {
      const { text, hint } = opts;
      const parts = [];
      if (typeof text === 'string' && text.trim()) parts.push(text.trim());
      // The pending marker is always present so the note clearly signals that
      // the audio still needs a real pass — even when text was supplied.
      const hasAudio = bytes && bytes.length > 0;
      if (hasAudio || parts.length === 0) parts.push(PENDING);
      return harden({
        transcript: parts.join('\n\n'),
        model: 'stub',
        meta: harden({
          pending: hasAudio,
          audioBytes: hasAudio ? bytes.length : 0,
          ...(hint ? { hint } : {}),
        }),
      });
    },
  });

/**
 * REAL processor (Option A), ready but NOT the default. Posts the audio to an
 * OpenAI-compatible /v1/audio/transcriptions endpoint using multipart/form-data
 * (node's built-in fetch + FormData/Blob, no deps). Flip the export below to use.
 *
 * @param {{url:string, model?:string, apiKey?:string}} cfg
 */
export const makeHttpWhisperProcessor = ({ url, model = 'whisper-1', apiKey } = {}) =>
  Far('HttpWhisperAudioProcessor', {
    async process(bytes, opts = {}) {
      const { mime = 'application/octet-stream', filename = 'audio', text } = opts;
      if (!bytes || bytes.length === 0) {
        // Text-only capture: nothing to transcribe.
        return harden({
          transcript: (text && text.trim()) || PENDING,
          model: 'text-only',
          meta: harden({ pending: false }),
        });
      }
      const form = new FormData();
      form.append('model', model);
      form.append(
        'file',
        new Blob([bytes], { type: mime }),
        filename,
      );
      const res = await fetch(url, {
        method: 'POST',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
        body: form,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`transcription endpoint ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      const transcript = (data && (data.text ?? data.transcript)) || '';
      const merged =
        text && text.trim() ? `${text.trim()}\n\n${transcript}` : transcript;
      return harden({
        transcript: merged || PENDING,
        model,
        meta: harden({ pending: false, endpoint: url }),
      });
    },
  });

/**
 * REAL multimodal processor (the ACTIVE one): a whisper -> gemma chain.
 *
 *   audio  -> faster-whisper transcribes VERBATIM -> gemma-4 adds title/summary/tags
 *   text   -> gemma-4 enriches the typed text
 *   image  -> gemma-4 VISION describes it (gemma-4-31b has a vision tower but NO
 *             audio tower — verified 2026-06-06 — hence whisper does the audio)
 *
 * Fidelity: the whisper transcript is kept VERBATIM — we never let the LLM rewrite
 * the user's words; gemma only adds metadata on top. Fail-soft: a gemma error still
 * returns the raw transcript, so a capture is never lost just because enrichment
 * hiccuped. Endpoints default to the live tinix deployment; override via env.
 *
 * @param {{whisperUrl?:string, whisperModel?:string, gemmaUrl?:string, gemmaModel?:string}} [cfg]
 */
export const makeGemmaMultimodalProcessor = ({
  whisperUrl = 'http://192.168.50.226:8000/v1/audio/transcriptions',
  whisperModel = 'deepdml/faster-whisper-large-v3-turbo-ct2',
  gemmaUrl = 'http://192.168.50.226:8003/v1/chat/completions',
  gemmaModel = 'default',
  corrections = DEFAULT_CORRECTIONS,
} = {}) => {
  const transcribe = async (bytes, mime, filename) => {
    const form = new FormData();
    form.append('model', whisperModel);
    form.append('file', new Blob([bytes], { type: mime || 'application/octet-stream' }), filename || 'audio');
    // Quality filter: English-only (no foreign-language hallucination), greedy
    // decode, VAD to drop silence, and condition_on_previous_text=false +
    // no-repeat to stop the runaway loops ("…August 22nd…" / "I think this could
    // be very useful to me" ×100) that whisper produces on long/quiet audio.
    form.append('language', process.env.WHISPER_LANG || 'en');
    form.append('temperature', '0');
    form.append('vad_filter', 'true');
    form.append('condition_on_previous_text', 'false');
    form.append('compression_ratio_threshold', '2.2');
    const res = await fetch(whisperUrl, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`whisper ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const data = await res.json();
    return ((data && (data.text ?? data.transcript)) || '').trim();
  };
  const gemma = async (messages, maxTokens = 400) => {
    const res = await fetch(gemmaUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: gemmaModel, messages, max_tokens: maxTokens, temperature: 0.2 }),
    });
    if (!res.ok) throw new Error(`gemma ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  };
  const enrich = async text => {
    const prompt =
      'You are a capture assistant for a personal knowledge system. Given the note ' +
      'below, reply with ONLY a compact JSON object: {"title": a title of at most 8 ' +
      'words, "summary": a 1-2 sentence summary, "tags": an array of 2-5 short ' +
      'lowercase tags, "entities": an array of the proper-noun key terms named in the ' +
      'note (people, projects, orgs, concepts) as written, for cross-linking}. ' +
      'Do NOT include or rewrite the note text itself.\n\nNote:\n' +
      text;
    const raw = await gemma([{ role: 'user', content: prompt }], 350);
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const o = JSON.parse(m[0]);
      return {
        title: o.title,
        summary: o.summary,
        tags: Array.isArray(o.tags) ? o.tags : [],
        entities: Array.isArray(o.entities) ? o.entities : [],
      };
    } catch {
      return null;
    }
  };
  const compose = (body, e) => {
    if (!e) return body;
    const head = [];
    if (e.title) head.push(`# ${e.title}`);
    if (e.summary) head.push(`> ${e.summary}`);
    if (e.tags && e.tags.length) head.push(e.tags.map(t => `#${String(t).trim().replace(/\s+/g, '-')}`).join(' '));
    return head.length ? `${head.join('\n')}\n\n---\n\n${body}` : body;
  };

  return Far('GemmaMultimodalAudioProcessor', {
    async process(bytes, opts = {}) {
      const { mime = '', filename = 'audio', hint, text } = opts;
      const hasAudio = bytes && bytes.length > 0;

      // IMAGE -> gemma vision.
      if (hasAudio && /^image\//.test(mime)) {
        const b64 = Buffer.from(bytes).toString('base64');
        const desc = await gemma([{ role: 'user', content: [
          { type: 'text', text: `Describe this captured image concisely${hint ? ` (hint: ${hint})` : ''}.` },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        ] }], 400);
        return harden({ transcript: desc || PENDING, model: `gemma:${gemmaModel} (vision)`, meta: harden({ pending: false, kind: 'image' }) });
      }

      // AUDIO -> whisper (verbatim) [+ any typed text] -> gemma enrichment.
      let body = text && text.trim() ? text.trim() : '';
      let usedWhisper = false;
      if (hasAudio) {
        const raw = await transcribe(bytes, mime, filename);
        const t = applyCorrections(raw, corrections);
        usedWhisper = true;
        body = body ? `${body}\n\n${t}` : t;
      }
      if (!body) return harden({ transcript: PENDING, model: 'empty', meta: harden({ pending: true }) });

      let e = null;
      let gemmaOk = false;
      try { e = await enrich(body); gemmaOk = !!e; } catch { /* keep the raw transcript */ }

      const model =
        `${usedWhisper ? `whisper:${whisperModel.split('/').pop()} + ` : ''}` +
        `gemma:${gemmaModel}${gemmaOk ? '' : ' (enrich-skipped)'}`;
      return harden({
        transcript: compose(body, e),
        model,
        meta: harden({
          pending: false,
          verbatim: body, // the raw whisper transcript (+ any typed text), WITHOUT gemma's header — the faithful voice note
          ...(e ? { title: e.title, summary: e.summary, tags: e.tags, entities: e.entities } : {}),
          ...(hint ? { hint } : {}),
        }),
      });
    },
  });
};

// ---------------------------------------------------------------------------
// THE SEAM. This single line selects the active processor. Default = stub.
// To wire a real one, replace the body with one of the factories above, e.g.:
//   export const makeAudioProcessor = () =>
//     makeHttpWhisperProcessor({ url: process.env.WHISPER_URL });
export const makeAudioProcessor = () =>
  makeGemmaMultimodalProcessor({
    whisperUrl: process.env.FIELD_WHISPER_URL,
    whisperModel: process.env.FIELD_WHISPER_MODEL,
    gemmaUrl: process.env.FIELD_GEMMA_URL,
    gemmaModel: process.env.FIELD_GEMMA_MODEL,
  });
