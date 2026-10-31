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
 * Which engine runs the children: `'host'` (ordinary host processes) or
 * `'sandbox'` (an `@endo/sandbox` slice).  Revealed by `inspect()` so a holder
 * can see the confinement it was granted.
 */
export type ShellEngine = 'host' | 'sandbox';

export type ShellInspectResult = {
  allowedCommands: readonly string[];
  /** Default invocation timeout in milliseconds, not a maximum. */
  timeoutMs: number;
  maxOutputBytes: number;
  engine: ShellEngine;
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
 * the caller.  Declared structurally here so this shipped public surface does
 * not depend on a runtime dependency on `@endo/host-spawner`; that package's
 * `Spawner` is assignable to this shape.
 */
export type Spawner = (
  argv: string[],
  opts?: {
    cwd?: string;
    env?: Record<string, string>;
    shell?: boolean;
    timeoutMs?: number;
    maxOutputBytes?: number;
  },
) => Promise<{
  pid: number;
  stdout?: AsyncIterable<Uint8Array> | null;
  stderr?: AsyncIterable<Uint8Array> | null;
  wait: () => Promise<{ code: number | null; signal: string | null }>;
  kill: (signal?: string | number) => Promise<void>;
}>;

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
