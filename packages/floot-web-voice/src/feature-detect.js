// @ts-check
// Browser feature-detection helpers used by the backends' `isSupported` checks
// and by the README's deployment guidance. All checks are best-effort, never
// throw, and run host-side in the browser (no SES globals assumed).

import harden from '@endo/harden';

/**
 * True when WebGPU is usable: `navigator.gpu` exists AND an adapter can be
 * acquired. `requestAdapter()` can resolve to `null` on machines where the API
 * is exposed but no GPU adapter is available (or it is blocklisted), so we must
 * actually await it rather than just sniff for `navigator.gpu`.
 *
 * @returns {Promise<boolean>}
 */
export const hasWebGPU = async () => {
  try {
    const gpu = /** @type {any} */ (globalThis.navigator)?.gpu;
    if (!gpu || typeof gpu.requestAdapter !== 'function') return false;
    const adapter = await gpu.requestAdapter();
    return adapter !== null && adapter !== undefined;
  } catch {
    return false;
  }
};
harden(hasWebGPU);

// A minimal WASM module that uses the SIMD `v128` value type. If
// WebAssembly.validate accepts it, the engine supports the SIMD proposal. This
// is the standard feature-probe used by ORT/transformers loaders.
const WASM_SIMD_PROBE = harden(
  new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60,
    0x00, 0x01, 0x7b, 0x03, 0x02, 0x01, 0x00, 0x0a, 0x0a, 0x01, 0x08, 0x00,
    0x41, 0x00, 0xfd, 0x0f, 0xfd, 0x62, 0x0b,
  ]),
);

/**
 * Best-effort check that the WebAssembly SIMD proposal is supported, by
 * validating a tiny module that returns a `v128`. The fastest ORT / transformers
 * WASM backends require SIMD.
 *
 * @returns {boolean}
 */
export const hasWasmSimd = () => {
  try {
    const wasm = /** @type {any} */ (globalThis).WebAssembly;
    return Boolean(wasm) && wasm.validate(WASM_SIMD_PROBE);
  } catch {
    return false;
  }
};
harden(hasWasmSimd);

/**
 * True when the page is cross-origin isolated (`globalThis.crossOriginIsolated`).
 * This requires serving `COOP: same-origin` + `COEP: require-corp`, and is a
 * precondition for `SharedArrayBuffer` and WASM threads — without it the
 * multi-threaded ORT / transformers backends silently fall back to slow
 * single-threaded execution (or fail to instantiate threaded WASM at all).
 *
 * @returns {boolean}
 */
export const isCrossOriginIsolated = () => {
  return globalThis.crossOriginIsolated === true;
};
harden(isCrossOriginIsolated);
