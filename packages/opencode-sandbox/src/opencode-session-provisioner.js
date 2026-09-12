// @ts-check
/* global process */

/**
 * Programmatic opencode sandbox session provisioning (no inbox forms).
 * Shared by the hosted backend factory and setup scripts.
 *
 * @module
 */

import { rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { E } from '@endo/eventual-send';
import { Fail, makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import {
  makeSandboxSessionId,
  provisionOpencodeSession,
} from './provision-opencode-session.js';
import { toCurrentSpecifier } from './current-specifier.js';
import { DEFAULT_STATE_PROVIDER_NAME } from './opencode-state-provider.js';

const nodeFsModuleSpecifier = toCurrentSpecifier(
  new URL('../../platform/src/fs/extended/node-fs-module.js', import.meta.url)
    .href,
);

/**
 * Where per-session client formulas live on the host by default: a directory
 * the backend owns, beside the sandbox infrastructure `setup-host.js` mints.
 */
export const DEFAULT_SESSIONS_PATH = harden(['opencode-sandbox', 'sessions']);

const OpencodeSessionProvisionerInterface = M.interface(
  'OpencodeSessionProvisioner',
  {
    provision: M.callWhen(M.string()).optional(M.record()).returns(M.string()),
    lookup: M.callWhen(M.string()).returns(M.any()),
    cancel: M.callWhen(M.string()).returns(M.undefined()),
    remove: M.callWhen(M.string()).returns(M.undefined()),
    help: M.call().returns(M.string()),
  },
);

/**
 * @param {string} sessionId
 */
const assertSessionId = sessionId => {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(sessionId)) {
    throw makeError(X`Invalid Floot session id ${q(sessionId)}`);
  }
};

/**
 * Make a narrowly scoped service that can only provision opencode clients for
 * Floot session ids beneath one fixed sessions directory.
 *
 * @param {any} hostAgent
 * @param {{
 *   sessionsPath?: readonly string[],
 *   clientBase?: string,
 *   credentialsName: string,
 *   workspaceBaseDir: string,
 *   configBaseDir?: string,
 *   rootfs: string,
 *   network?: string,
 *   sandboxNamespace?: string,
 *   stateProviderName?: string,
 * }} config
 * @param {{
 *   makeFilesystem?: (name: string, directory: string) => Promise<void>,
 *   provisionSession?: typeof provisionOpencodeSession,
 *   removeDirectory?: typeof rm,
 * }} [powers]
 */
export const makeOpencodeSessionProvisioner = (
  hostAgent,
  config,
  powers = {},
) => {
  const {
    sessionsPath = DEFAULT_SESSIONS_PATH,
    clientBase,
    credentialsName,
    workspaceBaseDir,
    // Per-session opencode config dirs live in a sibling of the workspace
    // base by default, so a config layer stays apart from the user-facing
    // workspace (never a git worktree, never published).  The durable
    // session state itself lives on the host-backed state provider, not
    // here.
    configBaseDir = path.join(
      path.dirname(workspaceBaseDir),
      'opencode-configs',
    ),
    rootfs,
    network = 'private',
    sandboxNamespace = 'opencode-sandbox',
    stateProviderName = DEFAULT_STATE_PROVIDER_NAME,
  } = config;
  const makeFilesystem =
    powers.makeFilesystem ||
    (async (name, directory) => {
      await mkdir(directory, { recursive: true });
      await E(hostAgent).makeUnconfined('@main', nodeFsModuleSpecifier, {
        powersName: '@none',
        resultName: name,
        env: harden({ ENDO_FS_ROOT: directory }),
      });
    });
  const provisionSession = powers.provisionSession || provisionOpencodeSession;
  const removeDirectory = powers.removeDirectory || rm;
  /** @type {Map<string, Promise<string>>} */
  const inFlight = new Map();
  // The sandbox session id is deterministic from the Floot session id, so
  // re-provision, destroy-backstop, and future resume all address the same
  // state directory and slice names.

  const namesFor = sessionId => {
    assertSessionId(sessionId);
    const clientName = `${clientBase}-${sessionId}`;
    return harden({
      clientName,
      clientPath: harden([...sessionsPath, clientName]),
      filesystemName: `opencode-workspace-${sessionId}`,
      workspaceDir: path.join(workspaceBaseDir, sessionId),
      configFilesystemName: `opencode-config-${sessionId}`,
      configDir: path.join(configBaseDir, sessionId),
    });
  };

  // The sessions directory is created on first use so a fresh host needs no
  // setup step beyond minting the caplet that owns it.
  // Different session IDs share this namespace. makeDirectory replaces an
  // existing directory, so concurrent initializers must not both create it.
  /** @type {Promise<void> | undefined} */
  let sessionsDirectoryInFlight;
  const ensureSessionsDirectory = () => {
    if (!sessionsDirectoryInFlight) {
      sessionsDirectoryInFlight = (async () => {
        await null;
        if (!(await E(hostAgent).has(...sessionsPath))) {
          await E(hostAgent).makeDirectory([...sessionsPath]);
        }
      })().finally(() => {
        // Retry failed initialization and recheck externally removed names.
        sessionsDirectoryInFlight = undefined;
      });
    }
    return sessionsDirectoryInFlight;
  };

  /**
   * @param {string} sessionId
   * @param {{
   *   mcp?: {
   *     socketDir: string,
   *     innerDir?: string,
   *     configPath: string,
   *     socketName?: string,
   *     stdioBridgeName?: string,
   *     serverName?: string,
   *   },
   *   workspaceDir?: string,
   *   network?: 'none' | 'private',
   *   model?: string,
   *   systemPrompt?: string,
   *   opencodeSessionId?: string,
   *   turnTimeoutMs?: number,
   * }} [options]
   */
  const provisionOne = async (sessionId, options = {}) => {
    const {
      clientName,
      clientPath,
      filesystemName,
      workspaceDir,
      configFilesystemName,
      configDir,
    } = namesFor(sessionId);
    const { network: requestedNetwork } = options;
    if (requestedNetwork !== undefined) {
      ['none', 'private'].includes(requestedNetwork) ||
        Fail`Unknown network profile ${q(requestedNetwork)}`;
    }
    await ensureSessionsDirectory();
    if (await E(hostAgent).has(...clientPath)) {
      if (requestedNetwork === undefined) return clientName;
      const client = await E(hostAgent).lookup(clientPath);
      const status = await E(client)
        .status()
        .catch(() => ({}));
      if (status.network === undefined || status.network === requestedNetwork) {
        return clientName;
      }
      // A policy change must reincarnate the slice with the new profile.
      // Stop the live incarnation first so the successor cannot race its
      // mounts, then drop the formula; durable state and the recorded
      // opencode session survive (terminate keeps them).
      await E(client)
        .terminate()
        .catch(error => {
          console.error(
            `[opencode-sandbox] stop before network change failed for ${sessionId}:`,
            error instanceof Error ? error.message : String(error),
          );
        });
      await E(hostAgent).remove(...clientPath);
    }

    // A prior interrupted attempt may have left only the temporary pet names.
    if (await E(hostAgent).has(filesystemName)) {
      await E(hostAgent).remove(filesystemName);
    }
    if (await E(hostAgent).has(configFilesystemName)) {
      await E(hostAgent).remove(configFilesystemName);
    }
    // An override roots the session's workspace filesystem at an existing
    // host directory (e.g. a new-project git worktree) instead of the
    // private per-session scratch dir.  remove() still only deletes the
    // private default path, never the shared worktree.
    const filesystemDir = options.workspaceDir || workspaceDir;
    await makeFilesystem(filesystemName, filesystemDir);
    // The opencode config dir is ALWAYS the private per-session path, never
    // the workspace override: config must stay out of a shared/published
    // workspace.
    await makeFilesystem(configFilesystemName, configDir);
    const sandboxSessionId = makeSandboxSessionId(sessionId);
    await provisionSession(
      hostAgent,
      {
        name: clientName,
        filesystemName,
        configFilesystemName,
        configHostDir: configDir,
        credentialsName,
        rootfs,
        network: requestedNetwork || network,
        sandboxNamespace,
        stateProviderName,
        sandboxSessionId,
        // Forward the Endo tool bridge socket mount when the caller supplied one.
        ...(options.mcp ? { mcp: options.mcp } : {}),
        // Broker-only transport: the loopback endpoint and listener container
        // the client formula joins. Never includes a credential.
        ...(options.brokerEnv ? { brokerEnv: options.brokerEnv } : {}),
        // Pin the CLI to the session's selected OpenRouter model.
        ...(options.model ? { model: options.model } : {}),
        ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
        ...(options.opencodeSessionId
          ? { opencodeSessionId: options.opencodeSessionId }
          : {}),
        ...(options.turnTimeoutMs
          ? { turnTimeoutMs: options.turnTimeoutMs }
          : {}),
      },
      {
        resultName: clientPath,
        removeNames: [filesystemName, configFilesystemName],
      },
    );
    const stored = await E(hostAgent).has(...clientPath);
    stored ||
      Fail`OpenCode session provisioner did not store ${q(clientPath.join('/'))}.`;
    return clientName;
  };

  /**
   * Stop the session's live incarnation and delete its durable state via
   * the client's `destroy()` (which terminates first, then removes the
   * state directory through the provider that minted it).
   *
   * @param {string} sessionId
   */
  const destroyClient = async sessionId => {
    const { clientPath } = namesFor(sessionId);
    // A session that never provisioned has no client formula and no durable
    // state to delete; do not create the sessions directory to ask.
    if (!(await E(hostAgent).has(...sessionsPath))) return;
    if (!(await E(hostAgent).has(...clientPath))) return;
    const client = await E(hostAgent).lookup(clientPath);
    await E(client).destroy();
  };

  /**
   * Delete the session's durable state directly through the state provider
   * bound under the sandbox namespace.  This is the backstop for a destroy
   * whose client formula is unreachable (a pruned release, a broken client
   * module): the provider owns the directory and knows how to remove only
   * what it created.
   *
   * @param {string} sessionId
   */
  const removeSessionState = async sessionId => {
    const providerPath = sandboxNamespace
      ? [sandboxNamespace, stateProviderName]
      : [stateProviderName];
    if (!(await E(hostAgent).has(...providerPath))) return;
    const stateProvider = await E(hostAgent).lookup(providerPath);
    await E(stateProvider).removeSession(sessionId);
  };

  return makeExo(
    'OpencodeSessionProvisioner',
    OpencodeSessionProvisionerInterface,
    {
      async provision(sessionId, options = {}) {
        let result = inFlight.get(sessionId);
        if (!result) {
          result = provisionOne(sessionId, options).finally(() => {
            inFlight.delete(sessionId);
          });
          inFlight.set(sessionId, result);
        }
        return result;
      },
      /**
       * The session's OpencodeClient capability, or `undefined` when the
       * session has not been provisioned.
       *
       * @param {string} sessionId
       */
      async lookup(sessionId) {
        const { clientPath } = namesFor(sessionId);
        await inFlight.get(sessionId)?.catch(() => {});
        if (!(await E(hostAgent).has(...sessionsPath))) return undefined;
        if (!(await E(hostAgent).has(...clientPath))) return undefined;
        return E(hostAgent).lookup(clientPath);
      },
      /**
       * Stop the session's live incarnation without deleting it: the daemon
       * cancels the client formula, which tears down its slice, mounts, and
       * credential grant; durable workspace and state survive, and the next
       * `lookup` reincarnates it over the same host directories.
       *
       * @param {string} sessionId
       */
      async cancel(sessionId) {
        const { clientPath } = namesFor(sessionId);
        await inFlight.get(sessionId)?.catch(() => {});
        if (!(await E(hostAgent).has(...sessionsPath))) return;
        if (await E(hostAgent).has(...clientPath)) {
          await E(hostAgent).cancel(
            [...clientPath],
            Error(`OpenCode session ${sessionId} stopped`),
          );
        }
      },
      async remove(sessionId) {
        const {
          clientPath,
          filesystemName,
          workspaceDir,
          configFilesystemName,
          configDir,
        } = namesFor(sessionId);
        await inFlight.get(sessionId)?.catch(() => {});
        // Destroy through the live client first: its `destroy()` terminates
        // the incarnation and then deletes durable state through the state
        // provider (never a plain terminate/cancel).  Best-effort — the
        // formula may already be gone and the state directory already
        // deleted.
        try {
          await destroyClient(sessionId);
        } catch (error) {
          console.error(
            `[opencode-sandbox] direct destroy of session ${sessionId} failed; relying on formula removal:`,
            error instanceof Error ? error.message : String(error),
          );
        }
        if (
          (await E(hostAgent).has(...sessionsPath)) &&
          (await E(hostAgent).has(...clientPath))
        ) {
          await E(hostAgent).remove(...clientPath);
        }
        if (await E(hostAgent).has(filesystemName)) {
          await E(hostAgent).remove(filesystemName);
        }
        if (await E(hostAgent).has(configFilesystemName)) {
          await E(hostAgent).remove(configFilesystemName);
        }
        await removeDirectory(workspaceDir, { recursive: true, force: true });
        // The config dir is always the private per-session path, so it is
        // safe to delete outright (it is never a shared workspace/worktree).
        await removeDirectory(configDir, { recursive: true, force: true });
        // Backstop: delete durable state through the provider directly, so a
        // destroy whose client formula was unreachable still removes it.
        // Idempotent after the client's own destroy already deleted it.
        await removeSessionState(makeSandboxSessionId(sessionId));
      },
      help: () =>
        'OpencodeSessionProvisioner: provision(flootSessionId, options?) creates one isolated OpencodeClient, workspace, and config dir; lookup(id) returns the client; cancel(id) stops its live incarnation; remove(id) destroys the incarnation and its durable state.',
    },
  );
};
harden(makeOpencodeSessionProvisioner);

/**
 * Standalone caplet entry point (the hosted backend composes the provisioner
 * in-process instead).
 *
 * @param {any} hostAgent
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = (hostAgent, _context, { env = {} } = {}) => {
  const clientBase =
    env.OPENCODE_CLIENT_NAME ||
    process.env.ENDO_OPENCODE_CLIENT_NAME ||
    'opencode-client';
  const credentialsName =
    env.OPENCODE_CREDS_NAME ||
    process.env.ENDO_OPENCODE_CREDS_NAME ||
    'opencode-creds';
  const workspaceBaseDir =
    env.OPENCODE_WORKSPACE_BASE_DIR ||
    process.env.ENDO_OPENCODE_WORKSPACE_DIR ||
    path.join(os.homedir(), 'opencode-workspaces');
  const configBaseDir =
    env.OPENCODE_CONFIG_BASE_DIR ||
    process.env.ENDO_OPENCODE_CONFIG_DIR ||
    path.join(path.dirname(workspaceBaseDir), 'opencode-configs');
  const rootfs =
    env.OPENCODE_SANDBOX_IMAGE ||
    process.env.OPENCODE_SANDBOX_IMAGE ||
    process.env.ENDO_OPENCODE_SANDBOX_IMAGE ||
    'oci:localhost/opencode:latest';
  return makeOpencodeSessionProvisioner(hostAgent, {
    clientBase,
    credentialsName,
    workspaceBaseDir,
    configBaseDir,
    rootfs,
  });
};
harden(make);
