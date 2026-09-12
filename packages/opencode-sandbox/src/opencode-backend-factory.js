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
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import path from 'node:path';
import {
  HostedBackendFactoryInterface,
  HostedTurnBackendAdminInterface,
  HostedTurnBackendInterface,
  normalizeHostedModelDescriptor,
} from '@endo/hosted-agent';
import { makeCleanupScope } from '@endo/hosted-agent/cleanup-scope.js';
import { makeSessionRegistry } from '@endo/hosted-agent/session-registry.js';

import { DEFAULT_MODEL, parseModelRef } from './opencode-agent-config.js';
import {
  OPENCODE_BROKER_ACCOUNT,
  OPENROUTER_ORIGIN,
} from './opencode-broker.js';

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
 * @param {(sessionId: string, options: { mcp: { socketDir: string, innerDir: string, configPath: string }, model?: string, systemPrompt?: string, workspaceHostPath?: string, network?: 'none' | 'private' | 'join', brokerEnv?: { OPENCODE_BROKER_BASE_URL: string, OPENCODE_BROKER_CONTAINER: string } }) => Promise<any>} powers.provisionClient
 *   Provision (or reopen) the session's OpencodeClient formula with the tool
 *   bridge mount, the pinned model, and the session persona baked into the
 *   opencode agent config, and return the client capability.
 * @param {(sessionId: string) => Promise<void>} powers.cancelClient
 *   Capture and await the current client's stop before cancelling its
 *   formula, including rollback after a failed provision attempt. Rejection
 *   retains that client's cleanup ownership; formula cancellation alone is
 *   not stop proof. Durable workspace and opencode session state survive.
 * @param {(sessionId: string) => Promise<void>} powers.removeSession
 *   Idempotently destroy the session's durable state: the client formula, its
 *   filesystems, the state directory, and their backing directories.
 * @param {(sessionId: string, toolSet: any) => Promise<ToolBridge>} powers.startToolBridge
 *   Start the per-session MCP socket server over the pinned tool set.
 * @param {(sessionId: string) => Promise<void>} powers.removeToolBridge
 *   Delete the session's socket directory.
 * @param {ReadonlyArray<any>} [powers.models] - hosted model descriptors.
 * @param {((spec: any) => Promise<{ revoke: () => Promise<void>, attestation: () => Promise<any>, sandboxEvidence: () => Promise<any> }>) | null} [powers.broker]
 *   Issue a revocable provider grant for a session without public networking.
 */
export const makeOpencodeBackendFactory = ({
  provisionClient,
  cancelClient,
  removeSession,
  startToolBridge,
  removeToolBridge,
  models = OPENCODE_MODELS,
  broker = null,
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
    ['off', 'public-internet'].includes(networkPolicy) ||
      Fail`Unknown network policy ${q(networkPolicy)}; expected "off" or "public-internet"`;
    // A broker grant makes `off` enforceable with the provider reachable:
    // the slice joins the listener's networkless namespace. Without a
    // broker the legacy refusal path stays (the session can still be
    // created, but a turn is refused with an actionable message).
    const network =
      networkPolicy === 'off' ? (broker ? 'join' : 'none') : 'private';
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
    await sessions.stop(sessionId);
    const bridge = await startToolBridge(sessionId, toolSet);
    /** @param {number} pending */
    const refuseUnsettled = pending => {
      pending === 0 ||
        Fail`OpenCode session has ${q(pending)} unsettled Endo tool call(s)`;
    };
    // Provider revocation and an idle MCP listener can be released even if
    // direct client stop fails. Formula cancellation depends on stop proof.
    const authorityResources = makeCleanupScope();
    authorityResources.add(async () => {
      refuseUnsettled(bridge.pendingCalls());
      await bridge.close();
    });
    const resources = makeCleanupScope();
    resources.add(() => authorityResources.run());
    const releaseResources = async () => {
      await resources.run();
      sessions.release(sessionId, releaseResources);
    };
    let client;
    try {
      let brokerEnv;
      if (networkPolicy === 'off' && broker) {
        // Issue the grant before the client exists: its endpoint and the
        // listener container are what the slice config and network need.
        const grant = await broker(
          harden({
            sessionId,
            providerOrigin: OPENROUTER_ORIGIN,
            accountRef: OPENCODE_BROKER_ACCOUNT,
            // The broker admits provider-scoped ids (`vendor/model`), which
            // is also what opencode's request body carries; the full
            // `openrouter/...` ref is only Floot's selection form.
            ...(spec.model ? { model: parseModelRef(spec.model) } : {}),
            networkPolicy: 'off',
          }),
        );
        authorityResources.add(() => E(grant).revoke());
        const [attestation, evidence] = await Promise.all([
          E(grant).attestation(),
          E(grant).sandboxEvidence(),
        ]);
        brokerEnv = harden({
          OPENCODE_BROKER_BASE_URL: `${attestation.endpoint}/api/v1`,
          OPENCODE_BROKER_CONTAINER: evidence.brokerSidecar.container,
        });
      }
      resources.add(() => cancelClient(sessionId));
      client = await provisionClient(sessionId, {
        mcp: {
          socketDir: bridge.socketDir,
          innerDir: bridge.innerDir,
          configPath: bridge.configPath,
        },
        network,
        ...(brokerEnv ? { brokerEnv } : {}),
        ...(spec.model ? { model: spec.model } : {}),
        ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
        ...(workspaceHostPath ? { workspaceHostPath } : {}),
      });
    } catch (error) {
      // Keep partial acquisition ownership even when rollback fails. Both
      // create and destroy retry this owner before touching the same session.
      sessions.retain(sessionId, releaseResources);
      try {
        await releaseResources();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'OpenCode session provisioning and rollback failed',
          { cause: error },
        );
      }
      throw error;
    }

    let terminated = false;
    // The client is stopped once; a retry after a refused teardown (an Endo
    // tool call still running host-side) resumes from there.
    let clientStopped = false;
    /** @type {Promise<void> | undefined} */
    let cleanupInFlight;
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
            // Cancellation is not evidence that the worker reaped its
            // processes. Keep this client owner for retry, while withdrawing
            // independent authority without cancelling its formula.
            try {
              await authorityResources.run();
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                'OpenCode client stop and authority cleanup remain pending',
                { cause: cleanupError },
              );
            }
            throw error;
          }
          clientStopped = true;
        }
        // A call that raced the check above is still running host-side; it has
        // to settle before the session is declared stopped.
        refuseUnsettled(bridge.pendingCalls());
        // Failed stages retain ownership; independent releases are still
        // attempted, so cancellation failure cannot suppress grant revocation.
        // Durable workspace and native state are retained.
        await releaseResources();
        terminated = true;
        sessions.release(sessionId, terminate);
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
        if (networkPolicy === 'off' && !broker) {
          // A refusal the operator can fix by setting the session policy. It is
          // reported as a leading abort — the stream contract for "the backend
          // never took the prompt" — so Floot records a clean failed turn
          // instead of an uncertain outcome, which would fence the session
          // until an operator resolved it.
          return readerFromIterator(
            (async function* refused() {
              yield {
                type: 'abort',
                reason:
                  'OpenCode session network policy is "off"; set the session policy to public-internet before sending a turn',
              };
            })(),
          );
        }
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
      await removeToolBridge(sessionId);
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
