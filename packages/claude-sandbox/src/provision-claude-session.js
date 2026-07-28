// @ts-check
/* global process */

/**
 * Programmatic Claude sandbox session provisioning (no inbox forms).
 * Shared by setup-hosted.js and the sandbox factory caplet.
 *
 * @module
 */

import os from 'node:os';
import nodePath from 'node:path';

import { E } from '@endo/eventual-send';

import { parseRootfs, rootfsLabel } from './parse-rootfs.js';
import { toCurrentSpecifier } from './current-specifier.js';

const clientModuleSpecifier = toCurrentSpecifier(
  new URL('./claude-client-module.js', import.meta.url).href,
);

const SANDBOX_WORKSPACE_PATH = '/workspace';
// Slice-internal mount path for the persistent Claude config dir (also
// CLAUDE_CONFIG_DIR). Deliberately outside /workspace so the transcript never
// leaks into a new-project git worktree or a `publishWorkspace` static site.
const SANDBOX_CONFIG_PATH = '/claude-config';

const ALLOWED_NETWORKS = harden(['none', 'private']);

/** @type {number} */
let sessionCounter = 0;

/**
 * @param {Array<{ mountPoint: string, mountName: string }>} mounts - The
 *   (mountPoint, mountName) pairs this session may `provideMount`/`removeMount`.
 *   Always the workspace; plus the persistent Claude config dir when one was
 *   provisioned.
 * @param {boolean} hasCredentials
 * @param {boolean} [hasMcpMount] - whether an `mcpMount` cap is bundled by
 *   reference into the powers (the Endo tool bridge socket directory).
 * @param {boolean} [hasConfigFilesystem] - whether a dedicated persistent
 *   config `Filesystem` cap is bundled by reference (enables cross-restart
 *   conversation persistence).
 * @returns {string}
 */
export const buildSessionPowersSource = (
  mounts,
  hasCredentials,
  hasMcpMount = false,
  hasConfigFilesystem = false,
) => `makeExo(
  'ClaudeSessionPowers',
  M.interface('ClaudeSessionPowers', {
    sandboxFactory: M.call().returns(M.any()),
    fsMounter: M.call().returns(M.any()),
    filesystem: M.call().returns(M.any()),
    configFilesystem: M.call().returns(M.any()),
    credentials: M.call().returns(M.any()),
    mcpMount: M.call().returns(M.any()),
    provideMount: M.call(M.string(), M.string()).returns(M.promise()),
    removeMount: M.call().returns(M.promise()),
    help: M.call().returns(M.string()),
  }),
  {
    sandboxFactory: () => sandboxFactory,
    fsMounter: () => fsMounter,
    filesystem: () => filesystem,
    configFilesystem: () => ${hasConfigFilesystem ? 'configFilesystem' : 'null'},
    credentials: () => ${hasCredentials ? 'credentials' : 'null'},
    mcpMount: () => ${hasMcpMount ? 'mcpMount' : 'null'},
    provideMount: (path, name) => {
      const allowed = ${JSON.stringify(
        mounts.map(m => [m.mountPoint, m.mountName]),
      )};
      if (!allowed.some(pair => pair[0] === path && pair[1] === name)) {
        throw Error('claude-sandbox session powers: provideMount restricted to this session mountpoints');
      }
      return E(agent).provideMount(path, name);
    },
    removeMount: () =>
      Promise.allSettled(
        ${JSON.stringify(
          mounts.map(m => m.mountName),
        )}.map(name => E(agent).remove(name)),
      ),
    help: () =>
      'Per-session claude-sandbox powers: sandboxFactory/fsMounter/filesystem/configFilesystem/credentials/mcpMount accessors + provideMount/removeMount bounded to this session mounts. No lookup.',
  },
)`;

/**
 * @param {string} name
 */
const slugify = name =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'claude';

/**
 * @param {string} sandboxNamespace
 * @param {string} name
 * @returns {string | string[]}
 */
const underNamespace = (sandboxNamespace, name) =>
  sandboxNamespace ? [sandboxNamespace, name] : name;

/**
 * Resolve hosted sandbox configuration from caplet formula env and process env.
 *
 * @param {Record<string, string>} [formulaEnv]
 */
