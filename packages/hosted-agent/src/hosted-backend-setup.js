// @ts-check

/**
 * The sequence a CLI adapter's `setup-hosted.js` runs. The Claude and
 * OpenCode adapters run the same one, in the same order: read the operator's
 * environment, resolve the retained or requested storage roots, read the
 * retained broker or settle a minted one's identity, provide the session
 * roots, refuse guest roots that overlap protected storage, mint or retain
 * the broker and apply its settings, mint the backend caplet under a
 * temporary name and swap it in, bind it into Floot's profile, and publish
 * the account. Each step here is one of those, parameterized by the adapter's
 * label, its `ENDO_<PREFIX>` variables and its pet-name directory. What
 * differs between adapters (the credential, the storage owner's powers, an
 * adapter's own identity checks) stays in the adapter's script, between these
 * steps, as explicit code rather than as hooks into a framework.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Fail, b, makeError, q } from '@endo/errors';
import { E } from '@endo/eventual-send';

import {
  configureBroker,
  forgetBrokerSettings,
  mintWithPowersPath,
  providePrivateDirectory,
  publishAccountOracle,
  publishBrokerSubscription,
  readAccountAuthority,
  readBrokerSettings,
  readSliceImageReference,
  readProvisionedEnvironment,
  resolveFuturePath,
  resolvePinnedImageRef,
} from './hosted-setup.js';
import {
  BROKER_OWNER_PATTERN,
  readBrokerWorkloadEnv,
} from './provider-broker-service.js';
import {
  containsPath,
  isNormalizedAbsolutePath,
  readMounterEnv,
} from './session-plan.js';

/** @import { BrokerSettings } from './provider-scopes.js' */

/**
 * @typedef {object} HostedBackendEnvironment
 * @property {string} accountAuthority The account authority the broker
 *   serves, as the operator declared it.
 * @property {string} backendName The name Floot's factory discovers the
 *   backend under.
 * @property {string} rootfs The configured slice image (`oci:<image>`).
 * @property {string} listenerImageRef The digest-pinned listener image, or
 *   '' when the environment names none.
 * @property {string} brokerDir The broker's private directory when minted.
 * @property {string} brokerOwnerId The operator's owner label for a minted
 *   broker, or '' to derive one from the host identity.
 * @property {BrokerSettings} brokerSettings
 * @property {string | undefined} mounterEnvText The session's 9P mounter
 *   settings, serialized for the backend, or undefined when none are set.
 * @property {string} flootDir Floot's host directory.
 */

/**
 * The operator's `ENDO_<PREFIX>_*` configuration that every hosted backend
 * reads the same way. A hosted daemon forwards only ENDO_-prefixed variables
 * to its ENDO_EXTRA subprocesses, so the mounter's own names are also accepted
 * under their ENDO_ spelling.
 *
 * @param {Record<string, string | undefined>} env
 * @param {object} spec
 * @param {string} spec.label The adapter's name for messages, e.g. `Claude`.
 * @param {string} spec.prefix The variable prefix, e.g. `ENDO_CLAUDE`.
 * @param {string} spec.defaultBackendName What Floot's factory discovers.
 * @param {string} spec.defaultRootfs The slice image when none is configured.
 * @param {string} spec.brokerDirName The broker directory's name under the
 *   home directory when none is configured.
 * @returns {HostedBackendEnvironment}
 */
