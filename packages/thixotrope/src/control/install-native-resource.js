// @ts-check
/** @import { ThixotropeDaemon, ThixotropeWorkerFacade } from '../core/daemon.js' */
import harden from '@endo/harden';

import { makeAdapterKeeper } from '../adapter-keeper.js';
import { makeNativeManager } from '../native/manager.js';
import { evaluateSource } from './evaluate-source.js';

/**
 * Resume one native installation. Caller serializes installations, removals
 * and collection. Every completed phase is durable and repeating it uses the
 * same manager.
 *
 * The adapter launcher is made once the manager is allocated, described by
 * that manager's id, so the processes it starts are closed when the manager
 * is retired.
 *
 * @param {ThixotropeDaemon} daemon
 * @param {ThixotropeWorkerFacade} workspace
 * @param {{name: string, digest: string, allocationKey: string, bundle: string, makeAdapters: (workerId: string) => object}} options
 */
export const installNativeResource = async (
  daemon,
  workspace,
  { name, digest, allocationKey, bundle, makeAdapters },
) => {
  const held = await workspace.evaluate('nativeResources.lookup(name)', {
    name,
  });
  if (
    held?.workerId !== undefined &&
    !daemon.listWorkerIds().includes(held.workerId)
  ) {
    // A removal retires the manager before the registry forgets the name,
    // so an entry naming a retired vat is one a removal did not finish.
    // Finish it before `prepare`, which would otherwise refuse a corrected
    // package as a different installation of the stale one.
    await workspace.evaluate('(nativeResources.remove(name), true)', { name });
  }
  const entry = await workspace.evaluate(
    'nativeResources.prepare(name, digest, allocationKey)',
    { name, digest, allocationKey },
  );
  if (!entry.complete) {
    const manager =
      entry.workerId === undefined
        ? await daemon.createWorker({
            debugLabel: `native:${name}`,
            allocationKey: entry.allocationKey,
          })
        : daemon.getWorker(entry.workerId);
    const adapters = makeAdapters(manager.workerId);
    await workspace.evaluate(
      '(nativeResources.attach(name, digest, workerId, worker), true)',
      {
        name,
        digest,
        workerId: manager.workerId,
        worker: daemon.makeResource('worker-facade', {
          workerId: manager.workerId,
        }),
      },
    );
    const kit = await evaluateSource(
      manager,
      `(endowments => {
        const result = (globalThis.nativeManager ??= (${makeNativeManager.toString()})(
          () => (${bundle}), (${makeAdapterKeeper.toString()}), endowments.adapters
        ));
        if (result.error !== undefined) throw Error(result.error);
        return result.kit;
      })`,
      {
        adapters,
      },
    );
    // The lifecycle facet stays private to the manager and the host: the
    // host records it by reference, under a publication only it knows.
    manager.notifyOnStart(kit.lifecycle);
    await workspace.evaluate(
      '(nativeResources.finish(name, digest, registration), true)',
      { name, digest, registration: kit.registration },
    );
  }
};
harden(installNativeResource);

/**
 * Remove a native installation: retire its manager vat, which closes the
 * native processes it launched and withdraws its start notice, then forget
 * the name. The vat goes first so that an interruption leaves a stale registry
 * entry, which a retried removal or a reinstallation under the name resolves,
 * rather than an orphaned manager that no name reaches but its start notice
 * still roots. Returns whether the name was installed. Caller serializes with
 * installations and collection.
 *
 * An installation interrupted between allocating its manager and recording
 * it has a vat no entry names; removal cannot reach it, and it is collected
 * once asleep, since nothing roots it.
 *
 * @param {ThixotropeDaemon} daemon
 * @param {ThixotropeWorkerFacade} workspace
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export const removeNativeResource = async (daemon, workspace, name) => {
  const entry = await workspace.evaluate('nativeResources.lookup(name)', {
    name,
  });
  if (entry === undefined) return false;
  if (
    entry.workerId !== undefined &&
    daemon.listWorkerIds().includes(entry.workerId)
  ) {
    await daemon.getWorker(entry.workerId).retire();
  }
  return workspace.evaluate('nativeResources.remove(name)', { name });
};
harden(removeNativeResource);
