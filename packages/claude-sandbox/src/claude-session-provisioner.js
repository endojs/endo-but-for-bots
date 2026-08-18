// @ts-check
/* global process */

import { rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { makeExo } from '@endo/exo';
import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';
import { M } from '@endo/patterns';
import { mountAsFilesystem } from '@endo/platform/fs/extended';

import {
  provisionClaudeSession,
  resolveSandboxConfig,
} from './provision-claude-session.js';
import { toCurrentSpecifier } from './current-specifier.js';

const nodeFsModuleSpecifier = toCurrentSpecifier(
  new URL('../../platform/src/fs/extended/node-fs-module.js', import.meta.url)
    .href,
);

const ClaudeSessionProvisionerInterface = M.interface(
  'ClaudeSessionProvisioner',
  {
    provision: M.callWhen(M.string()).optional(M.record()).returns(M.string()),
    remove: M.callWhen(M.string()).returns(M.undefined()),
    provideContainerMountBridge: M.callWhen(M.record()).returns(M.record()),
    releaseContainerMountBridge: M.callWhen(M.string()).returns(M.undefined()),
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
 * Bridge keys name host-side artifacts (a mountpoint directory and a host
 * mount pet name), so they are constrained to the same safe alphabet as
 * session ids. The floot attach registrar derives them as content hashes of
 * (client identity, cap identity, inner path).
 */
const BRIDGE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

/**
 * @param {string} key
 * @returns {string}
 */
const assertBridgeKey = key => {
  if (typeof key !== 'string' || !BRIDGE_KEY_RE.test(key)) {
    throw makeError(X`Invalid container mount bridge key ${q(key)}`);
  }
  return key;
};

/**
 * Make a narrowly scoped service that can only provision Claude clients for
 * Floot session ids beneath one fixed controller profile.
 *
 * @param {any} hostAgent
 * @param {{
 *   flootDir: string,
 *   clientBase: string,
 *   credentialsName: string,
 *   workspaceBaseDir: string,
 *   configBaseDir?: string,
 *   rootfs: string,
 *   network?: string,
 *   sandboxNamespace?: string,
 *   fsMounterName?: string,
 *   attachMountBaseDir?: string,
 * }} config
 * @param {{
 *   makeFilesystem?: (name: string, directory: string) => Promise<void>,
 *   provisionSession?: typeof provisionClaudeSession,
 *   removeDirectory?: typeof rm,
 *   getFsMounter?: () => Promise<any>,
 * }} [powers]
 */
export const makeClaudeSessionProvisioner = (
  hostAgent,
  config,
  powers = {},
) => {
  const {
    flootDir,
    clientBase,
    credentialsName,
    workspaceBaseDir,
    // Per-session Claude config dirs live in a sibling of the workspace base by
    // default, so the persistent conversation transcript is stored apart from
    // the user-facing workspace (never a git worktree, never published).
    configBaseDir = path.join(path.dirname(workspaceBaseDir), 'claude-configs'),
    rootfs,
    network = 'private',
    sandboxNamespace = 'claude-sandbox',
    fsMounterName = resolveSandboxConfig({}).fsMounterName,
    // Host directory for runtime-attach 9P mountpoints
    // (designs/runtime-container-fs-mount.md). The HOST picks this layout;
    // session guests only ever choose slice-internal paths under /mnt/.
    attachMountBaseDir = resolveSandboxConfig({}).mountBaseDir,
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
  const provisionSession = powers.provisionSession || provisionClaudeSession;
  const removeDirectory = powers.removeDirectory || rm;
  // `lookup` takes ONE name-or-path argument, so a namespaced mounter has to
  // arrive as a path array rather than as two arguments — the same shape
  // `underNamespace` produces for every other resolution in this package.
  const getFsMounter =
    powers.getFsMounter ||
    (() =>
      E(hostAgent).lookup(
        sandboxNamespace ? [sandboxNamespace, fsMounterName] : fsMounterName,
      ));
  /** @type {Map<string, Promise<string>>} */
  const inFlight = new Map();

  // Live runtime-attach bridges (designs/runtime-container-fs-mount.md),
  // keyed by the caller-derived bridge key. Worker-local: after a daemon
  // restart the floot registrar replays each persisted attach through
  // `provideContainerMountBridge`, which re-mounts 9P at the same
  // deterministic mountpoint and re-registers the same host mount pet name
  // (overwriting orphans the prior formula for GC — the same story as the
  // per-session workspace mount replay). The cap identity and mode are
  // remembered so a cached bridge is never served for a request it does not
  // match (a stale entry left by a swallowed release, say).
  /** @type {Map<string, { mountCap: any, handle: any, capId: string, mode: string }>} */
  const bridges = new Map();

  // Serialize bridge operations per key: without this, two concurrent
  // provides for one key would both miss the cache and stack two 9P mounts
  // on one mountpoint (leaking the loser), and a release racing a provide
  // could remove the pet name the provide just registered — cancelling the
  // fresh Mount formula while the cache still points at it.
  /** @type {Map<string, Promise<unknown>>} */
  const bridgeChains = new Map();
  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const withBridgeKeyLock = (key, fn) => {
    const prior = bridgeChains.get(key) || Promise.resolve();
    const run = prior.then(fn, fn);
    const tail = run.catch(() => {});
    bridgeChains.set(key, tail);
    // Drop the chain entry once idle so the map stays bounded by live work.
    tail.then(() => {
      if (bridgeChains.get(key) === tail) {
        bridgeChains.delete(key);
      }
    });
    return run;
  };

  const attachMountName = (/** @type {string} */ key) => `claude-attach-${key}`;

  /**
   * Resolve a session-held cap to a `Filesystem` the `@endo/9p-server`
   * mounter can serve. The 9P bridge serves THROUGH the cap, so every
   * attenuation the cap carries (read-only views, denied segments,
   * subdirectory scoping) stays enforced — the cap is the policy; the host
   * never re-derives file authority from a raw host path.
   *
   * @param {any} cap
   * @returns {Promise<any>}
   */
  const resolveServeableFilesystem = async cap => {
    await null;
    /** @type {string[]} */
    let methods;
    try {
      // eslint-disable-next-line no-underscore-dangle
      methods = await E(cap).__getMethodNames__();
    } catch {
      throw makeError(
        X`attach: capability does not support introspection; expected an EndoGit, Mount, or Filesystem capability`,
      );
    }
    if (methods.includes('worktree')) {
      // EndoGit: serve its worktree so in-slice `git` reads, edits, and
      // commits on the same tree the cap represents. A read-only git yields
      // a read-only worktree view and writes fail at the cap.
      const worktree = await E(cap).worktree();
      return mountAsFilesystem(worktree);
    }
    if (methods.includes('root') && methods.includes('statfs')) {
      // Already an endo-fs `Filesystem`.
      return cap;
    }
    if (methods.includes('readText') && methods.includes('entry')) {
      // Daemon `Mount` (or a mount-shaped view such as `readOnly()`).
      return mountAsFilesystem(cap);
    }
    throw makeError(
      X`attach: capability is not filesystem-like (methods: ${q(methods.join(', '))})`,
    );
  };

  /**
   * @param {{ key: string, capId: string, mode?: string }} options
   */
  const provideBridge = ({ key, capId, mode = 'rw' }) => {
    assertBridgeKey(key);
    if (mode !== 'ro' && mode !== 'rw') {
      throw makeError(X`attach: mode must be "ro" or "rw", got ${q(mode)}`);
    }
    if (typeof capId !== 'string' || capId === '') {
      throw makeError(X`attach: capId must be a non-empty string`);
    }
    return withBridgeKeyLock(key, async () => {
      await null;
      const existing = bridges.get(key);
      if (existing) {
        if (existing.capId === capId && existing.mode === mode) {
          return harden({
            mountCap: existing.mountCap,
            handle: existing.handle,
          });
        }
        // A cached bridge that does not match the request (a swallowed
        // release left it behind, or the attach's mode changed) must not be
        // served: its kernel mount and Mount cap enforce the WRONG mode.
        // Tear it down and mint afresh.
        bridges.delete(key);
        await E(existing.handle)
          .unmount()
          .catch(() => {});
      }
      const readOnly = mode === 'ro';
      const cap = await E(hostAgent).lookupById(capId);
      const fs = await resolveServeableFilesystem(cap);
      const mountPoint = path.join(attachMountBaseDir, attachMountName(key));
      const fsMounter = await getFsMounter();
      // Belt and braces: a read-only attach is enforced at the kernel mount
      // (`ro`), at the daemon Mount cap (`readOnly`), and at the slice bind
      // (the registrar passes the mode through to the bind list too).
      const handle = await E(fsMounter).mount(
        fs,
        mountPoint,
        harden({ lazyUnmount: true, readOnly }),
      );
      try {
        const mountCap = await E(hostAgent).provideMount(
          mountPoint,
          attachMountName(key),
          harden({ readOnly }),
        );
        bridges.set(key, harden({ mountCap, handle, capId, mode }));
        return harden({ mountCap, handle });
      } catch (error) {
        await E(handle)
          .unmount()
          .catch(() => {});
        throw error;
      }
    });
  };

  /**
   * @param {string} key
   */
  const releaseBridge = key => {
    assertBridgeKey(key);
    return withBridgeKeyLock(key, async () => {
      await null;
      const bridge = bridges.get(key);
      bridges.delete(key);
      if (bridge) {
        await E(bridge.handle)
          .unmount()
          .catch(() => {});
      }
      if (await E(hostAgent).has(attachMountName(key))) {
        await E(hostAgent).remove(attachMountName(key));
      }
    });
  };

  const namesFor = sessionId => {
    assertSessionId(sessionId);
    const clientName = `${clientBase}-${sessionId}`;
    return harden({
      clientName,
      clientPath: harden([flootDir, 'controller-profile', clientName]),
      filesystemName: `claude-workspace-${sessionId}`,
      workspaceDir: path.join(workspaceBaseDir, sessionId),
      configFilesystemName: `claude-config-${sessionId}`,
      configDir: path.join(configBaseDir, sessionId),
    });
  };

  /**
   * @param {string} sessionId
   * @param {{
   *   mcp?: { socketDir: string, innerDir?: string, configPath: string },
   *   workspaceDir?: string,
   *   model?: string,
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
    if (await E(hostAgent).has(...clientPath)) return clientName;

    // A prior interrupted attempt may have left only the temporary pet names.
    if (await E(hostAgent).has(filesystemName)) {
      await E(hostAgent).remove(filesystemName);
    }
    if (await E(hostAgent).has(configFilesystemName)) {
      await E(hostAgent).remove(configFilesystemName);
    }
    // An override roots the session's workspace filesystem at an existing host
    // directory (e.g. a new-project git worktree) instead of the private
    // per-session scratch dir, so the CLI and the guest's workspace cap share
    // files. remove() still only deletes the private default path, never the
    // shared worktree (owned by the git/scratch mount's daemon GC).
    const filesystemDir = options.workspaceDir || workspaceDir;
    await makeFilesystem(filesystemName, filesystemDir);
    // The Claude config dir is ALWAYS the private per-session path, never the
    // workspace override — the conversation transcript must stay out of a
    // shared/published workspace, and it must persist across daemon restarts.
    await makeFilesystem(configFilesystemName, configDir);
    await provisionSession(
      hostAgent,
      {
        name: clientName,
        filesystemName,
        configFilesystemName,
        configHostDir: configDir,
        credentialsName,
        rootfs,
        network,
        sandboxNamespace,
        // Forward the Endo tool bridge socket mount when the caller supplied one.
        ...(options.mcp ? { mcp: options.mcp } : {}),
        // Pin the CLI to the session's selected Anthropic model.
        ...(options.model ? { model: options.model } : {}),
      },
      {
        resultName: clientPath,
        removeNames: [filesystemName, configFilesystemName],
      },
    );
    if (!(await E(hostAgent).has(...clientPath))) {
      throw new Error(
        `Claude session provisioner did not store "${clientPath.join('/')}".`,
      );
    }
    return clientName;
  };

  return makeExo(
    'ClaudeSessionProvisioner',
    ClaudeSessionProvisionerInterface,
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
      async remove(sessionId) {
        const {
          clientPath,
          filesystemName,
          workspaceDir,
          configFilesystemName,
          configDir,
        } = namesFor(sessionId);
        await inFlight.get(sessionId)?.catch(() => {});
        if (await E(hostAgent).has(...clientPath)) {
          await E(hostAgent).remove(...clientPath);
        }
        if (await E(hostAgent).has(filesystemName)) {
          await E(hostAgent).remove(filesystemName);
        }
        if (await E(hostAgent).has(configFilesystemName)) {
          await E(hostAgent).remove(configFilesystemName);
        }
        await removeDirectory(workspaceDir, { recursive: true, force: true });
        // The config dir is always the private per-session path, so it is safe
        // to delete outright (it is never a shared workspace/worktree).
        await removeDirectory(configDir, { recursive: true, force: true });
      },
      /**
       * Bridge a cap over 9P for a runtime container attach
       * (designs/runtime-container-fs-mount.md): resolve the cap by
       * formula id, project it as a `Filesystem`, mount it at a
       * host-picked mountpoint, and register the mountpoint as a daemon
       * `Mount` cap the sandbox slice can bind. Idempotent per key —
       * replaying a persisted attach after a daemon restart re-mounts the
       * same deterministic host layout.
       *
       * @param {Record<string, any>} options - `{ key, capId, mode? }`
       *   (the interface guard admits any copyRecord; `provideBridge`
       *   validates each field).
       */
      async provideContainerMountBridge(options) {
        const { key, capId, mode } = options;
        return provideBridge({ key, capId, mode });
      },

      /**
       * Tear down a bridge minted by `provideContainerMountBridge`:
       * unmount the 9P mount and drop the host mount pet name. Called by
       * the floot attach registrar when the last session reference to an
       * attach goes away — AFTER the slice was recreated without the
       * bind, so the unmount does not race a live container.
       *
       * @param {string} key
       */
      async releaseContainerMountBridge(key) {
        await releaseBridge(key);
      },

      help: () =>
        'ClaudeSessionProvisioner: provision(flootSessionId) creates one isolated ClaudeClient and workspace; remove(flootSessionId) tears them down; provideContainerMountBridge({key, capId, mode})/releaseContainerMountBridge(key) bridge session-held caps over 9P for runtime container attaches.',
    },
  );
};
harden(makeClaudeSessionProvisioner);

/**
 * @param {any} hostAgent
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = (hostAgent, _context, { env = {} } = {}) => {
  const flootDir = env.FLOOT_DIR || process.env.ENDO_FLOOT_DIR || 'floot';
  const clientBase =
    env.CLAUDE_CLIENT_NAME ||
    process.env.ENDO_CLAUDE_CLIENT_NAME ||
    'claude-client';
  const credentialsName =
    env.CLAUDE_CREDS_NAME ||
    process.env.ENDO_CLAUDE_CREDS_NAME ||
    'claude-creds';
  const workspaceBaseDir =
    env.CLAUDE_WORKSPACE_BASE_DIR ||
    process.env.ENDO_CLAUDE_WORKSPACE_DIR ||
    path.join(os.homedir(), 'claude-workspaces');
  const configBaseDir =
    env.CLAUDE_CONFIG_BASE_DIR ||
    process.env.ENDO_CLAUDE_CONFIG_DIR ||
    path.join(path.dirname(workspaceBaseDir), 'claude-configs');
  const rootfs =
    env.CLAUDE_SANDBOX_IMAGE ||
    process.env.CLAUDE_SANDBOX_IMAGE ||
    process.env.ENDO_CLAUDE_SANDBOX_IMAGE ||
    'oci:localhost/claude-code:latest';
  return makeClaudeSessionProvisioner(hostAgent, {
    flootDir,
    clientBase,
    credentialsName,
    workspaceBaseDir,
    configBaseDir,
    rootfs,
  });
};
harden(make);
