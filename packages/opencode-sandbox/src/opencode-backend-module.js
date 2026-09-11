// @ts-check
/* global process */

/**
 * The `opencode-backend` caplet: a Floot hosted backend factory for the
 * opencode runtime, minted by `setup-hosted.js` with `@agent` host powers and
 * bound into the Floot controller profile under the conventional
 * `opencode-backend` name Floot's factory discovers.
 *
 * It composes the per-session provisioner
 * (`opencode-session-provisioner.js`) with the MCP tool bridge
 * (`mcp-bridge.js` over `mcp-socket-server.js`) and the hard-coded model
 * catalog and hands them to `makeOpencodeBackendFactory`. Floot only ever
 * holds the guarded factory facet; the host powers this caplet runs with
 * never cross that boundary.
 *
 * Formula env (all optional; `process.env` `ENDO_`-spellings are fallbacks):
 *   OPENCODE_CLIENT_NAME        Pet-name base for per-session clients.
 *   OPENCODE_CREDS_NAME         OpenCodeCredentials cap name (default
 *                               opencode-creds).
 *   OPENCODE_WORKSPACE_BASE_DIR Host base directory for per-session
 *                               workspaces.
 *   OPENCODE_CONFIG_BASE_DIR    Host base directory for per-session config
 *                               dirs.
 *   OPENCODE_SANDBOX_IMAGE      OCI rootfs for the slice.
 *   OPENCODE_MCP_DIR            Host base directory for per-session MCP
 *                               sockets.
 *   OPENCODE_BROKER_LISTENER_IMAGE  Digest-pinned provider-listener image.
 *                               When set, `off` sessions run broker-only;
 *                               when absent they keep the refusal path.
 *   OPENCODE_BROKER_DIR         Private host directory for listener state.
 *   OPENCODE_BROKER_OWNER_ID    Cleanup scope for listener containers.
 *
 * @module
 */

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';

import { parseModelRef } from './opencode-agent-config.js';
import { makeOpencodeBroker } from './opencode-broker.js';
import {
  makeOpencodeBackendFactory,
  OPENCODE_MODELS,
} from './opencode-backend-factory.js';
import { makeOpencodeSessionProvisioner } from './opencode-session-provisioner.js';
import { makeMcpBridgeForToolSet } from './mcp-bridge.js';
import { startMcpSocketServer } from './mcp-socket-server.js';

// One provider-listener runtime per daemon worker, shared by every backend
// incarnation. The backend caplet is both revived (an existing formula) and
// re-minted (setup-hosted) in the same process; composing a second runtime for
// the same owner would fail its exclusive owner lock. The runtime's stale-owner
// recovery sweeps containers left by a previous daemon process.
/** @type {Map<string, Promise<any>>} */
const brokerCompositions = new Map();

/**
 * Share one in-flight composition per key, and let a failed composition be
 * retried instead of poisoning every later attempt.
 *
 * @template T
 * @param {Map<string, Promise<T>>} cache
 * @param {string} key
 * @param {() => Promise<T>} factory
 * @returns {Promise<T>}
 */
export const memoizeBrokerComposition = (cache, key, factory) => {
  if (!cache.has(key)) {
    cache.set(
      key,
      factory().catch(error => {
        cache.delete(key);
        throw error;
      }),
    );
  }
  return /** @type {Promise<T>} */ (cache.get(key));
};
harden(memoizeBrokerComposition);

/**
 * Resolve the provisioner configuration from the formula env and the daemon's
 * environment.
 *
 * @param {Record<string, string>} env
 */
export const resolveBackendConfig = env => {
  const workspaceBaseDir =
    env.OPENCODE_WORKSPACE_BASE_DIR ||
    process.env.ENDO_OPENCODE_WORKSPACE_DIR ||
    path.join(os.homedir(), 'opencode-workspaces');
  const brokerDir =
    env.OPENCODE_BROKER_DIR ||
    process.env.ENDO_OPENCODE_BROKER_DIR ||
    path.join(os.homedir(), 'opencode-broker');
  return harden({
    clientBase:
      env.OPENCODE_CLIENT_NAME ||
      process.env.ENDO_OPENCODE_CLIENT_NAME ||
      'opencode-client',
    credentialsName:
      env.OPENCODE_CREDS_NAME ||
      process.env.ENDO_OPENCODE_CREDS_NAME ||
      'openrouter-auth',
    workspaceBaseDir,
    configBaseDir:
      env.OPENCODE_CONFIG_BASE_DIR ||
      process.env.ENDO_OPENCODE_CONFIG_DIR ||
      path.join(path.dirname(workspaceBaseDir), 'opencode-configs'),
    rootfs:
      env.OPENCODE_SANDBOX_IMAGE ||
      process.env.ENDO_OPENCODE_SANDBOX_IMAGE ||
      'oci:localhost/opencode-sandbox:latest',
    // The socket directory path is stable per session: the persisted client
    // formula's read-only mount records it, so a revival after a daemon
    // restart must find the new listener at the same path.
    mcpBaseDir:
      env.OPENCODE_MCP_DIR ||
      process.env.ENDO_OPENCODE_MCP_DIR ||
      path.join(os.homedir(), 'opencode-mcp'),
    broker: {
      listenerImageRef:
        env.OPENCODE_BROKER_LISTENER_IMAGE ||
        process.env.ENDO_OPENCODE_BROKER_LISTENER_IMAGE ||
        '',
      directory: brokerDir,
      ownerId:
        env.OPENCODE_BROKER_OWNER_ID ||
        process.env.ENDO_OPENCODE_BROKER_OWNER_ID ||
        '',
    },
  });
};
harden(resolveBackendConfig);

const execFile = promisify(execFileCallback);

