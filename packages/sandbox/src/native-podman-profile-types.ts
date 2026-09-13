/** Explicit operator configuration for native Podman operation containers. */
export type NativePodmanProfile = Readonly<{
  /** Linux uid_t/gid_t, excluding the unmapped-id sentinel. Zero is allowed. */
  uid: number;
  gid: number;
  /** Positive OCI signed 64-bit resource quantities; no defaults. */
  memoryBytes: bigint;
  cpuQuotaMicros: bigint;
  /** Positive 32-bit counts in this native launch profile. */
  pids: number;
  maxConcurrentOperations: number;
  /** Linux CFS period, in microseconds. */
  cpuPeriodMicros: number;
}>;

/** Identity as observed in the native controller's user namespace. */
export type HostIdentity = Readonly<{ hostUid: number; hostGid: number }>;
