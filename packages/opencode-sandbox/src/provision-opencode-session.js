// @ts-check
/* global process */

/**
 * Programmatic opencode sandbox session provisioning (no inbox forms).
 * Shared by the session provisioner and setup scripts.
 *
 * @module
 */

import os from 'node:os';
import nodePath from 'node:path';
import { createHash } from 'node:crypto';

import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';

import { parseRootfs, rootfsLabel } from './parse-rootfs.js';
import { toCurrentSpecifier } from './current-specifier.js';
import { DEFAULT_STATE_PROVIDER_NAME } from './opencode-state-provider.js';

const clientModuleSpecifier = toCurrentSpecifier(
  new URL('./opencode-client-module.js', import.meta.url).href,
);

const SANDBOX_WORKSPACE_PATH = '/workspace';
// Slice-internal mount path for the (optional, read-only) opencode config
// dir.  Deliberately outside /workspace so a planted workspace opencode.json
// or AGENTS.md is never loadable as a config layer.
const SANDBOX_CONFIG_PATH = '/opencode-config';
// Slice-internal mount path for the durable host-backed state directory.
// opencode runs with XDG_DATA_HOME here; it is NOT 9P (SQLite WAL needs
// same-host shared memory).
const SANDBOX_STATE_PATH = '/opencode-state';

const ALLOWED_NETWORKS = harden(['none', 'private', 'join']);

/**
 * Deterministic sandbox session id (bounded lowercase path component) derived
 * from the Floot session id. Deterministic so a re-provision, a destroy
 * backstop, and a later resume all address the same state and slice names.
 *
 * @param {string} name
 */
export const makeSandboxSessionId = name => {
  const slug = slugify(name).slice(0, 80);
  const digest = createHash('sha256')
    .update(String(name))
    .digest('hex')
    .slice(0, 12);
  return `${slug}-${digest}`;
};
harden(makeSandboxSessionId);

/**
 * @param {Array<{ mountPoint: string, mountName: string }>} mounts - The
 *   (mountPoint, mountName) pairs this session may `provideMount`/`removeMount`.
 *   Always the workspace; plus the optional opencode config dir.
 * @param {boolean} hasCredentials
 * @param {boolean} [hasMcpMount] - whether an `mcpMount` cap is bundled by
 *   reference into the powers (the Endo tool bridge socket directory).
 * @param {boolean} [hasConfigFilesystem] - whether a dedicated config
 *   `Filesystem` cap is bundled by reference.
 * @param {string} [sandboxSessionId] - when set, `stateProvider` is a
 *   per-session wrapper that refuses any other id.
 * @returns {string}
 */
