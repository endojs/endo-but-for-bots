// @ts-check
// spell-out-exempt: `args` is the MCP config's stdio-server field name.
//
// `makeClaudeCliBackend`: an `InferenceBackend` that runs each turn as one
// confined `claude -p` process (designs/endo-claude-inference-backends.md
// § Phased Implementation, phase 2). The guest's tools reach the process
// through one stdio MCP server, named in a per-turn `--mcp-config`
// (designs/endo-guest-stdio-mcp.md). Every effect (spawning, files, timers,
// signals) is an injected power, so the turn logic runs in tests with no
// binary and no credential.

import { concatBytes } from '@endo/bytes/concat.js';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { InferenceBackendInterface } from '@endo/inference/guards.js';
import {
  makeLimitEnforcer,
  makeProcessGroupKiller,
} from '@endo/inference/limits.js';
import { admissionRefusalResult } from '@endo/inference/classify.js';
import { decodeUtf8 } from '@endo/utf8/decode.js';
import { encodeUtf8 } from '@endo/utf8/encode.js';

import { buildCliArguments } from './confinement-options.js';
import { buildConstructedEnvironment } from './constructed-environment.js';
import { renderMcpConfig, serializeMcpConfig } from './mcp-config.js';
import {
  CLAUDE_CODE_RESPONSE_SHAPES,
  exitResponse,
  makeClaudeCodeClassifier,
  turnOutcome,
  unavailable,
} from './response-shapes.js';
import { makeClaudeStreamReducer } from './stream-reducer.js';

/** @import { InferRequest, InferResult, InferenceBackend } from '@endo/inference/types.js' */
/** @import { ChildProcessLike, ClaudeCliBackendOptions, ScratchDirectory, StdioProjection } from './backends.types.js' */

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = error =>
  error instanceof Error ? error.message : String(error);

/**
 * @param {Uint8Array | string} chunk
 * @returns {Uint8Array}
 */
const toBytes = chunk =>
  typeof chunk === 'string' ? encodeUtf8(chunk) : chunk;

const NEWLINE = 0x0a;

/**
 * Decodes a byte stream one complete line at a time, so a multibyte character
 * split across two chunks decodes intact.
 */
const makeLineDecoder = () => {
  let pending = new Uint8Array(0);
  return harden({
    /**
     * @param {Uint8Array} bytes
     * @returns {string} the complete lines `bytes` finished
     */
    push: bytes => {
      const buffered = concatBytes([pending, bytes]);
      let end = buffered.length;
      while (end > 0 && buffered[end - 1] !== NEWLINE) end -= 1;
      pending = buffered.slice(end);
      return decodeUtf8(buffered.subarray(0, end));
    },
    /** @returns {string} whatever followed the last newline */
    flush: () => {
      const rest = decodeUtf8(pending);
      pending = new Uint8Array(0);
      return rest;
    },
  });
};

/**
 * @param {ClaudeCliBackendOptions} options
 * @returns {InferenceBackend}
 */
