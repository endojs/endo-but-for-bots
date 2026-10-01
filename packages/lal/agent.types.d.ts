import type { Name, EndoGuest, NamePath, StampedMessage } from '@endo/daemon';

export type { NamePath };

/**
 * Arguments passed into the tool dispatcher in `agent.js`. pi-agent-core
 * delivers tool arguments as already-parsed JSON objects; SmallCaps
 * interpretation is applied only to per-tool `bigintArgs` fields (the
 * documented `messageNumber` surface), so BigInt-shaped strings like
 * "+5" round-trip into `messageNumber` as actual BigInts while every
 * other string field arrives verbatim from the LLM.
 */
export type ToolCallArgs = {
  methodName?: string;
  // Pet-name path fields carry their pre-validation shape:
  // `NamePathArgumentShape` admits a bare string so that the daemon's
  // `namePathFrom` can refuse it with a retry hint, rather than the guard
  // rejecting it opaquely.
  // `name` is the optional argument to the `list` tool when called against a
  // capability other than the guest's own root directory.
  name?: NamePath | string;
  petNamePath?: NamePath | string;
  fromPath?: NamePath;
  toPath?: NamePath;
  messageNumber?: number | bigint;
  reason?: string;
  edgeName?: string;
  recipientNamePath?: NamePath | string;
  description?: string;
  responseNamePath?: NamePath | string;
  strings?: string[];
  edgeNames?: Name[];
  petNamePaths?: (NamePath | string)[];
  // The dispatcher also maps the LLM's literal `'undefined'` sentinel to
  // absent before forwarding any other string for the daemon to refuse.
  workerNamePath?: NamePath | string;
  source?: string;
  codeNames?: string[];
  resultNamePath?: NamePath | string;
  fileName?: string | NamePath;
  content?: string;
  // Arguments to the `glob`/`grep` search tools: a glob or regexp `pattern`,
  // an optional `glob` filter restricting `grep` to matching paths, an
  // optional `maxResults` cap on returned matches, and `followSymlinks` to let
  // the enumerating walk descend through directory symlinks (`rg -L`).
  pattern?: string;
  glob?: string;
  maxResults?: number;
  followSymlinks?: boolean;
  slots?: Record<string, { label: string }>;
};

export type InboxMessage = StampedMessage;
export type GuestPowers = EndoGuest;

/** Configuration for a worker spawned from a form submission */
export type WorkerConfig = {
  name: string;
  host: string;
  model: string;
  authToken: string;
};

/** Context object for cancellation support */
export type LalContext = {
  whenCancelled?: () => Promise<void>;
  cancelled?: Promise<void>;
};
