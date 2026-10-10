// @ts-check
// Claude Code as a Floot hosted backend.
//
// Floot discovers hosted backends through `HostedBackendFactoryInterface`
// (@endo/hosted-agent): `describe()` names the backend, `listModels()` offers
// its catalog, and `create(spec, toolSet)` hands back one session's `run`
// facet (the turn protocol Floot's hosted-turn consumer drives) and its
// factory-only `admin` facet. This module is that seam for the Claude CLI
// runtime in @endo/claude-sandbox:
//
// - Each session is one isolated ClaudeClient formula (a `claude -p` process
//   per turn inside a rootless Podman slice over a projected workspace and a
//   persistent per-session config dir), provisioned lazily by the injected
//   provisioner and reincarnated by the daemon across restarts.
// - The Endo tools Floot pins for the session — the `HostedToolSet` it passes
//   to `create` — reach the CLI over a per-session MCP socket
//   (src/mcp-bridge.js, src/mcp-socket-server.js) bind-mounted read-only into
//   the slice. Only JSON crosses that socket; the guest capabilities stay in
//   Floot's worker on the far end of `E(toolSet).execute`.
// - Turn events are translated from the CLI's stream-json wire into the
//   provider-neutral hosted events (src/claude-hosted-events.js), so nothing
//   Claude-specific reaches Floot.
//
// Continuity is the CLI's own transcript: every turn resumes the conversation
// persisted in the session's config dir, so there is no checkpoint to
// acknowledge and `acknowledge()` is a no-op. The descriptor says so
// (`continuity: 'transcript'`) so a consumer can mirror what that transcript
// retains — a delivered prompt survives an aborted or failed turn there.

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import {
  HostedBackendFactoryInterface,
  HostedTurnBackendAdminInterface,
  HostedTurnBackendInterface,
  normalizeHostedModelDescriptor,
} from '@endo/hosted-agent';

import { translateClaudeTurn } from './claude-hosted-events.js';

/** The backend id Floot pins sessions to (`claude:<model>`). */
export const CLAUDE_BACKEND_ID = 'claude';
harden(CLAUDE_BACKEND_ID);

/**
 * The Anthropic models the CLI runtime offers, ordered faster/lighter to
 * stronger. Ids are passed verbatim to `claude --model`, so they must be valid
 * Anthropic model ids. The CLI has no reasoning-effort knob.
 */
export const CLAUDE_CLI_MODELS = harden(
  [
    {
      id: 'claude-haiku-4-5-20251001',
      title: 'Claude Haiku 4.5',
      description: 'Fastest and lightest — best for quick, simple turns.',
      default: true,
    },
    {
      id: 'claude-sonnet-4-6',
      title: 'Claude Sonnet 4.6',
      description: 'Balanced speed and capability.',
      default: false,
    },
    {
      id: 'claude-sonnet-5',
      title: 'Claude Sonnet 5',
      description: 'Stronger reasoning at Sonnet-class latency.',
      default: false,
    },
    {
      id: 'claude-opus-4-8',
      title: 'Claude Opus 4.8',
      description: 'High capability for hard reasoning and agentic work.',
      default: false,
    },
    {
      id: 'claude-opus-5',
      title: 'Claude Opus 5',
      description: 'Most capable — deepest reasoning and longest-horizon work.',
      default: false,
    },
  ].map(model =>
    normalizeHostedModelDescriptor({
      ...model,
      defaultReasoningEffort: null,
      reasoningEfforts: [],
    }),
  ),
);

/**
 * Floot session ids double as pet-name and path components on the host, so
 * they are bounded to the provisioner's namespace.
 *
 * @param {unknown} sessionId
 * @returns {string}
 */
const assertSessionId = sessionId => {
  (typeof sessionId === 'string' &&
    /^[a-z0-9][a-z0-9-]{0,127}$/.test(sessionId)) ||
    Fail`Claude sessionId must be a bounded lowercase path component`;
  return /** @type {string} */ (sessionId);
};

/**
 * `ClaudeClient.interrupt()` refuses when nothing is in flight. For a
 * cancellation barrier that is success, not failure: the turn it would have
 * stopped has already ended (or its reader was closed first, which is what
 * kills the process).
 *
 * @param {unknown} error
 */
const isIdleInterrupt = error =>
  error instanceof Error &&
  /no in-flight prompt to interrupt/.test(error.message);

/**
 * @typedef {object} ToolBridge
 * @property {string} socketDir - host directory holding the socket, relay, and
 *   MCP config; bind-mounted read-only into the slice.
 * @property {string} innerDir - slice path the directory mounts at.
 * @property {string} configPath - slice-internal path of the `mcp.json`.
 * @property {() => number} pendingCalls - Endo tool calls in flight.
 * @property {() => Promise<void>} close - stop the listener (idempotent).
 */

