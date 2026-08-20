// @ts-check
/// <reference types="ses"/>

/** @import { EndoGuest, EndoHost, EndoMount } from '@endo/daemon' */
/** @import { GitRemote, GitRemoteController } from '@endo/exo-git' */
/** @import { EndoProvisionForkOptions, EndoProvisionPersistence } from './code-mode-provisioning-types.js' */

import { makeError, q, X } from '@endo/errors';
import { E } from '@endo/eventual-send';

import {
  equalEndoProvisionPersistence,
  projectEndoProvisionRuntimeAuthority,
  validateEndoProvisionPersistence,
} from './code-mode-provision-policy.js';
import { registerProvisionedGuest } from './code-mode-grants.js';

/** @typedef {{ audience(): Promise<string> }} GitCredential */
/** @typedef {{ inspect(): Promise<{ available: boolean, revoked?: boolean }> }} GitCredentialController */
/** @typedef {Parameters<EndoHost['provideGitRemote']>[2]} GitRemoteProvisionOptions */

/**
 * An actionable reconstruction failure for a durable credential whose
 * process-local material did not survive a daemon restart.
 */
export class EndoCredentialUnavailableError extends Error {
  /**
   * @param {string} remoteName
   * @param {string | string[]} credentialPetName
   */
  constructor(remoteName, credentialPetName) {
    super(
      `Git credential ${JSON.stringify(credentialPetName)} for remote ${JSON.stringify(remoteName)} is unavailable; reprovision the credential on the host and retry`,
    );
    this.name = 'EndoCredentialUnavailableError';
    this.code = 'ENDO_CREDENTIAL_UNAVAILABLE';
    this.remoteName = remoteName;
    this.credentialPetName = credentialPetName;
  }
}
harden(EndoCredentialUnavailableError);

/**
 * @param {EndoHost} host
 * @param {string[]} namePath
 * @returns {Promise<boolean>}
 */
const hasNamePath = async (host, namePath) => {
  await null;
  for (let length = 1; length <= namePath.length; length += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await E(host).has(...namePath.slice(0, length)))) {
      return false;
    }
  }
  return true;
};

/**
 * @param {EndoHost} host
 * @param {string[]} namePath
 */
const ensureNameDirectory = async (host, namePath) => {
  await null;
  if (!(await hasNamePath(host, namePath))) {
    await E(host).makeDirectory(namePath);
  }
};

/**
 * @param {EndoHost} host
 * @param {string[]} namePath
 * @param {() => Promise<unknown>} provide
 * @returns {Promise<unknown>}
 */
const provideOrLookup = async (host, namePath, provide) => {
  await null;
  if (await hasNamePath(host, namePath)) {
    return E(host).lookup(namePath);
  }
  return provide();
};

/**
 * @param {EndoHost} host
 * @param {EndoProvisionPersistence} persistence
 * @returns {Promise<Map<string, GitCredential>>}
 */
const resolveGitCredentials = async (host, persistence) => {
  await null;
  /** @type {Map<string, GitCredential>} */
  const credentials = new Map();
  for (const [name, remote] of Object.entries(
    persistence.policy.gitRemotes ?? {},
  )) {
    if (remote.credential !== undefined) {
      // Sequential by design: credential diagnostics stay deterministic and no
      // host lookup is left outstanding after the first failure.
      let lookedUp;
      try {
        // eslint-disable-next-line no-await-in-loop
        lookedUp = await E(host).lookup(remote.credential);
      } catch {
        throw new EndoCredentialUnavailableError(name, remote.credential);
      }
      const credential = /** @type {GitCredential} */ (lookedUp);
      let controller;
      try {
        // eslint-disable-next-line no-await-in-loop
        controller = await E(host).getGitCredentialController(credential);
      } catch {
        throw makeError(
          X`Credential pet name ${q(JSON.stringify(remote.credential))} for remote ${q(name)} does not name a daemon-minted Git credential`,
        );
      }
      const credentialController = /** @type {GitCredentialController} */ (
        controller
      );
      // eslint-disable-next-line no-await-in-loop
      const inspection = await E(credentialController).inspect();
      if (
        !inspection ||
        inspection.available !== true ||
        inspection.revoked === true
      ) {
        throw new EndoCredentialUnavailableError(name, remote.credential);
      }
      // eslint-disable-next-line no-await-in-loop
      const audience = await E(credential).audience();
      const expectedAudience = new URL(remote.url).origin;
      if (audience !== expectedAudience) {
        throw makeError(
          X`Credential audience ${q(audience)} does not match remote ${q(name)} audience ${q(expectedAudience)}`,
        );
      }
      credentials.set(name, credential);
    }
  }
  return credentials;
};

