// @ts-check
/** @import { BundlerPowers } from '../platform/bundler.js' */
/** @import { Logger } from '../platform/logging.js' */
/** @import { PathPowers } from '../platform/paths.js' */
/** @import { makeThixotropeDaemon } from '../core/daemon.js' */
/** @import { ThixotropeStore } from '../store/store.js' */
import { E } from '@endo/far';
import harden from '@endo/harden';

import { make as makeClock } from '../../resources/clock/durable.js';
import { make as makeControl } from '../../resources/control/durable.js';
import { makeMailbox } from '../mail/mailbox.js';
import { makeObservableMap } from '../observable-map.js';

/**
 * The installations the supervisor provides rather than the user: the
 * rule that provides one, and what each built-in ships. What this module
 * ships into a vat by source is frozen in that vat's heap at first
 * evaluation: a change to it is a `WORKSPACE_VERSION` bump in
 * `supervisor.js`.
 *
 * @param {object} powers
 * @param {ThixotropeStore} powers.store
 * @param {BundlerPowers} powers.bundler
 * @param {PathPowers} powers.paths
 * @param {string} powers.packagePath
 * @param {Awaited<ReturnType<typeof makeThixotropeDaemon>>} powers.daemon
 * @param {any} powers.registry the registry vat's presence
 * @param {() => boolean} powers.registryHealthy
 * @param {(request: object) => Promise<any>} powers.requestInstall
 * @param {() => string} powers.randomId
 * @param {Logger} powers.log
 */
