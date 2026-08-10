/**
 * The raw duplex channel to the privileged Android side.
 *
 * Deliberately minimal and structural: nodejs-mobile's channel, a unix-socket
 * adapter, and an in-test loopback are all assignable to it, so the transport
 * is not welded to one embedding.
 */
export type BridgeChannel = {
  /** Deliver a frame to the Android side. */
  send: (frame: { id: number; request: unknown }) => void;
  /** Register the reply handler; returns an unsubscribe function. */
  subscribe: (handler: (frame: unknown) => void) => () => void;
};

/** The observable state of the mock `DevicePolicyManager`. */
export type MockDeviceState = {
  deviceOwner: boolean;
  model: string;
  apiLevel: number;
  restrictions: Set<string>;
  hiddenPackages: Set<string>;
  uninstallBlockedPackages: Set<string>;
  cameraDisabled: boolean;
  screenCaptureDisabled: boolean;
  maximumTimeToLockMs: number;
  passwordComplexity: string;
  lockCount: number;
  rebootCount: number;
  wiped: boolean;
  wipeReason: string | undefined;
};
