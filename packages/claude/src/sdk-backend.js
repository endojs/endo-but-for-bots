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
import { M, matches } from '@endo/patterns';
import { makeExo } from '@endo/exo';
import {
  CredentialGrantShape,
  CredentialRefusalShape,
  InferenceBackendInterface,
} from '@endo/inference/guards.js';
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

const AdmissionShape = M.or(CredentialGrantShape, CredentialRefusalShape);

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

    const versionFailure = await checkPinnedVersion(getVersion, version);
    if (versionFailure !== undefined) {
      return unavailable(`version check failed: ${versionFailure}`);
    }

    const admission = await E(credentialSource)
      .acquire()
      .then(
        grant =>
          // Checked with `matches`, not `mustMatch`, so that a malformed
          // grant's values (a credential among them) never reach the detail.
          matches(grant, AdmissionShape)
            ? grant
            : harden({
                type: /** @type {const} */ ('failed'),
                detail: 'malformed admission',
              }),
        // The rejection's message is not forwarded: a source's error may
        // carry the very credential it failed to deliver, and the detail
        // reaches the usage record.
        () =>
          harden({
            type: /** @type {const} */ ('failed'),
            detail: 'acquire rejected',
          }),
      );
    if (admission.type === 'failed') {
      return unavailable(`credential source failed: ${admission.detail}`);
    }
    if (admission.type === 'refused') {
      return admissionRefusalResult(admission.admission);
    }
    const { environment: credentialEnvironment, release } = admission;

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
