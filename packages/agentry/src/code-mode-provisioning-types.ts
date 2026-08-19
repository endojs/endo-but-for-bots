import type {
  CodeModeGlobal,
  CodeModeGrant,
} from '@endo/agent-tools/code-mode/types.js';
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

export type MountGrant = {
  /** Relative to the provisioning cwd, or an explicitly selected absolute root. */
  path: string;
  mode: 'readOnly' | 'readWrite';
  deniedSegments?: string[];
};

export type GitGrant = {
  /** Defaults to the compatibility `workspace` mount. */
  mount?: string;
  /** Mount-relative path segments naming a non-bare Git worktree. */
  path: string[];
  mode: 'readOnly' | 'readWrite' | 'historyRewrite';
};

export type NormalizedMountGrant = {
  /** Canonical absolute root, retained only in trusted policy state. */
  root: string;
  mode: 'readOnly' | 'readWrite';
  deniedSegments: string[];
  /** Whether this explicitly granted mount is bound into the guest. */
  guestBinding: boolean;
};

export type NormalizedGitGrant = {
  /** Explicit selected mount name. */
  mount: string;
  /** Mount-relative selector segments. */
  path: string[];
  /** Canonical absolute worktree root, retained only in trusted policy state. */
  root: string;
  mode: 'readOnly' | 'readWrite' | 'historyRewrite';
};

export type EndoProvisionGrantSpec = {
  /** Host-side pet-name path resolved when the session is first provisioned. */
  from: string[];
  /**
   * Optional supplemental prompt context; it is neither runtime authority nor
   * a method declaration.
   *
   * A future trusted descriptor registry selects TypeScript declarations
   * independently. This caller text must never supply, replace, or override
   * those declarations.
   */
  description?: string;
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
  mounts?: { [name: string]: MountGrant };
  gits?: { [name: string]: GitGrant };
  gitRemotes?: { [name: string]: GitRemoteSpec };
  /** Named capabilities to bind into the confined guest's lexical scope. */
  grants?: { [name: string]: EndoProvisionGrantSpec };
};

export type NormalizedGitRemoteSpec = NormalizedRemotePolicy & {
  credential?: string | string[];
};

export type EndoProvisionPolicy = {
  /** Keep Pi's standard tools active alongside the Endo evaluate tool. */
  piTools?: 'preserve';
  /** One authority graph for all filesystem roots. */
  mounts: { [name: string]: NormalizedMountGrant };
  /** Every Git grant names its selected mount explicitly. */
  gits?: { [name: string]: NormalizedGitGrant };
  gitRemotes?: { [name: string]: NormalizedGitRemoteSpec };
  /** Named capabilities to bind into the confined guest's lexical scope. */
  grants?: { [name: string]: EndoProvisionGrantSpec };
};

/**
 * Plain, non-secret reconstruction data.
 *
 * The record deliberately excludes formula identifiers, live capabilities,
 * credential material, daemon endpoints, and host authority.
 */
export type EndoProvisionPersistence = {
  version: 2;
  guestHandlePath: string[];
  workspacePath: string;
  policy: EndoProvisionPolicy;
};

/**
 * Optional parent retained session used only while creating a Pi fork.
 * The host validates this inert record and copies formula identifiers from its
 * retained controller aliases; it never gives the guest host lookup access.
 */
export type EndoProvisionForkOptions = {
  forkFrom?: EndoProvisionPersistence;
};

export type NormalizeEndoProvisionOptions = {
  /** Harness key that scopes retained daemon state. */
  harness: string;
  /** Stable caller-owned identifier used only to derive deterministic names. */
  sessionId: string;
  /** Caller-supplied working directory used to resolve a relative workspace. */
  cwd: string;
};

/** Narrow host-owned observation of a failed daemon connection. */
export type EndoConnectionFailureContext = {
  kind: 'disconnect' | 'protocol';
};

export type EndoConnectionFailureObserver = (
  error: unknown,
  context: EndoConnectionFailureContext,
) => void;

export type EndoCodeModeConnectionOptions = {
  /** Optional daemon socket override, independent of the workspace path. */
  sockPath?: string;
  /**
   * Observe connection failures that are not owned by an operation promise.
   * Application rejections remain exclusively deliverable through their
   * original promises.
   */
  onConnectionFailure?: EndoConnectionFailureObserver;
};

export type ProvisionEndoCodeModeOptions = NormalizeEndoProvisionOptions &
  EndoCodeModeConnectionOptions & {
    spec?: EndoProvisionSpec;
  };

export type ReconstructEndoCodeModeOptions = EndoCodeModeConnectionOptions &
  EndoProvisionForkOptions & {
    persistence: EndoProvisionPersistence;
  };

export type EndoProvisionResult = {
  /** Retained guest used as the live daemon-evaluation powers handle. */
  powers: EndoGuest;
  /** Live capabilities paired with the exact declarations they advertise. */
  grants: CodeModeGrant[];
  /** Lexical descriptors selected to match the capabilities actually granted. */
  globals: CodeModeGlobal[];
  persistence: EndoProvisionPersistence;
  /** Close client-side CapTP and cancel this caller's local operations. */
  cleanup: () => Promise<void>;
};