/**
 * Replace a retained credentialed remote so its formula records the current
 * host credential formula ID instead of retaining the ID from an earlier
 * reprovisioning.
 *
 * @param {EndoHost} host
 * @param {unknown} git
 * @param {string[]} remoteAlias
 * @param {GitRemoteProvisionOptions} options
 * @returns {Promise<unknown>}
 */
const reprovisionCredentialedRemote = async (
  host,
  git,
  remoteAlias,
  options,
) => {
  await null;
  if (await hasNamePath(host, remoteAlias)) {
    const previous = /** @type {GitRemote} */ (
      await E(host).lookup(remoteAlias)
    );
    const controller = /** @type {GitRemoteController} */ (
      await E(host).getGitRemoteController(previous)
    );
    await E(controller).revoke();
  }
  return E(host).provideGitRemote(git, remoteAlias, options);
};

/**
 * Resolve each requested grant once and retain its exact formula identifier.
 * Reusing that identifier prevents a concurrent host-name change from
 * substituting a different capability between resolution and retention.
 *
 * @param {EndoHost} host
 * @param {EndoProvisionPersistence} persistence
 * @returns {Promise<Map<string, string>>}
 */
const resolveGrantIdentifiers = async (host, persistence) => {
  await null;
  const identifiers = new Map();
  for (const [name, grant] of Object.entries(persistence.policy.grants ?? {})) {
    // eslint-disable-next-line no-await-in-loop
    const id = await E(host).identify(...grant.from);
    if (typeof id !== 'string') {
      throw makeError(
        X`Grant ${q(name)} source ${q(grant.from.join('/'))} is not available on the host`,
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await E(host).lookupById(id);
    identifiers.set(name, id);
  }
  return identifiers;
};

/**
 * @param {EndoHost} host
 * @param {EndoProvisionPersistence} persistence
 * @returns {Promise<void>}
 */
const assertRetainedGrantAliases = async (host, persistence) => {
  await null;
  const controllerPath = persistence.guestHandlePath.slice(0, -1);
  for (const name of Object.keys(persistence.policy.grants ?? {})) {
    const alias = harden([...controllerPath, 'grants', name]);
    // eslint-disable-next-line no-await-in-loop
    if (!(await hasNamePath(host, alias))) {
      throw makeError(
        X`Retained code-mode grant ${q(name)} is missing; refusing to re-resolve its host source`,
      );
    }
  }
};

/**
 * Resolve formula identifiers only after retained aliases have been checked.
 * This is used for forks, where the identifiers are copied into a new
 * controller namespace instead of resolving the parent's source paths.
 *
 * @param {EndoHost} host
 * @param {EndoProvisionPersistence} persistence
 * @returns {Promise<Map<string, string>>}
 */
const resolveRetainedGrantIdentifiers = async (host, persistence) => {
  await assertRetainedGrantAliases(host, persistence);
  const controllerPath = persistence.guestHandlePath.slice(0, -1);
  const identifiers = new Map();
  for (const name of Object.keys(persistence.policy.grants ?? {})) {
    const alias = harden([...controllerPath, 'grants', name]);
    // eslint-disable-next-line no-await-in-loop
    const id = await E(host).identify(...alias);
    if (typeof id !== 'string') {
      throw makeError(
        X`Retained code-mode grant ${q(name)} has no formula identifier`,
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await E(host).lookupById(id);
    identifiers.set(name, id);
  }
  return identifiers;
};

/**
 * Validate a retained parent session and obtain the exact formula identifiers
 * retained by its controller aliases for a child fork.
 *
 * @param {EndoHost} host
 * @param {EndoProvisionPersistence} parent
 * @param {EndoProvisionPersistence} child
 * @returns {Promise<Map<string, string>>}
 */
const resolveForkGrantIdentifiers = async (host, parent, child) => {
  await null;
  const normalizedParent = await validateEndoProvisionPersistence(parent);
  const normalizedChild = await validateEndoProvisionPersistence(child);
  if (
    equalEndoProvisionPersistence(
      normalizedParent.guestHandlePath,
      normalizedChild.guestHandlePath,
    )
  ) {
    throw makeError(
      X`Fork target must use a distinct retained guest namespace`,
    );
  }

  const parentControllerPath = normalizedParent.guestHandlePath.slice(0, -1);
  const parentPersistencePath = harden([
    ...parentControllerPath,
    'persistence',
  ]);
  if (!(await hasNamePath(host, parentPersistencePath))) {
    throw makeError(
      X`Fork parent has no retained code-mode policy; refusing to copy grants`,
    );
  }
  const storedParent = await E(host).lookup(parentPersistencePath);
  const normalizedStoredParent =
    await validateEndoProvisionPersistence(storedParent);
  if (
    !equalEndoProvisionPersistence(normalizedStoredParent, normalizedParent)
  ) {
    throw makeError(
      X`Fork parent retained policy does not match the requested parent`,
    );
  }

  const childControllerPath = normalizedChild.guestHandlePath.slice(0, -1);
  const childPersistencePath = harden([...childControllerPath, 'persistence']);
  if (await hasNamePath(host, childPersistencePath)) {
    throw makeError(
      X`Fork target already has retained code-mode policy; refusing to copy grants`,
    );
  }

  if (
    !equalEndoProvisionPersistence(
      projectEndoProvisionRuntimeAuthority(normalizedParent),
      projectEndoProvisionRuntimeAuthority(normalizedChild),
    )
  ) {
    throw makeError(
      X`Fork provision policies select different runtime authority`,
    );
  }
  if (
    !equalEndoProvisionPersistence(
      normalizedParent.policy,
      normalizedChild.policy,
    )
  ) {
    throw makeError(X`Fork provision policies have different session context`);
  }

  return resolveRetainedGrantIdentifiers(host, normalizedParent);
};

/**
 * @param {EndoHost} host
 * @param {EndoProvisionPersistence} persistence
 * @param {Map<string, GitCredential>} credentials
 * @param {Map<string, string> | undefined} grantIdentifiersToInstall
 * @returns {Promise<EndoGuest>}
 */
const realizeProvisionResources = async (
  host,
  persistence,
  credentials,
  grantIdentifiersToInstall,
) => {
  const controllerPath = persistence.guestHandlePath.slice(0, -1);
  const guestAgentPath = harden([...controllerPath, 'guest-agent']);
  const persistencePath = harden([...controllerPath, 'persistence']);
  await ensureNameDirectory(host, ['code-mode']);
  await ensureNameDirectory(host, persistence.guestHandlePath.slice(0, 2));
  await ensureNameDirectory(host, controllerPath);

  // Record the authenticated policy before creating any capability aliases.
  // If provisioning is interrupted after this point, a later attempt cannot
  // reuse those aliases under a changed policy.
  if (!(await hasNamePath(host, persistencePath))) {
    await E(host).storeValue(persistence, persistencePath);
  }

  /** @type {Array<[string, string[]]>} */
  const guestBindings = [];
  const mountsPath = harden([...controllerPath, 'mounts']);
  await ensureNameDirectory(host, mountsPath);
  /** @type {Map<string, EndoMount>} */
  const mounts = new Map();
  for (const [name, grant] of Object.entries(persistence.policy.mounts)) {
    const mountPath = harden([...mountsPath, name]);
    const mountAlias = harden([...mountPath, 'mount']);
    // eslint-disable-next-line no-await-in-loop
    await ensureNameDirectory(host, mountPath);
    const mount = /** @type {EndoMount} */ (
      // eslint-disable-next-line no-await-in-loop
      await provideOrLookup(host, mountAlias, () =>
        E(host).provideMount(grant.root, mountAlias, {
          readOnly: grant.mode === 'readOnly',
          deniedSegments: grant.deniedSegments,
        }),
      )
    );
    mounts.set(name, mount);
    if (grant.guestBinding) {
      guestBindings.push([name, mountAlias]);
    }
  }

  const gitsPath = harden([...controllerPath, 'gits']);
  /** @type {Map<string, unknown>} */
  const gits = new Map();
  await ensureNameDirectory(host, gitsPath);
  for (const [name, grant] of Object.entries(persistence.policy.gits ?? {})) {
    const grantPath = harden([...gitsPath, name]);
    const gitMountAlias = harden([...grantPath, 'mount']);
    const gitAlias = harden([...grantPath, 'git']);
    // eslint-disable-next-line no-await-in-loop
    await ensureNameDirectory(host, grantPath);
    const selectedMount = mounts.get(grant.mount);
    if (selectedMount === undefined) {
      throw makeError(
        X`Git grant ${q(name)} selects a mount that was not realized`,
      );
    }
    const gitMount = /** @type {EndoMount} */ (
      // A Git grant gets a fresh exact-root mount. The selected named mount is
      // the authority ceiling; this derived mount prevents a Git capability
      // from silently covering unrelated paths in that mount.
      // eslint-disable-next-line no-await-in-loop
      await provideOrLookup(host, gitMountAlias, () =>
        E(host).provideMount(grant.root, gitMountAlias, {
          readOnly: grant.mode === 'readOnly',
          deniedSegments: persistence.policy.mounts[grant.mount].deniedSegments,
        }),
      )
    );
    // eslint-disable-next-line no-await-in-loop
    const git = await provideOrLookup(host, gitAlias, () =>
      E(host).provideGit(gitMount, gitAlias, {
        allowHistoryRewrite: grant.mode === 'historyRewrite',
        readOnly: grant.mode === 'readOnly',
      }),
    );
    gits.set(name, git);
    guestBindings.push([name, gitAlias]);
  }

  const rootGit = gits.get('git');
  if (rootGit !== undefined) {
    // Git remotes live under their own namespace container so a remote name
    // can never resolve to a trusted infrastructure sibling of controllerPath
    // (the persistence record, guest handle, or guest agent). A flat sibling
    // alias would otherwise let a remote named `persistence` substitute the
    // stored persistence record for a minted GitRemote.
    const remotesPath = harden([...controllerPath, 'remotes']);
    await ensureNameDirectory(host, remotesPath);
    for (const [name, remote] of Object.entries(
      persistence.policy.gitRemotes ?? {},
    )) {
      const remoteAlias = harden([...remotesPath, name]);
      const remoteOptions = {
        name,
        url: remote.url,
        allowedDirections: remote.allowedDirections,
        fetchRefspecs: remote.fetchRefspecs,
        pushRefspecs: remote.pushRefspecs,
        ...(remote.defaultPullRef === undefined
          ? {}
          : { defaultPullRef: remote.defaultPullRef }),
        allowForcePush: remote.allowForcePush,
        allowTags: remote.allowTags,
        allowDelete: remote.allowDelete,
        allowLocalFileTransport: remote.allowLocalFileTransport,
        ...(remote.credential === undefined
          ? {}
          : { credential: credentials.get(name) }),
      };
      if (remote.credential === undefined) {
        // eslint-disable-next-line no-await-in-loop
        await provideOrLookup(host, remoteAlias, () =>
          E(host).provideGitRemote(rootGit, remoteAlias, remoteOptions),
        );
      } else {
        // eslint-disable-next-line no-await-in-loop
        await reprovisionCredentialedRemote(
          host,
          rootGit,
          remoteAlias,
          remoteOptions,
        );
      }
      guestBindings.push([name, remoteAlias]);
    }
  } else if (Object.keys(persistence.policy.gitRemotes ?? {}).length > 0) {
    throw makeError(X`Git remotes have no retained root Git grant`);
  }

  const httpPolicy = persistence.policy.http;
  if (httpPolicy !== undefined) {
    const httpAlias = harden([...controllerPath, 'http']);
    await provideOrLookup(host, httpAlias, () =>
      E(host).provideHttpClient(httpAlias, httpPolicy),
    );
    // Only the client is bound into the guest. The policy-bearing
    // `HttpClientControl` stays reachable from the host alone, so a session
    // cannot widen its own allowlist or lift its own bounds.
    guestBindings.push(['http', httpAlias]);
  }

  const grantEntries = Object.entries(persistence.policy.grants ?? {});
  if (grantEntries.length > 0) {
    const grantsPath = harden([...controllerPath, 'grants']);
    await ensureNameDirectory(host, grantsPath);
  }
  for (const [name] of grantEntries) {
    const grantAlias = harden([...controllerPath, 'grants', name]);
    if (grantIdentifiersToInstall !== undefined) {
      // eslint-disable-next-line no-await-in-loop
      if (await hasNamePath(host, grantAlias)) {
        throw makeError(
          X`Retained code-mode grant ${q(name)} exists without a retained policy`,
        );
      }
      const id = grantIdentifiersToInstall.get(name);
      if (id === undefined) {
        throw makeError(X`No resolved formula for grant ${q(name)}`);
      }
      // eslint-disable-next-line no-await-in-loop
      await E(host).storeIdentifier(grantAlias, id);
      // eslint-disable-next-line no-await-in-loop
    } else if (!(await hasNamePath(host, grantAlias))) {
      throw makeError(
        X`Retained code-mode grant ${q(name)} is missing; refusing to re-resolve its host source`,
      );
    }
    guestBindings.push([name, grantAlias]);
  }

  const hasHandle = await hasNamePath(host, persistence.guestHandlePath);
  const hasAgent = await hasNamePath(host, guestAgentPath);
  if (hasHandle !== hasAgent) {
    throw makeError(
      X`Retained code-mode guest is incomplete; its handle and agent paths disagree`,
    );
  }
  const guest = /** @type {EndoGuest} */ (
    hasAgent
      ? await E(host).lookup(guestAgentPath)
      : await E(host).provideGuest(persistence.guestHandlePath, {
          agentName: guestAgentPath,
        })
  );

  for (const [guestName, controllerAlias] of guestBindings) {
    // eslint-disable-next-line no-await-in-loop
    const id = await E(host).identify(...controllerAlias);
    if (typeof id !== 'string') {
      throw makeError(
        X`Controller alias ${q(controllerAlias.join('/'))} has no formula identifier`,
      );
    }
    // Identifier sharing preserves the controller alias and binds the exact
    // same retained formula into the guest under its simple lexical pet name.
    // eslint-disable-next-line no-await-in-loop
    await E(guest).storeIdentifier(guestName, id);
  }

  registerProvisionedGuest(guest);
  return guest;
};

/**
 * Validate any retained policy before realizing its daemon-side resources.
 *
 * @param {EndoHost} host
 * @param {EndoProvisionPersistence} persistence
 * @param {EndoProvisionForkOptions} [options]
 * @returns {Promise<EndoGuest>}
 */
export const realizeEndoProvisionOnHost = async (
  host,
  persistence,
  options = {},
) => {
  const normalizedPersistence =
    await validateEndoProvisionPersistence(persistence);
  const controllerPath = normalizedPersistence.guestHandlePath.slice(0, -1);
  const persistencePath = harden([...controllerPath, 'persistence']);
  const hasPersistence = await hasNamePath(host, persistencePath);
  /** @type {Map<string, string> | undefined} */
  let grantIdentifiersToInstall;
  if (options.forkFrom !== undefined) {
    grantIdentifiersToInstall = await resolveForkGrantIdentifiers(
      host,
      options.forkFrom,
      normalizedPersistence,
    );
  } else if (hasPersistence) {
    const stored = await E(host).lookup(persistencePath);
    const normalizedStored = await validateEndoProvisionPersistence(stored);
    if (
      !equalEndoProvisionPersistence(normalizedStored, normalizedPersistence)
    ) {
      throw makeError(
        X`Reconstruction cannot widen or change a retained code-mode provision policy`,
      );
    }
    await assertRetainedGrantAliases(host, normalizedPersistence);
  } else {
    await null;
    grantIdentifiersToInstall = await resolveGrantIdentifiers(
      host,
      normalizedPersistence,
    );
  }
  const credentials = await resolveGitCredentials(host, normalizedPersistence);
  return realizeProvisionResources(
    host,
    normalizedPersistence,
    credentials,
    grantIdentifiersToInstall,
  );
};
harden(realizeEndoProvisionOnHost);
