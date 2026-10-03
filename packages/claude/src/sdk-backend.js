// @ts-check
//
// `makeClaudeSdkBackend`: an `InferenceBackend` that runs each turn through
// the Claude Agent SDK's `query` (designs/endo-claude-inference-backends.md
// § Phased Implementation, phase 2). The SDK still drives the pinned Claude
// Code binary; the difference from the CLI backend is that the guest's MCP
// server is handed to the SDK in process, so no stdio server, socket, or
// nonce exists. The SDK's `query` is injected: this package does not depend
// on the SDK, and tests run with no binary and no credential.
//
// Confinement parity with the CLI's `--bare` is not established: no live
// probe has measured whether the SDK options exclude project and user
// memory, hooks, skills, and ambient MCP servers (the design's § Observed
// versus documented).

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { InferenceBackendInterface } from '@endo/inference/guards.js';
import { makeLimitEnforcer } from '@endo/inference/limits.js';
import { admissionRefusalResult } from '@endo/inference/classify.js';
import { encodeUtf8 } from '@endo/utf8/encode.js';

import { buildSdkOptions, checkPinnedVersion } from './confinement-options.js';
import { buildConstructedEnvironment } from './constructed-environment.js';
import {
  CLAUDE_CODE_RESPONSE_SHAPES,
  makeClaudeCodeClassifier,
  turnOutcome,
  unavailable,
} from './response-shapes.js';
import { makeClaudeStreamReducer } from './stream-reducer.js';
import {
  acquireAdmission,
  errorCategory,
  makeTerminationRace,
} from './turn-guard.js';

/** @import { InferRequest, InferResult, InferenceBackend } from '@endo/inference/types.js' */
/** @import { ClaudeCodeResponse, ClaudeSdkBackendOptions, ScratchDirectory } from './backends.types.js' */

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = error =>
  error instanceof Error ? error.message : String(error);

/**
 * The UTF-8 length of `message` as JSON. Values `JSON.stringify` refuses
 * still count, so that no message slips past the output-bytes ceiling: a
 * bigint counts as its decimal digits and a cycle as a short marker. As in
 * `JSON.stringify`, only an object that is its own ancestor is a cycle; an
 * object shared by siblings counts in full each time.
 *
 * @param {unknown} message
 * @returns {number}
 */
const serializedByteCount = message => {
  /** @type {object[]} */
  const ancestors = [];
  const text =
    JSON.stringify(
      message,
      /**
       * @this {unknown}
       * @param {string} _key
       * @param {unknown} value
       */
      function replacer(_key, value) {
        // `this` is the object holding `value`; whatever the stack holds
        // above it belongs to a finished branch.
        while (
          ancestors.length > 0 &&
          ancestors[ancestors.length - 1] !== this
        ) {
          ancestors.pop();
        }
        if (typeof value === 'bigint') return `${value}`;
        if (typeof value === 'object' && value !== null) {
          if (ancestors.includes(value)) return '[Circular]';
          ancestors.push(value);
        }
        return value;
      },
    ) ?? '';
  return encodeUtf8(text).length;
};

/**
 * @param {ClaudeSdkBackendOptions} options
 * @returns {InferenceBackend}
 */
export const makeClaudeSdkBackend = ({
  credentialSource,
  query,
  executablePath,
  version,
  getVersion,
  makeScratchDirectory,
  timers,
  pathValue,
  serverName = 'endo',
  responseShapes = CLAUDE_CODE_RESPONSE_SHAPES,
  maxBudgetUsd,
}) => {
  const classify = makeClaudeCodeClassifier(responseShapes, version);

  /**
   * @param {InferRequest} request
   * @returns {Promise<InferResult>}
   */
  const infer = async request => {
    const { prompt, guest, limits, model, cancelled } = request;

    const { signalTerminated, untilTerminated } = makeTerminationRace();
    const abortController = new AbortController();
    // Built before anything is awaited, so the wall clock and cancellation
    // also bound the version check and the wait for a credential.
    const enforcer = makeLimitEnforcer({
      limits,
      timers,
      cancelled,
      terminate: () => {
        try {
          abortController.abort();
        } finally {
          signalTerminated();
        }
      },
    });
    /** @type {(() => unknown) | undefined} */
    let release;
    /** @type {ScratchDirectory | undefined} */
    let scratch;
    try {
      const versionFailure = await untilTerminated(
        checkPinnedVersion(getVersion, version),
      );
      if (versionFailure !== undefined) {
        return unavailable(`version check failed: ${versionFailure}`);
      }

      const admission = await untilTerminated(
        acquireAdmission(credentialSource),
        late => late.type === 'granted' && E(late.release)(),
      );
      if (admission.type === 'failed') {
        return unavailable(`credential source failed: ${admission.detail}`);
      }
      if (admission.type === 'refused') {
        return admissionRefusalResult(admission.admission);
      }
      const { environment: credentialEnvironment } = admission;
      release = () => E(admission.release)();

      scratch = await untilTerminated(makeScratchDirectory(), late =>
        late.remove(),
      );
      const mcpServer = await untilTerminated(guest.buildMcpServer());
      const options = buildSdkOptions({
        serverName,
        toolNames: guest.toolNames,
        mcpServer,
        maxTurns: limits.maxTurns,
        model,
        workingDirectory: scratch.path,
        environment: buildConstructedEnvironment({
          configDirectory: scratch.configDirectory,
          pathValue,
          credentialEnvironment,
        }),
        executablePath,
        abortController,
        maxBudgetUsd,
      });

      const limitOutcome = enforcer.outcome();
      if (limitOutcome !== undefined) return limitOutcome;

      const reducer = makeClaudeStreamReducer();
      /** @type {ClaudeCodeResponse | undefined} */
      let thrown;
      /** @type {string | undefined} */
      let thrownCategory;
      /** @type {AsyncIterator<unknown> | undefined} */
      let messages;
      try {
        messages = query({ prompt, options })[Symbol.asyncIterator]();
        for (;;) {
          // Raced, not awaited alone: an SDK that ignores the abort signal
          // must not hold the turn open past its limits.
          // eslint-disable-next-line no-await-in-loop
          const step = await untilTerminated(messages.next());
          if (step.done) break;
          if (!enforcer.countOutputBytes(serializedByteCount(step.value))) {
            break;
          }
          if (reducer.pushEvent(step.value) && !enforcer.countTurn()) break;
        }
      } catch (error) {
        // The message is kept only for the response-shape table; the detail
        // names the error by category.
        thrown = harden({ source: 'thrown', message: messageOf(error) });
        thrownCategory = errorCategory(error);
      } finally {
        // Not awaited, for the same reason the loop is raced.
        const finished = messages;
        Promise.resolve()
          .then(() => finished?.return?.())
          .catch(() => {});
      }
      return turnOutcome({
        limitOutcome: enforcer.outcome(),
        reduction: reducer.finish(),
        classify,
        fallbackResponse: thrown,
        thrownCategory,
      });
    } catch (error) {
      return (
        enforcer.outcome() ??
        unavailable(`turn setup failed: ${errorCategory(error)}`)
      );
    } finally {
      enforcer.stop();
      const cleanups = [release, () => scratch?.remove()];
      for (const cleanup of cleanups) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await cleanup?.();
        } catch {
          // A cleanup failure must not replace the turn's result.
        }
      }
    }
  };

  return makeExo('ClaudeSdkBackend', InferenceBackendInterface, {
    describe() {
      return harden({ provider: 'anthropic', kind: 'claude-sdk', version });
    },
    infer,
  });
};
harden(makeClaudeSdkBackend);
