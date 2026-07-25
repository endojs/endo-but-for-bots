// @ts-check
/* global process */

import { rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { makeExo } from '@endo/exo';
import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';
import { M } from '@endo/patterns';

import { provisionClaudeSession } from './provision-claude-session.js';

const nodeFsModuleSpecifier = new URL(
  '../../platform/src/fs/extended/node-fs-module.js',
  import.meta.url,
).href;

const ClaudeSessionProvisionerInterface = M.interface(
  'ClaudeSessionProvisioner',
  {
    provision: M.callWhen(M.string()).optional(M.record()).returns(M.string()),
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
 * Make a narrowly scoped service that can only provision Claude clients for
 * Floot session ids beneath one fixed controller profile.
 *
 * @param {any} hostAgent
 * @param {{
 *   flootDir: string,
 *   clientBase: string,
 *   credentialsName: string,
 *   workspaceBaseDir: string,
 *   rootfs: string,
 *   network?: string,
 *   sandboxNamespace?: string,
 * }} config
 * @param {{
 *   makeFilesystem?: (name: string, directory: string) => Promise<void>,
 *   provisionSession?: typeof provisionClaudeSession,
 *   removeDirectory?: typeof rm,
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
    rootfs,
    network = 'private',
    sandboxNamespace = 'claude-sandbox',
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
  /** @type {Map<string, Promise<string>>} */
  const inFlight = new Map();

  const namesFor = sessionId => {
    assertSessionId(sessionId);
    const clientName = `${clientBase}-${sessionId}`;
    return harden({
      clientName,
      clientPath: harden([flootDir, 'controller-profile', clientName]),
      filesystemName: `claude-workspace-${sessionId}`,
      workspaceDir: path.join(workspaceBaseDir, sessionId),
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
    const { clientName, clientPath, filesystemName, workspaceDir } =
      namesFor(sessionId);
    if (await E(hostAgent).has(...clientPath)) return clientName;

    // A prior interrupted attempt may have left only the temporary pet name.
    if (await E(hostAgent).has(filesystemName)) {
      await E(hostAgent).remove(filesystemName);
    }
    // An override roots the session's workspace filesystem at an existing host
    // directory (e.g. a new-project git worktree) instead of the private
    // per-session scratch dir, so the CLI and the guest's workspace cap share
    // files. remove() still only deletes the private default path, never the
    // shared worktree (owned by the git/scratch mount's daemon GC).
    const filesystemDir = options.workspaceDir || workspaceDir;
    await makeFilesystem(filesystemName, filesystemDir);
    await provisionSession(
      hostAgent,
      {
        name: clientName,
        filesystemName,
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
        removeNames: [filesystemName],
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
        const { clientPath, filesystemName, workspaceDir } =
          namesFor(sessionId);
        await inFlight.get(sessionId)?.catch(() => {});
        if (await E(hostAgent).has(...clientPath)) {
          await E(hostAgent).remove(...clientPath);
        }
        if (await E(hostAgent).has(filesystemName)) {
          await E(hostAgent).remove(filesystemName);
        }
        await removeDirectory(workspaceDir, { recursive: true, force: true });
      },
      help: () =>
        'ClaudeSessionProvisioner: provision(flootSessionId) creates one isolated ClaudeClient and workspace; remove(flootSessionId) tears them down.',
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
    rootfs,
  });
};
harden(make);
