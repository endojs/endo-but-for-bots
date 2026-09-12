// @ts-check
// OpenCode as a Floot hosted backend.
//
// Floot discovers hosted backends through `HostedBackendFactoryInterface`
// (@endo/hosted-agent): `describe()` names the backend, `listModels()` offers
// its catalog, and `create(spec, toolSet)` hands back one session's `run`
// facet (the turn protocol Floot's hosted-turn consumer drives) and its
// factory-only `admin` facet. This module is that seam for the opencode CLI
// runtime in @endo/opencode-sandbox:
//
// - Each session is one isolated OpencodeClient formula: a long-lived
//   `opencode serve` process inside a rootless Podman slice, carried by the
//   in-slice stdio bridge, over a 9P-projected workspace and a host-backed
//   state directory (SQLite WAL needs same-host shared memory). The injected
//   provisioner creates it lazily and the daemon reincarnates it across
//   restarts.
// - The Endo tools Floot pins for the session — the `HostedToolSet` it passes
//   to `create` — reach the CLI over a per-session MCP socket
//   (src/mcp-bridge.js, src/mcp-socket-server.js) bind-mounted read-only into
//   the slice. Only JSON crosses that socket; the guest capabilities stay in
//   Floot's worker on the far end of `E(toolSet).execute`.
// - The client's bridge already emits the provider-neutral hosted events
//   (phase | text-delta | commentary-delta | tool-call | tool-result | usage |
//   end | abort), so `send` passes its reply reader straight through.
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
 * @typedef {object} ToolBridge
 * @property {string} socketDir - host directory holding the socket, relay, and
 *   MCP config; bind-mounted read-only into the slice.
 * @property {string} innerDir - slice path the directory mounts at.
 * @property {string} configPath - slice-internal path of the `mcp.json`.
 * @property {() => number} pendingCalls - Endo tool calls in flight.
 * @property {() => Promise<void>} close - stop the listener (idempotent).
 */

/**
 * Build the trusted lifecycle owner for opencode backend sessions.
 *
 * @param {object} powers
 * @param {(sessionId: string, options: { mcp: { socketDir: string, innerDir: string, configPath: string }, model?: string, systemPrompt?: string, workspaceHostPath?: string, network?: 'none' | 'private' }) => Promise<any>} powers.provisionClient
 *   Provision (or reopen) the session's OpencodeClient formula with the tool
 *   bridge mount, the pinned model, and the session persona baked into the
 *   opencode agent config, and return the client capability.
 * @param {(sessionId: string) => Promise<void>} powers.cancelClient
 *   Tear down the client's live incarnation — its slice, mounts, and
 *   credential grant — so the formula reincarnates fresh on the next
 *   `provisionClient`. Durable state (workspace, opencode session store)
 *   survives.
 * @param {(sessionId: string) => Promise<void>} powers.removeSession
 *   Idempotently destroy the session's durable state: the client formula, its
 *   filesystems, the state directory, and their backing directories.
 * @param {(sessionId: string, toolSet: any) => Promise<ToolBridge>} powers.startToolBridge
 *   Start the per-session MCP socket server over the pinned tool set.
 * @param {(sessionId: string) => Promise<void>} powers.removeToolBridge
 *   Delete the session's socket directory.
 * @param {ReadonlyArray<any>} [powers.models] - hosted model descriptors.
 */
