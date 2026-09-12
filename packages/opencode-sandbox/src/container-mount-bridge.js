// @ts-check
/* global process */

/**
 * Host-side bridge for runtime container mounts
 * (designs/runtime-container-fs-mount.md) — **refused in phase 1**.
 *
 * The `@endo/opencode-sandbox` slice is provisioned without a sandbox
 * policy attestation: a phase-1 slice cannot prove that a declared host
 * mountpoint is a 9P projection of a session-held capability rather than
 * raw host data.  Refusal is therefore the only available capability
 * mode, and this module exists so the floot attach registrar can resolve
 * a provider with the right shape (`provideContainerMountBridge` /
 * `releaseContainerMountBridge`) and receive a bounded, explanatory
 * error instead of a missing-name failure.
 *
 * The refusal is not immediate from Floot's point of view: the mount
 * recreate is fired, attach is reported as successful, and the refusal
 * surfaces as a `pendingReport` on the next `send`.  That is stated in
 * the operator docs rather than promised as a synchronous error (see
 * DESIGN.md § State, isolation, and teardown).
 *
 * Phase 2 (the policy/attestation path) can replace this implementation
 * with the full 9P bridge from `packages/claude-sandbox`; the exported
 * surface deliberately matches it so only this file changes.
 *
 * @module
 */

import { makeExo } from '@endo/exo';
import { makeError, X } from '@endo/errors';
import { M } from '@endo/patterns';

/**
 * The two methods a container-mount bridge provider offers.  Exported so
 * the hosted session provisioner can mix them into its own interface
 * rather than standing up a second exo for them.
 */
export const containerMountBridgeMethodGuards = harden({
  provideContainerMountBridge: M.callWhen(M.record()).returns(M.record()),
  releaseContainerMountBridge: M.callWhen(M.string()).returns(M.undefined()),
});

const ContainerMountBridgeInterface = M.interface(
  'ContainerMountBridgeProvider',
  {
    ...containerMountBridgeMethodGuards,
    help: M.call().returns(M.string()),
  },
);

/**
 * The phase-1 refusal.  Thrown from `provideContainerMountBridge` before
 * any side effect — no mountpoint directory is created, no 9P mount is
 * attempted, and no Mount pet name is registered.
 *
 * @returns {never}
 */
const refuseContainerMount = () => {
  throw makeError(
    X`opencode-sandbox refuses container mounts in phase 1: the slice carries no sandbox policy attestation, so a runtime bind cannot be proven a 9P projection of a session-held capability`,
  );
};

/**
 * Build the phase-1 container-mount bridge over a host agent's authority.
 * The `hostAgent`, `config`, and `powers` parameters are accepted for
 * signature compatibility with the phase-2 bridge and are deliberately
 * unused: nothing here touches host authority.
 *
 * @param {any} _hostAgent
 * @param {object} [_config]
 * @param {object} [_powers]
 */
export const makeContainerMountBridge = (
  _hostAgent,
  _config = {},
  _powers = {},
) =>
  harden({
    provideContainerMountBridge: _options => refuseContainerMount(),
    releaseContainerMountBridge: async _key => {
      // Nothing was ever provided, so there is nothing to release.  Kept
      // idempotent so a replayed attach after a daemon restart (or a
      // detach of an attach that was refused) is a no-op.
    },
  });
harden(makeContainerMountBridge);

/**
 * Wrap {@link makeContainerMountBridge} as a standalone exo, so a
 * deployment can name a bridge provider directly.  The floot attach
 * registrar resolves whatever the deployment named and probes it with
 * `__getMethodNames__` for `provideContainerMountBridge`, which
 * `makeExo` supplies.
 *
 * @param {any} hostAgent
 * @param {Parameters<typeof makeContainerMountBridge>[1]} [config]
 * @param {Parameters<typeof makeContainerMountBridge>[2]} [powers]
 */
export const makeContainerMountBridgeProvider = (
  hostAgent,
  config = {},
  powers = {},
) => {
  const bridge = makeContainerMountBridge(hostAgent, config, powers);
  return makeExo(
    'ContainerMountBridgeProvider',
    ContainerMountBridgeInterface,
    {
      /**
       * Refused in phase 1: a phase-1 slice has no policy attestation, so
       * no runtime bind can be proven a 9P projection.  The error is
       * bounded and explains the refusal; the floot attach registrar
       * reports it as a `pendingReport` on the next `send`.
       */
      provideContainerMountBridge: options =>
        bridge.provideContainerMountBridge(options),

      /**
       * Tear down a bridge minted by `provideContainerMountBridge`.  In
       * phase 1 nothing was minted, so this is an idempotent no-op.
       *
       * @param {string} key
       */
      async releaseContainerMountBridge(key) {
        await bridge.releaseContainerMountBridge(key);
        return undefined;
      },

      help: () =>
        'ContainerMountBridgeProvider (phase 1): provideContainerMountBridge({key, capId, mode})/releaseContainerMountBridge(key); provides are refused because the slice has no sandbox policy attestation.',
    },
  );
};
harden(makeContainerMountBridgeProvider);

/**
 * Unconfined caplet entry point, so a deployment can mint a bridge
 * provider with `endo make-unconfined` and name it for the floot factory
 * to find.
 *
 * @param {any} hostAgent
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = (hostAgent, _context, { env = {} } = {}) =>
  makeContainerMountBridgeProvider(hostAgent, {
    mountBaseDir:
      env.OPENCODE_SANDBOX_MOUNT_DIR ||
      process.env.OPENCODE_SANDBOX_MOUNT_DIR ||
      process.env.ENDO_OPENCODE_SANDBOX_MOUNT_DIR,
    fsMounterName:
      env.FS_MOUNTER_NAME || process.env.FS_MOUNTER_NAME || 'fs-mounter',
    sandboxNamespace:
      env.SANDBOX_NAMESPACE ||
      process.env.SANDBOX_NAMESPACE ||
      'opencode-sandbox',
  });
harden(make);
