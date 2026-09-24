// @ts-check
// Claude Code as a Floot hosted backend.
//
// The factory itself is the shared one (`@endo/hosted-agent/backend-factory-kit.js`):
// it validates Floot's request, serializes operations per session, retains
// each session's termination until the daemon owner's stop succeeds, and
// exposes the hosted turn protocol. This module declares what is Claude's:
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
// - The reasoning effort is the runtime's own axis: checked in shape here,
//   and against the efforts the runtime drives each model at in the
//   provisioner.
//
// Continuity is the CLI's own transcript: every turn resumes the conversation
// persisted in the session's config dir, so there is no checkpoint to
// acknowledge and `acknowledge()` is a no-op. The descriptor says so
// (`continuity: 'transcript'`) so a consumer can mirror what that transcript
// retains — a delivered prompt survives an aborted or failed turn there.

import { E } from '@endo/eventual-send';
import {
  isIdleInterrupt,
  makeHostedBackendFactory,
} from '@endo/hosted-agent/backend-factory-kit.js';

import { translateClaudeTurn } from './claude-hosted-events.js';
import { assertClaudeEffort } from './claude-effort.js';
import { DEFAULT_SERVER_NAME } from './mcp-socket-server.js';

/** @import { makeBackendCatalog } from '@endo/hosted-agent/backend-catalog.js' */
/** @import { DeclaredSubscription } from '@endo/hosted-agent/subscription-lister.js' */

export { NETWORK_POLICIES } from '@endo/hosted-agent/backend-factory-kit.js';

/** @typedef {import('@endo/hosted-agent/session-provisioner.js').SessionRequest} SessionRequest */

/** The backend id Floot pins sessions to (`claude:<model>`). */
export const CLAUDE_BACKEND_ID = 'claude';
harden(CLAUDE_BACKEND_ID);

/**
 * Build the trusted lifecycle owner for Claude CLI backend sessions over the
 * daemon session owner's three operations.
 *
 * @param {object} powers
 * @param {(sessionId: string, request: Record<string, any>, toolSet: any) => Promise<any>} powers.provisionSession
 *   Record (or reopen) the session's plan with the daemon owner and start its
 *   native controller with the pinned tool set, returning the client facet.
 * @param {(sessionId: string) => Promise<void>} powers.stopSession
 *   The owner's stop: fences the facet, awaits the controller's native cleanup
 *   acknowledgement, and retains failure for retry. The workspace and the
 *   persistent transcript survive.
 * @param {(sessionId: string) => Promise<void>} powers.removeSession
 *   The owner's removal: native cleanup, then the recorded storage owner's
 *   deletion, retaining failure and refusing reuse until it succeeds.
 * @param {ReturnType<typeof makeBackendCatalog>} powers.catalog What each
 *   account of the broker lists, as the Claude Code runtime offers it; a
 *   new session's pin is admitted by it in the provisioner.
 * @param {boolean} [powers.publicInternetEnabled] Verified operator broker policy.
 * @param {() => Promise<DeclaredSubscription[]>} [powers.listSubscriptions]
 */
export const makeClaudeBackendFactory = ({
  provisionSession,
  stopSession,
  removeSession,
  catalog,
  publicInternetEnabled = false,
  listSubscriptions = async () => [],
}) =>
  makeHostedBackendFactory({
    label: 'Claude',
    provisionSession,
    stopSession,
    removeSession,
    catalog,
    publicInternetEnabled,
    listSubscriptions,
    describe: () => ({
      id: CLAUDE_BACKEND_ID,
      title: 'Claude Code',
      continuity: 'transcript',
      nativeContextFormat: 'claude-code-jsonl-v1',
      providerId: 'anthropic',
      // What a system prompt must know about this place. Claude Code lists
      // an MCP server's tools as `mcp__<server>__<tool>`; the CLI has its
      // own shell and file tools; the hosted policy mounts the session
      // workspace at /workspace, the CLI's working directory.
      promptEnvironment: {
        toolNamePrefix: `mcp__${DEFAULT_SERVER_NAME}__`,
        toolNames: {},
        nativeTools: true,
        workspacePath: '/workspace',
      },
    }),
    readRequest: spec => {
      if (spec.reasoningEffort !== undefined && spec.reasoningEffort !== '') {
        assertClaudeEffort(spec.reasoningEffort);
      }
      return spec.reasoningEffort
        ? { reasoningEffort: spec.reasoningEffort }
        : {};
    },
    makeRun: ({ client, spec, subscription }) => ({
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
            ...(spec.reasoningEffort
              ? { reasoningEffort: spec.reasoningEffort }
              : {}),
            ...(systemPrompt ? { systemPrompt } : {}),
          }),
        );
        return translateClaudeTurn(raw);
      },
      // What this session's account lists: the pinned one's, or any not
      // set aside.
      models: () => catalog.offered(subscription),
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
    }),
    adminHelp:
      'Factory-only Claude CLI lifecycle administration: terminate (the daemon owner stops the native controller and its tool bridge; keeps the workspace and transcript).',
  });
harden(makeClaudeBackendFactory);
