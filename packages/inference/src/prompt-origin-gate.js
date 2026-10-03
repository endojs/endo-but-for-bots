// @ts-check

import { makeExo } from '@endo/exo';

import { InferenceBackendInterface } from './guards.js';

/** @import { InferRequest, InferResult, InferenceBackend } from './types.js' */

/**
 * Wraps a backend whose turns run without OS containment so that it serves
 * only root-authored prompts. A request whose `promptOrigin` is
 * `guest-influenced`, missing, or any other value is refused with
 * `needs-containment` before the wrapped backend is called.
 *
 * The gate is a tripwire, not an attenuator: `promptOrigin` is a label the
 * caller writes, so anyone holding the gated backend can claim
 * `root-authored`. Containment rests on who is given the backend; a
 * guest-influenced path must never hold an uncontained backend at all. Under
 * that routing a guest-influenced request never reaches this gate, so its
 * firing reports a routing defect; the caller surfaces it rather than
 * retrying on another backend. `needs-containment` is the only tag this gate
 * writes.
 *
 * @param {InferenceBackend} backend  a local (near) backend: `describe()` is
 *   a synchronous call.
 * @returns {InferenceBackend}
 */
export const makePromptOriginGate = backend =>
  makeExo('PromptOriginGate', InferenceBackendInterface, {
    describe() {
      return backend.describe();
    },
    /**
     * @param {InferRequest} request
     * @returns {Promise<InferResult>}
     */
    async infer(request) {
      if (request.promptOrigin !== 'root-authored') {
        return harden({ type: 'needs-containment' });
      }
      return backend.infer(request);
    },
  });
harden(makePromptOriginGate);
