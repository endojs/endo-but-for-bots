// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { assertPrivateDirectory } from '@endo/sandbox/private-directory.js';
import { readRuntimeConfig } from '@endo/sandbox/runtime-config.js';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from './current-specifier.js';

/** @import { EndoHost } from '@endo/daemon' */
/** @typedef {Parameters<EndoHost['getFormulaEnvironment']>[0]} FormulaIdentifier */

export const sandboxSpecifier = assertCurrentSpecifier(
  toCurrentSpecifier(
    new URL('../../sandbox/src/owned-agent.js', import.meta.url).href,
  ),
  'sandbox',
);
harden(sandboxSpecifier);

export const stateProviderSpecifier = assertCurrentSpecifier(
  toCurrentSpecifier(
    new URL('./opencode-state-provider-module.js', import.meta.url).href,
  ),
  'state provider',
);
harden(stateProviderSpecifier);

/**
 * Read one immutable formula by the ID captured from its current binding.
 * Do not revive it or resolve the mutable pet name again between reads.
 * @param {EndoHost} host
 * @param {string} name
 * @param {string} expectedSpecifier
 */
const readProvisionedEnvironment = async (host, name, expectedSpecifier) => {
  const identified = await E(host).identify('opencode-sandbox', name);
  if (!identified) throw Fail`Cannot identify OpenCode ${name}`;
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
export const readSandboxRuntime = async host => {
  const { identifier, env } = await readProvisionedEnvironment(
    host,
    'sandbox-factory',
    sandboxSpecifier,
  );
  return harden({ identifier, config: readRuntimeConfig(env) });
};
harden(readSandboxRuntime);

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

/** @param {Record<string, string | undefined>} env */
export const getHostedStorageRoots = env => {
  const workspaceDir =
    env.ENDO_OPENCODE_WORKSPACE_DIR ||
    path.join(homedir(), 'opencode-workspaces');
  return harden({
    stateDir: env.ENDO_OPENCODE_STATE_DIR || '/var/lib/endo/opencode-state',
    workspaceDir,
    configDir:
      env.ENDO_OPENCODE_CONFIG_DIR ||
      path.join(path.dirname(workspaceDir), 'opencode-configs'),
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
const resolveFuturePath = async name => {
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
