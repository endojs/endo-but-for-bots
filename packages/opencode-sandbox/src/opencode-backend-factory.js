// @ts-check
// OpenCode as a Floot hosted backend.
//
// Floot discovers hosted backends through `HostedBackendFactoryInterface`
// (@endo/hosted-agent): `describe()` names the backend, `listModels()` offers
// its catalog, and `create(spec, toolSet)` hands back one session's `run`
// facet (the turn protocol Floot's hosted-turn consumer drives) and its
// factory-only `admin` facet. This module is that seam for the opencode CLI
// runtime in @endo/opencode-sandbox.
//
// Session lifetime belongs to the daemon's session owner, not to this
// factory: the injected `provisionSession` records the approved plan and its
// exact dependencies, starts the native controller with the pinned tool set,
// and returns the owner's forwarding facet; `stopSession` and `removeSession`
// reach the owner's stop and removal, which retain failed native cleanup and
// refuse a successor until it succeeds. This factory validates Floot's
// request, serializes operations per session, and translates the facet into
// the hosted turn protocol. It performs no rollback of its own.
//
// Continuity is opencode's own persisted session store: every turn resumes the
// conversation recorded in the state directory, so there is no checkpoint to
// acknowledge and `acknowledge()` is a no-op. The descriptor says so
// (`continuity: 'transcript'`) so a consumer can mirror what that transcript
// retains — a delivered prompt survives an aborted or failed turn there.

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import path from 'node:path';
import {
  HostedBackendFactoryInterface,
  HostedTurnBackendAdminInterface,
  HostedTurnBackendInterface,
  normalizeHostedModelDescriptor,
} from '@endo/hosted-agent';
import { makeSessionRegistry } from '@endo/hosted-agent/session-registry.js';

import { DEFAULT_MODEL } from './opencode-agent-config.js';

/** The backend id Floot pins sessions to (`opencode:<model>`). */
export const OPENCODE_BACKEND_ID = 'opencode';
harden(OPENCODE_BACKEND_ID);

/**
 * The OpenRouter-routed models this backend offers, ordered faster/lighter to
 * stronger. Ids are full opencode refs (`openrouter/<vendor>/<model>`) passed
 * verbatim into the session config, whose host-generated provider block pins
 * the same endpoint (src/opencode-agent-config.js). opencode has no
 * reasoning-effort knob here — `--variant` mapping is unproven — so no model
 * declares efforts.
 */
export const OPENCODE_MODELS = harden(
  [
    {
      id: DEFAULT_MODEL,
      title: 'DeepSeek V4.1 Flash',
      description: 'Fast and inexpensive — best for quick, simple turns.',
      default: true,
    },
  ].map(model =>
    normalizeHostedModelDescriptor({
      ...model,
      defaultReasoningEffort: null,
      reasoningEfforts: [],
    }),
  ),
);

/** The catalog under the `*-CLI-MODELS` name the sibling backends use. */
export const OPENCODE_CLI_MODELS = OPENCODE_MODELS;
harden(OPENCODE_CLI_MODELS);

const NETWORK_POLICIES = harden(['off', 'public-internet']);

/**
 * Floot session ids double as pet-name and path components on the host, so
 * they are bounded to the session owner's namespace.
 *
 * @param {unknown} sessionId
 * @returns {string}
 */
const assertSessionId = sessionId => {
  (typeof sessionId === 'string' &&
    /^[a-z0-9][a-z0-9-]{0,127}$/.test(sessionId)) ||
    Fail`OpenCode sessionId must be a bounded lowercase path component`;
  return /** @type {string} */ (sessionId);
};

/**
 * `OpencodeClient.interrupt()` refuses when nothing is in flight. For a
 * cancellation barrier that is success, not failure: the turn it would have
 * stopped has already ended (or its reader was closed first, which is what
 * ends the turn).
 *
 * @param {unknown} error
 */
const isIdleInterrupt = error =>
  error instanceof Error &&
  /no in-flight prompt to interrupt/.test(error.message);

/**
 * @typedef {object} SessionRequest
 * @property {'off' | 'public-internet'} networkPolicy
 * @property {string} [model]
 * @property {string} [systemPrompt]
 * @property {string} [workspaceHostPath] Operator-supplied worktree; never
 *   owned storage.
 */

/**
 * Build the Floot-facing factory over the daemon-owned session lifecycle.
 *
 * @param {object} powers
 * @param {(sessionId: string, request: SessionRequest, toolSet: any) => Promise<any>} powers.provisionSession
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
 * @param {ReadonlyArray<any>} [powers.models] - hosted model descriptors.
 */
export const makeOpencodeBackendFactory = ({
  provisionSession,
  stopSession,
  removeSession,
  models = OPENCODE_MODELS,
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
        Fail`OpenCode model id must be a bounded string`;
      catalog.some(model => model.id === spec.model) ||
        Fail`Unknown OpenCode model ${q(spec.model.slice(0, 64))}`;
    }
    spec.reasoningEffort === undefined ||
      spec.reasoningEffort === '' ||
      Fail`The OpenCode runtime has no reasoning-effort setting`;
    const declaredMounts = spec.containerMounts ?? [];
    (Array.isArray(declaredMounts) && declaredMounts.length === 0) ||
      Fail`The OpenCode backend has no slice attestation for container mounts; refusing the session instead of claiming binds it does not have`;
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
      models: listModels,
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
    });
    const admin = makeExo(
      'HostedTurnBackendAdmin',
      HostedTurnBackendAdminInterface,
      {
        terminate,
        help: () =>
          'Factory-only OpenCode lifecycle administration: terminate (the daemon owner stops the native controller and its tool bridge; keeps the workspace and session store).',
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
      // Never underneath a running client.
      await sessions.stop(sessionId);
      await removeSession(sessionId);
    });
  };

  return makeExo('OpencodeBackendFactory', HostedBackendFactoryInterface, {
    async describe() {
      return harden({
        id: OPENCODE_BACKEND_ID,
        title: 'OpenCode',
        kind: 'hosted',
        continuity: 'transcript',
        toolOwnership: 'endo',
        supportedNetworkPolicies: NETWORK_POLICIES,
      });
    },
    listModels,
    create,
    destroy,
    help() {
      return 'OpenCode backend factory: describe, listModels, create, and idempotent destroy.';
    },
  });
};
harden(makeOpencodeBackendFactory);
