import type { FarRef, RemoteFunctions } from '@endo/eventual-send';

import type {
  DriverSliceContext,
  SandboxHandle,
  SandboxMakeOpts,
  SliceSpec,
} from './types.js';

/**
 * Host-authorized native paths, resolved before crossing into a shared native
 * worker. These paths grant host filesystem authority and must never be
 * accepted directly from a guest. Their owner retains the corresponding mount
 * formulas until the native handle has completed disposal.
 */
export type NativeSandboxMakeOpts = Omit<
  SandboxMakeOpts,
  'rootfs' | 'mounts'
> & {
  rootfs: SliceSpec['rootfs'];
  mounts?: Readonly<SliceSpec['mounts']>;
  /** Explicitly owned scratch; no implicit daemon mount acquisition. */
  scratchHostPath?: string;
};

/** Static mounts only; no methods accept or create daemon Mount capabilities. */
export type NativeSandboxHandle = FarRef<
  Pick<
    RemoteFunctions<SandboxHandle>,
    'help' | 'spawn' | 'policy' | 'reset' | 'dispose'
  >
>;

/** Cleanup ownership transferred before an individual driver preparation begins. */
export type DriverPreparation<Context = DriverSliceContext> = Readonly<{
  value: Promise<Context>;
  close(): Promise<void>;
}>;