export const resolveSandboxConfig = (formulaEnv = {}) => ({
  sandboxFactoryName:
    formulaEnv.SANDBOX_FACTORY_NAME ||
    process.env.SANDBOX_FACTORY_NAME ||
    'sandbox-factory',
  fsMounterName:
    formulaEnv.FS_MOUNTER_NAME || process.env.FS_MOUNTER_NAME || 'fs-mounter',
  sandboxNamespace:
    formulaEnv.SANDBOX_NAMESPACE || process.env.SANDBOX_NAMESPACE || '',
  backend:
    formulaEnv.CLAUDE_SANDBOX_BACKEND ||
    process.env.CLAUDE_SANDBOX_BACKEND ||
    'podman',
  defaultImage:
    formulaEnv.CLAUDE_SANDBOX_IMAGE ||
    process.env.CLAUDE_SANDBOX_IMAGE ||
    undefined,
  mountBaseDir:
    formulaEnv.CLAUDE_SANDBOX_MOUNT_DIR ||
    process.env.CLAUDE_SANDBOX_MOUNT_DIR ||
    os.tmpdir(),
});

/**
 * @param {any} hostAgent
 * @param {object} spec
 * @param {string} spec.name
 * @param {string|string[]} spec.filesystemName
 * @param {string|string[]} [spec.configFilesystemName] - A dedicated
 *   persistent `Filesystem` cap for the Claude config dir. When present, the
 *   client mounts it at `/claude-config` and points CLAUDE_CONFIG_DIR there, so
 *   the conversation transcript survives daemon restarts.
 * @param {string} [spec.configHostDir] - Plain host backing directory of
 *   `configFilesystemName`, forwarded to the client so it can detect a
 *   pre-restart transcript and resume it.
 * @param {string|string[]|null} [spec.credentialsName]
 * @param {string} [spec.rootfs]
 * @param {string} [spec.network]
 * @param {string} [spec.model]
 * @param {string} [spec.initialPrompt]
 * @param {string} [spec.sandboxNamespace]
 * @param {Record<string, string>} [spec.formulaEnv]
 * @param {{ socketDir: string, innerDir?: string, configPath: string }} [spec.mcp]
 *   - Endo tool bridge: bind `socketDir` read-only at `innerDir` (default
 *   `/endo-mcp`) inside the slice and point Claude at `configPath` (the
 *   slice-internal mcp.json). Provided by @endo/floot's per-session MCP server.
 * @param {{ resultName?: string|string[], removeNames?: (string|string[])[] }} [opts]
 */
