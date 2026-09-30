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
  // `name` is the optional argument to the `list` tool when called against a
  // capability other than the guest's own root directory.
  name?: NamePath;
  petNamePath?: NamePath;
  fromPath?: NamePath;
  toPath?: NamePath;
  messageNumber?: number | bigint;
  reason?: string;
  edgeName?: string;
  petName?: NamePath;
  recipientName?: NamePath;
  description?: string;
  responseName?: NamePath;
  strings?: string[];
  edgeNames?: Name[];
  petNames?: NamePath[];
  workerName?: NamePath;
  source?: string;
  codeNames?: string[];
  resultName?: NamePath;
  fileName?: string;
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