export const buildSessionPowersSource = (
  mounts,
  hasCredentials,
  hasMcpMount = false,
  hasConfigFilesystem = false,
  sandboxSessionId = '',
) => {
  const stateProviderExpression = sandboxSessionId
    ? `makeExo(
    'OpencodeSessionState',
    M.interface('OpencodeSessionState', {
      provideSessionMount: M.call().optional(M.string()).returns(M.promise()),
      removeSession: M.call().optional(M.string()).returns(M.promise()),
    }),
    {
      provideSessionMount: requested => {
        if (requested !== undefined && requested !== ${JSON.stringify(sandboxSessionId)}) {
          throw Error('opencode-sandbox state provider is restricted to this session');
        }
        return E(stateProvider).provideSessionMount(${JSON.stringify(sandboxSessionId)});
      },
      removeSession: requested => {
        if (requested !== undefined && requested !== ${JSON.stringify(sandboxSessionId)}) {
          throw Error('opencode-sandbox state provider is restricted to this session');
        }
        return E(stateProvider).removeSession(${JSON.stringify(sandboxSessionId)});
      },
    },
  )`
    : 'stateProvider';
  return `makeExo(
  'OpencodeSessionPowers',
  M.interface('OpencodeSessionPowers', {
    sandboxFactory: M.call().returns(M.any()),
    fsMounter: M.call().returns(M.any()),
    stateProvider: M.call().returns(M.any()),
    filesystem: M.call().returns(M.any()),
    configFilesystem: M.call().returns(M.any()),
    credentials: M.call().returns(M.any()),
    mcpMount: M.call().returns(M.any()),
    provideMount: M.call(M.string(), M.string())
      .optional(M.record())
      .returns(M.promise()),
    removeMount: M.call().returns(M.promise()),
    help: M.call().returns(M.string()),
  }),
  {
    sandboxFactory: () => sandboxFactory,
    fsMounter: () => fsMounter,
    stateProvider: () => ${stateProviderExpression},
    filesystem: () => filesystem,
    configFilesystem: () => ${hasConfigFilesystem ? 'configFilesystem' : 'null'},
    credentials: () => ${hasCredentials ? 'credentials' : 'null'},
    mcpMount: () => ${hasMcpMount ? 'mcpMount' : 'null'},
    provideMount: (path, name, options = {}) => {
      const allowed = ${JSON.stringify(
        mounts.map(m => [m.mountPoint, m.mountName]),
      )};
      if (!allowed.some(pair => pair[0] === path && pair[1] === name)) {
        throw Error('opencode-sandbox session powers: provideMount restricted to this session mountpoints');
      }
      return E(agent).provideMount(path, name, options);
    },
    removeMount: () =>
      Promise.allSettled(
        ${JSON.stringify(
          mounts.map(m => m.mountName),
        )}.map(name => E(agent).remove(name)),
      ),
    help: () =>
      'Per-session opencode-sandbox powers: sandboxFactory/fsMounter/stateProvider/filesystem/configFilesystem/credentials/mcpMount accessors + provideMount/removeMount bounded to this session mounts. No lookup.',
  },
)`;
};

/**
 * @param {string} name
 */
const slugify = name =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'opencode';

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
  stateProviderName:
    formulaEnv.STATE_PROVIDER_NAME ||
    process.env.STATE_PROVIDER_NAME ||
    DEFAULT_STATE_PROVIDER_NAME,
  sandboxNamespace:
    formulaEnv.SANDBOX_NAMESPACE || process.env.SANDBOX_NAMESPACE || '',
  backend:
    formulaEnv.OPENCODE_SANDBOX_BACKEND ||
    process.env.OPENCODE_SANDBOX_BACKEND ||
    'podman',
  defaultImage:
    formulaEnv.OPENCODE_SANDBOX_IMAGE ||
    process.env.OPENCODE_SANDBOX_IMAGE ||
    undefined,
  stateInnerPath:
    formulaEnv.OPENCODE_STATE_INNER_DIR ||
    process.env.OPENCODE_STATE_INNER_DIR ||
    SANDBOX_STATE_PATH,
  mountBaseDir:
    formulaEnv.OPENCODE_SANDBOX_MOUNT_DIR ||
    process.env.OPENCODE_SANDBOX_MOUNT_DIR ||
    process.env.ENDO_OPENCODE_SANDBOX_MOUNT_DIR ||
    os.tmpdir(),
});