export const makeOpencodeBackendFactory = ({
  provisionClient,
  cancelClient,
  removeSession,
  startToolBridge,
  removeToolBridge,
  models = OPENCODE_MODELS,
}) => {
  const catalog = harden(models.map(normalizeHostedModelDescriptor));
  const listModels = async () => catalog;

  // One live instance per session. `create` and `destroy` for one session id
  // run in order, and either stops an instance this factory still runs before
  // acting: a second `create` for a live session is the session's new owner (a
  // Floot factory rebuilt without a daemon restart revives every session it
  // records, while the old instance's admin facet died with the old factory),
  // not a request for a duplicate that would race the same opencode session
  // store.
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
    const networkPolicy = spec.networkPolicy ?? 'off';
    ['off', 'public-internet'].includes(networkPolicy) ||
      Fail`Unknown network policy ${q(networkPolicy)}; expected "off" or "public-internet"`;
    const network = networkPolicy === 'off' ? 'none' : 'private';
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
      Fail`The phase-1 OpenCode backend has no slice attestation for container mounts; refusing the session instead of claiming binds it does not have`;
    let workspaceHostPath;
    if (spec.workspaceHostPath !== undefined) {
      workspaceHostPath = `${spec.workspaceHostPath}`;
      (workspaceHostPath.length > 0 &&
        workspaceHostPath.length <= 4096 &&
        path.isAbsolute(workspaceHostPath) &&
        path.normalize(workspaceHostPath) === workspaceHostPath &&
        !workspaceHostPath.includes('\0')) ||
        Fail`workspaceHostPath must be a canonical absolute host path`;
    }
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
        network,
        ...(spec.model ? { model: spec.model } : {}),
        ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
        ...(workspaceHostPath ? { workspaceHostPath } : {}),
      });
    } catch (error) {
      await bridge.close().catch(() => {});
      throw error;
    }

    let terminated = false;
    // The client is stopped once; a retry after a refused teardown (an Endo
    // tool call still running host-side) resumes from there.
    let clientStopped = false;
    /** @type {Promise<void> | undefined} */
    let cleanupInFlight;
    /** @param {number} pending */
    const refuseUnsettled = pending => {
      pending === 0 ||
        Fail`OpenCode session has ${q(pending)} unsettled Endo tool call(s)`;
    };
    const terminate = () => {
      if (terminated) return Promise.resolve();
      if (cleanupInFlight) return cleanupInFlight;
      cleanupInFlight = (async () => {
        await null;
        if (!clientStopped) {
          // An unsettled Endo tool call refuses the stop before anything is
          // torn down: killing the client under it would leave the call
          // running host-side with no reader for its result while this
          // reported success.
          refuseUnsettled(bridge.pendingCalls());
          // Stop the client here, awaited, rather than leaving it to the
          // formula cancellation below. The worker-side teardown (slice, both
          // 9P mounts, their pet names, the credential grant) has to be
          // finished before a successor's provision() can run, or the
          // predecessor's unmount, name removal, and grant revocation land on
          // the successor's mount, name, and grant.
          try {
            await E(client).terminate();
          } catch (error) {
            // An unreachable worker: the formula cancellation below is the
            // durable teardown, so a failed direct stop is no reason to keep
            // the session alive.
            console.error(
              `[opencode-sandbox] direct stop of session ${sessionId} failed; relying on cancellation:`,
              error instanceof Error ? error.message : String(error),
            );
          }
          clientStopped = true;
        }
        // A call that raced the check above is still running host-side; it has
        // to settle before the session is declared stopped.
        refuseUnsettled(bridge.pendingCalls());
        await bridge.close();
        // A stop, not a deletion: the workspace and the opencode session
        // store stay for the next revival.
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
       * Start one opencode turn and hand back the client's reply reader. The
       * session's model and persona are baked into the client's config at
       * provision time, so the persona rides each send unchanged; the client
       * refuses a turn that asks to change it.
       *
       * @param {string} prompt
       * @param {Record<string, any>} [options]
       */
      async send(prompt, options = {}) {
        networkPolicy !== 'off' ||
          Fail`OpenCode session network policy is "off"; set the session policy to public-internet before sending a turn`;
        const systemPrompt = options.systemPrompt || spec.systemPrompt;
        return E(client).send(
          prompt,
          harden({ ...(systemPrompt ? { systemPrompt } : {}) }),
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
          ? `Hosted OpenCode backend run method: ${method}`
          : 'Hosted OpenCode backend: send, models, interrupt, acknowledge (no-op; the opencode session store is the continuity), and status.',
    });
    const admin = makeExo(
      'HostedTurnBackendAdmin',
      HostedTurnBackendAdminInterface,
      {
        terminate,
        help: () =>
          'Factory-only OpenCode lifecycle administration: terminate (stops the client and the tool bridge; keeps the workspace and session store).',
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
      // Never underneath a running client.
      await stopLive(sessionId);
      try {
        await removeSession(sessionId);
      } finally {
        await removeToolBridge(sessionId);
      }
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
        // Floot initializes every session at `off` and refuses a turn whose
        // current policy the descriptor does not list, so both arms are
        // required even though phase 1 only exercises `public-internet`.
        supportedNetworkPolicies: ['off', 'public-internet'],
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
