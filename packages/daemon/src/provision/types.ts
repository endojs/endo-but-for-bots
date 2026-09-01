import type { NormalizedRemotePolicy, RemotePolicy } from '@endo/exo-git';

import type { EndoGuest, EndoHost, NameOrPath } from '../types.js';

export type MountProvision = {
  /** Absolute host path. Relative paths are an adapter concern. */
  path: string;
  readOnly?: boolean;
  deniedSegments?: string[];
};

export type GitProvision = {
  /** Guest binding key in the sibling `mount` collection. */
  mount: string;
  /** Mount-relative path segments naming a non-bare Git worktree. */
  path: string[];
  readOnly?: boolean;
  allowHistoryRewrite?: boolean;
};

export type GitRemoteProvision = Omit<
  RemotePolicy,
  'name' | 'allowedDirections' | 'fetchRefspecs' | 'pushRefspecs'
> & {
  /** Guest binding key in the sibling `git` collection. */
  git: string;
  /** Git protocol remote name, distinct from this entry's guest binding. */
  name: string;
  allowedDirections?: Array<'fetch' | 'push'>;
  fetchRefspecs?: string[];
  pushRefspecs?: string[];
  /** Host-owned credential pet name or path; never credential material. */
  credential?: NameOrPath;
};

/**
 * Immutable host-validated authority for a retained named guest.
 * Collection property keys are the guest binding names.
 */
export type EndoGuestAuthority = {
  mount?: { [guestBinding: string]: MountProvision };
  git?: { [guestBinding: string]: GitProvision };
  gitRemote?: { [guestBinding: string]: GitRemoteProvision };
};

export type NormalizedMountProvision = {
  root: string;
  readOnly: boolean;
  deniedSegments: string[];
};

export type NormalizedGitProvision = {
  mount: string;
  path: string[];
  root: string;
  readOnly: boolean;
  allowHistoryRewrite: boolean;
};

export type NormalizedGitRemoteProvision = NormalizedRemotePolicy & {
  git: string;
  name: string;
  credential?: NameOrPath;
};

export type EndoGuestAuthorityPolicy = {
  mount: { [guestBinding: string]: NormalizedMountProvision };
  git: { [guestBinding: string]: NormalizedGitProvision };
  gitRemote: { [guestBinding: string]: NormalizedGitRemoteProvision };
};

export type ProvisionPathPowers = {
  realPath: (path: string) => Promise<string>;
  isDirectory: (path: string) => Promise<boolean>;
  resolvePath: (...segments: string[]) => string;
  relativePath: (from: string, to: string) => string;
  isAbsolutePath: (path: string) => boolean;
  pathSeparator: string;
};

export type HostProvisionPowers = {
  pathPowers: ProvisionPathPowers | undefined;
  has: (...petNamePath: string[]) => Promise<boolean>;
  identify: (...petNamePath: string[]) => Promise<string | undefined>;
  lookup: (petNamePath: string | string[]) => Promise<unknown>;
  makeDirectory: (petNamePath: string | string[]) => Promise<unknown>;
  storeValue: EndoHost['storeValue'];
  provideMount: EndoHost['provideMount'];
  provideGit: EndoHost['provideGit'];
  provideGitRemote: EndoHost['provideGitRemote'];
  getGitCredentialController: EndoHost['getGitCredentialController'];
  /** Bind an already-realized capability into the retained guest. */
  bindGuest: (
    guest: EndoGuest,
    guestName: string,
    source: string | string[],
  ) => Promise<void>;
  /** Bind an already-retained formula identifier into the guest. */
  bindGuestIdentifier: (
    guest: EndoGuest,
    guestName: string,
    id: string,
  ) => Promise<void>;
};

export type ResolvedCredential = {
  credential: unknown;
  identifier: string;
};
