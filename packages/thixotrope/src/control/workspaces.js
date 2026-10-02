// @ts-check
/** @import { Logger } from '../platform/logging.js' */
/** @import { FilePowers } from '../platform/files.js' */
/** @import { HashPowers } from '../platform/hashes.js' */
/** @import { makeThixotropeDaemon } from '../core/daemon.js' */
import { E } from '@endo/far';
import harden from '@endo/harden';

import { evaluateSource } from '../core/evaluate-source.js';
import { makeMailAddressBook } from '../mail/mail-address-book.js';
import { makeMailContact } from '../mail/mail-contact.js';
import { makeObservableMap } from '../observable-map.js';
import { assertWorkspaceName } from './names.js';
import { makeWorkspaceAccess } from './workspace-access.js';

/**
 * A workspace: a vat of its own, published as a retention root, with an
 * inventory, an access object for the registry, a provided mailbox and,
 * on first use, an address book. One per name, `default` always.
 *
 * @typedef {object} Workspace
 * @property {string} name
 * @property {string} workerId
 * @property {any} worker the vat's facade
 * @property {any} inventory the inventory's presence; undefined while
 *   the vat is quarantined
 * @property {any} access the workspace access object's presence;
 *   undefined while the vat is quarantined
 * @property {() => Promise<any>} getAddressBook the address book, made on
 *   first use
 */

/**
 * The table of workspace names a state directory serves, `workspace.json`.
 * @typedef {object} WorkspaceTable
 * @property {number} version
 * @property {Record<string, { workerId: string }>} workspaces
 */

/**
 * The workspaces a state directory serves: the table of their names, each
 * opened under the allocation key derived from its name, provided its
 * mailbox and handed the daemon's clock, and made by name on request.
 *
 * @param {object} powers
 * @param {Awaited<ReturnType<typeof makeThixotropeDaemon>>} powers.daemon
 * @param {HashPowers} powers.hashes
 * @param {WorkspaceTable} powers.config
 *   the table, `workspace.json`, which the host writes through `saveConfig`
 * @param {() => Promise<void>} powers.saveConfig
 * @param {Logger} powers.log
 * @param {<T>(job: () => Promise<T>) => Promise<T>} powers.serialized the
 *   turn a vat allocation and a collection take
 * @param {any} powers.registry the registry vat's presence
 * @param {() => boolean} powers.registryHealthy
 * @param {() => any} powers.getIndex the host's installation index, opened
 *   under the store lease
 * @param {any} powers.provide the provide rule of the built-ins
 * @param {any} powers.shipMailbox
 * @param {() => unknown} powers.clockFacet the clock's facet as provided
 *   this lifetime, or undefined once the clock is removed
 * @param {() => boolean} powers.isStopping
 */
