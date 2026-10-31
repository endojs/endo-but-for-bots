export type GitRemoteProfile = 'fetch-only' | 'agent';

export type GitDirection = 'fetch' | 'push';

export type GitRemoteProfileOptions = {
  name: string;
  url: string;
  allowedDirections: GitDirection[];
  fetchRefspecs: string[];
  pushRefspecs?: string[];
  allowedBranches?: string[];
  allowForcePush: boolean;
  allowTags: boolean;
  allowDelete: boolean;
};

export type GitRemotePolicyView = Omit<
  GitRemoteProfileOptions,
  'pushRefspecs'
> & {
  pushRefspecs: string[];
  revoked: boolean;
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

export type GitRemoteInspection = {
  policy: GitRemotePolicyView;
  credential: GitCredentialHealth;
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
