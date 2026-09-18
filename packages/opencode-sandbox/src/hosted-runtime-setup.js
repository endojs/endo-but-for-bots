// @ts-check

import { Fail } from '@endo/errors';
import {
  assertRuntimePlacement as assertHostedRuntimePlacement,
  prepareRuntimeEnv as prepareHostedRuntimeEnv,
  readProvisionedEnvironment as readHostedProvisionedEnvironment,
  readSliceImageReference as readHostedSliceImageReference,
  resolveFuturePath as resolveHostedFuturePath,
  resolvePinnedImageRef as resolveHostedPinnedImageRef,
} from '@endo/hosted-agent/hosted-setup.js';
import { readRuntimeConfig } from '@endo/sandbox/runtime-config.js';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from '@endo/hosted-agent/current-specifier.js';
import { readOpencodeBrokerConfig } from './opencode-broker-service-agent.js';

/** @import { EndoHost } from '@endo/daemon' */

export const stateProviderSpecifier = assertCurrentSpecifier(
  toCurrentSpecifier(
    new URL('./opencode-state-provider-module.js', import.meta.url).href,
  ),
  'state provider',
);
harden(stateProviderSpecifier);

/** Host-only native sandbox service; constructed with slot-free null powers. */
export const nativeSandboxSpecifier = assertCurrentSpecifier(
  toCurrentSpecifier(
    new URL('../../sandbox/src/native-agent.js', import.meta.url).href,
  ),
  'native sandbox',
);
harden(nativeSandboxSpecifier);

/** Owned provider broker; its sole powers dependency is the SecretBlob. */
export const brokerServiceSpecifier = assertCurrentSpecifier(
  toCurrentSpecifier(
    new URL('./opencode-broker-service-agent.js', import.meta.url).href,
  ),
  'broker service',
);
harden(brokerServiceSpecifier);

/** Durable storage owner; its sole powers dependency is the state provider. */
export const sessionStorageSpecifier = assertCurrentSpecifier(
  toCurrentSpecifier(
    new URL('./opencode-session-storage-module.js', import.meta.url).href,
  ),
  'session storage',
);
harden(sessionStorageSpecifier);

const LABEL = 'OpenCode';

/**
 * Read one immutable formula under `opencode-sandbox/` by its verified
 * entrypoint; see `@endo/hosted-agent/hosted-setup.js`.
 * @param {EndoHost} host
 * @param {string} name
 * @param {string} expectedSpecifier
 */
const readProvisionedEnvironment = (host, name, expectedSpecifier) =>
  readHostedProvisionedEnvironment(host, {
    label: LABEL,
    namePath: ['opencode-sandbox', name],
    expectedSpecifier,
  });

/** @param {EndoHost} host */
export const readStateProvider = async host => {
  const { identifier, env } = await readProvisionedEnvironment(
    host,
    'state-provider',
    stateProviderSpecifier,
  );
  const stateDir = env.ENDO_OPENCODE_STATE_DIR;
  (typeof stateDir === 'string' && stateDir.length > 0) ||
    Fail`State provider must have a persisted ENDO_OPENCODE_STATE_DIR`;
  return harden({ identifier, stateDir });
};
harden(readStateProvider);

/** @param {EndoHost} host */
export const readNativeSandbox = async host => {
  const { identifier, env } = await readProvisionedEnvironment(
    host,
    'native-sandbox',
    nativeSandboxSpecifier,
  );
  return harden({ identifier, config: readRuntimeConfig(env) });
};
harden(readNativeSandbox);

/** @param {EndoHost} host */
export const readBrokerService = async host => {
  const { identifier, env } = await readProvisionedEnvironment(
    host,
    'broker-service',
    brokerServiceSpecifier,
  );
  return harden({ identifier, config: readOpencodeBrokerConfig(env) });
};
harden(readBrokerService);

/** @param {EndoHost} host */
export const readSessionStorage = async host => {
  const { identifier, env } = await readProvisionedEnvironment(
    host,
    'session-storage',
    sessionStorageSpecifier,
  );
  const {
    OPENCODE_WORKSPACE_BASE_DIR: workspaceDir,
    OPENCODE_MCP_DIR: mcpDir,
  } = env;
  (typeof workspaceDir === 'string' &&
    workspaceDir.length > 0 &&
    typeof mcpDir === 'string' &&
    mcpDir.length > 0) ||
    Fail`Session storage must have persisted workspace and MCP roots`;
  return harden({ identifier, roots: harden({ workspaceDir, mcpDir }) });
};
harden(readSessionStorage);

/** @param {Record<string, string | undefined>} env */
export const getHostedStorageRoots = env => {
  const workspaceDir =
    env.ENDO_OPENCODE_WORKSPACE_DIR ||
    path.join(homedir(), 'opencode-workspaces');
  return harden({
    stateDir: env.ENDO_OPENCODE_STATE_DIR || '/var/lib/endo/opencode-state',
    workspaceDir,
    mcpDir: env.ENDO_OPENCODE_MCP_DIR || path.join(homedir(), 'opencode-mcp'),
  });
};
harden(getHostedStorageRoots);

/**
 * The shared setup helpers bound to this package's label; see
 * `@endo/hosted-agent/hosted-setup.js` for each contract.
 * @param {string} name
 */
export const resolveFuturePath = name => resolveHostedFuturePath(name, LABEL);
harden(resolveFuturePath);

/**
 * @param {string} directory
 * @param {ReturnType<typeof getHostedStorageRoots>} roots
 */
export const assertRuntimePlacement = (directory, roots) =>
  assertHostedRuntimePlacement(directory, roots, LABEL);
harden(assertRuntimePlacement);

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} ownerId
 * @param {ReturnType<typeof getHostedStorageRoots>} roots
 */
export const prepareRuntimeEnv = (env, ownerId, roots) =>
  prepareHostedRuntimeEnv(env, ownerId, roots, LABEL);
harden(prepareRuntimeEnv);

/** @param {string} rootfs */
export const readSliceImageReference = rootfs =>
  readHostedSliceImageReference(rootfs, LABEL);
harden(readSliceImageReference);

/**
 * @param {string} rootfs
 * @param {Parameters<typeof resolveHostedPinnedImageRef>[1]} [exec]
 */
export const resolvePinnedImageRef = (rootfs, exec = undefined) =>
  resolveHostedPinnedImageRef(rootfs, exec, LABEL);
harden(resolvePinnedImageRef);