/**
 * @param {any} hostAgent
 * @param {object} spec
 * @param {string} spec.name
 * @param {string|string[]} spec.filesystemName
 * @param {string|string[]} [spec.configFilesystemName] - A dedicated
 *   read-only `Filesystem` cap for the optional opencode config dir.
 * @param {string} [spec.configHostDir] - Plain host backing directory of
 *   `configFilesystemName` (diagnostic).
 * @param {string|string[]|null} [spec.credentialsName]
 * @param {string} [spec.rootfs]
 * @param {string} [spec.network]
 * @param {string} [spec.model]
 * @param {string} [spec.systemPrompt]
 * @param {string} [spec.initialPrompt]
 * @param {string} [spec.opencodeSessionId] - Persisted opencode session id to
 *   resume on revival.
 * @param {string} [spec.sandboxSessionId] - Deterministic sandbox session id;
 *   the provisioner supplies it so destroy-backstop and resume agree. Defaults
 *   to `makeSandboxSessionId(name)`.
 * @param {number} [spec.turnTimeoutMs] - Per-turn wall-clock budget for the
 *   in-slice bridge.
 * @param {string} [spec.sandboxNamespace]
 * @param {string} [spec.stateProviderName]
 * @param {Record<string, string>} [spec.formulaEnv]
 * @param {{
 *   socketDir: string,
 *   innerDir?: string,
 *   configPath: string,
 *   socketName?: string,
 *   stdioBridgeName?: string,
 *   serverName?: string,
 * }} [spec.mcp] - Endo tool bridge: bind `socketDir` read-only at `innerDir`
 *   (default `/endo-mcp`) inside the slice and point opencode at the
 *   host-generated `mcp` config entry (see `mcp-socket-server.js`).
 * @param {{ resultName?: string|string[], removeNames?: (string|string[])[] }} [opts]
 */
