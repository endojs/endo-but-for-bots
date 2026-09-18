// @ts-check

/**
 * The shared `@endo/hosted-agent` setup helpers bound to this package's label,
 * and the one image reader Codex needs that the other adapters do not: Codex
 * takes its slice image from formula configuration rather than from a setup
 * environment variable, so the reference it is handed must already be pinned.
 *
 * @module
 */

import {
  assertRuntimePlacement as assertHostedRuntimePlacement,
  prepareRuntimeEnv as prepareHostedRuntimeEnv,
  readProvisionedEnvironment as readHostedProvisionedEnvironment,
  readSliceImageReference as readHostedSliceImageReference,
  resolveFuturePath as resolveHostedFuturePath,
  resolvePinnedImageRef as resolveHostedPinnedImageRef,
} from '@endo/hosted-agent/hosted-setup.js';
import { readRuntimeConfig } from '@endo/sandbox/runtime-config.js';

import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from '@endo/hosted-agent/current-specifier.js';
import { assertCodexStateRoot } from './codex-state-provider.js';

export { readPinnedSliceImage } from './codex-image-reference.js';

const LABEL = 'Codex';

/**
 * Pet-name directory for everything this adapter mints; the host root stays
 * clean, and the backend's session state is named from here.
 */
export const SANDBOX_DIR = 'codex-sandbox';

/** The common scoped native Podman service; Codex has no volume registry. */
export const nativeSandboxSpecifier = assertCurrentSpecifier(
  toCurrentSpecifier(
    new URL('../../sandbox/src/native-agent.js', import.meta.url).href,
  ),
  'native sandbox',
);
harden(nativeSandboxSpecifier);

/** One host directory per session, with ownership markers. */
export const stateProviderSpecifier = assertCurrentSpecifier(
  toCurrentSpecifier(
    new URL('./codex-state-provider-module.js', import.meta.url).href,
  ),
  'state provider',
);
harden(stateProviderSpecifier);

/** The host-private backend records plans and delegates to the session owner. */
export const backendSpecifier = assertCurrentSpecifier(
  toCurrentSpecifier(
    new URL('./codex-backend-module.js', import.meta.url).href,
  ),
  'codex backend',
);
harden(backendSpecifier);

/**
 * Read one immutable formula under `codex-sandbox/` by its verified
 * entrypoint; see `@endo/hosted-agent/hosted-setup.js`.
 * @param {any} host The `@agent` host powers.
 * @param {string} name
 * @param {string} expectedSpecifier
 */
export const readProvisionedEnvironment = (host, name, expectedSpecifier) =>
  readHostedProvisionedEnvironment(host, {
    label: LABEL,
    namePath: ['codex-sandbox', name],
    expectedSpecifier,
  });
harden(readProvisionedEnvironment);

/** @param {any} host */
export const readNativeSandbox = async host => {
  const { identifier, env } = await readProvisionedEnvironment(
    host,
    'native-sandbox',
    nativeSandboxSpecifier,
  );
  return harden({
    identifier,
    config: readRuntimeConfig(env),
  });
};
harden(readNativeSandbox);

/** @param {any} host */
export const readStateProvider = async host => {
  const { identifier, env } = await readProvisionedEnvironment(
    host,
    'state-provider',
    stateProviderSpecifier,
  );
  return harden({
    identifier,
    stateDir: assertCodexStateRoot(env.ENDO_CODEX_STATE_DIR),
  });
};
harden(readStateProvider);

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

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} ownerId
 * @param {Record<string, string>} roots
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