export const provisionClaudeSession = async (
  hostAgent,
  spec,
  { resultName, removeNames = [] } = {},
) => {
  const {
    name,
    filesystemName,
    configFilesystemName = null,
    configHostDir = '',
    credentialsName = null,
    rootfs: rootfsValue = '',
    network = 'private',
    model = '',
    initialPrompt = '',
    sandboxNamespace: specNamespace,
    formulaEnv = {},
    mcp = null,
  } = spec;

  const {
    sandboxFactoryName,
    fsMounterName,
    sandboxNamespace,
    backend,
    defaultImage,
    mountBaseDir,
  } = resolveSandboxConfig({
    ...formulaEnv,
    ...(specNamespace !== undefined
      ? { SANDBOX_NAMESPACE: specNamespace }
      : {}),
  });

  /** @type {Array<string | string[]>} */
  let toCleanup = [...removeNames];
  try {
    if (!name) throw new Error('Missing "name".');
    if (!filesystemName) throw new Error('Missing filesystem.');
    if (!ALLOWED_NETWORKS.includes(network)) {
      throw new Error(
        `Unknown network profile "${network}"; expected one of ${ALLOWED_NETWORKS.join(', ')}.`,
      );
    }
    const parsedRootfs = parseRootfs(rootfsValue, { defaultImage });

    const slug = slugify(name);
    sessionCounter += 1;
    const sessionId = `${slug}-${Date.now().toString(36)}-${sessionCounter.toString(36)}`;
    const hostMountPoint = nodePath.join(
      mountBaseDir,
      `claude-sandbox-${sessionId}`,
    );
    const workspacePetName = `claude-${sessionId}-workspace`;

    // Dedicated persistent Claude config dir (holds the conversation
    // transcript). A separate filesystem + mount from the workspace, so the
    // transcript never lands in a new-project git worktree or a published
    // static site. Absent for legacy callers that pass no config filesystem.
    const hasConfigFilesystem = Boolean(configFilesystemName);
    const configMountPoint = hasConfigFilesystem
      ? nodePath.join(mountBaseDir, `claude-config-${sessionId}`)
      : '';
    const configPetName = hasConfigFilesystem
      ? `claude-${sessionId}-config`
      : '';

    const powersName = `claude-${sessionId}-powers`;
    toCleanup = [powersName, ...removeNames];
    const codeNames = ['agent', 'sandboxFactory', 'fsMounter', 'filesystem'];
    const petNames = [
      '@agent',
      underNamespace(sandboxNamespace, sandboxFactoryName),
      underNamespace(sandboxNamespace, fsMounterName),
      filesystemName,
    ];
    if (hasConfigFilesystem) {
      codeNames.push('configFilesystem');
      petNames.push(/** @type {string | string[]} */ (configFilesystemName));
    }
    if (credentialsName) {
      codeNames.push('credentials');
      petNames.push(credentialsName);
    }

    // Optional Endo tool bridge: register the bridge's socket directory as a
    // read-only Mount cap and bundle it (by reference) into the session powers.
    // Its formula persists via the powers reference (like `powersName`), so we
    // drop the temporary host pet name after the client is minted.
    let mcpConfigPath = '';
    let mcpInnerDir = '';
    const hasMcpMount = Boolean(mcp && mcp.socketDir && mcp.configPath);
    if (hasMcpMount) {
      const mcpMountName = `claude-${sessionId}-mcp`;
      mcpInnerDir = /** @type {any} */ (mcp).innerDir || '/endo-mcp';
      mcpConfigPath = /** @type {any} */ (mcp).configPath;
      await E(hostAgent).provideMount(
        /** @type {any} */ (mcp).socketDir,
        mcpMountName,
        harden({ readOnly: true }),
      );
      toCleanup = [mcpMountName, ...toCleanup];
      codeNames.push('mcpMount');
      petNames.push(mcpMountName);
    }

    const mountList = [
      { mountPoint: hostMountPoint, mountName: workspacePetName },
      ...(hasConfigFilesystem
        ? [{ mountPoint: configMountPoint, mountName: configPetName }]
        : []),
    ];

    await E(hostAgent).evaluate(
      '@main',
      buildSessionPowersSource(
        mountList,
        Boolean(credentialsName),
        hasMcpMount,
        hasConfigFilesystem,
      ),
      harden(codeNames),
      harden(petNames),
      powersName,
    );

    /** @type {Record<string, any>} */
    const options = {
      powersName,
      env: harden({
        SESSION_ID: sessionId,
        CREATED_AT: new Date().toISOString(),
        WORKSPACE_MOUNT_POINT: hostMountPoint,
        WORKSPACE_PET_NAME: workspacePetName,
        WORKSPACE_PATH: SANDBOX_WORKSPACE_PATH,
        BACKEND: backend,
        NETWORK: network,
        CLAUDE_ROOTFS: rootfsValue,
        DEFAULT_IMAGE: defaultImage ?? '',
        MODEL: model,
        INITIAL_PROMPT: initialPrompt,
        ...(hasConfigFilesystem
          ? {
              CONFIG_MOUNT_POINT: configMountPoint,
              CONFIG_PET_NAME: configPetName,
              CLAUDE_CONFIG_INNER_DIR: SANDBOX_CONFIG_PATH,
              CLAUDE_CONFIG_HOST_DIR: configHostDir,
            }
          : {}),
        ...(hasMcpMount
          ? { MCP_CONFIG_PATH: mcpConfigPath, MCP_INNER_DIR: mcpInnerDir }
          : {}),
      }),
    };
    if (resultName !== undefined) {
      options.resultName = resultName;
    }
    const client = await E(hostAgent).makeUnconfined(
      '@main',
      clientModuleSpecifier,
      harden(options),
    );

    await Promise.allSettled(toCleanup.map(n => E(hostAgent).remove(n)));

    return harden({
      client,
      sessionId,
      hostMountPoint,
      rootfsLabel: rootfsLabel(parsedRootfs),
    });
  } catch (error) {
    await Promise.allSettled(toCleanup.map(n => E(hostAgent).remove(n)));
    throw error;
  }
};
harden(provisionClaudeSession);
harden(buildSessionPowersSource);
harden(resolveSandboxConfig);
