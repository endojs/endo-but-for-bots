// @ts-check
// endo run --UNCONFINED packages/daemon/src/networks/setup-iroh.js --powers @agent

import { E } from '@endo/eventual-send';

const owner = harden(['@pins', 'installations', 'iroh']);
const workerPath = harden([...owner, 'worker']);
const servicePath = harden(['@nets', 'iroh']);
const legacyServicePath = harden(['network-service-iroh']);

/**
 * @param {any} host
 * @param {string[]} path
 */
const hasPath = async (host, path) => {
  await null;
  for (let n = 1; n <= path.length; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await E(host).has(...path.slice(0, n)))) return false;
  }
  return true;
};

/**
 * Serialized host setup. Keep the active transport and worker identities while
 * moving only aliases of that transport's actual worker into installation
 * storage. Unrelated historical workers are deliberately left alone.
 *
 * @param {any} host
 * @param {string} specifier - stable package or hosted current-release URL
 * @returns {Promise<boolean>} whether a transport was newly provisioned
 */
export const provisionIrohNetwork = async (host, specifier) => {
  const diagnostics = await E(host).diagnostics();
  const parents = [owner.slice(0, 2), owner];
  for (const path of parents) {
    // eslint-disable-next-line no-await-in-loop
    if (await hasPath(host, path)) {
      // eslint-disable-next-line no-await-in-loop
      const id = await E(host).identify(...path);
      // eslint-disable-next-line no-await-in-loop
      if ((await E(diagnostics).getFormula(id)).type !== 'directory') {
        throw Error('Iroh installation parent is not a directory');
      }
    }
  }
  /** @param {string[]} path */
  const identify = async path => {
    const exists = await hasPath(host, path);
    return exists ? E(host).identify(...path) : undefined;
  };
  const serviceId = await identify(servicePath);
  const legacyServiceId = await identify(legacyServicePath);
  if (serviceId && legacyServiceId && serviceId !== legacyServiceId) {
    throw Error('Conflicting Iroh network service bindings');
  }
  const activeId = serviceId || legacyServiceId;
  const installedWorkerId = await identify(workerPath);
  let activeWorkerId = installedWorkerId;
  if (activeId) {
    const record = await E(diagnostics).getFormula(activeId);
    if (
      record.type !== 'make-unconfined' ||
      record.properties?.worker?.kind !== 'reference'
    ) {
      throw Error('Iroh service has no built-in worker dependency');
    }
    activeWorkerId = record.properties.worker.identifier;
    if (!activeWorkerId) throw Error('Iroh service worker is missing');
    if (installedWorkerId && installedWorkerId !== activeWorkerId) {
      throw Error('Iroh installation worker differs from the active transport');
    }
  }
  if (activeWorkerId) {
    if ((await E(diagnostics).getFormula(activeWorkerId)).type !== 'worker') {
      throw Error('Iroh worker dependency is not a worker');
    }
  }
  /** @type {string[][]} */
  const workerAliases = [];
  if (activeId) {
    for (const name of await E(host).list()) {
      if (name === 'iroh-worker' || name.startsWith('iroh-worker-')) {
        // eslint-disable-next-line no-await-in-loop
        if ((await E(host).identify(name)) === activeWorkerId) {
          workerAliases.push([name]);
        }
      }
    }
    if (!installedWorkerId && workerAliases.length === 0) {
      throw Error('Active Iroh worker has no known inventory alias to migrate');
    }
  }
  // All conflicts are checked before creating directories or removing aliases.
  for (const path of parents) {
    // eslint-disable-next-line no-await-in-loop
    await E(host).provideDirectory(path);
  }
  /**
   * @param {string[]} from
   * @param {string[]} to
   * @param {string} id
   */
  const moveAlias = async (from, to, id) => {
    await null;
    if ((await identify(from)) !== id) throw Error('Iroh source changed');
    const destination = await identify(to);
    if (destination && destination !== id)
      throw Error('Iroh destination changed');
    if (!destination) await E(host).copy(from, to);
    if ((await identify(from)) !== id || (await identify(to)) !== id) {
      throw Error('Iroh binding changed during migration');
    }
    await E(host).remove(...from);
  };
  for (const from of workerAliases) {
    // eslint-disable-next-line no-await-in-loop
    await moveAlias(from, workerPath, activeWorkerId);
  }
  if (legacyServiceId) {
    await moveAlias(legacyServicePath, servicePath, legacyServiceId);
  }
  if (activeId) return false;
  await E(host).provideWorker(workerPath);
  await E(host).makeUnconfined(workerPath, specifier, {
    powersName: '@agent',
    resultName: servicePath,
  });
  return true;
};
harden(provisionIrohNetwork);

/**
 * Install or migrate the Iroh transport without replacing its identity.
 * `reviveNetworks()` revives the direct `@nets/iroh` service on each restart;
 * the nested worker is retained as its formula dependency.
 * @param {any} powers
 */
export const main = async powers => {
  const installed = await provisionIrohNetwork(powers, '@endo/daemon/iroh.js');
  return installed
    ? 'iroh network installed at @nets/iroh'
    : 'iroh network already installed at @nets/iroh';
};
harden(main);