export const readHostedBackendEnvironment = (
  env,
  { label, prefix, defaultBackendName, defaultRootfs, brokerDirName },
) => {
  const accountAuthority = readAccountAuthority(
    env,
    `${prefix}_ACCOUNT_AUTHORITY`,
    label,
  );
  const backendName = env[`${prefix}_BACKEND_NAME`] || defaultBackendName;
  if (backendName !== defaultBackendName) {
    console.warn(
      `${label} backend name is "${backendName}"; Floot's factory only discovers "${defaultBackendName}" unless its own configuration is changed to match.`,
    );
  }
  const rootfs = env[`${prefix}_SANDBOX_IMAGE`] || defaultRootfs;
  // Daemon-owned sessions require the provider broker, so the listener image
  // is required whenever one is minted; there is no session path without one.
  const listenerImageRef = env[`${prefix}_BROKER_LISTENER_IMAGE`] || '';
  const brokerDir =
    env[`${prefix}_BROKER_DIR`] || path.join(os.homedir(), brokerDirName);
  const brokerOwnerId = env[`${prefix}_BROKER_OWNER_ID`] || '';
  // Session capacity, public egress and the admission trail: the broker's
  // operator settings, applied at every start (see provideBrokerService).
  const brokerSettings = readBrokerSettings(env, prefix);
  /** @type {Record<string, string>} */
  const mounterSettings = {};
  for (const name of [
    'NINEP_SUDO',
    'NINEP_MOUNT_PROGRAM',
    'NINEP_UMOUNT_PROGRAM',
  ]) {
    const value = env[`ENDO_${name}`] || env[name];
    if (value) mounterSettings[name] = value;
  }
  const mounterEnvText =
    Object.keys(mounterSettings).length === 0
      ? undefined
      : JSON.stringify(readMounterEnv(mounterSettings));
  const flootDir = env.ENDO_FLOOT_DIR || env.FLOOT_DIR || 'floot';
  return harden({
    accountAuthority,
    backendName,
    rootfs,
    listenerImageRef,
    brokerDir,
    brokerOwnerId,
    brokerSettings,
    mounterEnvText,
    flootDir,
  });
};
harden(readHostedBackendEnvironment);

/**
 * The host-side services `setup-host.js` provisions, without which no
 * backend can be minted.
 *
 * @param {any} hostAgent
 * @param {string} sandboxDir The adapter's pet-name directory.
 * @param {string[]} names
 */
export const requireProvisioned = async (hostAgent, sandboxDir, names) => {
  await null;
  for (const name of names) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await E(hostAgent).has(sandboxDir, name))) {
      throw Fail`${q(`${sandboxDir}/${name}`)} is missing — run setup-host.js first.`;
    }
  }
};
harden(requireProvisioned);

/**
 * A retained storage owner's roots are the effective ones: the backend must
 * record sessions where that owner can remove them. The current
 * environment's roots apply only when the owner is minted now. Either way
 * they are refused here, before any mint, if the owner would refuse them at
 * construction: a formula that cannot construct is still bound and would be
 * retained by every later run.
 *
 * @param {any} hostAgent
 * @param {object} spec
 * @param {string} spec.prefix
 * @param {string} spec.sandboxDir
 * @param {{ workspaceDir: string, mcpDir: string }} spec.requestedRoots
 * @param {() => Promise<{ roots: { workspaceDir: string, mcpDir: string } }>} spec.readSessionStorage
 *   Reads the retained owner's persisted roots.
 * @returns {Promise<{ existingStorage: boolean, workspaceDir: string, mcpDir: string }>}
 */
export const resolveSessionStorageRoots = async (
  hostAgent,
  { prefix, sandboxDir, requestedRoots, readSessionStorage },
) => {
  await null;
  const existingStorage = await E(hostAgent).has(sandboxDir, 'session-storage');
  const { workspaceDir, mcpDir } = existingStorage
    ? (await readSessionStorage()).roots
    : requestedRoots;
  isNormalizedAbsolutePath(workspaceDir) ||
    Fail`${b(`${prefix}_WORKSPACE_DIR`)} (or the retained storage owner's root) must be a normalized absolute path: ${q(workspaceDir)}`;
  isNormalizedAbsolutePath(mcpDir) ||
    Fail`${b(`${prefix}_MCP_DIR`)} (or the retained storage owner's root) must be a normalized absolute path: ${q(mcpDir)}`;
  return harden({ existingStorage, workspaceDir, mcpDir });
};
harden(resolveSessionStorageRoots);

