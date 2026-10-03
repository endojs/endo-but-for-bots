// @ts-check

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { mustMatch } from '@endo/patterns';

import {
  BackendDescriptionShape,
  InferResultShape,
  InferenceBackendInterface,
} from './guards.js';

/** @import { InferRequest, InferResult, InferenceBackend, UsageRecord, UsageSink } from './types.js' */

const textEncoder = new TextEncoder();

/**
 * The UTF-8 encoded length of `text`. A lone surrogate counts as the three
 * bytes of the U+FFFD replacement character the encoder writes for it.
 *
 * @param {string} text
 */
const utf8ByteLength = text => textEncoder.encode(text).length;

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
 * credential, passes that credential's `secretIdentifier` at construction. The sink
 * adds the run id and cost estimate when it writes.
 *
 * The wrapped backend's `describe()` is read before the turn starts, so a
 * throwing `describe()` rejects `infer` without starting a turn rather than
 * discarding the result of one that ran. A wrapped backend that rejects
 * breaks the `infer` contract; the rejection propagates and no record is
 * written, because there is no classified result to record. So does a
 * description or result outside its shape, since the wrapped backend need
 * not be guarded itself.
 *
 * @param {InferenceBackend} backend  a local (near) backend: `describe()` is
 *   a synchronous call.
 * @param {object} options
 * @param {string} options.secretIdentifier  the secret manager's identifier for the
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
  { secretIdentifier, sink, now, reportSinkError = () => {} },
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
      const description = backend.describe();
      mustMatch(harden(description), BackendDescriptionShape, 'description');
      const { provider, kind, version } = description;
      const startedAt = now();
      const result = await backend.infer(request);
      mustMatch(harden(result), InferResultShape, 'backend result');
      const latencyMs = Math.max(0, now() - startedAt);

      /** @type {UsageRecord} */
      const record = {
        provider,
        backendKind: kind,
        secretIdentifier,
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
