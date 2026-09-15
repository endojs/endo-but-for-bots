// @ts-check

/**
 * The Claude adapter's host-setup bindings over
 * `@endo/hosted-agent/hosted-setup.js`: the pinned specifiers of the
 * daemon-owned services and controller, the verified readers of each
 * provisioned formula under `claude-sandbox/`, the storage roots, and the
 * native runtime placement.
 *
 * @module
 */

import { Fail } from '@endo/errors';
import {
  assertNoRuntimeLeftovers,
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

import { readClaudeBrokerConfig } from './claude-broker-service-agent.js';

import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from './current-specifier.js';

/** @import { EndoHost } from '@endo/daemon' */

const LABEL = 'Claude';

/** Pet-name directory the host-side services live under. */
export const SANDBOX_DIR = 'claude-sandbox';
harden(SANDBOX_DIR);

/** Host-only native sandbox service; constructed with slot-free null powers. */
export const nativeSandboxSpecifier = assertCurrentSpecifier(
  toCurrentSpecifier(
    new URL('../../sandbox/src/native-agent.js', import.meta.url).href,
  ),
  'native sandbox',
);
harden(nativeSandboxSpecifier);

/** Per-session persistent config directories; minted with `@none`. */
export const stateProviderSpecifier = assertCurrentSpecifier(
  toCurrentSpecifier(
    new URL('./claude-state-provider-module.js', import.meta.url).href,
  ),
  'state provider',
);
harden(stateProviderSpecifier);

/** Durable storage owner; its sole powers dependency is the state provider. */
export const sessionStorageSpecifier = assertCurrentSpecifier(
  toCurrentSpecifier(
    new URL('./claude-session-storage-module.js', import.meta.url).href,
  ),
  'session storage',
);
harden(sessionStorageSpecifier);

/** Owned provider broker; its sole powers dependency is the SecretBlob. */
export const brokerServiceSpecifier = assertCurrentSpecifier(
  toCurrentSpecifier(
    new URL('./claude-broker-service-agent.js', import.meta.url).href,
  ),
  'broker service',
);
harden(brokerServiceSpecifier);

/** The per-session native controller the daemon session owner starts. */
export const controllerSpecifier = assertCurrentSpecifier(
  toCurrentSpecifier(
    new URL('./claude-native-controller.js', import.meta.url).href,
  ),
  'native controller',
);
harden(controllerSpecifier);

/**
 * @param {EndoHost} host
 * @param {string[]} namePath
 * @param {string} expectedSpecifier
 */
const readProvisionedEnvironment = (host, namePath, expectedSpecifier) =>
  readHostedProvisionedEnvironment(host, {
    label: LABEL,
    namePath,
    expectedSpecifier,
  });

/** @param {EndoHost} host */
export const readNativeSandbox = async host => {
  const { identifier, env } = await readProvisionedEnvironment(
    host,
    [SANDBOX_DIR, 'native-sandbox'],
    nativeSandboxSpecifier,
  );
  return harden({ identifier, config: readRuntimeConfig(env) });
};
harden(readNativeSandbox);

/** @param {EndoHost} host */
export const readStateProvider = async host => {
  const { identifier, env } = await readProvisionedEnvironment(
    host,
    [SANDBOX_DIR, 'state-provider'],
    stateProviderSpecifier,
  );
  const stateDir = env.ENDO_CLAUDE_STATE_DIR;
  (typeof stateDir === 'string' && stateDir.length > 0) ||
    Fail`Claude state provider must have a persisted ENDO_CLAUDE_STATE_DIR`;
  return harden({ identifier, stateDir });
};
harden(readStateProvider);

/** @param {EndoHost} host */
export const readSessionStorage = async host => {
  const { identifier, env } = await readProvisionedEnvironment(
    host,
    [SANDBOX_DIR, 'session-storage'],
    sessionStorageSpecifier,
  );
  const { CLAUDE_WORKSPACE_BASE_DIR: workspaceDir, CLAUDE_MCP_DIR: mcpDir } =
    env;
  (typeof workspaceDir === 'string' &&
    workspaceDir.length > 0 &&
    typeof mcpDir === 'string' &&
    mcpDir.length > 0) ||
    Fail`Claude session storage must have persisted workspace and MCP roots`;
  return harden({ identifier, roots: harden({ workspaceDir, mcpDir }) });
};
harden(readSessionStorage);

/** @param {EndoHost} host */
export const readBrokerService = async host => {
  const { identifier, env } = await readProvisionedEnvironment(
    host,
    [SANDBOX_DIR, 'broker-service'],
    brokerServiceSpecifier,
  );
  return harden({ identifier, config: readClaudeBrokerConfig(env) });
};
harden(readBrokerService);

/** @param {Record<string, string | undefined>} env */
export const getHostedStorageRoots = env => {
  const workspaceDir =
    env.ENDO_CLAUDE_WORKSPACE_DIR || path.join(homedir(), 'claude-workspace');
  return harden({
    stateDir: env.ENDO_CLAUDE_STATE_DIR || '/var/lib/endo/claude-state',
    workspaceDir,
    mcpDir: env.ENDO_CLAUDE_MCP_DIR || path.join(homedir(), 'claude-mcp'),
  });
};
harden(getHostedStorageRoots);

/** @param {string} name */
export const resolveFuturePath = name => resolveHostedFuturePath(name, LABEL);
harden(resolveFuturePath);

/**
 * @param {string} directory
 * @param {Record<string, string>} roots
 */
export const assertRuntimePlacement = (directory, roots) =>
  assertHostedRuntimePlacement(directory, roots, LABEL);
harden(assertRuntimePlacement);

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

/**
 * The native runtime's persisted construction policy. The runtime owns the
 * validated runtime directory itself; the inbox-form factory beside it holds
 * no runtime directory or ownership marker, but it does reconcile Podman
 * orphans under the host's label, and the native runtime sweeps under its own
 * by exact match, so the native label carries a `-native` suffix.
 * @param {Record<string, string | undefined>} env
 * @param {string} ownerId The host's label; the native label derives from it.
 * @param {Record<string, string>} roots
 */
export const prepareNativeRuntimeEnv = async (env, ownerId, roots) => {
  const nativeEnv = await prepareHostedRuntimeEnv(
    env,
    `${ownerId}-native`,
    roots,
    LABEL,
  );
  await assertNoRuntimeLeftovers(
    nativeEnv.ENDO_SANDBOX_RUNTIME_DIR,
    nativeEnv.ENDO_SANDBOX_OWNER_ID,
  );
  return nativeEnv;
};
harden(prepareNativeRuntimeEnv);