export const provisionOpencodeSession = async (
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
    systemPrompt = '',
    initialPrompt = '',
    opencodeSessionId = '',
    sandboxSessionId = '',
    turnTimeoutMs = 0,
    sandboxNamespace: specNamespace,
    stateProviderName: specStateProviderName,
    formulaEnv = {},
    mcp = null,
    brokerEnv = undefined,
  } = spec;

  const {
    sandboxFactoryName,
    fsMounterName,
    stateProviderName,
    sandboxNamespace,
    backend,
    defaultImage,
    stateInnerPath,
    mountBaseDir,
  } = resolveSandboxConfig({
    ...formulaEnv,
    ...(specNamespace !== undefined
      ? { SANDBOX_NAMESPACE: specNamespace }
      : {}),
    ...(specStateProviderName !== undefined
      ? { STATE_PROVIDER_NAME: specStateProviderName }
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

    const sessionId = sandboxSessionId || makeSandboxSessionId(name);
    /^[a-z0-9][a-z0-9-]{0,127}$/.test(sessionId) ||
      Fail`Invalid sandbox session id`;
    const hostMountPoint = nodePath.join(
      mountBaseDir,
      `opencode-sandbox-${sessionId}`,
    );
    const workspacePetName = `opencode-${sessionId}-workspace`;

    // Optional dedicated opencode config dir.  A separate filesystem +
    // mount from the workspace, so config never lands in a new-project git
    // worktree or a published static site.
    const hasConfigFilesystem = Boolean(configFilesystemName);
    const configMountPoint = hasConfigFilesystem
      ? nodePath.join(mountBaseDir, `opencode-config-${sessionId}`)
      : '';
    const configPetName = hasConfigFilesystem
      ? `opencode-${sessionId}-config`
      : '';

    const powersName = `opencode-${sessionId}-powers`;
    toCleanup = [powersName, ...removeNames];
    const codeNames = [
      'agent',
      'sandboxFactory',
      'fsMounter',
      'stateProvider',
      'filesystem',
    ];
    const petNames = [
      '@agent',
      underNamespace(sandboxNamespace, sandboxFactoryName),
      underNamespace(sandboxNamespace, fsMounterName),
      underNamespace(sandboxNamespace, stateProviderName),
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
    // read-only Mount cap and bundle it (by reference) into the session
    // powers.  Its formula persists via the powers reference (like
    // `powersName`), so we drop the temporary host pet name after the client
    // is minted.
    let mcpConfigPath = '';
    let mcpInnerDir = '';
    let mcpSocketName = '';
    let mcpBridgeName = '';
    let mcpServerName = '';
    const hasMcpMount = Boolean(mcp && mcp.socketDir && mcp.configPath);
    if (hasMcpMount) {
      const mcpMountName = `opencode-${sessionId}-mcp`;
      mcpInnerDir = /** @type {any} */ (mcp).innerDir || '/endo-mcp';
      mcpConfigPath = /** @type {any} */ (mcp).configPath;
      mcpSocketName = /** @type {any} */ (mcp).socketName || '';
      mcpBridgeName = /** @type {any} */ (mcp).stdioBridgeName || '';
      mcpServerName = /** @type {any} */ (mcp).serverName || '';
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
        sessionId,
      ),
      harden(codeNames),
      harden(petNames),
      powersName,
    );

    /** @type {Record<string, any>} */
    if (brokerEnv !== undefined) {
      const { OPENCODE_BROKER_BASE_URL, OPENCODE_BROKER_CONTAINER } = brokerEnv;
      (typeof OPENCODE_BROKER_BASE_URL === 'string' &&
        OPENCODE_BROKER_BASE_URL.length > 0 &&
        OPENCODE_BROKER_BASE_URL.length <= 512 &&
        typeof OPENCODE_BROKER_CONTAINER === 'string' &&
        OPENCODE_BROKER_CONTAINER.length > 0 &&
        OPENCODE_BROKER_CONTAINER.length <= 128) ||
        Fail`Invalid broker transport for the OpenCode client`;
    }

    /** @type {Record<string, any>} */
    const options = {
      powersName,
      env: harden({
        SESSION_ID: sessionId,
        CREATED_AT: new Date().toISOString(),
        WORKSPACE_MOUNT_POINT: hostMountPoint,
        WORKSPACE_PET_NAME: workspacePetName,
        WORKSPACE_PATH: SANDBOX_WORKSPACE_PATH,
        STATE_INNER_PATH: stateInnerPath,
        BACKEND: backend,
        NETWORK: network,
        OPENCODE_ROOTFS: rootfsValue,
        DEFAULT_IMAGE: defaultImage ?? '',
        MODEL: model,
        SYSTEM_PROMPT: systemPrompt,
        INITIAL_PROMPT: initialPrompt,
        ...(brokerEnv === undefined
          ? {}
          : {
              OPENCODE_BROKER_BASE_URL: brokerEnv.OPENCODE_BROKER_BASE_URL,
              OPENCODE_BROKER_CONTAINER: brokerEnv.OPENCODE_BROKER_CONTAINER,
            }),
        ...(opencodeSessionId
          ? { OPENCODE_SESSION_ID: opencodeSessionId }
          : {}),
        ...(Number.isSafeInteger(turnTimeoutMs) && turnTimeoutMs > 0
          ? { OPENCODE_BRIDGE_TURN_TIMEOUT_MS: String(turnTimeoutMs) }
          : {}),
        ...(hasConfigFilesystem
          ? {
              CONFIG_MOUNT_POINT: configMountPoint,
              CONFIG_PET_NAME: configPetName,
              OPENCODE_CONFIG_INNER_DIR: SANDBOX_CONFIG_PATH,
              OPENCODE_CONFIG_HOST_DIR: configHostDir,
            }
          : {}),
        ...(hasMcpMount
          ? {
              MCP_CONFIG_PATH: mcpConfigPath,
              MCP_INNER_DIR: mcpInnerDir,
              MCP_SOCKET_NAME: mcpSocketName,
              MCP_BRIDGE_NAME: mcpBridgeName,
              MCP_SERVER_NAME: mcpServerName,
            }
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

    await Promise.allSettled(
      toCleanup.map(n =>
        Array.isArray(n) ? E(hostAgent).remove(...n) : E(hostAgent).remove(n),
      ),
    );

    return harden({
      client,
      sessionId,
      hostMountPoint,
      rootfsLabel: rootfsLabel(parsedRootfs),
    });
  } catch (error) {
    await Promise.allSettled(
      toCleanup.map(n =>
        Array.isArray(n) ? E(hostAgent).remove(...n) : E(hostAgent).remove(n),
      ),
    );
    throw error;
  }
};
harden(provisionOpencodeSession);
harden(buildSessionPowersSource);
harden(resolveSandboxConfig);