/**
 * The retained broker's persisted profile, when a broker service exists, its
 * account authority checked against the configuration: a retained broker
 * keeps its directory, owner, account and image pins, and a changed account
 * is refused, not silently discarded. The adapter then checks whatever else
 * of the profile is identity to it, and the image pins with
 * `assertRetainedBrokerImages`.
 *
 * @param {any} hostAgent
 * @param {object} spec
 * @param {string} spec.sandboxDir
 * @param {string} spec.accountAuthority
 * @param {() => Promise<{ config: any }>} spec.readBrokerService Reads the
 *   retained broker's persisted profile by its verified entrypoint.
 * @returns {Promise<any | undefined>} The profile, or undefined when no
 *   broker service exists.
 */
export const readRetainedBroker = async (
  hostAgent,
  { sandboxDir, accountAuthority, readBrokerService },
) => {
  await null;
  if (!(await E(hostAgent).has(sandboxDir, 'broker-service'))) {
    return undefined;
  }
  const retained = (await readBrokerService()).config;
  retained.accountAuthority === accountAuthority ||
    Fail`The retained ${q(`${sandboxDir}/broker-service`)} serves account authority ${q(retained.accountAuthority)} but the configuration now names ${q(accountAuthority)}; retire it deliberately`;
  return retained;
};
harden(readRetainedBroker);

/**
 * The listener runtime's own identity check of its image reference; setup
 * pins the slice image itself but never rewrites the listener reference.
 */
const LISTENER_IMAGE_PATTERN = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/;

/**
 * The owner label of a broker about to be minted, and everything the broker
 * kit would refuse of the operator's configuration, refused here before any
 * mint or directory creation. The label derives from the host identity
 * unless the operator named one.
 *
 * @param {any} hostAgent
 * @param {object} spec
 * @param {string} spec.label
 * @param {string} spec.prefix
 * @param {string} spec.ownerPrefix The derived owner label's prefix, e.g.
 *   `claude`.
 * @param {string} spec.brokerDir
 * @param {string} spec.brokerOwnerId The operator's owner label, or ''.
 * @param {string} spec.rootfs
 * @param {string} spec.listenerImageRef
 * @returns {Promise<string>} The broker's owner label.
 */
export const resolveMintedBrokerIdentity = async (
  hostAgent,
  {
    label,
    prefix,
    ownerPrefix,
    brokerDir,
    brokerOwnerId: requestedOwnerId,
    rootfs,
    listenerImageRef,
  },
) => {
  await null;
  if (listenerImageRef === '') {
    throw Fail`${b(`${prefix}_BROKER_LISTENER_IMAGE`)} is required: the backend records the broker service into every session plan`;
  }
  isNormalizedAbsolutePath(brokerDir) ||
    Fail`${b(`${prefix}_BROKER_DIR`)} must be a normalized absolute path: ${q(brokerDir)}`;
  let brokerOwnerId = requestedOwnerId;
  if (brokerOwnerId === '') {
    const hostId = await E(hostAgent).identify('@agent');
    if (typeof hostId !== 'string' || hostId.length === 0) {
      throw Fail`Cannot identify the ${b(label)} broker host`;
    }
    brokerOwnerId = `${ownerPrefix}-${createHash('sha256').update(hostId).digest('hex').slice(0, 48)}`;
  }
  BROKER_OWNER_PATTERN.test(brokerOwnerId) ||
    Fail`${b(`${prefix}_BROKER_OWNER_ID`)} must match ${q(BROKER_OWNER_PATTERN)}: ${q(brokerOwnerId)}`;
  LISTENER_IMAGE_PATTERN.test(listenerImageRef) ||
    Fail`${b(`${prefix}_BROKER_LISTENER_IMAGE`)} must be a lowercase, digest-pinned image reference: ${q(listenerImageRef)}`;
  readSliceImageReference(rootfs, label);
  return brokerOwnerId;
};
harden(resolveMintedBrokerIdentity);

