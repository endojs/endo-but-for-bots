// @ts-check
/* global process */

/**
 * Host-side 9P bridge for runtime container mounts
 * (designs/runtime-container-fs-mount.md).
 *
 * A Floot session that holds a filesystem capability can ask for it to appear
 * inside its sandbox slice under `/mnt/`. This module is the privileged half
 * of that: given a cap's daemon formula id, it resolves the cap, projects it
 * as a `Filesystem` the `@endo/9p-server` mounter can serve, mounts it at a
 * **host-picked** mountpoint, and registers that mountpoint as a daemon
 * `Mount` cap the slice binds. The floot attach registrar
 * (`@endo/floot/src/container-mounts.js`) owns the policy — possession,
 * `/mnt/` path validation, ref counting, persistence — and calls this for the
 * two operations that need root-host authority and the `fs-mounter`.
 *
 * **The cap is the policy.** The bridge serves *through* the capability, so
 * every attenuation it carries — a read-only view, denied segments, a
 * subdirectory scoping — stays enforced. The host never re-derives file
 * authority from a raw host path, which is why the daemon-mount fast path
 * (`provideHostPath`) is deliberately not taken.
 *
 * Bridges are idempotent per caller-supplied key. The registrar derives that
 * key deterministically from (client identity, cap identity, inner path), so
 * replaying a persisted attach after a daemon restart re-mounts the same host
 * layout and re-registers the same mount pet name.
 *
 * @module
 */

import os from 'node:os';
import path from 'node:path';

