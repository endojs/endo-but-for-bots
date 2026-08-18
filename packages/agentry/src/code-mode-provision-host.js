// @ts-check
/// <reference types="ses"/>

/** @import { EndoGuest, EndoHost, EndoMount } from '@endo/daemon' */
/** @import { GitRemote, GitRemoteController } from '@endo/exo-git' */
/** @import { EndoProvisionPersistence } from './code-mode-provisioning-types.js' */

import { makeError, q, X } from '@endo/errors';
import { E } from '@endo/eventual-send';

import {
  equalEndoProvisionPersistence,
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
 * @param {EndoHost} host
 * @param {EndoProvisionPersistence} persistence
 * @param {Map<string, GitCredential>} credentials
 * @returns {Promise<EndoGuest>}
 */
const realizeProvisionResources = async (host, persistence, credentials) => {
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
 * @returns {Promise<EndoGuest>}
 */
export const realizeEndoProvisionOnHost = async (host, persistence) => {
  // Revalidate the caller-held record immediately before minting capabilities.
  // This catches a moved or symlink-swapped canonical root during first
  // realization, not only during a later daemon restart.
  const normalizedPersistence =
    await validateEndoProvisionPersistence(persistence);
  const controllerPath = persistence.guestHandlePath.slice(0, -1);
  const persistencePath = harden([...controllerPath, 'persistence']);
  const hasPersistence = await hasNamePath(host, persistencePath);
  if (hasPersistence) {
    const stored = await E(host).lookup(persistencePath);
    const normalizedStored = await validateEndoProvisionPersistence(stored);
    if (
      !equalEndoProvisionPersistence(normalizedStored, normalizedPersistence)
    ) {
      throw makeError(
        X`Reconstruction cannot widen or change a retained code-mode provision policy`,
      );
    }
  }
  const credentials = await resolveGitCredentials(host, normalizedPersistence);
  return realizeProvisionResources(host, normalizedPersistence, credentials);
};
harden(realizeEndoProvisionOnHost);