export const makeClaudeCliBackend = ({
  credentialSource,
  executablePath,
  version,
  stdioProjection,
  spawn,
  makeScratchDirectory,
  kill,
  timers,
  pathValue,
  serverName = 'endo',
  responseShapes = CLAUDE_CODE_RESPONSE_SHAPES,
  permissionPromptsNone = false,
}) => {
  const classify = makeClaudeCodeClassifier(responseShapes, version);
  const killProcessGroup = makeProcessGroupKiller({ kill });

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

    /** @type {ChildProcessLike | undefined} */
    let child;
    /** @type {() => void} */
    let onTerminate = () => {};
    const enforcer = makeLimitEnforcer({
      limits,
      timers,
      cancelled,
      terminate: () => {
        try {
          if (child !== undefined) killProcessGroup(child.pid);
        } finally {
          onTerminate();
        }
      },
    });
    /** @type {ScratchDirectory | undefined} */
    let scratch;
    /** @type {StdioProjection | undefined} */
    let projection;
    try {
      scratch = await makeScratchDirectory();
      projection = await stdioProjection(guest);
      const mcpConfigPath = await scratch.writeFile(
        'mcp-config.json',
        serializeMcpConfig(
          renderMcpConfig({
            serverName,
            transport: {
              kind: 'stdio',
              command: projection.command,
              args: [...(projection.commandArguments ?? [])],
            },
          }),
        ),
      );
      const settingsPath = await scratch.writeFile('settings.json', '{}');
      const argv = buildCliArguments({
        mcpConfigPath,
        settingsPath,
        serverName,
        toolNames: guest.toolNames,
        maxTurns: limits.maxTurns,
        model,
        permissionPromptsNone,
      });
      const env = buildConstructedEnvironment({
        configDirectory: scratch.configDirectory,
        pathValue,
        credentialEnvironment,
      });

      const limitOutcome = enforcer.outcome();
      if (limitOutcome !== undefined) return limitOutcome;

      const reducer = makeClaudeStreamReducer();
      const stdoutLines = makeLineDecoder();
      /** @type {Uint8Array[]} */
      const stderrChunks = [];
      let stderrByteCount = 0;
      const spawned = spawn(executablePath, argv, {
        cwd: scratch.path,
        // A fresh copy: Node's spawn writes into `options.env` (it adds
        // NODE_V8_COVERAGE when the parent has it), which throws on a frozen
        // record.
        env: { ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      child = spawned;

      /** @type {Promise<{ exitCode: number | null, signal: string | null } | { spawnError: string } | undefined>} */
      const ended = new Promise(resolve => {
        // A killed group can leave a grandchild holding stdout open, so a
        // limit or cancellation settles without waiting for `close`.
        onTerminate = () => resolve(undefined);
        spawned.on('error', error => resolve({ spawnError: error.message }));
        spawned.on('close', (exitCode, signal) =>
          resolve({ exitCode, signal }),
        );
      });

      /** @param {string} text */
      const pushStdout = text => {
        const began = reducer.pushText(text);
        for (let turn = 0; turn < began; turn += 1) {
          if (!enforcer.countTurn()) return;
        }
      };
      spawned.stdout?.on('data', chunk => {
        const bytes = toBytes(chunk);
        if (!enforcer.countOutputBytes(bytes.length)) return;
        pushStdout(stdoutLines.push(bytes));
      });
      spawned.stderr?.on('data', chunk => {
        // Only the tail is classified; keep a bounded window of it.
        const bytes = toBytes(chunk);
        stderrChunks.push(bytes);
        stderrByteCount += bytes.length;
        while (stderrByteCount > 65_536 && stderrChunks.length > 1) {
          stderrByteCount -= stderrChunks[0].length;
          stderrChunks.shift();
        }
      });
      // A process that exits before reading stdin must not raise EPIPE here;
      // its exit is classified from `close`.
      spawned.stdin?.on('error', () => {});
      spawned.stdin?.write(prompt);
      spawned.stdin?.end();

      const exit = await ended;
      if (exit === undefined) {
        return enforcer.outcome() ?? unavailable('turn terminated');
      }
      if ('spawnError' in exit) {
        return (
          enforcer.outcome() ?? unavailable(`spawn failed: ${exit.spawnError}`)
        );
      }
      pushStdout(stdoutLines.flush());
      const stderr = decodeUtf8(concatBytes(stderrChunks));
      return turnOutcome({
        limitOutcome: enforcer.outcome(),
        reduction: reducer.finish(),
        classify,
        fallbackResponse: exitResponse({ ...exit, stderr }),
        exitCode: exit.exitCode,
      });
    } catch (error) {
      return (
        enforcer.outcome() ??
        unavailable(`turn setup failed: ${messageOf(error)}`)
      );
    } finally {
      enforcer.stop();
      const cleanups = [
        () => E(release)(),
        () => projection?.close?.(),
        () => scratch?.remove(),
      ];
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

  return makeExo('ClaudeCliBackend', InferenceBackendInterface, {
    describe() {
      return harden({ provider: 'anthropic', kind: 'claude-cli', version });
    },
    infer,
  });
};
harden(makeClaudeCliBackend);
