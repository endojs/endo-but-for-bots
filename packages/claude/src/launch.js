// @ts-check
/* global process, Buffer, setTimeout, clearTimeout */
//
// The concrete `launch` seam: spawn the confined `claude -p` directly (never
// through a shell), deliver the prompt on stdin, enforce the three bounds, and
// turn its `--output-format stream-json --verbose` transcript into a tagged
// InferResult. It never rejects for a per-call outcome.
//
// The transcript parse is `@endo/agent-mcp-stdio`'s `parseClaudeStreamJson`
// (exactly one terminal `result`; a background task's result does not count;
// a malformed or truncated stream is a parse error, never a success), so the
// harness and the stdio server share one reading of the stream.

import { parseClaudeStreamJson } from '@endo/agent-mcp-stdio';

import {
  ok,
  rateLimited,
  nonzeroExit,
  parseError,
  limitExceeded,
  authFailed,
  cancelled as cancelledResult,
} from './results.js';

/** @import { ChildProcess, SpawnOptions } from 'node:child_process' */
/** @import { InferResult, LaunchSpec } from './claude.types.js' */

/**
 * Keep only the number- and string-valued usage fields an `ok` result carries.
 *
 * @param {Record<string, unknown> | undefined} source
 * @returns {Record<string, number | string>}
 */
const usageOf = source => {
  /** @type {Record<string, number | string>} */
  const usage = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    if (typeof value === 'number' || typeof value === 'string') {
      usage[key] = value;
    }
  }
  return usage;
};

/**
 * Map one parsed transcript to an InferResult.
 *
 * @param {ReturnType<typeof parseClaudeStreamJson>} parsed
 * @param {number | null} code
 * @param {() => number} now
 * @returns {InferResult}
 */
export const resultFromStream = (parsed, code, now = Date.now) => {
  const { outcome } = parsed;
  if (outcome.type === 'parse-error') {
    // A stream that never reached a terminal result: a non-zero exit is the
    // better account of what happened.
    return code !== 0 && code !== null
      ? nonzeroExit(code)
      : parseError(outcome.detail ?? 'unparseable stream');
  }
  if (outcome.type === 'ok') {
    return ok(parsed.text ?? '', {
      ...usageOf(parsed.usage),
      ...usageOf({
        num_turns: parsed.fields?.num_turns,
        total_cost_usd: parsed.fields?.total_cost_usd,
        session_id: parsed.fields?.session_id,
      }),
    });
  }
  if (outcome.type === 'rate-limited') {
    const resetsAt = parsed.quota?.resetsAt;
    const retryAfterMs =
      typeof resetsAt === 'number' ? resetsAt * 1000 - now() : undefined;
    return rateLimited(
      retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : undefined,
    );
  }
  if (parsed.fields?.subtype === 'error_max_turns') {
    return limitExceeded('max-turns');
  }
  // api-error / unavailable / policy-refusal / error: an unsuccessful turn.
  // The InferResult union has no finer tag; report the exit status.
  return nonzeroExit(code === null || code === 0 ? 1 : code);
};
harden(resultFromStream);

/** API statuses that mean the credential itself was rejected. */
const AUTH_STATUSES = harden([401, 403]);

/**
 * The status of a stream-json `api_retry` event for a rejected credential, or
 * `undefined` for any other line.
 *
 * @param {string} line
 * @returns {number | undefined}
 */
export const authRetryStatus = line => {
  if (!line.includes('"api_retry"')) return undefined;
  try {
    const event = JSON.parse(line);
    if (
      event?.type === 'system' &&
      event.subtype === 'api_retry' &&
      AUTH_STATUSES.includes(event.error_status)
    ) {
      return event.error_status;
    }
  } catch {
    // Not a whole JSON line; the terminal parse reports malformed streams.
  }
  return undefined;
};
harden(authRetryStatus);

/**
 * @param {object} options
 * @param {(command: string, args: readonly string[], options: SpawnOptions) => ChildProcess} options.spawn
 * @param {string} options.claudePath - absolute path of the pinned `claude`.
 * @param {string} options.cwd - the confined process's working directory
 *   (a private per-turn directory, never the harness's own).
 * @param {() => number} [options.now]
 * @param {(child: ChildProcess) => void} [options.kill] - kill the child and
 *   its process group.
 * @param {(chunk: Buffer) => void} [options.onStderr] - the child's stderr,
 *   for harness diagnostics; never part of the result.
 * @param {number} [options.authRetryLimit] - stop the child with
 *   `auth-failed` after this many `401`/`403` API retries. A rejected
 *   credential otherwise makes `claude` retry for minutes and the turn ends
 *   as `limit-exceeded: wall-clock` (endo-but-for-bots#1369 gap 11).
 */
export const makeLaunch = ({
  spawn,
  claudePath,
  cwd,
  now = Date.now,
  onStderr,
  authRetryLimit = 2,
  kill = child => {
    try {
      // `detached` puts the child in its own group: take the MCP relay with it.
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  },
}) => {
  /**
   * @param {LaunchSpec} spec
   * @returns {Promise<InferResult>}
   */
  const launch = spec =>
    new Promise(resolve => {
      const { argv, env, prompt, limits, cancelled } = spec;
      const child = spawn(claudePath, [...argv], {
        env: { ...env },
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        shell: false,
      });

      /** @type {InferResult | undefined} */
      let early;
      let settled = false;
      /** @param {InferResult} result */
      const stop = result => {
        if (early === undefined) {
          early = result;
          kill(child);
        }
      };

      /** @type {Buffer[]} */
      const chunks = [];
      let bytes = 0;
      let pending = '';
      let authRetries = 0;
      child.stdout?.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > limits.outputByteCap) {
          stop(limitExceeded('output-bytes'));
          return;
        }
        chunks.push(chunk);
        const lines = `${pending}${chunk.toString('utf-8')}`.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const status = authRetryStatus(line);
          if (status !== undefined) {
            authRetries += 1;
            if (authRetries >= authRetryLimit) stop(authFailed(status));
          }
        }
      });
      // stderr is always drained, so a chatty child cannot block on a full
      // pipe; its content is not part of the result.
      if (onStderr) child.stderr?.on('data', onStderr);
      else child.stderr?.resume();

      const timer = setTimeout(
        () => stop(limitExceeded('wall-clock')),
        limits.wallClockMs,
      );

      if (
        cancelled &&
        typeof (/** @type {any} */ (cancelled).then) === 'function'
      ) {
        const onCancel = () => {
          if (settled) return;
          stop(cancelledResult('mid-stream'));
        };
        Promise.resolve(cancelled).then(onCancel, onCancel);
      }

      child.on('error', error => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve(parseError(`cannot spawn claude: ${error.message}`));
      });
      child.on('close', code => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (early !== undefined) {
          resolve(early);
          return;
        }
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve(resultFromStream(parseClaudeStreamJson(text), code, now));
      });

      child.stdin?.on('error', () => {
        // The child exited before reading the prompt; `close` reports it.
      });
      child.stdin?.end(prompt);
    });
  return launch;
};
harden(makeLaunch);
