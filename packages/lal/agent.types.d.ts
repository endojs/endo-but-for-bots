import type {
  Name,
  EndoGuest,
  NamePath,
  NameOrPath,
  StampedMessage,
} from '@endo/daemon';
import type { ChatMessage } from '@endo/jsonl-transcript';

export type { NameOrPath };

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
  name?: NameOrPath;
  petNamePath?: NamePath;
  petNameOrPath?: NameOrPath;
  fromPath?: NamePath;
  toPath?: NamePath;
  messageNumber?: number | bigint;
  reason?: string;
  edgeName?: NameOrPath;
  petName?: NameOrPath;
  recipientName?: NameOrPath;
  description?: string;
  responseName?: NameOrPath;
  strings?: string[];
  edgeNames?: Name[];
  petNames?: NameOrPath[];
  workerName?: string;
  source?: string;
  codeNames?: string[];
  resultName?: NameOrPath;
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

/**
 * The Endo mail message that started a worker round, recorded in the
 * transcript as an `endo:mail` entry. Ids only, never live references.
 */
export type TranscriptMail = {
  number?: number | bigint;
  messageIdentifier?: string;
  replyTo?: string;
};

/** The writable mount methods the transcript harness uses. */
export type TranscriptMount = {
  list(): string[];
  maybeReadText(path: string): string | undefined;
  writeText(path: string, text: string): void;
  makeFile(path: string, text?: string): void;
  lookup(path: string): unknown;
};

/** One worker's session transcript, held only by the trusted harness. */
export type WorkerTranscript = {
  /** The session file's name at the mount root. */
  readonly fileName: string;
  /** A fresh copy of the resumed session's PiAgent seed messages. */
  readonly seedMessages: ChatMessage[];
  markRecorded(messages: readonly unknown[]): void;
  recordMail(mail: TranscriptMail): Promise<void>;
  recordMessages(messages: readonly unknown[]): Promise<void>;
  close(): Promise<void>;
};