export const makeBuiltins = ({
  store,
  bundler,
  paths,
  packagePath,
  daemon,
  registry,
  registryHealthy,
  requestInstall,
  randomId,
  log,
}) => {
  /**
   * An installation the supervisor provides rather than the user: the
   * same path as any installation, so it has a vat, a budget and a
   * failure lifetime of its own, is listed with the rest, and can be
   * removed, in which case the next start provides it again. Its digest
   * is a constant: what it ships changes only with the workspace
   * version. One provided daemon-wide is held by the registry, and its
   * caller hands the value to the workspaces that need it (the clock, to
   * every one); one provided to a workspace takes its name in that
   * workspace's inventory. A name the user has taken is
   * theirs; the supervisor says so and goes on without.
   *
   * The registry finds one it holds again, so a healthy installation
   * costs a start one lookup; only one that is missing or whose vat is
   * gone is installed, and one still pending rejoined, with its code put
   * in the store for that. A failed one stays failed until it is removed,
   * unless `replaceUnhealthy` says otherwise. Resolves to the installed
   * value, or to undefined when it could not be provided.
   * @param {string} name
   * @param {() => Promise<{kind: 'application', bundleDigest: string} | {kind: 'native', durableDigest: string, ephemeralDigest: string}>} ship
   *   put the code in the store and name it
   * @param {object} [options]
   * @param {{ workspace: string, access: any }} [options.into] the
   *   workspace the installation belongs to; absent for a daemon-wide one
   * @param {(value: unknown) => Promise<void>} [options.onStale] what to
   *   do with a daemon-wide value whose vat is gone: take it back from
   *   wherever it was handed; omitted, a stale value is left where it was
   *   handed, for one handed nowhere
   * @param {Record<string, unknown>} [options.powers] host powers the
   *   installation is provided, beside its grants
   * @param {boolean} [options.replaceUnhealthy] an installation that
   *   failed, or whose vat is quarantined, is removed and provided afresh,
   *   for one that keeps nothing worth repairing
   */
  const provide = async (
    name,
    ship,
    {
      into = undefined,
      onStale = undefined,
      powers = undefined,
      replaceUnhealthy = false,
    } = {},
  ) => {
    const where = into === undefined ? '' : ` to ${into.workspace}`;
    if (!registryHealthy()) {
      log.error(
        `${name} not provided${where}: the registry vat is quarantined`,
      );
      return undefined;
    }
    try {
      let held = await E(registry).lookup(name, into?.workspace);
      if (held !== undefined && held.digest !== `builtin:${name}`) {
        // The user's own installation under the name, which a removal of
        // the built-in let them make: theirs, whatever its health.
        log.error(
          `${name} not provided${where}: the name is held by another installation`,
        );
        return undefined;
      }
      if (
        held !== undefined &&
        replaceUnhealthy &&
        (held.status === 'failed' ||
          (held.workerId !== undefined &&
            daemon
              .inspectWorkers()
              .find(worker => worker.workerId === held.workerId)?.failure))
      ) {
        // Nothing of it is worth repairing: the name is freed and the
        // installation made again.
        await E(registry).remove(name, into?.workspace);
        held = undefined;
      }
      if (held?.status === 'failed') {
        // Asking again would only answer the same failure.
        log.error(
          `${name} not provided${where}: its installation failed, and stays failed until it is removed: ${held.error}`,
        );
        return undefined;
      }
      if (held?.status === 'ready') {
        if (
          held.workerId !== undefined &&
          daemon.listWorkerIds().includes(held.workerId)
        ) {
          // Held and alive. A workspace installation is put under its
          // name again, which is nothing to do while it is there, and
          // provides it afresh to an inventory it was taken out of.
          if (into !== undefined) {
            await E(into.access)
              .put(name, held.value)
              .catch((/** @type {Error} */ error) => {
                log.error(`${name} not provided${where}:`, error);
              });
          }
          return held.value;
        }
        // Ready, but its vat is gone: retired by the host while the
        // registry could not answer, or collected once quarantined. The
        // name is freed, a daemon-wide value handed to `onStale` to take
        // back from wherever it was handed, and the installation provided
        // afresh.
        await E(registry).remove(name, into?.workspace);
        if (into === undefined && held.value !== undefined && onStale)
          await onStale(held.value);
      }
      const { result } = await requestInstall(
        harden({
          name,
          ...(into === undefined ? {} : into),
          digest: `builtin:${name}`,
          allocationKey: randomId(),
          grants: [],
          ...(powers === undefined ? {} : { powers }),
          ...(await ship()),
        }),
      );
      return await result;
    } catch (error) {
      log.error(`${name} not provided${where}:`, error);
      return undefined;
    }
  };
  // The clock is a native resource shipped with the package, provided
  // daemon-wide: its manager vat holds every pending deadline, and its
  // adapter process holds the timers, and every workspace holds its facet
  // under `clock`. Removing it retires both; the next start provides it
  // again. Its durable factory is shipped by source like every other
  // built-in, so it must be whole (closing over nothing but the guest
  // prelude); the adapter's module is bundled into the store under its
  // digest, so the package's own directory is never pinned and may change
  // underneath a running installation. The installed clock keeps running
  // the bundle it was installed with, so a change to what its two halves
  // say to each other is a `WORKSPACE_VERSION` bump (in `supervisor.js`),
  // which makes a fresh
  // installation of it.
  const shipClock = async () => {
    const directory = paths.resolve(packagePath, 'resources', 'clock');
    return /** @type {const} */ ({
      kind: 'native',
      durableDigest: store.putBundle(`({ make: ${makeClock.toString()} })`),
      ephemeralDigest: store.putBundle(
        await bundler.bundleNative(paths.join(directory, 'ephemeral.js')),
      ),
    });
  };
  // The control socket is a native resource shipped with the package,
  // provided daemon-wide with the host's administration as its power: its
  // adapter listens on `control.sock` and starts each client's session
  // from a facet of the administration, so the operator's authority stays
  // host code and works while vats are broken. It keeps nothing worth
  // repairing, so one that failed is made again.
  const shipControl = async () => {
    const directory = paths.resolve(packagePath, 'resources', 'control');
    return /** @type {const} */ ({
      kind: 'native',
      durableDigest: store.putBundle(`({ make: ${makeControl.toString()} })`),
      ephemeralDigest: store.putBundle(
        await bundler.bundleNative(paths.join(directory, 'ephemeral.js')),
      ),
    });
  };
  /** @returns {Promise<{kind: 'application', bundleDigest: string}>} */
  const shipMailbox = async () => ({
    kind: 'application',
    bundleDigest: store.putBundle(
      `({ make: () => (${makeMailbox.toString()})((${makeObservableMap.toString()})) })`,
    ),
  });
  return harden({ provide, shipClock, shipControl, shipMailbox });
};
harden(makeBuiltins);
