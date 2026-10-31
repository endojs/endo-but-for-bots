import type { EndoHost } from '@endo/daemon';
import type { RemoteCredentialHealth, RemoteSnapshot } from '@endo/exo-git';

export type GitRemoteProfile = 'fetch-only' | 'agent';

/** The options `EndoHost.provideGitRemote` accepts. */
type GitRemoteProvisionOptions = Parameters<EndoHost['provideGitRemote']>[2];

/**
 * Turns each array-valued field into a readonly array, matching the hardened
 * values `makeGitRemoteProfile` returns.
 */
type ReadonlyArrayValue<V> = V extends readonly (infer U)[] ? readonly U[] : V;
type ReadonlyFields<T> = {
  readonly [K in keyof T]: ReadonlyArrayValue<T[K]>;
};

/**
 * The CLI's view of the daemon's `provideGitRemote` options: the policy a
 * bounded profile supplies, without the credential (bound at provisioning)
 * or the options no profile sets.
 */
export type GitRemoteProfileOptions = ReadonlyFields<
  Required<
    Pick<
      GitRemoteProvisionOptions,
      | 'name'
      | 'url'
      | 'allowedDirections'
      | 'fetchRefspecs'
      | 'allowForcePush'
      | 'allowTags'
      | 'allowDelete'
    >
  > &
    Pick<GitRemoteProvisionOptions, 'pushRefspecs' | 'allowedBranches'>
>;

/** What `GitRemoteController.inspect()` reports. */
export type GitRemotePolicyView = RemoteSnapshot & { revoked: boolean };

/**
 * A revoked remote carries no `credential`: revocation closes every
 * guest-facing method, including `credentialHealth()`, so only the
 * controller's policy view remains. An active remote always carries one.
 */
export type GitRemoteInspection =
  | { policy: GitRemotePolicyView & { revoked: true } }
  | {
      policy: GitRemotePolicyView & { revoked: false };
      credential: RemoteCredentialHealth;
    };
