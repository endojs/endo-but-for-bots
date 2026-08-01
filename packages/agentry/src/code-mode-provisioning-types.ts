import type { CodeModeGlobal } from '@endo/agent-tools/code-mode/evaluate-tool.js';
import type { EndoGuest } from '@endo/daemon';

export type GitRemoteSpec = {
  url: string;
  allowedDirections?: Array<'fetch' | 'push'>;
  fetchRefspecs?: string[];
  pushRefspecs?: string[];
  allowedBranches?: string[];
  allowForcePush?: boolean;
  allowTags?: boolean;
  allowDelete?: boolean;
  allowLocalFileTransport?: boolean;
  /** Host-side pet name only. Secret material is never accepted here. */
  credential?: string | string[];
};

export type EndoProvisionSpec = {
  workspace?: {
    path?: string;
    deniedSegments?: string[];
  };
  fs?: 'readOnly' | 'readWrite';
  git?: 'readOnly' | 'readWrite' | 'historyRewrite';
  gitRemotes?: { [name: string]: GitRemoteSpec };
};

export type NormalizedGitRemoteSpec = {
  url: string;
  allowedDirections: Array<'fetch' | 'push'>;
  fetchRefspecs: string[];
  pushRefspecs: string[];
  allowForcePush: boolean;
  allowTags: boolean;
  allowDelete: boolean;
  allowLocalFileTransport: boolean;
  credential?: string | string[];
};

export type EndoProvisionPolicy = {
  workspace: {
    deniedSegments: string[];
  };
  fs?: 'readOnly' | 'readWrite';
  git?: 'readOnly' | 'readWrite' | 'historyRewrite';
  gitRemotes?: { [name: string]: NormalizedGitRemoteSpec };
};

/**
 * Plain, non-secret reconstruction data.
 *
 * The record deliberately excludes formula identifiers, live capabilities,
 * credential material, daemon endpoints, and host authority.
 */
export type EndoProvisionPersistence = {
  version: 1;
  guestPetName: string[];
  workspacePath: string;
  policy: EndoProvisionPolicy;
};

export type NormalizeEndoProvisionOptions = {
  /** Stable caller-owned identifier used only to derive deterministic names. */
  sessionId: string;
  /** Caller-supplied working directory used to resolve a relative workspace. */
  cwd: string;
};

export type ProvisionEndoCodeModeOptions = NormalizeEndoProvisionOptions & {
  spec?: EndoProvisionSpec;
  /** Optional daemon socket override, independent of the workspace path. */
  sockPath?: string;
};

export type ReconstructEndoCodeModeOptions = {
  persistence: EndoProvisionPersistence;
  /** Optional daemon socket override, independent of the workspace path. */
  sockPath?: string;
};

export type EndoProvisionResult = {
  /** Retained guest used as the live daemon-evaluation powers handle. */
  powers: EndoGuest;
  /** Lexical descriptors selected to match the capabilities actually granted. */
  globals: CodeModeGlobal[];
  persistence: EndoProvisionPersistence;
  /** Close client-side CapTP and cancel this caller's local operations. */
  cleanup: () => Promise<void>;
};
