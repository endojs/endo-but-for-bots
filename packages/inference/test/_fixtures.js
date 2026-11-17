// @ts-check
// prefer-endo-primitives-exempt: the projection carries a remotable function
// (`buildMcpServer`), which only `Far` can make.

import { Far } from '@endo/far';
import { makeExo } from '@endo/exo';

import { InferenceBackendInterface } from '../src/guards.js';

/** @import { BackendDescription, InferRequest, InferResult } from '../src/types.js' */

export const makeProjection = (formulaIdentifier = 'formula:guest-1') =>
  harden({
    buildMcpServer: Far('buildMcpServer', () => harden({})),
    toolNames: harden(['readText', 'writeText']),
    formulaIdentifier,
  });
harden(makeProjection);

/** @param {Partial<InferRequest>} [overrides] */
export const makeRequest = (overrides = {}) =>
  harden({
    prompt: 'write then read',
    guest: makeProjection(),
    limits: harden({ maxWallClockMs: 1000, maxOutputBytes: 4096, maxTurns: 3 }),
    cancelled: new Promise(() => {}),
    ...overrides,
  });
harden(makeRequest);

/**
 * A backend that answers every request with `result` and remembers the
 * requests it saw.
 *
 * @param {InferResult} result
 * @param {BackendDescription} [description]
 */
export const makeRecordingBackend = (
  result,
  description = {
    provider: 'test-vendor',
    kind: 'test-harness',
    version: '1.0.0',
  },
) => {
  /** @type {InferRequest[]} */
  const requests = [];
  const backend = makeExo('RecordingBackend', InferenceBackendInterface, {
    describe() {
      return harden(description);
    },
    /**
     * @param {InferRequest} request
     * @returns {Promise<InferResult>}
     */
    async infer(request) {
      requests.push(request);
      return result;
    },
  });
  return { backend, requests };
};
harden(makeRecordingBackend);
