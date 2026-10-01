// @ts-check
/** @import { ThixotropeDaemon, ThixotropeWorkerFacade } from '../core/daemon.js' */
import harden from '@endo/harden';

import { makeAdapterKeeper } from '../adapter-keeper.js';
import { makeManager } from '../native/manager-kit.js';
import { makeNativeManager } from '../native/manager.js';
import { evaluateSource } from './evaluate-source.js';

/**
 * The host side of installing into the workspace: one path for every kind,
 * driven phase by phase against the workspace's `installations` registry so
 * that an interrupted installation resumes on a retry with the same identity
 * and never allocates a second vat or runs a factory twice.
 *
 * Caller serializes installations, removals and collection.
 */

/**
 * Forget a registry entry whose vat is gone. A removal retires the vat before
 * the registry forgets the name, so such an entry is a removal that did not
 * finish; finishing it before `prepare` lets a corrected directory take the
 * name rather than be refused as a different installation of the stale one.
 * @param {ThixotropeDaemon} daemon
 * @param {ThixotropeWorkerFacade} workspace
 * @param {string} name
 */
const forgetStale = async (daemon, workspace, name) => {
  const held = await workspace.evaluate('installations.lookup(name)', {
    name,
  });
  if (
    held?.workerId !== undefined &&
    !daemon.listWorkerIds().includes(held.workerId)
  ) {
    await workspace.evaluate('(installations.remove(name), true)', { name });
  }
};

/**
 * Reserve the name and allocate its vat, or find both again on a retry.
 * @param {ThixotropeDaemon} daemon
 * @param {ThixotropeWorkerFacade} workspace
 * @param {{name: string, kind: 'application' | 'native', digest: string, allocationKey: string, grants?: Array<[string, string]>}} options
 * @returns {Promise<{ complete: boolean, vat: ThixotropeWorkerFacade | undefined }>}
 */
const allocate = async (
  daemon,
  workspace,
  { name, kind, digest, allocationKey, grants = [] },
) => {
  await forgetStale(daemon, workspace, name);
  const entry = await workspace.evaluate(
    'installations.prepare(name, kind, digest, allocationKey, grants)',
    { name, kind, digest, allocationKey, grants },
  );
  if (entry.complete) return harden({ complete: true, vat: undefined });
  const vat =
    entry.workerId === undefined
      ? await daemon.createWorker({
          debugLabel: `${kind === 'application' ? 'app' : 'native'}:${name}`,
          allocationKey: entry.allocationKey,
        })
      : daemon.getWorker(entry.workerId);
  await workspace.evaluate(
    '(installations.attach(name, digest, workerId, worker), true)',
    {
      name,
      digest,
      workerId: vat.workerId,
      worker: daemon.makeResource('worker-facade', { workerId: vat.workerId }),
    },
  );
  return harden({ complete: false, vat });
};

/**
 * Record a factory failure in the registry and rethrow it.
 * @param {ThixotropeWorkerFacade} workspace
 * @param {string} name
 * @param {string} digest
 * @param {unknown} error
 */
const failWith = async (workspace, name, digest, error) => {
  await workspace.evaluate('(installations.fail(name, digest, error), true)', {
    name,
    digest,
    error: String(/** @type {Error} */ (error)?.message ?? error),
  });
  throw error;
};

/**
 * Install an application: its bundle is staged into a fresh vat in bounded
 * messages, then the workspace runs its factory with the granted powers,
 * guest to guest, and puts the root into the inventory under the name.
 *
 * Resolves once the factory call has been issued, to a record holding the
 * promise for the root, which settles when the factory does (a record, so
 * that awaiting the issue does not await the settlement). The caller holds
 * its installation lock only until then: a factory that awaits something is not a reason to hold
 * up a removal, a collection or another installation, and one that never
 * answers is removed like any other. A factory still pending when the host
 * restarts settles afterwards; the host's own answer is what a restart
 * breaks, not the installation.
 *
 * @param {ThixotropeDaemon} daemon
 * @param {ThixotropeWorkerFacade} workspace
 * @param {{name: string, digest: string, allocationKey: string, bundle: string, grants: Array<[string, string]>}} options
 * @returns {Promise<{ result: Promise<unknown> }>}
 */
export const installApplication = async (
  daemon,
  workspace,
  { name, digest, allocationKey, bundle, grants },
) => {
  const { complete, vat } = await allocate(daemon, workspace, {
    name,
    kind: 'application',
    digest,
    allocationKey,
    grants,
  });
  // A retry finds the bundle already staged more often than not; one message
  // asks before the whole transfer is repeated.
  if (
    !complete &&
    vat !== undefined &&
    !(await vat.evaluate('globalThis.installation !== undefined'))
  ) {
    try {
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
    } catch (error) {
      await failWith(workspace, name, digest, error);
    }
  }
  const result = workspace.evaluate('installations.start(name, digest)', {
    name,
    digest,
  });
  // Issued, not settled: the caller decides whether to wait.
  void result.catch(() => {});
  return harden({ result });
};
harden(installApplication);

/**
 * Install a native resource: its durable module runs once in a fresh manager
 * vat, with an adapter launcher described by that vat so the processes it
 * starts are closed when the vat is retired; the host records the manager's
 * lifecycle facet for start notices and the workspace puts the public
 * facet into the inventory under the name.
 *
 * @param {ThixotropeDaemon} daemon
 * @param {ThixotropeWorkerFacade} workspace
 * @param {{name: string, digest: string, allocationKey: string, bundle: string, makeAdapters: (workerId: string) => object}} options
 */
export const installNative = async (
  daemon,
  workspace,
  { name, digest, allocationKey, bundle, makeAdapters },
) => {
  const { complete, vat: manager } = await allocate(daemon, workspace, {
    name,
    kind: 'native',
    digest,
    allocationKey,
  });
  if (complete || manager === undefined) return;
  const adapters = makeAdapters(manager.workerId);
  /** @type {any} */
  let kit;
  try {
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
  } catch (error) {
    await failWith(workspace, name, digest, error);
  }
  // The lifecycle facet stays private to the manager and the host: the host
  // records it by reference, under a publication only it knows.
  manager.notifyOnStart(kit.lifecycle);
  await workspace.evaluate(
    '(installations.finish(name, digest, facet), true)',
    { name, digest, facet: kit.facet },
  );
};
harden(installNative);

/**
 * Remove an installation of either kind: retire its vat, which closes the
 * native processes it launched, withdraws its start notice and drops the
 * host rows keyed by it, then forget the name. The vat goes first so that an
 * interruption leaves a stale registry entry, which a retried removal or a
 * reinstallation under the name resolves, rather than an orphaned vat that no
 * name reaches but whose start notice still roots it. An installation
 * interrupted between allocating its vat and recording it has a vat no entry
 * names; removal cannot reach it, and it is collected once asleep, since
 * nothing roots it. Returns whether the name was installed.
 *
 * @param {ThixotropeDaemon} daemon
 * @param {ThixotropeWorkerFacade} workspace
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export const removeInstallation = async (daemon, workspace, name) => {
  const entry = await workspace.evaluate('installations.lookup(name)', {
    name,
  });
  if (entry === undefined) return false;
  if (
    entry.workerId !== undefined &&
    daemon.listWorkerIds().includes(entry.workerId)
  ) {
    await daemon.getWorker(entry.workerId).retire();
  }
  return workspace.evaluate('installations.remove(name)', { name });
};
harden(removeInstallation);
