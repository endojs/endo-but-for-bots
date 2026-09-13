// @ts-check

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { assertPrivateDirectory } from '@endo/sandbox/private-directory.js';
import { readRuntimeConfig } from '@endo/sandbox/runtime-config.js';
import { execFile as execFileCallback } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from './current-specifier.js';
import { readOpencodeBrokerConfig } from './opencode-broker-service-agent.js';

/** @import { EndoHost } from '@endo/daemon' */
/** @typedef {Parameters<EndoHost['getFormulaEnvironment']>[0]} FormulaIdentifier */

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

/**
 * Read one immutable formula by the ID captured from its current binding.
 * Do not revive it or resolve the mutable pet name again between reads.
 * @param {EndoHost} host
 * @param {string} name
 * @param {string} expectedSpecifier
 */
const readProvisionedEnvironment = async (host, name, expectedSpecifier) => {
  const identified = await E(host).identify('opencode-sandbox', name);
  if (!identified) throw Fail`Cannot identify OpenCode ${q(name)}`;
  // The daemon returns a formula ID; identify's public type erases its brand.
  const identifier = /** @type {FormulaIdentifier} */ (identified);
  const record = await E(E(host).diagnostics()).getFormula(identifier);
  const specifier = record.properties.specifier;
  (record.type === 'make-unconfined' &&
    specifier?.kind === 'literal' &&
    specifier.value === expectedSpecifier) ||
    Fail`OpenCode ${name} has an unsupported entrypoint. Retire the old runtime and prove its processes have stopped before replacing its formula; removing its name alone is insufficient.`;
  const env = await E(host).getFormulaEnvironment(identifier);
  return harden({ identifier, env });
};

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
 * Canonicalize existing ancestors without creating a future guest storage root.
 * The operator must keep these ancestors outside guest rename authority.
 * @param {string} name
 * @returns {Promise<string>}
 */
export const resolveFuturePath = async name => {
  await null;
  try {
    return await fs.realpath(name);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
      throw error;
    const existing = await fs.lstat(name).catch(missing => {
      if (/** @type {NodeJS.ErrnoException} */ (missing).code !== 'ENOENT')
        throw missing;
      return undefined;
    });
    !existing || Fail`OpenCode storage path has an unresolved symlink`;
    const parent = path.dirname(name);
    if (parent === name) throw error;
    return path.join(await resolveFuturePath(parent), path.basename(name));
  }
};
harden(resolveFuturePath);

/**
 * Validate operator placement, including guest roots which do not exist yet.
 * No mkdir/chmod adoption: the runtime parent is provisioned by the deployment.
 * The caller supplies effective persisted roots where a formula already exists.
 * @param {string} directory
 * @param {ReturnType<typeof getHostedStorageRoots>} roots
 * @returns {Promise<string>}
 */
export const assertRuntimePlacement = async (directory, roots) => {
  const canonical = await assertPrivateDirectory(directory, fs);
  for (const root of Object.values(roots)) {
    path.isAbsolute(root) || Fail`OpenCode storage roots must be absolute`;
    // eslint-disable-next-line no-await-in-loop
    const guest = await resolveFuturePath(root);
    const relative = path.relative(canonical, guest);
    const reverse = path.relative(guest, canonical);
    /** @param {string} value */
    const outside = value =>
      value === '..' || value.startsWith(`..${path.sep}`);
    (outside(relative) && outside(reverse)) ||
      Fail`Sandbox runtime directory must be disjoint from OpenCode guest storage roots`;
  }
  return canonical;
};
harden(assertRuntimePlacement);

/**
 * Persist only the explicit runtime construction policy; no ambient credentials.
 * @param {Record<string, string | undefined>} env
 * @param {string} ownerId
 * @param {ReturnType<typeof getHostedStorageRoots>} roots
 */
export const prepareRuntimeEnv = async (env, ownerId, roots) => {
  const config = readRuntimeConfig({ ...env, ENDO_SANDBOX_OWNER_ID: ownerId });
  const directory = await assertRuntimePlacement(config.directory, roots);
  return harden({
    ENDO_SANDBOX_RUNTIME_DIR: directory,
    ENDO_SANDBOX_OWNER_ID: config.ownerId,
    ENDO_SANDBOX_GENERATED_MAX_BYTES: String(config.maxBytes),
    ENDO_SANDBOX_GENERATED_MAX_ENTRIES: String(config.maxEntries),
  });
};
harden(prepareRuntimeEnv);

const execFile = promisify(execFileCallback);

/**
 * The spelling checks of the configured slice image that need no Podman —
 * the digest the broker kit refuses at construction, and an option-like name
 * Podman would misparse — so setup refuses them before any mint.
 * @param {string} rootfs Config rootfs (`oci:<image>` or already pinned).
 * @returns {{ image: string, imageDigest?: string }}
 */
export const readSliceImageReference = rootfs => {
  const image = rootfs.startsWith('oci:') ? rootfs.slice(4) : rootfs;
  // A leading dash would be parsed as a podman option rather than an image.
  !image.startsWith('-') || Fail`Invalid OpenCode sandbox image ${q(image)}`;
  if (image.includes('@sha256:')) {
    const imageDigest = image.slice(image.indexOf('@') + 1);
    /^sha256:[a-f0-9]{64}$/.test(imageDigest) ||
      Fail`OpenCode sandbox image digest is invalid, got ${q(imageDigest)}`;
    return harden({ image, imageDigest });
  }
  return harden({ image });
};
harden(readSliceImageReference);

/**
 * Resolve a local OCI image reference to its immutable digest form. The
 * broker binds each grant attestation to the exact slice image, so setup pins
 * what Podman actually resolved rather than trusting a mutable tag.
 *
 * @param {string} rootfs Config rootfs (`oci:<image>` or already pinned).
 * @param {(file: string, args: string[]) => Promise<{ stdout: string }>} [exec]
 * @returns {Promise<{ imageRef: string, imageDigest: string }>}
 */
export const resolvePinnedImageRef = async (rootfs, exec = execFile) => {
  const { image, imageDigest: pinned } = readSliceImageReference(rootfs);
  if (pinned !== undefined) {
    return harden({ imageRef: image, imageDigest: pinned });
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
