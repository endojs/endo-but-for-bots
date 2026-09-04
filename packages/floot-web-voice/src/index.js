// @ts-check
// Public entry point for @endo/floot-web-voice.
//
// `makeLocalVoiceServers` selects the first supported in-browser voice backend
// and hands back ready-to-use STT + TTS servers shaped exactly like the daemon
// voice caplets (AudioServer / TtsServer). The host (floot-component.js) wires
// them in place of the remote caplets when running locally:
//
//   const local = await makeLocalVoiceServers();
//   const { audioServer, ttsServer } = local ?? (await resolveRemoteCaplets());
//
// When no backend is supported it returns `null`, and the caller falls back to
// the remote daemon caplets.

import harden from '@endo/harden';

import {
  onnxPiperMoonshineBackend,
  transformersWebGpuBackend,
} from './backends/index.js';

/** @import { LocalVoiceServers, VoiceBackend } from './types.js' */

// Default preference order. transformers-webgpu first (simplest WebGPU path);
// onnx-piper-moonshine second (engine parity with the server caplets, and the
// WASM fallback for machines without WebGPU). Reorder via `opts.preferred`.
/** @type {VoiceBackend[]} */
const DEFAULT_BACKENDS = harden([
  transformersWebGpuBackend,
  onnxPiperMoonshineBackend,
]);

/**
 * Order `backends` so any whose id appears in `preferred` come first, in the
 * order given; the rest keep their original relative order. Unknown ids in
 * `preferred` are ignored.
 *
 * @param {VoiceBackend[]} backends
 * @param {string[]} preferred
 * @returns {VoiceBackend[]}
 */
const orderByPreference = (backends, preferred) => {
  const byId = new Map(backends.map(b => [b.id, b]));
  /** @type {VoiceBackend[]} */
  const ordered = [];
  const seen = new Set();
  for (const id of preferred) {
    const backend = byId.get(id);
    if (backend && !seen.has(id)) {
      ordered.push(backend);
      seen.add(id);
    }
  }
  for (const backend of backends) {
    if (!seen.has(backend.id)) {
      ordered.push(backend);
      seen.add(backend.id);
    }
  }
  return ordered;
};

/**
 * Probe the known backends in preference order and stand up the first one whose
 * `isSupported()` resolves true. Returns its `{ audioServer, ttsServer,
 * backendId }`, or `null` if none are supported (caller then falls back to the
 * remote daemon caplets).
 *
 * @param {{ preferred?: string[] }} [opts]
 * @returns {Promise<LocalVoiceServers | null>}
 */
export const makeLocalVoiceServers = async ({ preferred = [] } = {}) => {
  const backends = orderByPreference(DEFAULT_BACKENDS, preferred);
  for (const backend of backends) {
    let supported = false;
    try {
      // Sequential on purpose: probe in preference order and stop at the first
      // hit, so we never pay a later backend's detection cost unnecessarily.
      // eslint-disable-next-line no-await-in-loop
      supported = await backend.isSupported();
    } catch {
      // A misbehaving backend must not abort selection; treat as unsupported.
      supported = false;
    }
    if (!supported) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const [audioServer, ttsServer] = await Promise.all([
      backend.createSTT(),
      backend.createTTS(),
    ]);
    return harden({ audioServer, ttsServer, backendId: backend.id });
  }
  return null;
};
harden(makeLocalVoiceServers);

export {
  onnxPiperMoonshineBackend,
  transformersWebGpuBackend,
} from './backends/index.js';
export {
  makeAudioOutChannel,
  makeBufferedReader,
  makeTranscriptChannel,
} from './wire.js';
export {
  hasWasmSimd,
  hasWebGPU,
  isCrossOriginIsolated,
} from './feature-detect.js';
