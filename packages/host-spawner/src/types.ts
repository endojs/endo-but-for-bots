import type { ERef } from '@endo/eventual-send';
import type { PassableBytesReader } from '@endo/exo-stream';

export type SpawnerOpts = {
  cwd?: string;
  env?: Record<string, string>;
  shell?: boolean;
  /**
   * Hard ceiling, in milliseconds, after which the spawner may terminate the
   * process tree itself.  The host spawner ignores it; the sandbox spawner
   * hands it to the slice.
   */
  timeoutMs?: number;
  /**
   * Per-stream byte budget the caller keeps.  The host spawner ignores it; the
   * sandbox spawner derives the slice's stdout / stderr byte limits from it.
   */
  maxOutputBytes?: number;
};

export type ProcessLike = {
  pid: number;
  stdout?: AsyncIterable<Uint8Array> | null;
  stderr?: AsyncIterable<Uint8Array> | null;
  wait: () => Promise<{ code: number | null; signal: string | null }>;
  kill: (signal?: string | number) => Promise<void>;
};

export type Spawner = (
  argv: string[],
  opts?: SpawnerOpts,
) => Promise<ProcessLike>;

export type HostSpawnerOptions = {
  searchPath?: string;
  defaultEnv?: Record<string, string | undefined>;
  killProcessGroup?: boolean;
};

/**
 * The part of an `@endo/sandbox` `SandboxHandle` the sandbox spawner uses,
 * declared structurally so this package does not depend on `@endo/sandbox`.
 */
export type SandboxSlice = {
  spawn(
    argv: readonly string[],
    opts?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      stdoutByteLimit?: bigint;
      stderrByteLimit?: bigint;
    },
  ): Promise<SandboxProcess>;
};

export type SandboxProcess = {
  pid(): number;
  stdout(): ERef<PassableBytesReader>;
  stderr(): ERef<PassableBytesReader>;
  wait(): Promise<{ code: number | null; signal: string | null }>;
  kill(
    signal?: 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGQUIT' | 'SIGKILL',
  ): Promise<void>;
};