export const makeWorkspaces = ({
  daemon,
  hashes,
  config,
  saveConfig,
  log,
  serialized,
  registry,
  registryHealthy,
  getIndex,
  provide,
  shipMailbox,
  clockFacet,
  isStopping,
}) => {
  /** @type {Map<string, Workspace>} */
  const workspaces = new Map();
  const DEFAULT_WORKSPACE = 'default';
  /**
   * The allocation key of a workspace's vat is derived from its name, so
   * every start finds the vat again with no record to lose, and a start
   * interrupted between creating the vat and recording the name leaves
   * nothing to recover by label.
   * @param {string} name
   */
  const workspaceKey = name =>
    hashes
      .sha256Hex(new TextEncoder().encode(`thixotrope:workspace:${name}`))
      .slice(0, 32);
  /**
   * The address book of a workspace, made in its vat on first use and
   * reused for this host lifetime rather than journaling another
   * evaluator call for every command.
   * @param {string} name
   * @param {any} worker
   */
  const makeAddressBookGetter = (name, worker) => {
    /** @type {Promise<any> | undefined} */
    let mailboxAddressBook;
    return () => {
      if (mailboxAddressBook) return mailboxAddressBook;
      // Some fifteen kilobytes of guest source, more than one message
      // can carry: transferred in bounded messages, on a staging slot of its
      // own so no future transfer into the workspace can collide with
      // it. A vat that already holds the address book is asked first, so
      // a supervisor restart costs one message rather than the whole
      // transfer again.
      const introductions = daemon.makeResource('mail-introductions');
      const opening = worker
        .evaluate('globalThis.mailAddressBook')
        .then((/** @type {any} */ existing) =>
          existing !== undefined
            ? existing
            : evaluateSource(
                worker,
                `(({ introductions }) => {
        // The book and its contacts look the mailbox up at each use, so
        // one provided afresh after a removal is the one they speak to,
        // and its absence is reported at every use, not memoised.
        const provideMailbox = () => {
          const mailbox = inventory.get('mailbox');
          if (mailbox === undefined)
            throw Error('The workspace has no mailbox; restart the supervisor to provide one');
          return mailbox;
        };
        provideMailbox();
        return (globalThis.mailAddressBook ??= (async () => {
          if (!inventory.has('contacts')) {
            inventory.set('contacts', (${makeObservableMap.toString()})());
          }
          const mail = (${makeMailAddressBook.toString()})(
            provideMailbox, inventory.get('contacts'), (${makeMailContact.toString()}), introductions
          );
          if (!inventory.has('mail')) inventory.set('mail', mail);
          return mail;
        })());
      })`,
                { introductions },
                { slot: 'thixotrope.mailSource' },
              ),
        );
      // Supervisor restart is a lifetime boundary for view subscriptions
      // on the mailbox, as it is for the inventory's; the mailbox vat is
      // woken for it on the first mail command of a lifetime, not at
      // every start.
      /** @type {Promise<any>} */
      const settled = opening.then(async (/** @type {any} */ book) => {
        await worker.evaluate(
          "E(inventory.get('mailbox')).disconnectEphemeral().then(() => true)",
        );
        return book;
      });
      mailboxAddressBook = settled;
      // Failed initialization can be repaired in the workspace. Do not
      // pin a rejected attempt in the host after the user repairs its
      // durable root.
      void settled.catch(() => {
        if (mailboxAddressBook === settled) mailboxAddressBook = undefined;
      });
      return settled;
    };
  };
  /**
   * Hand a daemon-wide value to a workspace under its name. The same value
   * under the name already is nothing to do; a name the user has taken is
   * theirs, and the supervisor says so and goes on without.
   * @param {Workspace} workspace
   * @param {string} name
   * @param {unknown} value
   */
  const handOut = async (workspace, name, value) => {
    if (workspace.access === undefined) return;
    try {
      await E(workspace.access).put(name, value);
    } catch (error) {
      log.error(`${name} not provided to ${workspace.name}:`, error);
    }
  };
  /**
   * Take a daemon-wide value back from every workspace that still holds
   * it under its name; a value the user put there since is theirs.
   * @param {string} name
   * @param {unknown} value
   * @param {Iterable<Workspace>} [among] those served, by default
   */
  const takeBack = async (name, value, among = workspaces.values()) => {
    for (const workspace of among) {
      if (workspace.access !== undefined) {
        // eslint-disable-next-line no-await-in-loop
        await E(workspace.access)
          .remove(name, value)
          .catch((/** @type {Error} */ error) => {
            log.error(`${name} not taken back from ${workspace.name}:`, error);
          });
      }
    }
  };
  /**
   * Remove every installation of a workspace whose vat is gone: their
   * values were in that vat's inventory, so they go with it, and the name
   * is provided afresh. The registry removes them, retiring their vats;
   * the host's index does when the registry cannot answer.
   * @param {string} workspace
   */
  const removeInstallationsOf = async workspace => {
    if (registryHealthy()) {
      const entries = (await E(registry).list()).filter(
        (/** @type {{workspace?: string}} */ entry) =>
          entry.workspace === workspace,
      );
      for (const { name } of entries) {
        // eslint-disable-next-line no-await-in-loop
        await E(registry)
          .remove(name, workspace)
          .catch((/** @type {Error} */ error) => {
            // The entry is gone and its vat retired; what failed is
            // taking the value out of the workspace vat that is gone.
            log.error(
              `workspace ${workspace}: ${name} removed; its value stays in the vat that is gone:`,
              error,
            );
          });
      }
      return;
    }
    for (const entry of getIndex().list()) {
      if (entry.workspace === workspace) {
        const { workerId, name } = entry;
        if (workerId !== undefined && daemon.listWorkerIds().includes(workerId))
          // eslint-disable-next-line no-await-in-loop
          await serialized(() => daemon.getWorker(workerId).retire());
        getIndex().forget(workspace, name);
      }
    }
  };
  /**
   * Open a workspace by name: find or make its vat under the key derived
   * from the name, publish its root, record it, and bootstrap its
   * inventory and access object unless the vat is quarantined, in which
   * case the workspace is served without them and its commands say so.
   * The vat and its publication are one turn with collection, since
   * nothing roots a fresh vat before its publication. The table is a
   * cache of the names served: a row naming a vat that is gone, collected
   * once quarantined, say, is dropped, and the vat under the name's key
   * serves, made afresh if there is none.
   * @param {string} name
   */
  const openWorkspace = async name => {
    const stale = config.workspaces[name];
    if (
      stale !== undefined &&
      !daemon.listWorkerIds().includes(stale.workerId)
    ) {
      log.error(
        `workspace ${name}: the vat ${stale.workerId} the table names is gone; its installations go with it, and the vat under its key serves, made afresh if there is none`,
      );
      // The installations go first: removal is idempotent by name, so a
      // start that ends in between finds the row again and retries.
      await removeInstallationsOf(name);
      delete config.workspaces[name];
      await saveConfig();
    }
    const worker = await serialized(async () => {
      const vat = await daemon.createWorker({
        debugLabel: `workspace:${name}`,
        allocationKey: workspaceKey(name),
      });
      const failed = daemon
        .inspectWorkers()
        .find(entry => entry.workerId === vat.workerId)?.failure;
      if (!failed) {
        // Repeating this after a restart reuses the globals rather than
        // replacing retained values.
        const root = await vat.evaluate(
          "(globalThis.vats ??= controller, globalThis.workspaceRoot ??= Far('Workspace', { help: () => 'Persistent workspace' }))",
          { controller: daemon.makeResource('worker-controller') },
        );
        daemon.publish(root, `workspace-${vat.workerId}`);
      }
      return vat;
    });
    const { workerId } = worker;
    const recorded = config.workspaces[name];
    if (recorded === undefined) {
      config.workspaces[name] = { workerId };
      await saveConfig();
    } else if (recorded.workerId !== workerId) {
      throw Error('Invalid workspace metadata');
    }
    let inventory;
    /** @type {any} */
    let access;
    if (
      !daemon.inspectWorkers().find(entry => entry.workerId === workerId)
        ?.failure
    ) {
      inventory = await worker.evaluate(
        `(globalThis.inventory ??= (${makeObservableMap.toString()})())`,
      );
      await E(inventory).disconnectEphemeral();
      // The workspace's whole part in installing: resolving grants and
      // holding installed values. The registry vat does the rest. A vat
      // that already holds the access object is asked first, so a start
      // costs one message rather than the source again.
      access = await worker.evaluate('globalThis.workspaceAccess');
      if (access === undefined) {
        access = await evaluateSource(
          worker,
          `(() => (globalThis.workspaceAccess ??= (${makeWorkspaceAccess.toString()})(inventory)))`,
          {},
        );
      }
    }
    /** @type {Workspace} */
    const workspace = harden({
      name,
      workerId,
      worker,
      inventory,
      access,
      getAddressBook: makeAddressBookGetter(name, worker),
    });
    return workspace;
  };
  /**
   * What every workspace is provided: the daemon's clock under `clock`,
   * and a mailbox of its own, in a vat of its own, under `mailbox`.
   * @param {Workspace} workspace
   */
  const provideInto = async workspace => {
    if (workspace.access === undefined) {
      log.error(
        `nothing provided to ${workspace.name}: the workspace vat is quarantined`,
      );
      return;
    }
    const clock = clockFacet();
    if (clock !== undefined) await handOut(workspace, 'clock', clock);
    await provide('mailbox', shipMailbox, {
      into: { workspace: workspace.name, access: workspace.access },
    });
  };
  /** @type {Map<string, Promise<Workspace>>} */
  const creating = new Map();
  /**
   * Make a workspace by name, or find it; two requests for one name make
   * one workspace.
   * @param {string} name
   */
  const createWorkspace = async name => {
    assertWorkspaceName(name);
    if (isStopping()) throw Error('Supervisor is stopping');
    const existing = workspaces.get(name);
    if (existing !== undefined) return existing;
    let opening = creating.get(name);
    if (opening === undefined) {
      opening = openWorkspace(name).then(async workspace => {
        const handed = clockFacet();
        await provideInto(workspace);
        workspaces.set(name, workspace);
        // A clock removed meanwhile was taken back from the workspaces
        // served then; this one was handed it before it was served.
        if (handed !== undefined && clockFacet() !== handed)
          await takeBack('clock', handed, [workspace]);
        return workspace;
      });
      creating.set(name, opening);
      void opening.catch(() => {}).then(() => creating.delete(name));
    }
    return opening;
  };
  const describeWorkspace = (/** @type {Workspace} */ workspace) =>
    harden({ name: workspace.name, workerId: workspace.workerId });
  return harden({
    workspaces,
    DEFAULT_WORKSPACE,
    openWorkspace,
    provideInto,
    createWorkspace,
    handOut,
    takeBack,
    removeInstallationsOf,
    describeWorkspace,
  });
};
harden(makeWorkspaces);
