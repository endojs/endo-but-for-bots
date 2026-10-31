import type { ERef } from '@endo/eventual-send';
import type {
  PassableBytesReader,
  PassableBytesWriter,
} from '@endo/exo-stream';

export type SpawnerOptions = {
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
   * Per-stream byte budget the caller keeps by truncating and draining.
   * Informational for every engine: neither spawner terminates a process for
   * writing past it.
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
  options?: SpawnerOptions,
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
      captureStdout?: boolean;
      captureStderr?: boolean;
      stdoutByteLimit?: bigint;
      stderrByteLimit?: bigint;
    },
  ): Promise<SandboxProcess>;
};

export type SandboxTerminationSignal =
  'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGQUIT' | 'SIGKILL';

export type SandboxProcess = {
  // The writer's return value is never read: the adapter only closes stdin.
  stdin(): ERef<PassableBytesWriter<any>>;
  stdout(): ERef<PassableBytesReader>;
  stderr(): ERef<PassableBytesReader>;
  wait(): Promise<{ code: number | null; signal: string | null }>;
  kill(signal?: SandboxTerminationSignal): Promise<void>;
};