/**
 * The per-session roots. The MCP socket base must be private and
 * symlink-free: a planted link there would redirect the per-session sockets
 * another process can then squat.
 *
 * @param {object} spec
 * @param {string} spec.prefix
 * @param {string} spec.workspaceDir
 * @param {string} spec.mcpDir
 */
export const provideSessionRoots = async ({ prefix, workspaceDir, mcpDir }) => {
  await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
  await providePrivateDirectory(`${prefix}_MCP_DIR`, mcpDir);
};
harden(provideSessionRoots);

/**
 * The backend refuses a guest root that resolves into protected storage on
 * every provision, so the layout is refused here rather than at the first
 * session. Roots not created yet resolve through their existing ancestors.
 *
 * @param {object} spec
 * @param {string} spec.label
 * @param {string} spec.prefix
 * @param {string} spec.workspaceDir
 * @param {string} spec.mcpDir
 * @param {string} spec.effectiveBrokerDir The retained broker's directory,
 *   or the one a broker would be minted into.
 * @param {string[]} spec.protectedRoots Every protected root, the broker
 *   directory among them, in the order the message names them.
 * @param {string} spec.protectedDescription How the message names them,
 *   e.g. `the broker directory and the runtime directory`.
 */
export const assertGuestRootsDisjoint = async ({
  label,
  prefix,
  workspaceDir,
  mcpDir,
  effectiveBrokerDir,
  protectedRoots,
  protectedDescription,
}) => {
  await null;
  isNormalizedAbsolutePath(effectiveBrokerDir) ||
    Fail`${b(`${prefix}_BROKER_DIR`)} (or the retained broker's directory) must be a normalized absolute path: ${q(effectiveBrokerDir)}`;
  const roots = await Promise.all(
    [workspaceDir, mcpDir, ...protectedRoots].map(root =>
      resolveFuturePath(root, label),
    ),
  );
  for (const [index, root] of roots.slice(0, 2).entries()) {
    for (const other of roots.slice(index + 1)) {
      if (containsPath(root, other) || containsPath(other, root)) {
        // The adapter's literal wording, not data: a details substitution
        // would quote it.
        throw makeError(
          `${label} guest roots overlap protected storage: the workspace and MCP roots must be disjoint from each other, ${protectedDescription}`,
        );
      }
    }
  }
};
harden(assertGuestRootsDisjoint);

/**
 * The provider broker service, an owned native service whose one exact
 * powers dependency is the credential. Its identity (owner, directory, image
 * pins, account, and whatever the adapter adds) is persisted in the formula
 * environment; an existing service is retained with it, and the operator's
 * settings are applied either way, at every start. Only asking Podman for an
 * unpinned slice image's digest and creating the broker directory wait for
 * the mint.
 *
 * @param {any} hostAgent
 * @param {object} spec
 * @param {string} spec.label
 * @param {string} spec.prefix
 * @param {string} spec.sandboxDir
 * @param {boolean} spec.existingBroker
 * @param {string} spec.rootfs
 * @param {Parameters<typeof resolvePinnedImageRef>[1]} [spec.exec]
 * @param {string} spec.brokerDir
 * @param {string} spec.brokerOwnerId
 * @param {string} spec.listenerImageRef
 * @param {Record<string, unknown>} spec.identity The adapter's own persisted
 *   identity fields, in the order the profile records them (the account
 *   authority among them).
 * @param {BrokerSettings} spec.brokerSettings
 * @param {string} spec.configEnvName The formula environment variable the
 *   profile is persisted under, e.g. `CLAUDE_BROKER_CONFIG`.
 * @param {(env: Record<string, string>) => unknown} spec.readBrokerConfig
 *   The broker agent's own reader, which refuses what it would refuse at
 *   construction.
 * @param {string} spec.specifier The broker service's entrypoint.
 * @param {string[]} spec.powersPath The credential the broker reads.
 * @param {string} spec.temporary The alias name used only for the mint.
 * @param {Record<string,string>} [spec.workloadEnv] Validated operator construction settings.
 */
