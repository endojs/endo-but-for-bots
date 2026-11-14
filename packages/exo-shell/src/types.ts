export type ShellPolicy = {
  allowedCommands: readonly string[];
  /** Default invocation timeout in milliseconds; a caller may override it. */
  timeoutMs: number;
  maxOutputBytes: number;
  env?: Record<string, string>;
  searchPath?: string;
  engine?: ShellEngine;
};

/**
 * Which engine a provisioned shell runs its children under: `'host'`
 * (ordinary host processes) or `'sandbox'` (an `@endo/sandbox` slice).
 */
export type ShellEngine = 'host' | 'sandbox';

/**
 * The engine `inspect()` reveals, so a holder can see the confinement it was
 * granted.  Besides a {@link ShellEngine}, `'environment'` marks a shell that
 * delegates execution to an environment runner: its children run wherever
 * the runner placed them, and the shell itself attests nothing about their
 * confinement.
 */
export type ShellInspectEngine = ShellEngine | 'environment';

export type ShellInspectResult = {
  allowedCommands: readonly string[];
  /** Default invocation timeout in milliseconds, not a maximum. */
  timeoutMs: number;
  maxOutputBytes: number;
  engine: ShellInspectEngine;
};

export type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  truncated: boolean;
};

/**
 * The engine `makeShell` drives execution through: host or sandbox, chosen by
 * the caller.  Declared structurally here so this published package does not
 * depend on the private `@endo/host-spawner`, whose `Spawner` and
 * `makeSandboxSpawner` results are assignable to these shapes.
 */
export type SpawnerOptions = {
  cwd?: string;
  env?: Record<string, string>;
  shell?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

/**
 * A spawned child. `wait()` resolves with the exit status of a process that
 * ended on its own or on a `kill()` the caller requested. A sandbox spawner's
 * `wait()` and `kill()` reject instead when the child was killed without the
 * caller's request or when containment failed, so a confinement failure never
 * reads as an ordinary signal exit.
 */
export type ProcessLike = {
  pid: number;
  stdout?: AsyncIterable<Uint8Array> | null;
  stderr?: AsyncIterable<Uint8Array> | null;
  wait: () => Promise<{ code: number | null; signal: string | null }>;
  kill: (signal?: string | number) => Promise<void>;
};

export type Spawner = (
  argv: string[],
  options?: SpawnerOptions,
) => Promise<ProcessLike>;

export type EndoShell = {
  inspect: () => Promise<ShellInspectResult>;
  exec: (
    command: string,
    args: readonly string[],
    options?: {
      /** Override the default with a positive integer up to 2**31 - 1 ms. */
      timeoutMs?: number;
    },
  ) => Promise<ShellResult>;
};
