// @ts-check

import { buildClaudeArgv } from './argv.js';
import { buildClaudeEnv } from './env.js';
import { makeStreamReducer } from './stream.js';

/** @import { InferenceBackend, InferRequest, InferResult } from '@endo/inference/src/types.js' */

/**
 * What the CLI backend needs from a guest projection. The CLI cannot consume
 * an in-process `McpServer`, so the projection must name a stdio command the
 * binary spawns (endo-guest-stdio-mcp).
 *
 * gap: see PR body, Gap 1.
 *
 * @typedef {object} StdioGuestProjection
 * @property {readonly string[]} toolNames
 * @property {string} formulaIdentifier  audit label only
 * @property {{ command: string, args: string[], env?: Record<string, string> }} stdio
 */

/**
 * @param {object} powers
 * @param {typeof import('node:child_process').spawn} powers.spawn
 * @param {typeof import('node:fs/promises')} powers.fs
 * @param {(...parts: string[]) => string} powers.join
 * @param {string} powers.scratchRoot  where per-turn HOME/config dirs go
 * @param {string} powers.executable  the pinned `claude` binary
 * @param {string} powers.version  the pinned binary's version, for the shape
 *   table; a mismatch with the binary's own `init` report ends the turn
 * @param {{ credentialId: string, read: () => Promise<string> }} powers.credential
 * @param {string} [powers.baseUrl]  loopback broker listener (target delivery)
 * @param {boolean} [powers.permissionPromptsNone]
 * @param {(child: { pid: number | undefined, turnDir: string }) => void} [powers.onSpawn]
 *   observation hook for the probe harness (gate 4's environ check)
 * @param {(snapshot: any) => void} [powers.onFinish]  observation hook that
 *   receives the reducer snapshot (init event, result event) after each turn
 * @param {(turnDir: string) => Promise<void>} [powers.prepareTurnDir]
 *   probe-only hook that plants hostile files before spawn (gate 2)
 * @returns {InferenceBackend<StdioGuestProjection>}
 */
export const makeClaudeCliBackend = ({
  spawn,
  fs,
  join,
  scratchRoot,
  executable,
  version,
  credential,
  baseUrl,
  permissionPromptsNone = false,
  onSpawn,
  onFinish,
  prepareTurnDir,
}) => {
  const describe = () =>
    harden({ kind: 'claude-cli', provider: 'anthropic', version });

  /**
   * @param {InferRequest<StdioGuestProjection>} request
   * @returns {Promise<InferResult>}
   */
  const infer = async request => {
    const { prompt, guest, limits, model, cancelled } = request;
    const turnDir = await fs.mkdtemp(join(scratchRoot, 'turn-'));
    const home = join(turnDir, 'home');
    const configDir = join(turnDir, 'config');
    const cwd = join(turnDir, 'cwd');
    try {
      await fs.mkdir(home, { mode: 0o700 });
      await fs.mkdir(configDir, { mode: 0o700 });
      await fs.mkdir(cwd, { mode: 0o700 });
      const mcpConfigPath = join(turnDir, 'mcp.json');
      await fs.writeFile(
        mcpConfigPath,
        JSON.stringify({ mcpServers: { guest: guest.stdio } }),
        { mode: 0o600 },
      );
      if (prepareTurnDir) await prepareTurnDir(turnDir);

      let bearer;
      try {
        bearer = await credential.read();
      } catch {
        return harden({ type: 'unavailable', reason: 'credential read failed' });
      }
      const argv = buildClaudeArgv({
        mcpConfigPath,
        toolNames: guest.toolNames,
        maxTurns: limits.maxTurns,
        model,
        permissionPromptsNone,
      });
      const env = buildClaudeEnv({ home, configDir, bearer, baseUrl });
      bearer = undefined;

      const reducer = makeStreamReducer({ version });
      const child = spawn(executable, argv, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      onSpawn?.({ pid: child.pid, turnDir });

      /** @type {InferResult | undefined} */
      let early;
      const kill = (/** @type {InferResult} */ why) => {
        if (early === undefined) early = why;
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      };
      const timer = setTimeout(
        () => kill(harden({ type: 'limit-exceeded', which: 'wall-clock' })),
        limits.wallClockMs,
      );
      cancelled?.catch(() => kill(harden({ type: 'cancelled' })));

      let outputBytes = 0;
      let stderrTail = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > limits.outputBytes) {
          kill(harden({ type: 'limit-exceeded', which: 'output-bytes' }));
          return;
        }
        reducer.push(chunk);
        const { classified, init } = reducer.snapshot();
        if (init && init.claude_code_version !== version) {
          kill(
            harden({
              type: 'unavailable',
              reason: `binary reports ${init.claude_code_version}, pinned ${version}`,
            }),
          );
        } else if (classified !== undefined) {
          kill(classified);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        stderrTail = (stderrTail + chunk).slice(-400);
      });
      child.stdin.end(prompt);

      const exit = await new Promise(resolve => {
        child.on('error', error => resolve({ error }));
        child.on('close', (code, signal) => resolve({ code, signal }));
      });
      clearTimeout(timer);
      reducer.end();
      onFinish?.(reducer.snapshot());
      if (early !== undefined) return early;

      const { result } = reducer.snapshot();
      if (result === undefined) {
        return harden({
          type: 'unavailable',
          reason: `no result event (exit ${JSON.stringify(exit)}; ${stderrTail.trim()})`,
        });
      }
      if (result.subtype === 'error_max_turns') {
        return harden({ type: 'limit-exceeded', which: 'max-turns' });
      }
      if (result.subtype !== 'success' || result.is_error) {
        return harden({
          type: 'unavailable',
          reason: `result ${result.subtype}: ${String(result.result ?? '').slice(0, 200)}`,
        });
      }
      const u = result.usage ?? {};
      return harden({
        type: 'ok',
        text: String(result.result ?? ''),
        usage: {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          turns: result.num_turns ?? 0,
          durationMs: result.duration_ms ?? 0,
          costUsd: result.total_cost_usd ?? 0,
        },
      });
    } finally {
      await fs.rm(turnDir, { recursive: true, force: true });
    }
  };

  return harden({ describe, infer });
};
harden(makeClaudeCliBackend);