export const provideBrokerService = async (
  hostAgent,
  {
    label,
    prefix,
    sandboxDir,
    existingBroker,
    rootfs,
    exec = undefined,
    brokerDir,
    brokerOwnerId,
    listenerImageRef,
    identity,
    brokerSettings,
    configEnvName,
    readBrokerConfig,
    specifier,
    powersPath,
    temporary,
    workloadEnv = {},
  },
) => {
  await null;
  const settingsEnv = readBrokerWorkloadEnv(workloadEnv);
  const brokerPath = [sandboxDir, 'broker-service'];
  if (existingBroker) {
    const retained = await readProvisionedEnvironment(hostAgent, {
      label,
      namePath: brokerPath,
      expectedSpecifier: specifier,
    });
    const recorded = readBrokerWorkloadEnv(retained.env);
    for (const key of new Set([
      ...Object.keys(recorded),
      ...Object.keys(settingsEnv),
    ])) {
      recorded[key] === settingsEnv[key] ||
        Fail`${b(label)} broker workload configuration changed at ${key}; stop and retire its retained owner before replacing it`;
    }
    console.log(
      `Retaining ${label} broker service with its persisted configuration; its slice and listener images match the current pins.`,
    );
  } else {
    const { imageRef, imageDigest } = await resolvePinnedImageRef(
      rootfs,
      exec,
      label,
    );
    await providePrivateDirectory(`${prefix}_BROKER_DIR`, brokerDir);
    await forgetBrokerSettings(brokerDir);
    const brokerConfig = JSON.stringify({
      ownerId: brokerOwnerId,
      directory: brokerDir,
      imageRef,
      imageDigest,
      listenerImageRef,
      ...identity,
      ...brokerSettings,
    });
    readBrokerConfig({ [configEnvName]: brokerConfig });
    await mintWithPowersPath(hostAgent, {
      powersPath,
      temporary,
      specifier,
      resultName: brokerPath,
      env: { [configEnvName]: brokerConfig, ...settingsEnv },
    });
    console.log(`Minted ${sandboxDir}/broker-service`);
  }
  await configureBroker(hostAgent, brokerPath, brokerSettings, label);
};
harden(provideBrokerService);

/**
 * The hosted backend factory: a pinned unconfined caplet whose module path is
 * tied to a release checkout, holding no durable state of its own, so it is
 * re-created on every run. It runs with `@agent` host powers, but Floot only
 * ever receives the guarded factory facet. The replacement is minted under a
 * temporary name before the live one is touched: if the mint fails, the
 * existing backend and the Floot binding to it keep working.
 *
 * @param {any} hostAgent
 * @param {object} spec
 * @param {string} spec.label
 * @param {string} spec.sandboxDir
 * @param {string} spec.specifier The backend module's current specifier.
 * @param {string} spec.envPrefix The backend's own variable prefix, e.g.
 *   `CLAUDE` for `CLAUDE_WORKSPACE_BASE_DIR`.
 * @param {string} spec.workspaceDir
 * @param {string} spec.mcpDir
 * @param {string | undefined} spec.mounterEnvText
 * @returns {Promise<string[]>} The backend's pet-name path.
 */
