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
 * the caller.  `@endo/host-spawner` owns the seam's types, so the Shell and
 * both spawners share one declaration.
 */
export type { ProcessLike, Spawner, SpawnerOptions } from '@endo/host-spawner';

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