/**
 * Build the trusted lifecycle owner for Claude CLI backend sessions.
 *
 * @param {object} powers
 * @param {(sessionId: string, options: { mcp: { socketDir: string, innerDir: string, configPath: string }, model?: string, workspaceDir?: string }) => Promise<any>} powers.provisionClient
 *   Provision (or reopen) the session's ClaudeClient formula with the tool
 *   bridge mount, and return the client capability.
 * @param {(sessionId: string) => Promise<void>} powers.cancelClient
 *   Tear down the client's live incarnation — its slice, mounts, and
 *   credential grant — so the formula reincarnates fresh on the next
 *   `provisionClient`. Durable state (workspace, transcript) survives.
 * @param {(sessionId: string) => Promise<void>} powers.removeSession
 *   Idempotently destroy the session's durable state: the client formula, its
 *   filesystems, and their backing directories.
 * @param {(sessionId: string, toolSet: any) => Promise<ToolBridge>} powers.startToolBridge
 *   Start the per-session MCP socket server over the pinned tool set.
 * @param {(sessionId: string) => Promise<void>} powers.removeToolBridge
 *   Delete the session's socket directory.
 * @param {ReadonlyArray<any>} [powers.models] - hosted model descriptors.
 */
export const makeClaudeBackendFactory = ({
  provisionClient,
  cancelClient,
  removeSession,
  startToolBridge,
  removeToolBridge,
  models = CLAUDE_CLI_MODELS,
}) => {
  const catalog = harden(models.map(normalizeHostedModelDescriptor));
  const listModels = async () => catalog;

  // One live instance per session. `create` and `destroy` for one session id
  // run in order, and either stops an instance this factory still runs before
  // acting: a second `create` for a live session is the session's new owner (a
  // Floot factory rebuilt without a daemon restart revives every session it
  // records, while the old instance's admin facet died with the old factory),
  // not a request for a duplicate that would race the same CLI transcript.
  /** @type {Map<string, { terminate: () => Promise<void> }>} */
  const live = new Map();
  /** @type {Map<string, Promise<void>>} */
  const sessionChains = new Map();
  /**
   * @template T
   * @param {string} sessionId
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const inSessionOrder = (sessionId, operation) => {
    const previous = sessionChains.get(sessionId) || Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    sessionChains.set(sessionId, settled);
    void settled.then(() => {
      if (sessionChains.get(sessionId) === settled) {
        sessionChains.delete(sessionId);
      }
    });
    return result;
  };
  /** @param {string} sessionId */
  const stopLive = async sessionId => {
    const current = live.get(sessionId);
    if (current) await current.terminate();
  };

  /**
   * @param {Record<string, any>} spec
   * @param {any} toolSet
   */
  const createSession = async (spec, toolSet) => {
    const { sessionId } = spec;
    if (spec.model !== undefined && spec.model !== '') {
      catalog.some(model => model.id === spec.model) ||
        Fail`Unknown Claude model ${q(spec.model)}`;
    }
    spec.reasoningEffort === undefined ||
      spec.reasoningEffort === '' ||
      Fail`The Claude CLI runtime has no reasoning-effort setting`;
    // A predecessor that cannot stop — an unsettled Endo tool call — refuses
    // the successor rather than running beside it.
    await stopLive(sessionId);
    const bridge = await startToolBridge(sessionId, toolSet);
    let client;
    try {
      client = await provisionClient(sessionId, {
        mcp: {
          socketDir: bridge.socketDir,
          innerDir: bridge.innerDir,
          configPath: bridge.configPath,
        },
        ...(spec.model ? { model: spec.model } : {}),
        ...(spec.workspaceHostPath
          ? { workspaceDir: `${spec.workspaceHostPath}` }
          : {}),
      });
    } catch (error) {
      await bridge.close().catch(() => {});
      throw error;
    }

    let terminated = false;
    // The CLI is stopped once; a retry after a refused teardown (an Endo tool
    // call still running host-side) resumes from there.
    let clientStopped = false;
    /** @type {Promise<void> | undefined} */
    let cleanupInFlight;
    /** @param {number} pending */
    const refuseUnsettled = pending => {
      pending === 0 ||
        Fail`Claude session has ${q(pending)} unsettled Endo tool call(s)`;
    };
    const terminate = () => {
      if (terminated) return Promise.resolve();
      if (cleanupInFlight) return cleanupInFlight;
      cleanupInFlight = (async () => {
        await null;
        if (!clientStopped) {
          // An unsettled Endo tool call refuses the stop before anything is
          // torn down: killing the CLI under it would leave the call running
          // host-side with no reader for its result while this reported
          // success.
          refuseUnsettled(bridge.pendingCalls());
          // Stop the CLI here, awaited, rather than leaving it to the formula
          // cancellation below. The worker-side teardown (slice, both 9P
          // mounts, their pet names, the credential grant) has to be finished
          // before a successor's provision() can run, or the predecessor's
          // unmount, name removal, and grant revocation land on the
          // successor's mount, name, and grant.
          try {
            await E(client).terminate();
          } catch (error) {
            // An unreachable worker: the formula cancellation below is the
            // durable teardown, so a failed direct stop is no reason to keep
            // the session alive.
            console.error(
              `[claude-sandbox] direct stop of session ${sessionId} failed; relying on cancellation:`,
              error instanceof Error ? error.message : String(error),
            );
          }
          clientStopped = true;
        }
        // A call that raced the check above is still running host-side; it has
        // to settle before the session is declared stopped.
        refuseUnsettled(bridge.pendingCalls());
        await bridge.close();
        // A stop, not a deletion: the workspace and the transcript stay for
        // the next revival.
        await cancelClient(sessionId);
        terminated = true;
        if (live.get(sessionId)?.terminate === terminate) {
          live.delete(sessionId);
        }
      })().finally(() => {
        if (!terminated) cleanupInFlight = undefined;
      });
      return cleanupInFlight;
    };

    const run = makeExo('HostedTurnBackend', HostedTurnBackendInterface, {
      /**
       * Start one CLI turn. The session's pinned model rides every spawn and
       * the caller's system prompt (Floot's session persona) is appended to
       * the CLI's own via `--append-system-prompt`, since a fresh `claude -p`
       * never sees the conversation tree's system message.
       *
       * @param {string} prompt
       * @param {Record<string, any>} [options]
       */
      async send(prompt, options = {}) {
        const systemPrompt = options.systemPrompt || spec.systemPrompt;
        const raw = await E(client).send(
          prompt,
          harden({
            ...(spec.model ? { model: spec.model } : {}),
            ...(systemPrompt ? { systemPrompt } : {}),
          }),
        );
        return translateClaudeTurn(raw);
      },
      models: listModels,
      /**
       * Kill the in-flight `claude -p`. The client serializes turns behind
       * the killed process's exit, so a prompt sent after this resolves cannot
       * race it.
       */
      async interrupt() {
        try {
          await E(client).interrupt();
        } catch (error) {
          if (!isIdleInterrupt(error)) throw error;
        }
      },
      // Continuity is the CLI transcript; there is no checkpoint to commit.
      async acknowledge(_checkpoint) {
        await null;
      },
      async status() {
        const status = await E(client).status();
        return harden({
          ...status,
          pendingToolCalls: bridge.pendingCalls(),
          toolBridge: harden({
            innerDir: bridge.innerDir,
            configPath: bridge.configPath,
          }),
        });
      },
      help: method =>
        method
          ? `Hosted Claude CLI backend run method: ${method}`
          : 'Hosted Claude CLI backend: send, models, interrupt, acknowledge (no-op; the CLI transcript is the continuity), and status.',
    });
    const admin = makeExo(
      'HostedTurnBackendAdmin',
      HostedTurnBackendAdminInterface,
      {
        terminate,
        help: () =>
          'Factory-only Claude CLI lifecycle administration: terminate (stops the slice and the tool bridge; keeps the workspace and transcript).',
      },
    );
    live.set(sessionId, harden({ terminate }));
    return harden({ run, admin });
  };

  /**
   * @param {Record<string, any>} spec
   * @param {any} toolSet
   */
  const create = async (spec, toolSet) => {
    const sessionId = assertSessionId(spec?.sessionId);
    return inSessionOrder(sessionId, () => createSession(spec, toolSet));
  };

  /** @param {Record<string, any>} spec */
  const destroy = async spec => {
    const sessionId = assertSessionId(spec?.sessionId);
    return inSessionOrder(sessionId, async () => {
      // Never underneath a running CLI.
      await stopLive(sessionId);
      await removeSession(sessionId);
      await removeToolBridge(sessionId);
    });
  };

  return makeExo('ClaudeBackendFactory', HostedBackendFactoryInterface, {
    async describe() {
      return harden({
        id: CLAUDE_BACKEND_ID,
        title: 'Claude Code',
        kind: 'hosted',
        continuity: 'transcript',
        toolOwnership: 'endo',
      });
    },
    listModels,
    create,
    destroy,
    help() {
      return 'Claude CLI backend factory: describe, listModels, create, and idempotent destroy.';
    },
  });
};
harden(makeClaudeBackendFactory);
