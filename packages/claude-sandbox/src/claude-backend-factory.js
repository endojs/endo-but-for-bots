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
// - Each session is one record the daemon session owner keeps: a `claude -p`
//   process per turn inside a rootless Podman slice over a projected
//   workspace and a persistent per-session config dir, activated by the
//   native controller (src/claude-native-controller.js) the owner starts.
// - The Endo tools Floot pins for the session — the `HostedToolSet` it passes
//   to `create` — reach the CLI over a per-session MCP socket the controller
//   runs (src/mcp-socket-server.js) bind-mounted read-only into the slice.
//   Only JSON crosses that socket; the guest capabilities stay in Floot's
//   worker on the far end of `E(toolSet).execute`.
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
import { makeSessionRegistry } from '@endo/hosted-agent/session-registry.js';
import path from 'node:path';

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

/** The network policies a session may request; the broker attests each. */
export const NETWORK_POLICIES = harden(['off', 'public-internet']);

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
 * What the backend records for a session, beyond its id: the network policy
 * the broker must attest, the model and persona the plan carries, and an
 * optional operator-supplied workspace.
 * @typedef {object} SessionRequest
 * @property {'off' | 'public-internet'} networkPolicy
 * @property {string} [model]
 * @property {string} [systemPrompt]
 * @property {string} [workspaceHostPath] Operator-supplied worktree; never
 *   owned, never removed.
 */

/**
 * Build the trusted lifecycle owner for Claude CLI backend sessions over the
 * daemon session owner's three operations.
 *
 * @param {object} powers
 * @param {(sessionId: string, request: SessionRequest, toolSet: any) => Promise<any>} powers.provisionSession
 *   Record (or reopen) the session's plan with the daemon owner and start its
 *   native controller with the pinned tool set, returning the client facet.
 * @param {(sessionId: string) => Promise<void>} powers.stopSession
 *   The owner's stop: fences the facet, awaits the controller's native cleanup
 *   acknowledgement, and retains failure for retry. The workspace and the
 *   persistent transcript survive.
 * @param {(sessionId: string) => Promise<void>} powers.removeSession
 *   The owner's removal: native cleanup, then the recorded storage owner's
 *   deletion, retaining failure and refusing reuse until it succeeds.
 * @param {ReadonlyArray<any>} [powers.models] - hosted model descriptors.
 */
export const makeClaudeBackendFactory = ({
  provisionSession,
  stopSession,
  removeSession,
  models = CLAUDE_CLI_MODELS,
}) => {
  const catalog = harden(models.map(normalizeHostedModelDescriptor));
  const listModels = async () => catalog;

  const sessions = makeSessionRegistry();

  /**
   * @param {Record<string, any>} spec
   * @param {any} toolSet
   */
  const createSession = async (spec, toolSet) => {
    const { sessionId } = spec;
    const networkPolicy = spec.networkPolicy ?? 'off';
    NETWORK_POLICIES.includes(networkPolicy) ||
      Fail`Unknown network policy ${q(networkPolicy)}; expected "off" or "public-internet"`;
    if (spec.model !== undefined && spec.model !== '') {
      (typeof spec.model === 'string' && spec.model.length <= 256) ||
        Fail`Claude model id must be a bounded string`;
      catalog.some(model => model.id === spec.model) ||
        Fail`Unknown Claude model ${q(spec.model.slice(0, 64))}`;
    }
    spec.reasoningEffort === undefined ||
      spec.reasoningEffort === '' ||
      Fail`The Claude CLI runtime has no reasoning-effort setting`;
    const declaredMounts = spec.containerMounts ?? [];
    (Array.isArray(declaredMounts) && declaredMounts.length === 0) ||
      Fail`The Claude backend has no slice attestation for container mounts; refusing the session instead of claiming binds it does not have`;
    let workspaceHostPath;
    if (spec.workspaceHostPath !== undefined) {
      workspaceHostPath = `${spec.workspaceHostPath}`;
      (workspaceHostPath.length > 0 &&
        workspaceHostPath.length <= 4096 &&
        path.isAbsolute(workspaceHostPath) &&
        path.normalize(workspaceHostPath) === workspaceHostPath &&
        !workspaceHostPath.includes('\0')) ||
        Fail`workspaceHostPath must be a normalized absolute host path`;
    }
    // A predecessor that cannot stop refuses the successor rather than running
    // beside it: the registry retains its failed stop and rethrows here.
    await sessions.stop(sessionId);
    const client = await provisionSession(
      sessionId,
      harden({
        networkPolicy,
        ...(spec.model ? { model: spec.model } : {}),
        ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
        ...(workspaceHostPath ? { workspaceHostPath } : {}),
      }),
      toolSet,
    );

    let terminated = false;
    /** @type {Promise<void> | undefined} */
    let stopInFlight;
    const terminate = () => {
      if (terminated) return Promise.resolve();
      if (stopInFlight) return stopInFlight;
      stopInFlight = (async () => {
        await null;
        // The owner's stop is the containment barrier: it does not resolve
        // until the controller acknowledges native cleanup. A failure retains
        // this terminate for retry through the registry.
        await stopSession(sessionId);
        terminated = true;
        sessions.release(sessionId, terminate);
      })().finally(() => {
        if (!terminated) stopInFlight = undefined;
      });
      return stopInFlight;
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
        // Forward the turn's options rather than rebuilding them. Naming the
        // fields here meant every continuity option the stack added — the
        // transcript above all — was dropped on the way to the client. The
        // session still remembered, because Claude's own store survives on a
        // host bind and `--continue` found it, so the stack's record was
        // never what was carrying the conversation.
        const raw = await E(client).send(
          prompt,
          harden({
            ...options,
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
        return E(client).status();
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
          'Factory-only Claude CLI lifecycle administration: terminate (the daemon owner stops the native controller and its tool bridge; keeps the workspace and transcript).',
      },
    );
    sessions.retain(sessionId, terminate);
    return harden({ run, admin });
  };

  /**
   * @param {Record<string, any>} spec
   * @param {any} toolSet
   */
  const create = async (spec, toolSet) => {
    const sessionId = assertSessionId(spec?.sessionId);
    return sessions.inOrder(sessionId, () => createSession(spec, toolSet));
  };

  /** @param {Record<string, any>} spec */
  const destroy = async spec => {
    const sessionId = assertSessionId(spec?.sessionId);
    return sessions.inOrder(sessionId, async () => {
      // Never underneath a running CLI.
      await sessions.stop(sessionId);
      await removeSession(sessionId);
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
        supportedNetworkPolicies: NETWORK_POLICIES,
      });
    },
    listModels,
    create,
    async stop(spec) {
      const sessionId = assertSessionId(spec?.sessionId);
      return sessions.inOrder(sessionId, async () => {
        // Reach the durable owner even when no admin survived this factory.
        if (!(await sessions.stop(sessionId))) await stopSession(sessionId);
      });
    },
    destroy,
    help() {
      return 'Claude CLI backend factory: describe, listModels, create, stop (keeps state), and idempotent destroy.';
    },
  });
};
harden(makeClaudeBackendFactory);
