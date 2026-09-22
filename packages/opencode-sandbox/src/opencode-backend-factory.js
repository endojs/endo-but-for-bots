// @ts-check
// OpenCode as a Floot hosted backend.
//
// The factory itself is the shared one (`@endo/hosted-agent/backend-factory-kit.js`):
// it validates Floot's request, serializes operations per session, retains
// each session's termination until the daemon owner's stop succeeds, and
// exposes the hosted turn protocol. This module declares what is OpenCode's:
// the runtime has no reasoning-effort setting and no subscriptions, its
// client's reply reader passes through untranslated, and its model list is
// what the broker's OpenRouter account offers under opencode's route spelling.
//
// Continuity is opencode's own persisted session store: every turn resumes
// the conversation recorded in the state directory, so there is no checkpoint
// to acknowledge and `acknowledge()` is a no-op. The descriptor says so
// (`continuity: 'transcript'`) so a consumer can mirror what that store
// retains — a delivered prompt survives an aborted or failed turn there.

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import {
  isIdleInterrupt,
  makeHostedBackendFactory,
} from '@endo/hosted-agent/backend-factory-kit.js';

import { DEFAULT_SERVER_NAME } from './mcp-socket-server.js';

/** @import { makeBackendCatalog } from '@endo/hosted-agent/backend-catalog.js' */

/** @typedef {import('@endo/hosted-agent/session-provisioner.js').SessionRequest} SessionRequest */

/** The backend id Floot pins sessions to (`opencode:<model>`). */
export const OPENCODE_BACKEND_ID = 'opencode';
harden(OPENCODE_BACKEND_ID);

/**
 * Build the Floot-facing factory over the daemon-owned session lifecycle.
 *
 * @param {object} powers
 * @param {(sessionId: string, request: Record<string, any>, toolSet: any) => Promise<any>} powers.provisionSession
 *   Record (or reuse) the session's approved plan and exact dependencies, and
 *   start its native controller with the pinned tool set. Resolves to the
 *   owner's session facet (`send`, `interrupt`, `status`). A rejection leaves
 *   whatever the owner acquired under the owner's retained cleanup; this
 *   factory does not roll back.
 * @param {(sessionId: string) => Promise<void>} powers.stopSession
 *   The owner's stop: fences the facet, awaits the controller's native cleanup
 *   acknowledgement, and retains failure for retry. Durable workspace and
 *   native state survive.
 * @param {(sessionId: string) => Promise<void>} powers.removeSession
 *   The owner's removal: native cleanup, then the recorded storage owner's
 *   deletion, retaining failure and refusing reuse until it succeeds.
 * @param {ReturnType<typeof makeBackendCatalog>} powers.catalog What the
 *   broker's OpenRouter account lists, as opencode routes it; a new
 *   session's pin is admitted by it in the provisioner.
 * @param {boolean} [powers.publicInternetEnabled] Verified operator broker policy.
 */
export const makeOpencodeBackendFactory = ({
  provisionSession,
  stopSession,
  removeSession,
  catalog,
  publicInternetEnabled = false,
}) =>
  makeHostedBackendFactory({
    label: 'OpenCode',
    provisionSession,
    stopSession,
    removeSession,
    catalog,
    publicInternetEnabled,
    describe: () => ({
      id: OPENCODE_BACKEND_ID,
      title: 'OpenCode',
      continuity: 'transcript',
      // What a system prompt must know about this place. opencode lists an
      // MCP server's tools as `<server>_<tool>`; it has its own shell and
      // file tools; the hosted policy mounts the session workspace at
      // /workspace, its working directory.
      promptEnvironment: {
        toolNamePrefix: `${DEFAULT_SERVER_NAME}_`,
        toolNames: {},
        nativeTools: true,
        workspacePath: '/workspace',
      },
    }),
    readRequest: spec => {
      spec.reasoningEffort === undefined ||
        spec.reasoningEffort === '' ||
        Fail`The OpenCode runtime has no reasoning-effort setting`;
      return {};
    },
    makeRun: ({ client, spec }) => ({
      /**
       * Start one opencode turn and hand back the client's reply reader. The
       * session's model and persona are baked into the recorded plan, so the
       * persona rides each send unchanged; the client refuses a turn that
       * asks to change it.
       *
       * @param {string} prompt
       * @param {Record<string, any>} [options]
       */
      async send(prompt, options = {}) {
        const systemPrompt = options.systemPrompt || spec.systemPrompt;
        // Forward the turn's options rather than rebuilding them. Naming the
        // fields here meant every continuity option the stack added — the
        // transcript above all — was dropped on the way to the client, which
        // then had nothing to restore from and started context-free.
        return E(client).send(
          prompt,
          harden({ ...options, ...(systemPrompt ? { systemPrompt } : {}) }),
        );
      },
      models: () => catalog.offered(),
      /**
       * Abort the in-flight turn through the client's terminal barrier. The
       * client serializes turns behind the aborted turn's terminal, so a
       * prompt sent after this resolves cannot race it.
       */
      async interrupt() {
        try {
          await E(client).interrupt();
        } catch (error) {
          if (!isIdleInterrupt(error)) throw error;
        }
      },
      // Continuity is the opencode session store; there is no checkpoint to
      // commit.
      async acknowledge(_checkpoint) {
        await null;
      },
      async status() {
        return E(client).status();
      },
      help: method =>
        method
          ? `Hosted OpenCode backend run method: ${method}`
          : 'Hosted OpenCode backend: send, models, interrupt, acknowledge (no-op; the opencode session store is the continuity), and status.',
    }),
    adminHelp:
      'Factory-only OpenCode lifecycle administration: terminate (the daemon owner stops the native controller and its tool bridge; keeps the workspace and session store).',
  });
harden(makeOpencodeBackendFactory);