/**
 * Resolve a local OCI image reference to its immutable digest form. A
 * policy-free broker lease still binds the lease attestation to the exact
 * slice image, so setup must pin what podman actually resolved rather than
 * trusting a mutable tag.
 *
 * @param {string} rootfs - Config rootfs (`oci:<image>` or already pinned).
 * @param {(file: string, args: string[]) => Promise<{ stdout: string }>} [exec]
 * @returns {Promise<{ imageRef: string, imageDigest: string }>}
 */
export const resolvePinnedImageRef = async (rootfs, exec = execFile) => {
  const image = rootfs.startsWith('oci:') ? rootfs.slice(4) : rootfs;
  // A leading dash would be parsed as a podman option rather than an image.
  image.startsWith('-') && Fail`Invalid OpenCode sandbox image ${q(image)}`;
  if (image.includes('@sha256:')) {
    const imageDigest = image.slice(image.indexOf('@') + 1);
    /^sha256:[a-f0-9]{64}$/.test(imageDigest) ||
      Fail`OpenCode sandbox image digest is invalid, got ${q(imageDigest)}`;
    return harden({ imageRef: image, imageDigest });
  }
  const { stdout } = await exec('podman', [
    'image',
    'inspect',
    '--format',
    '{{.Digest}}',
    image,
  ]);
  const imageDigest = stdout.trim();
  /^sha256:[a-f0-9]{64}$/.test(imageDigest) ||
    Fail`Cannot resolve a digest for OpenCode sandbox image ${q(image)}; build it before setup-hosted`;
  return harden({ imageRef: `${image}@${imageDigest}`, imageDigest });
};
harden(resolvePinnedImageRef);

/**
 * Caplet entry point.
 *
 * @param {any} hostAgent - `@agent` host powers.
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = async (hostAgent, _context, { env = {} } = {}) => {
  const {
    clientBase,
    credentialsName,
    workspaceBaseDir,
    configBaseDir,
    rootfs,
    mcpBaseDir,
    broker: brokerConfig,
  } = resolveBackendConfig(env);
  // Broker-only egress is composed here, in the same @agent context that
  // mints the backend. Setting the listener image opts in; every failure is
  // fatal so a half-configured broker never becomes a silently weaker path.
  // The slice and the lease must name the same image, so a tag is resolved
  // once and both use the pinned ref.
  let broker = null;
  let sliceRootfs = rootfs;
  if (brokerConfig.listenerImageRef !== '') {
    const { imageRef, imageDigest } = await resolvePinnedImageRef(rootfs);
    sliceRootfs = `oci:${imageRef}`;
    let ownerId = brokerConfig.ownerId;
    if (!ownerId) {
      const hostId = await E(hostAgent).identify('@agent');
      (typeof hostId === 'string' && hostId.length > 0) ||
        Fail`Cannot identify the OpenCode broker host`;
      ownerId = `opencode-${createHash('sha256').update(hostId).digest('hex').slice(0, 48)}`;
    }
    const compositionKey = JSON.stringify({
      ownerId,
      directory: brokerConfig.directory,
      listenerImageRef: brokerConfig.listenerImageRef,
      imageRef,
      imageDigest,
    });
    const composed = await memoizeBrokerComposition(
      brokerCompositions,
      compositionKey,
      async () => {
        // Resolved only on a cache miss: a shared composition must not depend
        // on a secret lookup that a later make would otherwise repeat.
        const secret = await E(hostAgent).lookup(['secrets', credentialsName]);
        return makeOpencodeBroker({
          secret,
          ownerId,
          directory: brokerConfig.directory,
          imageRef,
          imageDigest,
          listenerImageRef: brokerConfig.listenerImageRef,
          // The broker admits the provider-scoped ids opencode's request
          // bodies carry, not Floot's `openrouter/...` selection refs.
          models: OPENCODE_MODELS.map(model => parseModelRef(model.id)),
        });
      },
    );
    broker = composed.issuer;
    // Deliberately no dispose on formula cancellation: the composition is
    // process-scoped and shared, and a cancelled formula may be immediately
    // re-minted. Containers left by a dead daemon are swept by the runtime's
    // stale-owner recovery on the next start.
  }

  const provisioner = makeOpencodeSessionProvisioner(hostAgent, {
    clientBase,
    credentialsName,
    workspaceBaseDir,
    configBaseDir,
    rootfs: sliceRootfs,
  });
  const socketDirFor = sessionId => path.join(mcpBaseDir, sessionId);

  return makeOpencodeBackendFactory({
    ...(broker ? { broker } : {}),
    provisionClient: async (sessionId, options) => {
      // The factory carries the Floot-side `workspaceHostPath`; the
      // provisioner names the same override `workspaceDir`.
      const { workspaceHostPath, ...rest } = options;
      await E(provisioner).provision(
        sessionId,
        harden({
          ...rest,
          ...(workspaceHostPath ? { workspaceDir: workspaceHostPath } : {}),
        }),
      );
      return E(provisioner).lookup(sessionId);
    },
    cancelClient: sessionId => E(provisioner).cancel(sessionId),
    removeSession: sessionId => E(provisioner).remove(sessionId),
    startToolBridge: async (sessionId, toolSet) => {
      const bridge = await makeMcpBridgeForToolSet(toolSet);
      const server = await startMcpSocketServer({
        socketDir: socketDirFor(sessionId),
        bridge,
      });
      return harden({
        socketDir: server.socketDir,
        innerDir: server.innerDir,
        configPath: server.innerConfigPath,
        pendingCalls: bridge.pendingCalls,
        close: server.close,
      });
    },
    removeToolBridge: async sessionId => {
      await rm(socketDirFor(sessionId), { recursive: true, force: true });
    },
  });
};
harden(make);
