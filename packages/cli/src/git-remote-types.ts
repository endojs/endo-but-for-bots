export type GitRemoteProfileOptions = {
  name: string;
  url: string;
  allowedDirections: string[];
  fetchRefspecs: string[];
  pushRefspecs?: string[];
  allowedBranches?: string[];
  allowForcePush: boolean;
  allowTags: boolean;
  allowDelete: boolean;
};

export type GitRemoteInspection = {
  policy: GitRemoteProfileOptions & {
    pushRefspecs: string[];
    revoked: boolean;
  };
  credential:
    | { required: false }
    | {
        required: true;
        kind: string;
        audience: string;
        available: boolean;
        revoked: boolean;
      };
};