export const provideBackendCaplet = async (
  hostAgent,
  {
    label,
    sandboxDir,
    specifier,
    envPrefix,
    workspaceDir,
    mcpDir,
    mounterEnvText,
  },
) => {
  await null;
  const backendPath = [sandboxDir, 'backend'];
  const backendNextPath = [sandboxDir, 'backend-next'];
  if (await E(hostAgent).has(...backendNextPath)) {
    await E(hostAgent).remove(...backendNextPath);
  }
  await E(hostAgent).makeUnconfined('@main', specifier, {
    powersName: '@agent',
    resultName: backendNextPath,
    env: harden({
      [`${envPrefix}_WORKSPACE_BASE_DIR`]: workspaceDir,
      [`${envPrefix}_MCP_DIR`]: mcpDir,
      ...(mounterEnvText === undefined
        ? {}
        : { [`${envPrefix}_MOUNTER_ENV`]: mounterEnvText }),
    }),
  });
  await E(hostAgent).copy(backendNextPath, backendPath);
  await E(hostAgent).remove(...backendNextPath);
  console.log(
    `Minted the ${label} hosted backend at "${backendPath.join('/')}".`,
  );
  return harden(backendPath);
};
harden(provideBackendCaplet);

/**
 * Floot's factory discovers hosted backends by name in its own profile
 * (controller-profile), not at the host root, so the factory facet is copied
 * in. Re-copying keeps it pointed at the backend minted above across restarts
 * and release pruning; copy overwrites an existing binding, so no remove is
 * needed, and removing first would open a window in which Floot cannot
 * discover the backend if the copy fails. An adapter whose factory publishes
 * new-project workspaces also names the host-global static asset server,
 * bound the same way so the factory resolves it from its own powers; the
 * asset server's setup re-mints it against the current release each start.
 *
 * @param {any} hostAgent
 * @param {object} spec
 * @param {string} spec.flootDir
 * @param {string} spec.backendName
 * @param {string[]} spec.backendPath
 * @param {string} [spec.assetServerName]
 * @returns {Promise<boolean>} Whether the profile exists and was bound.
 */
export const bindFlootBackend = async (
  hostAgent,
  { flootDir, backendName, backendPath, assetServerName = undefined },
) => {
  await null;
  if (!(await E(hostAgent).has(flootDir, 'controller-profile'))) {
    console.warn(
      `Floot controller profile "${flootDir}/controller-profile" is absent; skipping the "${backendName}" binding.`,
    );
    return false;
  }
  await E(hostAgent).copy(backendPath, [
    flootDir,
    'controller-profile',
    backendName,
  ]);
  console.log(`Bound "${backendName}" into "${flootDir}/controller-profile".`);
  if (assetServerName !== undefined) {
    if (await E(hostAgent).has(assetServerName)) {
      await E(hostAgent).copy(
        [assetServerName],
        [flootDir, 'controller-profile', assetServerName],
      );
      console.log(
        `Bound "${assetServerName}" into "${flootDir}/controller-profile".`,
      );
    } else {
      console.log(
        `Asset server "${assetServerName}" is absent; new-project publishing stays disabled.`,
      );
    }
  }
  return true;
};
harden(bindFlootBackend);

/**
 * The account's discovery: its oracle, and the broker as a Subscription that
 * shares are made over (`provideSubscriptionShare`), re-minted so they
 * follow a new broker.
 *
 * @param {any} hostAgent
 * @param {object} spec
 * @param {string} spec.label
 * @param {string} spec.sandboxDir
 * @param {string} spec.providerId
 * @param {string} spec.flootDir
 * @param {string} spec.backendId
 * @param {string} spec.accountAuthority
 * @param {string[]} [spec.subscriptionIds] A pool's members.
 */
export const publishHostedAccount = async (
  hostAgent,
  {
    label,
    sandboxDir,
    providerId,
    flootDir,
    backendId,
    accountAuthority,
    subscriptionIds = undefined,
  },
) => {
  await publishAccountOracle(hostAgent, {
    label,
    dir: sandboxDir,
    providerId,
    flootDir,
    backendId,
    accountAuthority,
    ...(subscriptionIds ? { subscriptionIds } : {}),
  });
  await publishBrokerSubscription(hostAgent, { label, dir: sandboxDir });
  console.log(
    `Hosted ${label} sandbox ready. Floot sessions on backend "${backendId}" are recorded under "${sandboxDir}/session-records" and owned by the daemon.`,
  );
};
harden(publishHostedAccount);
