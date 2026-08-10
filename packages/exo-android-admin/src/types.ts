import type { ACTIONS } from './protocol.js';

/** Every action name in the closed protocol catalog. */
export type ActionName = keyof typeof ACTIONS;

/**
 * How dangerous an action is.  `destructive` actions are additionally gated
 * by the policy's `allowDestructive` flag, so a broad action allowlist cannot
 * confer a device wipe by accident.
 */
export type ActionKind = 'query' | 'mutate' | 'destructive';

/**
 * Which policy allowlist constrains an action's subject.  `package` checks
 * `allowedPackages`, `restriction` checks `allowedRestrictions`, and an
 * absent scope means the action allowlist alone governs the call.
 */
export type ActionScope = 'package' | 'restriction';

export type ActionSpec = {
  kind: ActionKind;
  /** Argument names, in the order the exo method receives them. */
  args: readonly string[];
  scope?: ActionScope;
};

/** The versioned request envelope sent across the bridge. */
export type AdminRequest = {
  v: number;
  action: string;
  args: Record<string, unknown>;
};

/**
 * The result envelope returned by the bridge.  Failures are data, not
 * exceptions: a JVM throwable cannot cross the channel as a JavaScript throw.
 */
export type AdminResult =
  | { ok: true; value?: unknown }
  | { ok: false; error?: { name?: string; message?: string } };

/**
 * The single seam between the portable exo and the privileged Android side.
 * A desktop mock, a nodejs-mobile channel, and a Robolectric harness are all
 * assignable to this shape, which is what lets the admin surface be tested
 * without a device.
 */
export type AdminTransport = (
  request: AdminRequest,
) => Promise<AdminResult> | AdminResult;

/**
 * The authority bounds enforced at the exo boundary, before any request
 * reaches the bridge.
 */
export type AdminPolicy = {
  /** Action names the holder may invoke. */
  allowedActions: readonly string[];
  /** Package names that package-scoped actions may target. */
  allowedPackages?: readonly string[];
  /** Restriction keys that restriction-scoped actions may target. */
  allowedRestrictions?: readonly string[];
  /** Gates `destructive` actions even when they appear in `allowedActions`. */
  allowDestructive?: boolean;
};

/**
 * A validated policy with every optional field settled.  Revocation is
 * deliberately *not* part of these bounds: it is shared mutable state owned
 * by the control facet, so that a facet derived by `attenuate` dies with its
 * parent rather than carrying a stale copy of a `revoked` flag.
 */
export type AdminPolicyBounds = {
  allowedActions: readonly string[];
  allowedPackages: readonly string[];
  allowedRestrictions: readonly string[];
  allowDestructive: boolean;
};

/** The policy as reported by `inspect()`, with live revocation state. */
export type AdminPolicySnapshot = AdminPolicyBounds & {
  revoked: boolean;
};

export type DeviceState = {
  deviceOwner: boolean;
  [key: string]: unknown;
};

/**
 * The guest-facing facet.  This is the only half ever vended to a remote
 * peer; it can invoke permitted actions and attenuate itself, but it cannot
 * widen its own policy or revoke.
 */
export type AndroidAdmin = {
  getDeviceState: () => Promise<DeviceState>;
  listUserRestrictions: () => Promise<string[]>;
  isApplicationHidden: (packageName: string) => Promise<boolean>;

  lockNow: () => Promise<void>;
  setCameraDisabled: (disabled: boolean) => Promise<void>;
  setScreenCaptureDisabled: (disabled: boolean) => Promise<void>;
  setMaximumTimeToLock: (timeMs: number) => Promise<void>;
  setRequiredPasswordComplexity: (complexity: string) => Promise<void>;
  addUserRestriction: (key: string) => Promise<void>;
  clearUserRestriction: (key: string) => Promise<void>;
  setApplicationHidden: (packageName: string, hidden: boolean) => Promise<void>;
  setUninstallBlocked: (packageName: string, blocked: boolean) => Promise<void>;

  reboot: () => Promise<void>;
  wipeData: (reason?: string) => Promise<void>;

  /**
   * Derive a strictly weaker capability.  The result's policy is the
   * intersection of this one with `restriction`, so delegation can only
   * narrow authority — never widen it — and the derived facet dies with its
   * parent when the parent is revoked.
   */
  attenuate: (restriction: AdminPolicy) => AndroidAdmin;

  /** The policy bounds this facet enforces. */
  inspect: () => AdminPolicySnapshot;
  help: () => string;
};

/**
 * The host-retained facet.  Never vended: it can re-scope the policy and
 * revoke the client outright.
 */
export type AndroidAdminControl = {
  inspect: () => AdminPolicySnapshot;
  setPolicy: (policy: AdminPolicy) => void;
  revoke: () => void;
  isRevoked: () => boolean;
  help: () => string;
};