import { makeError, q, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { mountAsFilesystem } from '@endo/platform/fs/extended';

/**
 * The two methods a container-mount bridge provider offers. Exported so the
 * hosted session provisioner can mix them into its own interface rather than
 * standing up a second exo for them.
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
 * Bridge keys name host-side artifacts (a mountpoint directory and a host
 * mount pet name), so they are constrained to a filename- and pet-name-safe
 * alphabet. The floot attach registrar derives them as content hashes of
 * (client identity, cap identity, inner path).
 */
const BRIDGE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

/**
 * @param {string} key
 * @returns {string}
 */
const assertBridgeKey = key => {
  if (typeof key !== 'string' || !BRIDGE_KEY_RE.test(key)) {
    throw makeError(X`Invalid container mount bridge key ${q(key)}`);
  }
  return key;
};

/**
 * Build the container-mount bridge over a host agent's authority.
 *
 * @param {any} hostAgent - Root-host powers: `lookupById` to resolve the
 *   attached cap, `provideMount` to register the bridged mountpoint, and
 *   `has`/`remove`/`lookup` for the mount pet name and the `fs-mounter`.
 * @param {object} [config]
 * @param {string} [config.mountBaseDir] - Host directory the 9P mountpoints
 *   live under. The HOST picks this layout; session guests only ever choose
 *   slice-internal paths under `/mnt/`.
 * @param {string} [config.fsMounterName] - Pet name of the `@endo/9p-server`
 *   mount caplet.
 * @param {string} [config.sandboxNamespace] - Directory the host-side infra
 *   caplets live under. Empty means they sit at the host root.
 * @param {string} [config.mountNamePrefix] - Prefix for the host mount pet
 *   names this bridge registers.
 * @param {object} [powers]
 * @param {() => Promise<any>} [powers.getFsMounter] - Resolve the 9P mounter.
 *   Injectable for tests; defaults to a `lookup` under the namespace.
 */
export const makeContainerMountBridge = (
  hostAgent,
  config = {},
  powers = {},
) => {
  const {
    mountBaseDir = os.tmpdir(),
    fsMounterName = 'fs-mounter',
    sandboxNamespace = 'claude-sandbox',
    mountNamePrefix = 'claude-attach',
  } = config;
  // `lookup` takes ONE name-or-path argument, so a namespaced mounter has to
  // arrive as a path array rather than as two arguments — the same shape
  // `underNamespace` produces for every other resolution in this package.
  const getFsMounter =
    powers.getFsMounter ||
    (() =>
      E(hostAgent).lookup(
        sandboxNamespace ? [sandboxNamespace, fsMounterName] : fsMounterName,
      ));

  /** @param {string} key */
  const mountNameFor = key => `${mountNamePrefix}-${key}`;

  // Live bridges, keyed by the caller-derived bridge key. Worker-local: after
  // a daemon restart the floot registrar replays each persisted attach
  // through `provideContainerMountBridge`, which re-mounts 9P at the same
  // deterministic mountpoint and re-registers the same host mount pet name
  // (overwriting orphans the prior formula for GC — the same story as the
  // per-session workspace mount replay). The cap identity and mode are
  // remembered so a cached bridge is never served for a request it does not
  // match (a stale entry left by a swallowed release, say).
  /** @type {Map<string, { mountCap: any, handle: any, capId: string, mode: string }>} */
  const bridges = new Map();

  // Serialize bridge operations per key: without this, two concurrent
  // provides for one key would both miss the cache and stack two 9P mounts
  // on one mountpoint (leaking the loser), and a release racing a provide
  // could remove the pet name the provide just registered — cancelling the
  // fresh Mount formula while the cache still points at it.
  /** @type {Map<string, Promise<unknown>>} */
  const bridgeChains = new Map();
  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const withBridgeKeyLock = (key, fn) => {
    const prior = bridgeChains.get(key) || Promise.resolve();
    const run = prior.then(fn, fn);
    const tail = run.catch(() => {});
    bridgeChains.set(key, tail);
    // Drop the chain entry once idle so the map stays bounded by live work.
    tail.then(() => {
      if (bridgeChains.get(key) === tail) {
        bridgeChains.delete(key);
      }
    });
    return run;
  };

  /**
   * Resolve a session-held cap to a `Filesystem` the `@endo/9p-server`
   * mounter can serve. The 9P bridge serves THROUGH the cap, so every
   * attenuation the cap carries (read-only views, denied segments,
   * subdirectory scoping) stays enforced — the cap is the policy; the host
   * never re-derives file authority from a raw host path.
   *
   * @param {any} cap
   * @returns {Promise<any>}
   */
  const resolveServeableFilesystem = async cap => {
    await null;
    /** @type {string[]} */
    let methods;
    try {
      // eslint-disable-next-line no-underscore-dangle
      methods = await E(cap).__getMethodNames__();
    } catch {
      throw makeError(
        X`attach: capability does not support introspection; expected an EndoGit, Mount, or Filesystem capability`,
      );
    }
    if (methods.includes('worktree')) {
      // EndoGit: serve its worktree so in-slice `git` reads, edits, and
      // commits on the same tree the cap represents. A read-only git yields
      // a read-only worktree view and writes fail at the cap.
      const worktree = await E(cap).worktree();
      return mountAsFilesystem(worktree);
    }
    if (methods.includes('root') && methods.includes('statfs')) {
      // Already an endo-fs `Filesystem`.
      return cap;
    }
    if (methods.includes('readText') && methods.includes('entry')) {
      // Daemon `Mount` (or a mount-shaped view such as `readOnly()`).
      return mountAsFilesystem(cap);
    }
    throw makeError(
      X`attach: capability is not filesystem-like (methods: ${q(methods.join(', '))})`,
    );
  };

  /**
   * @param {{ key: string, capId: string, mode?: string }} options
   */
  const provideContainerMountBridge = ({ key, capId, mode = 'rw' }) => {
    assertBridgeKey(key);
    if (mode !== 'ro' && mode !== 'rw') {
      throw makeError(X`attach: mode must be "ro" or "rw", got ${q(mode)}`);
    }
    if (typeof capId !== 'string' || capId === '') {
      throw makeError(X`attach: capId must be a non-empty string`);
    }
    return withBridgeKeyLock(key, async () => {
      await null;
      const existing = bridges.get(key);
      if (existing) {
        if (existing.capId === capId && existing.mode === mode) {
          return harden({
            mountCap: existing.mountCap,
            handle: existing.handle,
          });
        }
        // A cached bridge that does not match the request (a swallowed
        // release left it behind, or the attach's mode changed) must not be
        // served: its kernel mount and Mount cap enforce the WRONG mode.
        // Tear it down and mint afresh — but only if the teardown actually
        // succeeded. The new mount would land on the SAME deterministic
        // mountpoint, so minting over a mount that is still attached stacks
        // two of them and leaks the one underneath, along with its bridge
        // server and socket. Keep the cache entry so a later release can
        // still find it, and say what happened.
        bridges.delete(key);
        try {
          await E(existing.handle).unmount();
        } catch (error) {
          bridges.set(key, existing);
          throw makeError(
            X`attach: could not release the stale bridge at ${q(key)} before re-minting it; the mountpoint is still in use: ${q(
              error instanceof Error ? error.message : String(error),
            )}`,
          );
        }
      }
      const readOnly = mode === 'ro';
      const cap = await E(hostAgent).lookupById(capId);
      const fs = await resolveServeableFilesystem(cap);
      const mountPoint = path.join(mountBaseDir, mountNameFor(key));
      const fsMounter = await getFsMounter();
      // Belt and braces: a read-only attach is enforced at the kernel mount
      // (`ro`), at the daemon Mount cap (`readOnly`), and at the slice bind
      // (the registrar passes the mode through to the bind list too).
      const handle = await E(fsMounter).mount(
        fs,
        mountPoint,
        harden({ lazyUnmount: true, readOnly }),
      );
      try {
        const mountCap = await E(hostAgent).provideMount(
          mountPoint,
          mountNameFor(key),
          harden({ readOnly }),
        );
        bridges.set(key, harden({ mountCap, handle, capId, mode }));
        return harden({ mountCap, handle });
      } catch (error) {
        await E(handle)
          .unmount()
          .catch(() => {});
        throw error;
      }
    });
  };

  /**
   * @param {string} key
   */
  const releaseContainerMountBridge = key => {
    assertBridgeKey(key);
    return withBridgeKeyLock(key, async () => {
      await null;
      const bridge = bridges.get(key);
      bridges.delete(key);
      if (bridge) {
        try {
          await E(bridge.handle).unmount();
        } catch (error) {
          // The caller has already dropped whatever referenced this bridge,
          // so refusing here would only strand it silently. Drop the pet
          // name anyway — but a mount that outlived its release is a live
          // export of someone's capability, so name the mountpoint an
          // operator has to reap by hand.
          console.error(
            `[claude-sandbox] could not unmount the container mount bridge at ${path.join(
              mountBaseDir,
              mountNameFor(key),
            )}; it is still serving and must be released by hand:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      if (await E(hostAgent).has(mountNameFor(key))) {
        await E(hostAgent).remove(mountNameFor(key));
      }
    });
  };

  return harden({
    provideContainerMountBridge,
    releaseContainerMountBridge,
  });
};
harden(makeContainerMountBridge);

/**
 * Wrap {@link makeContainerMountBridge} as a standalone exo, so a deployment
 * can name a bridge provider directly. The floot attach registrar resolves
 * whatever the deployment named and probes it with `__getMethodNames__` for
 * `provideContainerMountBridge`, which `makeExo` supplies.
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
       * Bridge a cap over 9P for a runtime container attach
       * (designs/runtime-container-fs-mount.md): resolve the cap by formula
       * id, project it as a `Filesystem`, mount it at a host-picked
       * mountpoint, and register the mountpoint as a daemon `Mount` cap the
       * sandbox slice can bind. Idempotent per key — replaying a persisted
       * attach after a daemon restart re-mounts the same deterministic host
       * layout.
       *
       * @param {Record<string, any>} options - `{ key, capId, mode? }` (the
       *   interface guard admits any copyRecord; the bridge validates each
       *   field).
       */
      async provideContainerMountBridge(options) {
        const { key, capId, mode } = options;
        return bridge.provideContainerMountBridge({ key, capId, mode });
      },

      /**
       * Tear down a bridge minted by `provideContainerMountBridge`: unmount
       * the 9P mount and drop the host mount pet name. Called by the floot
       * attach registrar when the last session reference to an attach goes
       * away — AFTER the slice was recreated without the bind, so the
       * unmount does not race a live container.
       *
       * @param {string} key
       */
      async releaseContainerMountBridge(key) {
        await bridge.releaseContainerMountBridge(key);
      },

      help: () =>
        'ContainerMountBridgeProvider: provideContainerMountBridge({key, capId, mode})/releaseContainerMountBridge(key) bridge session-held caps over 9P for runtime container attaches (designs/runtime-container-fs-mount.md).',
    },
  );
};
harden(makeContainerMountBridgeProvider);

/**
 * Unconfined caplet entry point, so a deployment can mint a bridge provider
 * with `endo make-unconfined` and name it for the floot factory to find.
 *
 * @param {any} hostAgent
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = (hostAgent, _context, { env = {} } = {}) =>
  makeContainerMountBridgeProvider(hostAgent, {
    mountBaseDir:
      env.CLAUDE_SANDBOX_MOUNT_DIR ||
      process.env.CLAUDE_SANDBOX_MOUNT_DIR ||
      os.tmpdir(),
    fsMounterName:
      env.FS_MOUNTER_NAME || process.env.FS_MOUNTER_NAME || 'fs-mounter',
    sandboxNamespace:
      env.SANDBOX_NAMESPACE ||
      process.env.SANDBOX_NAMESPACE ||
      'claude-sandbox',
  });
harden(make);
