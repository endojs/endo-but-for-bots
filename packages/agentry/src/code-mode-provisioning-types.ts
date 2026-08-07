import type { CodeModeGlobal } from '@endo/agent-tools/code-mode/evaluate-tool.js';
import type { EndoGuest } from '@endo/daemon';
import type { NormalizedRemotePolicy, RemotePolicy } from '@endo/exo-git';

export type GitRemoteSpec = Omit<
  RemotePolicy,
  'allowedDirections' | 'fetchRefspecs' | 'pushRefspecs'
> & {
  allowedDirections?: Array<'fetch' | 'push'>;
  fetchRefspecs?: string[];
  pushRefspecs?: string[];
  /** Host-side pet name only. Secret material is never accepted here. */
  credential?: string | string[];
};

export type EndoProvisionSpec = {
  /** Keep Pi's standard tools active alongside the Endo evaluate tool. */
  piTools?: 'preserve';
  workspace?: {
    path?: string;
    deniedSegments?: string[];
  };
  fs?: 'readOnly' | 'readWrite';
  git?: 'readOnly' | 'readWrite' | 'historyRewrite';
  gitRemotes?: { [name: string]: GitRemoteSpec };
};

export type NormalizedGitRemoteSpec = NormalizedRemotePolicy & {
  credential?: string | string[];
};

export type EndoProvisionPolicy = {
  /** Keep Pi's standard tools active alongside the Endo evaluate tool. */
  piTools?: 'preserve';
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
  guestHandlePath: string[];
  workspacePath: string;
  policy: EndoProvisionPolicy;
};

export type NormalizeEndoProvisionOptions = {
  /** Harness key that scopes retained daemon state. */
  harness: string;
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
