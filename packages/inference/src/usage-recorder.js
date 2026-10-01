// @ts-check

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';

import { InferenceBackendInterface } from './guards.js';

/** @import { InferRequest, InferResult, InferenceBackend, UsageRecord, UsageSink } from './types.js' */

/**
 * The UTF-8 encoded length of `text`. A lone surrogate counts as the three
 * bytes of the replacement character an encoder would write for it.
 *
 * @param {string} text
 */
const utf8ByteLength = text => {
  let length = 0;
  for (const character of text) {
    const codePoint = /** @type {number} */ (character.codePointAt(0));
    if (codePoint < 0x80) length += 1;
    else if (codePoint < 0x800) length += 2;
    else if (codePoint < 0x1_0000) length += 3;
    else length += 4;
  }
  return length;
};

/**
 * Wraps a backend so that each classified result becomes one usage record
 * handed to the deployment's usage sink. The result passes through
 * unchanged.
 *
 * The recorder fills only what it observes: provider, backend kind, and
 * version from the wrapped backend's `describe()`; prompt origin and formula
 * identifier from the request; latency around `infer`; and the tag, turns,
 * bytes, and token usage from the result. It cannot see inside the
 * credential source, so the deployment, which makes one backend per
 * credential, passes that credential's `secretId` at construction. The sink
 * adds the run id and cost estimate when it writes.
 *
 * A wrapped backend that rejects breaks the `infer` contract; the rejection
 * propagates and no record is written, because there is no classified result
 * to record.
 *
 * @param {InferenceBackend} backend
 * @param {object} options
 * @param {string} options.secretId  the secret manager's identifier for the
 *   backend's credential, never its bytes.
 * @param {UsageSink} options.sink
 * @param {() => number} options.now  milliseconds, such as `Date.now`.
 * @param {(error: unknown) => void} [options.reportSinkError]  the sink owns
 *   durability; a failed write is reported here and does not affect the
 *   turn's result.
 * @returns {InferenceBackend}
 */
export const makeUsageRecorder = (
  backend,
  { secretId, sink, now, reportSinkError = () => {} },
) =>
  makeExo('UsageRecorder', InferenceBackendInterface, {
    describe() {
      return backend.describe();
    },
    /**
     * @param {InferRequest} request
     * @returns {Promise<InferResult>}
     */
    async infer(request) {
      const startedAt = now();
      const result = await backend.infer(request);
      const latencyMs = Math.max(0, now() - startedAt);
      const { provider, kind, version } = backend.describe();

      /** @type {UsageRecord} */
      const record = {
        provider,
        backendKind: kind,
        secretId,
        formulaIdentifier: request.guest.formulaIdentifier,
        latencyMs,
        resultType: result.type,
      };
      if (version !== undefined) record.backendVersion = version;
      if (request.promptOrigin !== undefined) {
        record.promptOrigin = request.promptOrigin;
      }
      if (result.type === 'unavailable') record.detail = result.detail;
      if (result.type === 'limit-exceeded') record.detail = result.which;
      if (result.type === 'ok') {
        record.outputBytes = utf8ByteLength(result.text);
        if (result.usage !== undefined) {
          record.usage = result.usage;
          if (result.usage.turns !== undefined) {
            record.turns = result.usage.turns;
          }
        }
      }

      E(sink).write(harden(record)).catch(reportSinkError);
      return result;
    },
  });
harden(makeUsageRecorder);
