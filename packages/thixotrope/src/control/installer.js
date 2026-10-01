// @ts-check
/** @import { ThixotropeDaemon } from '../core/daemon.js' */
/** @import { ThixotropeStore } from '../store/store-fs.js' */
import { Fail, q } from '@endo/errors';
import { Far } from '@endo/far';
import harden from '@endo/harden';

import { makeAdapterKeeper } from '../adapter-keeper.js';
import { evaluateSource } from '../core/evaluate-source.js';
import { makeManager } from '../native/manager-kit.js';
import { makeNativeManager } from '../native/manager.js';

/**
 * What the registry vat asks of the host to install something: a vat under
 * an allocation key, code staged into it from the bundle store, a native
 * manager made in it with its launcher, and a vat retired. Every operation
 * is idempotent, so the registry may make it again after a host restart
 * broke its answer. The host resource of this, `installer`, is granted to
 * the registry vat alone.
 *
 * @param {object} powers
 * @param {Promise<ThixotropeDaemon>} powers.daemon the daemon, once built: a
 *   restoring registry vat makes its first call while the endpoint is still
 *   restoring, before the daemon exists, and that call waits here
 * @param {ThixotropeStore} powers.store
 * @param {<T>(operation: () => Promise<T>) => Promise<T>} [powers.serialize]
 *   take a turn with vat collection: an allocation has no root until its
 *   facade is answered, so a collection must not run across one
 * @param {Set<string>} [powers.allocating] the vats handed out by `allocate`
 *   that the registry has not yet named in a later call: the facade is
 *   still on its way when the turn ends, and until the registry holds it
 *   nothing roots the vat, so a collection is told to keep these
 */
export const makeInstaller = ({
  daemon: daemonP,
  store,
  serialize = op => op(),
  allocating = new Set(),
}) =>
  Far('ThixotropeInstaller', {
    help: () =>
      'allocate(label, allocationKey) finds or creates a durable vat and returns its facade; stage(workerId, bundleDigest) stages an application bundle from the store into the vat; installNativeModule(workerId, durableDigest, ephemeralDigest) makes the native manager in the vat and returns its facet; retire(workerId) retires a vat.',
    /**
     * @param {string} label
     * @param {string} allocationKey
     */
    allocate: (label, allocationKey) =>
      serialize(async () => {
        typeof label === 'string' || Fail`Expected a label`;
        const daemon = await daemonP;
        const worker = await daemon.createWorker({
          debugLabel: label,
          allocationKey,
        });
        allocating.add(worker.workerId);
        return daemon.makeResource('worker-facade', {
          workerId: worker.workerId,
        });
      }),
    /**
     * Stage an application's bundle into its vat, in bounded messages: the
     * vat's journal carries it from here, and the bundle stays in the store
     * until a later start's sweep finds nothing naming it. A retry finds
     * the bundle already staged more often than not; one message asks
     * before the whole transfer is repeated.
     * @param {string} workerId
     * @param {string} bundleDigest
     */
    stage: async (workerId, bundleDigest) => {
      const daemon = await daemonP;
      allocating.delete(workerId);
      const vat = daemon.getWorker(workerId);
      if (await vat.evaluate('globalThis.installation !== undefined')) {
        return true;
      }
      const bundle = store.readBundle(bundleDigest);
      bundle !== undefined ||
        Fail`Application bundle ${q(bundleDigest)} is not in the store`;
      await evaluateSource(
        vat,
        `(() => {
          if (globalThis.installation === undefined) {
            const namespace = (\n${bundle}\n);
            if (typeof namespace.make !== 'function')
              throw Error('Application module must export make(powers)');
            globalThis.installation = harden({ namespace });
          }
          return true;
        })`,
        {},
      );
      return true;
    },
    /**
     * Make a native resource's manager in its vat: its durable module runs
     * once there, with an adapter launcher described by that vat so the
     * processes it starts are closed when the vat is retired, together with
     * the manager kit and the keeper, retaining the kit or the failure in
     * the vat's own heap so a retry never runs the factory twice. The host
     * records the manager's lifecycle facet for start and exit notices and
     * returns the public facet.
     * @param {string} workerId
     * @param {string} durableDigest
     * @param {string} ephemeralDigest
     */
    installNativeModule: async (workerId, durableDigest, ephemeralDigest) => {
      const daemon = await daemonP;
      allocating.delete(workerId);
      const manager = daemon.getWorker(workerId);
      const adapters = daemon.makeResource('native-adapter', {
        workerId,
        key: ephemeralDigest,
      });
      // A retry finds the manager already made more often than not; one
      // message asks before the transfer.
      /** @type {{ facet: any, lifecycle: any }} */
      let kit;
      if (await manager.evaluate('globalThis.nativeManager !== undefined')) {
        kit = await manager.evaluate(
          `(() => {
            const result = globalThis.nativeManager;
            if (result.error !== undefined) throw Error(result.error);
            return result.kit;
          })()`,
        );
      } else {
        const bundle = store.readBundle(durableDigest);
        bundle !== undefined ||
          Fail`Durable bundle ${q(durableDigest)} is not in the store`;
        kit = await evaluateSource(
          manager,
          `(endowments => {
            const result = (globalThis.nativeManager ??= (${makeNativeManager.toString()})(
              () => (${bundle}), (${makeAdapterKeeper.toString()}), (${makeManager.toString()}), endowments.adapters
            ));
            if (result.error !== undefined) throw Error(result.error);
            return result.kit;
          })`,
          { adapters },
        );
      }
      // The lifecycle facet stays private to the manager and the host: the
      // host records it by reference, under a publication only it knows.
      manager.notifyOnStart(kit.lifecycle);
      return harden({ facet: kit.facet });
    },
    /**
     * Retire a vat; a vat already gone is nothing to retire.
     * @param {string} workerId
     */
    retire: async workerId => {
      const daemon = await daemonP;
      allocating.delete(workerId);
      if (!daemon.listWorkerIds().includes(workerId)) return false;
      await daemon.getWorker(workerId).retire();
      return true;
    },
  });
harden(makeInstaller);
