// @ts-check
/** @import { ThixotropeDaemon, ThixotropeWorkerFacade } from '../core/daemon.js' */
import harden from '@endo/harden';

import { makeAdapterKeeper } from '../adapter-keeper.js';
import { makeNativeManager } from '../native/manager.js';
import { evaluateSource } from './evaluate-source.js';

/**
 * Resume one native installation. Caller serializes installations and collection.
 * Every completed phase is durable and repeating it uses the same manager.
 * @param {ThixotropeDaemon} daemon
 * @param {ThixotropeWorkerFacade} workspace
 * @param {{name: string, digest: string, allocationKey: string, bundle: string, adapters: any}} options
 */
export const installNativeResource = async (
  daemon,
  workspace,
  { name, digest, allocationKey, bundle, adapters },
) => {
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
    daemon.publish(kit.lifecycle, entry.allocationKey);
    manager.notifyOnStart(entry.allocationKey);
    await workspace.evaluate(
      '(nativeResources.finish(name, digest, registration), true)',
      { name, digest, registration: kit.registration },
    );
  }
};
harden(installNativeResource);
