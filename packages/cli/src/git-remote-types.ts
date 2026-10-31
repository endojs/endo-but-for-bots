import type { GitRemoteProvisionOptions } from '@endo/daemon';

export type GitRemoteProfile = 'fetch-only' | 'agent';

export type GitDirection = NonNullable<
  GitRemoteProvisionOptions['allowedDirections']
>[number];

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

export type GitRemotePolicyView = Omit<
  GitRemoteProfileOptions,
  'pushRefspecs'
> & {
  readonly pushRefspecs: readonly string[];
  readonly revoked: boolean;
};

export type GitCredentialHealth =
  | { required: false }
  | {
      required: true;
      kind: string;
      audience: string;
      available: boolean;
      revoked: boolean;
    };

/**
 * `credential` is absent for a revoked remote: revocation closes every
 * guest-facing method, including `credentialHealth()`, so only the
 * controller's policy view remains.
 */
export type GitRemoteInspection = {
  policy: GitRemotePolicyView;
  credential?: GitCredentialHealth;
};

export type GitRemoteHost = {
  getGitRemoteController(remote: unknown): Promise<unknown>;
};

export type GitRemoteController = {
  inspect(): Promise<GitRemotePolicyView>;
};

export type GitRemoteCap = {
  credentialHealth(): Promise<GitCredentialHealth>;
};
