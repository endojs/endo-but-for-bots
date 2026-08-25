// @ts-check
/// <reference types="ses"/>

/** @import { EndoGuestAuthority, EndoGuestAuthorityPolicy, HostProvisionPowers, NormalizedGitProvision, NormalizedGitRemoteProvision, NormalizedMountProvision, ResolvedCredential } from './types.js' */
/** @import { EndoGuest, NameOrPath } from '../types.js' */
/** @typedef {{ audience: () => string }} GitCredential */
/** @typedef {{ inspect: () => Promise<{ available: boolean, revoked: boolean }> }} GitCredentialController */

import { makeError, q, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { normalizeGitRemotePolicy } from '@endo/exo-git';
import { keyEQ, mustMatch } from '@endo/patterns';

import { isConfinedPath } from '../mount.js';
import { isPetName, namePathFrom } from '../pet-name.js';
import { EndoGuestAuthorityShape } from './shapes.js';
import {
  allInOrder,
  assertNoSecretSearchParams,
  assertPathString,
  assertProvisionBindingName,
  normalizeDeniedSegments,
} from './naming.js';

/** @param {string} binding */
const makeCredentialUnavailable = binding =>
  makeError(
    X`ENDO_CREDENTIAL_UNAVAILABLE: Credential for Git remote binding ${q(binding)} is unavailable`,
    Error,
    { code: 'ENDO_CREDENTIAL_UNAVAILABLE' },
  );

export { EndoGuestAuthorityShape } from './shapes.js';
export { assertNoSecretSearchParams } from './naming.js';

/**
 * @param {string} left
 * @param {string} right
 */
const compareStrings = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * @param {NameOrPath} value
 * @param {string} label
 */
const normalizeNameOrPath = (value, label) => {
  let path;
  try {
    path = namePathFrom(value);
  } catch {
    throw makeError(X`${q(label)} must be a pet name or name path`);
  }
  return typeof value === 'string' ? value : harden([...path]);
};

/**
 * Construct the host-side authority provider used by `EndoHost.provideGuest`.
 * The named guest remains the lifecycle anchor; this helper only validates,
 * records, realizes, and binds its immutable capability graph.
 *
 * @param {HostProvisionPowers} powers
 */
export const makeGuestAuthorityProvider = powers => {
  const {
    pathPowers,
    has,
    identify,
    lookup,
    makeDirectory,
    storeValue,
    provideMount,
    provideGit,
    provideGitRemote,
    getGitCredentialController,
    bindGuest,
    bindGuestIdentifier,
  } = powers;

  if (pathPowers === undefined) {
    const unavailable = async () => {
      throw makeError(X`Guest authority path powers are not available`);
    };
    return harden({
      hasGuestAuthority: async () => false,
      provideGuestAuthority: unavailable,
      retainedAuthorityBindings: async () => new Set(),
    });
  }

  const { realPath, isDirectory, resolvePath, isAbsolutePath } = pathPowers;

  /**
   * @param {string} candidate
   * @param {string} label
   */
  const canonicalDirectory = async (candidate, label) => {
    await null;
    let canonical;
    try {
      canonical = await realPath(candidate);
    } catch {
      throw makeError(X`${q(label)} does not exist or cannot be resolved`);
    }
    if (!(await isDirectory(canonical))) {
      throw makeError(X`${q(label)} must resolve to a directory`);
    }
    return canonical;
  };

  /** @param {string[]} namePath */
  const hasNamePath = async namePath => {
    for (let length = 1; length <= namePath.length; length += 1) {
      // The directory walk must stop at the first missing ancestor.
      // eslint-disable-next-line no-await-in-loop
      if (!(await has(...namePath.slice(0, length)))) return false;
    }
    return true;
  };

  /** @param {string[]} namePath */
  const ensureDirectory = async namePath => {
    if (!(await hasNamePath(namePath))) await makeDirectory(namePath);
  };

  /**
   * @param {string[]} namePath
   * @param {() => Promise<unknown>} provide
   */
  const provideOrLookup = async (namePath, provide) =>
    (await hasNamePath(namePath)) ? lookup(namePath) : provide();

  /**
   * @param {EndoGuestAuthority} authority
   * @returns {Promise<EndoGuestAuthorityPolicy>}
   */
  const normalizeAuthority = async authority => {
    mustMatch(authority, EndoGuestAuthorityShape, 'Endo guest authority');
    /** @type {Array<[string, Promise<NormalizedMountProvision>]>} */
    const mountJobs = Object.entries(authority.mount ?? {})
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([name, grant]) => {
        assertProvisionBindingName(name, `mount binding ${name}`);
        const label = `authority.mount.${name}`;
        const path = assertPathString(grant.path, `${label}.path`);
        if (!isAbsolutePath(path)) {
          throw makeError(X`${q(`${label}.path`)} must be absolute`);
        }
        return [
          name,
          canonicalDirectory(resolvePath(path), `${label}.path`).then(root =>
            harden({
              root,
              readOnly: grant.readOnly ?? false,
              deniedSegments: normalizeDeniedSegments(
                grant.deniedSegments,
                `${label}.deniedSegments`,
              ),
            }),
          ),
        ];
      });
    const mountValues = await allInOrder(mountJobs.map(([, job]) => job));
    const mount = /** @type {Record<string, NormalizedMountProvision>} */ (
      Object.fromEntries(
        mountJobs.map(([name], index) => [name, mountValues[index]]),
      )
    );

    /** @type {Array<[string, Promise<NormalizedGitProvision>]>} */
    const gitJobs = Object.entries(authority.git ?? {})
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([name, grant]) => {
        assertProvisionBindingName(name, `git binding ${name}`);
        const label = `authority.git.${name}`;
        assertProvisionBindingName(grant.mount, `${label}.mount`);
        const selectedMount = mount[grant.mount];
        if (selectedMount === undefined) {
          throw makeError(
            X`${q(`${label}.mount`)} names an unavailable mount binding ${q(grant.mount)}`,
          );
        }
        const readOnly = grant.readOnly ?? false;
        const allowHistoryRewrite = grant.allowHistoryRewrite ?? false;
        if (selectedMount.readOnly && !readOnly) {
          throw makeError(
            X`writable Git binding ${q(name)} requires a writable selected mount`,
          );
        }
        if (readOnly && allowHistoryRewrite) {
          throw makeError(
            X`read-only Git binding ${q(name)} cannot allow history rewrite`,
          );
        }
        const path = grant.path.map((segment, index) => {
          if (
            !isPetName(segment) ||
            segment === '.' ||
            segment === '..' ||
            segment.includes('/') ||
            segment.includes('\\') ||
            selectedMount.deniedSegments.includes(segment.toLowerCase())
          ) {
            throw makeError(
              X`${q(`${label}.path[${index}]`)} must be an allowed relative path segment`,
            );
          }
          return segment;
        });
        const rootJob = canonicalDirectory(
          resolvePath(selectedMount.root, ...path),
          `${label}.path`,
        ).then(async root => {
          await null;
          if (!(await isConfinedPath(root, selectedMount.root, pathPowers))) {
            throw makeError(
              X`${q(`${label}.path`)} escapes selected mount ${q(grant.mount)}`,
            );
          }
          return harden({
            mount: grant.mount,
            path: harden([...path]),
            root,
            readOnly,
            allowHistoryRewrite,
          });
        });
        return [name, rootJob];
      });
    const gitValues = await allInOrder(gitJobs.map(([, job]) => job));
    const git = /** @type {Record<string, NormalizedGitProvision>} */ (
      Object.fromEntries(
        gitJobs.map(([name], index) => [name, gitValues[index]]),
      )
    );

    const gitRemote =
      /** @type {Record<string, NormalizedGitRemoteProvision>} */ (
        Object.fromEntries(
          Object.entries(authority.gitRemote ?? {})
            .sort(([left], [right]) => compareStrings(left, right))
            .map(([binding, remote]) => {
              assertProvisionBindingName(
                binding,
                `gitRemote binding ${binding}`,
              );
              const label = `authority.gitRemote.${binding}`;
              assertProvisionBindingName(remote.git, `${label}.git`);
              const selectedGit = git[remote.git];
              if (selectedGit === undefined) {
                throw makeError(
                  X`${q(`${label}.git`)} names an unavailable Git binding ${q(remote.git)}`,
                );
              }
              if (selectedGit.readOnly) {
                throw makeError(
                  X`Git remote binding ${q(binding)} requires writable Git authority`,
                );
              }
              const policy = normalizeGitRemotePolicy({
                name: remote.name,
                policy: /** @type {any} */ (remote),
              });
              const credential =
                remote.credential === undefined
                  ? undefined
                  : normalizeNameOrPath(
                      remote.credential,
                      `${label}.credential`,
                    );
              const parsedUrl = new URL(policy.url);
              if (parsedUrl.username !== '' || parsedUrl.password !== '') {
                throw makeError(
                  X`${q(`${label}.url`)} must not embed credentials`,
                );
              }
              assertNoSecretSearchParams(parsedUrl, `${label}.url`);
              const { protocol } = parsedUrl;
              if (protocol !== 'https:' && credential !== undefined) {
                throw makeError(
                  X`${q(`${label}.credential`)} is only valid for https remotes`,
                );
              }
              return [
                binding,
                harden({
                  ...policy,
                  git: remote.git,
                  name: remote.name,
                  ...(credential === undefined ? {} : { credential }),
                }),
              ];
            }),
        )
      );

    const seen = new Set();
    for (const [category, record] of Object.entries({
      mount,
      git,
      gitRemote,
    })) {
      for (const name of Object.keys(record)) {
        if (seen.has(name)) {
          throw makeError(
            X`Guest binding ${q(name)} occurs in more than one authority category`,
          );
        }
        seen.add(name);
      }
      void category;
    }
    return harden({
      mount: harden(mount),
      git: harden(git),
      gitRemote: harden(gitRemote),
    });
  };

  /**
   * Re-verify that a retained policy's already-normalized roots still
   * exist, are still directories, and remain within their confinement
   * roots. A reconnect that supplies no new `authority` reuses the retained
   * policy verbatim; without this, a root swapped out from under the daemon
   * (e.g. its directory deleted and replaced with a symlink out of
   * confinement) would go unchecked until first file access.
   *
   * @param {EndoGuestAuthorityPolicy} policy
   */
  const revalidateRetainedPolicy = async policy => {
    await allInOrder(
      Object.entries(policy.mount).map(([name, mountPolicy]) =>
        canonicalDirectory(mountPolicy.root, `retained mount ${name}`).then(
          canonical => {
            if (canonical !== mountPolicy.root) {
              throw makeError(
                X`retained mount ${q(name)} no longer resolves to its recorded root`,
              );
            }
          },
        ),
      ),
    );
    await allInOrder(
      Object.entries(policy.git).map(([name, gitPolicy]) =>
        canonicalDirectory(gitPolicy.root, `retained git ${name}`).then(
          async canonical => {
            await null;
            if (canonical !== gitPolicy.root) {
              throw makeError(
                X`retained git ${q(name)} no longer resolves to its recorded root`,
              );
            }
            if (
              !(await isConfinedPath(
                canonical,
                policy.mount[gitPolicy.mount].root,
                pathPowers,
              ))
            ) {
              throw makeError(
                X`retained git ${q(name)} escapes its selected mount`,
              );
            }
          },
        ),
      ),
    );
  };
  harden(revalidateRetainedPolicy);

  /** @param {EndoGuestAuthorityPolicy} policy */
  const resolveCredentials = async policy => {
    /** @type {Map<string, ResolvedCredential>} */
    const resolved = new Map();
    await allInOrder(
      Object.entries(policy.gitRemote).map(async ([binding, remote]) => {
        if (remote.credential === undefined) return;
        let value;
        try {
          value = await lookup(remote.credential);
        } catch {
          throw makeCredentialUnavailable(binding);
        }
        const path =
          typeof remote.credential === 'string'
            ? [remote.credential]
            : remote.credential;
        const identifier = await identify(...path);
        if (identifier === undefined) {
          throw makeCredentialUnavailable(binding);
        }
        let controller;
        try {
          controller = await getGitCredentialController(value);
        } catch {
          throw makeError(
            X`Credential for Git remote binding ${q(binding)} is not daemon-minted`,
          );
        }
        let inspection;
        try {
          inspection = await E(
            /** @type {GitCredentialController} */ (controller),
          ).inspect();
        } catch {
          throw makeCredentialUnavailable(binding);
        }
        if (inspection.available !== true || inspection.revoked === true) {
          throw makeCredentialUnavailable(binding);
        }
        const credential = /** @type {GitCredential} */ (value);
        let audience;
        try {
          audience = await E(credential).audience();
        } catch {
          throw makeCredentialUnavailable(binding);
        }
        if (audience !== new URL(remote.url).origin) {
          throw makeError(
            X`Credential audience does not match Git remote binding ${q(binding)}`,
          );
        }
        resolved.set(binding, harden({ credential, identifier }));
      }),
    );
    return resolved;
  };

  /** @param {Record<string, string>} introducedNames */
  const resolveIntroductions = async introducedNames => {
    await null;
    return harden(
      Object.fromEntries(
        await allInOrder(
          Object.keys(introducedNames)
            .sort(compareStrings)
            .map(async hostName => [
              hostName,
              (await identify(hostName)) ?? null,
            ]),
        ),
      ),
    );
  };

  /**
   * @param {string[]} guestPath
   * @param {EndoGuestAuthority | undefined} authority
   * @param {Record<string, string> | undefined} introducedNames
   * @param {() => Promise<EndoGuest>} makeGuest
   */
  const run = async (guestPath, authority, introducedNames, makeGuest) => {
    await null;
    const controllerPath = harden(['provisioned-guests', ...guestPath]);
    const policyPath = harden([...controllerPath, 'authority']);
    /** @type {EndoGuestAuthorityPolicy} */
    let policy;
    /** @type {Map<string, ResolvedCredential>} */
    let credentials;
    /** @type {Record<string, string>} */
    let retainedIntroductions;
    if (await hasNamePath(policyPath)) {
      const retained =
        /** @type {{ policy: EndoGuestAuthorityPolicy, credentialIds: Record<string, string>, introducedNames: Record<string, string> }} */ (
          await lookup(policyPath)
        );
      if (authority === undefined) {
        policy = retained.policy;
        await revalidateRetainedPolicy(policy);
      } else {
        policy = await normalizeAuthority(authority);
      }
      credentials = await resolveCredentials(policy);
      const credentialIds = harden(
        Object.fromEntries(
          [...credentials].map(([name, value]) => [name, value.identifier]),
        ),
      );
      retainedIntroductions =
        introducedNames === undefined
          ? retained.introducedNames
          : harden(
              Object.fromEntries(
                Object.entries(introducedNames).sort(([left], [right]) =>
                  compareStrings(left, right),
                ),
              ),
            );
      if (
        !keyEQ(
          retained,
          harden({
            policy,
            credentialIds,
            introducedNames: retainedIntroductions,
          }),
        )
      ) {
        throw makeError(
          X`provideGuest cannot widen or change retained authority for ${q(guestPath.join('/'))}`,
        );
      }
    } else {
      if (authority === undefined) {
        throw makeError(
          X`No retained authority for guest ${q(guestPath.join('/'))}`,
        );
      }
      if (await hasNamePath(guestPath)) {
        throw makeError(
          X`provideGuest cannot add authority to an existing unprovisioned guest ${q(guestPath.join('/'))}`,
        );
      }
      policy = await normalizeAuthority(authority);
      credentials = await resolveCredentials(policy);
      const credentialIds = harden(
        Object.fromEntries(
          [...credentials].map(([name, value]) => [name, value.identifier]),
        ),
      );
      retainedIntroductions = harden(
        Object.fromEntries(
          Object.entries(introducedNames ?? {}).sort(([left], [right]) =>
            compareStrings(left, right),
          ),
        ),
      );
      for (let length = 1; length <= controllerPath.length; length += 1) {
        // Directory ancestors must be created in order.
        // eslint-disable-next-line no-await-in-loop
        await ensureDirectory(controllerPath.slice(0, length));
      }
      // Persist immutable inert policy and credential identities before
      // minting aliases, so interruption recovery never follows rebound names.
      await storeValue(
        harden({
          policy,
          credentialIds,
          introducedNames: retainedIntroductions,
        }),
        policyPath,
      );
    }
    const introductionIds = await resolveIntroductions(retainedIntroductions);

    const mountsPath = harden([...controllerPath, 'mount']);
    const gitsPath = harden([...controllerPath, 'git']);
    const remotesPath = harden([...controllerPath, 'git-remote']);
    await Promise.all([
      ensureDirectory(mountsPath),
      ensureDirectory(gitsPath),
      ensureDirectory(remotesPath),
    ]);

    /** @type {Map<string, unknown>} */
    const mounts = new Map();
    for (const [name, mountPolicy] of Object.entries(policy.mount)) {
      const alias = harden([...mountsPath, name]);
      // Realization is intentionally ordered for deterministic recovery.
      // eslint-disable-next-line no-await-in-loop
      const mount = await provideOrLookup(alias, () =>
        provideMount(mountPolicy.root, alias, {
          readOnly: mountPolicy.readOnly,
          deniedSegments: mountPolicy.deniedSegments,
        }),
      );
      mounts.set(name, mount);
    }

    /** @type {Map<string, unknown>} */
    const gits = new Map();
    for (const [name, gitPolicy] of Object.entries(policy.git)) {
      const entryPath = harden([...gitsPath, name]);
      // Each Git binding depends on its directory and exact-root mount.
      // eslint-disable-next-line no-await-in-loop
      await ensureDirectory(entryPath);
      const mountAlias = harden([...entryPath, 'mount']);
      const gitAlias = harden([...entryPath, 'git']);
      // eslint-disable-next-line no-await-in-loop
      const exactMount = await provideOrLookup(mountAlias, () =>
        provideMount(gitPolicy.root, mountAlias, {
          readOnly: gitPolicy.readOnly,
          deniedSegments: policy.mount[gitPolicy.mount].deniedSegments,
        }),
      );
      // eslint-disable-next-line no-await-in-loop
      const gitCap = await provideOrLookup(gitAlias, () =>
        provideGit(/** @type {any} */ (exactMount), gitAlias, {
          readOnly: gitPolicy.readOnly,
          allowHistoryRewrite: gitPolicy.allowHistoryRewrite,
        }),
      );
      gits.set(name, gitCap);
    }

    /** @type {Map<string, unknown>} */
    const remotes = new Map();
    for (const [binding, remote] of Object.entries(policy.gitRemote)) {
      const alias = harden([...remotesPath, binding]);
      const gitCap = gits.get(remote.git);
      const credential = credentials.get(binding)?.credential;
      // Git remotes depend on their named Git binding.
      // eslint-disable-next-line no-await-in-loop
      const remoteCap = await provideOrLookup(alias, () =>
        provideGitRemote(/** @type {any} */ (gitCap), alias, {
          name: remote.name,
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
          ...(remote.allowedBranches === undefined
            ? {}
            : { allowedBranches: remote.allowedBranches }),
          ...(credential === undefined ? {} : { credential }),
        }),
      );
      remotes.set(binding, remoteCap);
    }

    const guest = await makeGuest();
    for (const [hostName, guestName] of Object.entries(retainedIntroductions)) {
      const id = introductionIds[hostName];
      if (id !== null) {
        // Reapply provideGuest's established introduction behavior using the
        // source currently bound in the host namespace.
        // eslint-disable-next-line no-await-in-loop
        await bindGuestIdentifier(guest, guestName, id);
      }
    }
    for (const name of mounts.keys()) {
      // Bindings are installed in deterministic category order.
      // eslint-disable-next-line no-await-in-loop
      await bindGuest(guest, name, harden([...mountsPath, name]));
    }
    for (const name of gits.keys()) {
      // eslint-disable-next-line no-await-in-loop
      await bindGuest(guest, name, harden([...gitsPath, name, 'git']));
    }
    for (const name of remotes.keys()) {
      // eslint-disable-next-line no-await-in-loop
      await bindGuest(guest, name, harden([...remotesPath, name]));
    }
    return guest;
  };

  // Keyed per guest path so unrelated guests provision concurrently; only
  // calls for the *same* guest need to serialize against each other.
  /** @type {Map<string, Promise<unknown>>} */
  const tailByGuestPath = new Map();
  /** @type {typeof run} */
  const provideGuestAuthority = (
    guestPath,
    authority,
    introducedNames,
    makeGuest,
  ) => {
    const key = guestPath.join('/');
    const tail = tailByGuestPath.get(key) ?? Promise.resolve();
    const result = tail.then(() =>
      run(guestPath, authority, introducedNames, makeGuest),
    );
    tailByGuestPath.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  };
  /** @param {string[]} guestPath */
  const hasGuestAuthority = guestPath =>
    hasNamePath(['provisioned-guests', ...guestPath, 'authority']);

  /**
   * The guest binding names already granted by retained authority, used to
   * extend the introduced-name collision guard to a reconnect that supplies
   * no new `authority` (and so would otherwise see an empty binding set).
   *
   * @param {string[]} guestPath
   * @returns {Promise<Set<string>>}
   */
  const retainedAuthorityBindings = async guestPath => {
    await null;
    const policyPath = harden(['provisioned-guests', ...guestPath, 'authority']);
    if (!(await hasNamePath(policyPath))) {
      return new Set();
    }
    const retained =
      /** @type {{ policy: EndoGuestAuthorityPolicy }} */ (
        await lookup(policyPath)
      );
    return new Set([
      ...Object.keys(retained.policy.mount),
      ...Object.keys(retained.policy.git),
      ...Object.keys(retained.policy.gitRemote),
    ]);
  };

  return harden({
    hasGuestAuthority,
    provideGuestAuthority,
    retainedAuthorityBindings,
  });
};
harden(makeGuestAuthorityProvider);
