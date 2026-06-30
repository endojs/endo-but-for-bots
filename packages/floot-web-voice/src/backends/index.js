// @ts-check
// Barrel of the known in-browser voice backends. Each is a `VoiceBackend` (see
// ../types.js): `{ id, isSupported, createSTT, createTTS }`. The two concrete
// implementations are filled in by their respective backend agents; this module
// only re-exports them so index.js (and the selector) has a single import site.

export { onnxPiperMoonshineBackend } from './onnx-piper-moonshine.js';
export { transformersWebGpuBackend } from './transformers-webgpu.js';
