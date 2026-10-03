import type {
  ClassifiedResult,
  CredentialSource,
  GuestToolProjection,
  InferResult,
  InferUsage,
  LimitTimers,
  McpServer,
  ShapeTable,
} from '@endo/inference/types.js';
import type { ERef } from '@endo/eventual-send';

/**
 * How one turn's stream ended, read from the stream alone. `malformed` covers
 * an unparseable line and more than one terminal `result` event; `missing`
 * means no terminal `result` event arrived.
 */
export type StreamTerminal =
  'success' | 'max-turns' | 'error' | 'missing' | 'malformed';

export type StreamReduction = {
  terminal: StreamTerminal;
  /** The terminal `result.result`, else the assistant text seen. */
  text: string;
  usage?: InferUsage;
  /** Model turns observed: a run of assistant events sharing a message id is one turn. */
  turns: number;
  /** The terminal `result` event, when exactly one arrived. */
  resultEvent?: Record<string, unknown>;
  /** Why the stream is `malformed`. */
  detail?: string;
};

export type ClaudeStreamReducer = {
  /** Feeds raw stdout; returns the number of new model turns it began. */
  pushText: (chunk: string) => number;
  /** Feeds one parsed event; returns whether it began a new model turn. */
  pushEvent: (event: unknown) => boolean;
  finish: () => StreamReduction;
};

/**
 * The passable record a Claude Code response-shape row matches. `result` is
 * the JSON-primitive fields of the terminal `result` event; `exit` is a
 * process that ended without one; `thrown` is an Agent SDK rejection.
 */
export type ClaudeCodeResponse =
  | ({ source: 'result' } & Record<string, string | number | boolean | null>)
  | {
      source: 'exit';
      exitCode: number | null;
      signal: string | null;
      stderr: string;
    }
  | { source: 'thrown'; message: string };

/**
 * A launchable stdio MCP server that serves one guest projection to the
 * `claude` process. The launcher closes over the projection's
 * `buildMcpServer`; it must not resolve the guest by `formulaIdentifier`.
 */
export type StdioProjection = {
  command: string;
  commandArguments?: readonly string[];
  close?: () => void | Promise<void>;
};

export type ScratchDirectory = {
  /** The turn's working directory. */
  path: string;
  /** A fresh, empty directory used as both `HOME` and `CLAUDE_CONFIG_DIR`. */
  configDirectory: string;
  /** Writes a file readable only by its owner and returns its path. */
  writeFile: (name: string, contents: string) => Promise<string>;
  remove: () => Promise<void>;
};

export type ChildStream = {
  on: (event: 'data', listener: (chunk: Uint8Array | string) => void) => void;
};

export type ChildWritable = {
  on: (event: 'error', listener: (error: unknown) => void) => void;
  write: (data: string) => unknown;
  end: () => unknown;
};

/** The subset of a Node `ChildProcess` the CLI backend uses. */
export type ChildProcessLike = {
  pid?: number;
  stdin: ChildWritable | null;
  stdout: ChildStream | null;
  stderr: ChildStream | null;
  on: ((event: 'error', listener: (error: Error) => void) => void) &
    ((
      event: 'close' | 'exit',
      listener: (exitCode: number | null, signal: string | null) => void,
    ) => void);
};

export type SpawnOptions = {
  cwd: string;
  env: Record<string, string>;
  stdio: ['pipe', 'pipe', 'pipe'];
  detached: true;
};

export type Spawn = (
  command: string,
  commandArguments: readonly string[],
  options: SpawnOptions,
) => ChildProcessLike;

export type CliArgumentsSpec = {
  mcpConfigPath: string;
  settingsPath: string;
  serverName: string;
  toolNames: readonly string[];
  maxTurns: number;
  model?: string;
  /** Adds `--max-budget-usd`, the same ceiling as the SDK's `maxBudgetUsd`. */
  maxBudgetUsd?: number;
  /** Adds `--permission-prompts none`, on CLI versions that have it. */
  permissionPromptsNone?: boolean;
};

export type SdkOptionsSpec = {
  serverName: string;
  toolNames: readonly string[];
  mcpServer: McpServer;
  maxTurns: number;
  model?: string;
  workingDirectory: string;
  environment: Record<string, string>;
  executablePath: string;
  abortController: AbortController;
  maxBudgetUsd?: number;
};

export type ConstructedEnvironmentSpec = {
  configDirectory: string;
  pathValue: string;
  /** The `env` of a granted `acquire()`. */
  credentialEnvironment: Record<string, string>;
  lang?: string;
};

export type ClaudeCliBackendOptions = {
  credentialSource: ERef<CredentialSource>;
  /** The pinned `claude` binary. */
  executablePath: string;
  /**
   * The pinned binary's exact version. Each turn compares it with
   * `getVersion()` before acquiring the credential, and it selects
   * response-shape rows.
   */
  version: string;
  /** Reads the binary's actual version, as `claude --version` reports it. */
  getVersion: () => string | Promise<string>;
  stdioProjection: (
    guest: GuestToolProjection,
  ) => StdioProjection | Promise<StdioProjection>;
  spawn: Spawn;
  makeScratchDirectory: () => Promise<ScratchDirectory>;
  kill: (pid: number, signal: string) => unknown;
  timers: LimitTimers;
  /** The child's whole `PATH`. */
  pathValue: string;
  serverName?: string;
  responseShapes?: ShapeTable;
  permissionPromptsNone?: boolean;
  maxBudgetUsd?: number;
};

export type SdkQuery = (parameters: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<unknown>;

export type ClaudeSdkBackendOptions = {
  credentialSource: ERef<CredentialSource>;
  /** The Agent SDK's `query`, injected so this package does not depend on the SDK. */
  query: SdkQuery;
  /** The pinned `claude` binary the SDK drives. */
  executablePath: string;
  /**
   * The pinned binary's exact version. Each turn compares it with
   * `getVersion()` before acquiring the credential, and it selects
   * response-shape rows.
   */
  version: string;
  /** Reads the binary's actual version, as `claude --version` reports it. */
  getVersion: () => string | Promise<string>;
  makeScratchDirectory: () => Promise<ScratchDirectory>;
  timers: LimitTimers;
  pathValue: string;
  serverName?: string;
  responseShapes?: ShapeTable;
  maxBudgetUsd?: number;
};

export type TurnOutcomeSpec = {
  limitOutcome?: InferResult;
  reduction: StreamReduction;
  classify: (response: ClaudeCodeResponse) => ClassifiedResult | undefined;
  /** The response to classify when the stream has no usable terminal event. */
  fallbackResponse?: ClaudeCodeResponse;
  /** A CLI success also requires a zero exit. */
  exitCode?: number | null;
};
