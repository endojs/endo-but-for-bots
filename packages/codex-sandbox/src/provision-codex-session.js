// @ts-check
/* global process */

import os from 'node:os';
import nodePath from 'node:path';

import { E } from '@endo/eventual-send';

import { parseRootfs, rootfsLabel } from './parse-rootfs.js';
import { toCurrentSpecifier } from './current-specifier.js';

const clientModuleSpecifier = toCurrentSpecifier(
  new URL('./codex-client-module.js', import.meta.url).href,
);
const SANDBOX_WORKSPACE_PATH = '/workspace';
const SANDBOX_CODEX_HOME_PATH = '/codex-home';
const ALLOWED_NETWORKS = harden(['none', 'private']);
let sessionCounter = 0;

/**
 * @param {{ mountPoint: string, mountName: string }} workspace
 * @param {boolean} hasMcpMount
 */
export const buildSessionPowersSource = (workspace, hasMcpMount) => `makeExo(
  'CodexSessionPowers',
  M.interface('CodexSessionPowers', {
    sandboxFactory: M.call().returns(M.any()),
    fsMounter: M.call().returns(M.any()),
    filesystem: M.call().returns(M.any()),
    codexHomeMount: M.call().returns(M.any()),
    mcpMount: M.call().returns(M.any()),
    provideMount: M.call(M.string(), M.string()).returns(M.promise()),
    removeMount: M.call().returns(M.promise()),
    help: M.call().returns(M.string()),
  }),
  {
    sandboxFactory: () => sandboxFactory,
    fsMounter: () => fsMounter,
    filesystem: () => filesystem,
    codexHomeMount: () => codexHomeMount,
    mcpMount: () => ${hasMcpMount ? 'mcpMount' : 'null'},
    provideMount: (path, name) => {
      if (path !== ${JSON.stringify(workspace.mountPoint)} || name !== ${JSON.stringify(workspace.mountName)}) {
        throw Error('codex-sandbox session powers: provideMount restricted to this session workspace mountpoint');
      }
      return E(agent).provideMount(path, name);
    },
    removeMount: () => E(agent).remove(${JSON.stringify(workspace.mountName)}),
    help: () =>
      'Per-session codex-sandbox powers: sandboxFactory/fsMounter/filesystem/codexHomeMount/mcpMount accessors plus one bounded workspace provideMount. No lookup.',
  },
)`;
harden(buildSessionPowersSource);

const slugify = name =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'codex';

const underNamespace = (sandboxNamespace, name) =>
  sandboxNamespace ? [sandboxNamespace, name] : name;

/** @param {Record<string, string>} [formulaEnv] */
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
    formulaEnv.CODEX_SANDBOX_BACKEND ||
    process.env.CODEX_SANDBOX_BACKEND ||
    'podman',
  defaultImage:
    formulaEnv.CODEX_SANDBOX_IMAGE ||
    process.env.CODEX_SANDBOX_IMAGE ||
    undefined,
  mountBaseDir:
    formulaEnv.CODEX_SANDBOX_MOUNT_DIR ||
    process.env.CODEX_SANDBOX_MOUNT_DIR ||
    os.tmpdir(),
});
harden(resolveSandboxConfig);

/**
 * @param {any} hostAgent
 * @param {{
 *   name: string,
 *   filesystemName: string|string[],
 *   codexHomeName: string|string[],
 *   threadStateFile: string,
 *   rootfs?: string,
 *   network?: string,
 *   model?: string,
 *   sandboxNamespace?: string,
 *   formulaEnv?: Record<string, string>,
 *   mcp?: { socketDir: string, innerDir?: string, configPath: string } | null,
 * }} spec
 * @param {{ resultName?: string|string[], removeNames?: (string|string[])[] }} [opts]
 */
export const provisionCodexSession = async (
  hostAgent,
  spec,
  { resultName, removeNames = [] } = {},
) => {
  const {
    name,
    filesystemName,
    codexHomeName,
    threadStateFile,
    rootfs: rootfsValue = '',
    network = 'private',
    model = '',
    sandboxNamespace: specNamespace,
    formulaEnv = {},
    mcp = null,
  } = spec;
  const config = resolveSandboxConfig({
    ...formulaEnv,
    ...(specNamespace === undefined
      ? {}
      : { SANDBOX_NAMESPACE: specNamespace }),
  });
  if (!name) throw new Error('Missing "name".');
  if (!filesystemName) throw new Error('Missing filesystem.');
  if (!codexHomeName) throw new Error('Missing Codex home mount.');
  if (!threadStateFile) throw new Error('Missing thread state file.');
  if (!ALLOWED_NETWORKS.includes(network)) {
    throw new Error(
      `Unknown network profile "${network}"; expected one of ${ALLOWED_NETWORKS.join(', ')}.`,
    );
  }
  const parsedRootfs = parseRootfs(rootfsValue, {
    defaultImage: config.defaultImage,
  });
  sessionCounter += 1;
  const sessionId = `${slugify(name)}-${Date.now().toString(36)}-${sessionCounter.toString(36)}`;
  const hostMountPoint = nodePath.join(
    config.mountBaseDir,
    `codex-sandbox-${sessionId}`,
  );
  const workspacePetName = `codex-${sessionId}-workspace`;
  const powersName = `codex-${sessionId}-powers`;
  /** @type {Array<string|string[]>} */
  let toCleanup = [powersName, ...removeNames];

  try {
    const codeNames = [
      'agent',
      'sandboxFactory',
      'fsMounter',
      'filesystem',
      'codexHomeMount',
    ];
    const petNames = [
      '@agent',
      underNamespace(config.sandboxNamespace, config.sandboxFactoryName),
      underNamespace(config.sandboxNamespace, config.fsMounterName),
      filesystemName,
      codexHomeName,
    ];
    let mcpConfigPath = '';
    let mcpInnerDir = '';
    const hasMcpMount = Boolean(mcp?.socketDir && mcp?.configPath);
    if (hasMcpMount) {
      const mcpMountName = `codex-${sessionId}-mcp`;
      mcpInnerDir = mcp?.innerDir || '/endo-mcp';
      mcpConfigPath = /** @type {NonNullable<typeof mcp>} */ (mcp).configPath;
      await E(hostAgent).provideMount(
        /** @type {NonNullable<typeof mcp>} */ (mcp).socketDir,
        mcpMountName,
        harden({ readOnly: true }),
      );
      toCleanup = [mcpMountName, ...toCleanup];
      codeNames.push('mcpMount');
      petNames.push(mcpMountName);
    }
    await E(hostAgent).evaluate(
      '@main',
      buildSessionPowersSource(
        { mountPoint: hostMountPoint, mountName: workspacePetName },
        hasMcpMount,
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
        CODEX_HOME_INNER_DIR: SANDBOX_CODEX_HOME_PATH,
        THREAD_STATE_FILE: threadStateFile,
        BACKEND: config.backend,
        NETWORK: network,
        CODEX_ROOTFS: rootfsValue,
        DEFAULT_IMAGE: config.defaultImage || '',
        MODEL: model,
        ...(hasMcpMount
          ? { MCP_CONFIG_PATH: mcpConfigPath, MCP_INNER_DIR: mcpInnerDir }
          : {}),
      }),
      ...(resultName === undefined ? {} : { resultName }),
    };
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
harden(provisionCodexSession);
