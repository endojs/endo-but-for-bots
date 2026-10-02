// @ts-check
//
// `makeClaudeSdkBackend`: an `InferenceBackend` that runs each turn through
// the Claude Agent SDK's `query` (designs/endo-claude-inference-backends.md
// § Phased Implementation, phase 2). The SDK still drives the pinned Claude
// Code binary; the difference from the CLI backend is that the guest's MCP
// server is handed to the SDK in process, so no stdio server, socket, or
// nonce exists. The SDK's `query` is injected: this package does not depend
// on the SDK, and tests run with no binary and no credential.

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { InferenceBackendInterface } from '@endo/inference/guards.js';
import { makeLimitEnforcer } from '@endo/inference/limits.js';
import { admissionRefusalResult } from '@endo/inference/classify.js';
import { encodeUtf8 } from '@endo/utf8/encode.js';

import { buildSdkOptions } from './confinement-options.js';
import { buildConstructedEnvironment } from './constructed-environment.js';
import {
  CLAUDE_CODE_RESPONSE_SHAPES,
  makeClaudeCodeClassifier,
  turnOutcome,
  unavailable,
} from './response-shapes.js';
import { makeClaudeStreamReducer } from './stream-reducer.js';

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
 * bigint counts as its decimal digits and a repeated object as a short
 * marker.
 *
 * @param {unknown} message
 * @returns {number}
 */
const serializedByteCount = message => {
  const seen = new WeakSet();
  const text =
    JSON.stringify(message, (_key, value) => {
      if (typeof value === 'bigint') return `${value}`;
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Repeated]';
        seen.add(value);
      }
      return value;
    }) ?? '';
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

    const admission = await E(credentialSource)
      .acquire()
      .catch(error =>
        harden({
          type: /** @type {const} */ ('failed'),
          detail: messageOf(error),
        }),
      );
    if (admission.type === 'failed') {
      return unavailable(`credential source failed: ${admission.detail}`);
    }
    if (admission.type === 'refused') {
      return admissionRefusalResult(admission.admission);
    }
    const { env: credentialEnvironment, release } = admission;

    const abortController = new AbortController();
    const enforcer = makeLimitEnforcer({
      limits,
      timers,
      cancelled,
      terminate: () => abortController.abort(),
    });
    const reducer = makeClaudeStreamReducer();
    /** @type {ScratchDirectory | undefined} */
    let scratch;
    try {
      scratch = await makeScratchDirectory();
      const mcpServer = await guest.buildMcpServer();
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

      /** @type {ClaudeCodeResponse | undefined} */
      let thrown;
      try {
        for await (const message of query({ prompt, options })) {
          if (!enforcer.countOutputBytes(serializedByteCount(message))) break;
          if (reducer.pushEvent(message) && !enforcer.countTurn()) break;
        }
      } catch (error) {
        thrown = harden({ source: 'thrown', message: messageOf(error) });
      }
      return turnOutcome({
        limitOutcome: enforcer.outcome(),
        reduction: reducer.finish(),
        classify,
        fallbackResponse: thrown,
      });
    } catch (error) {
      return (
        enforcer.outcome() ??
        unavailable(`turn setup failed: ${messageOf(error)}`)
      );
    } finally {
      enforcer.stop();
      const cleanups = [() => E(release)(), () => scratch?.remove()];
      for (const cleanup of cleanups) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await cleanup();
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
