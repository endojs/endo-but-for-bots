// @ts-check
import { Fail, q } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { E } from '@endo/far';
import harden from '@endo/harden';
import { M } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';

import { describeError } from '../describe-error.js';
import { makeSerialQueue } from '../serial-queue.js';

/**
 * @typedef {'application' | 'native'} InstallationKind
 *
 * @typedef {object} InstallRequest
 * @property {string} name the installation's name, which its value takes
 *   in the inventory
 * @property {string} [workspace] the workspace the installation belongs to
 *   and whose inventory takes the value; absent for one the daemon holds
 *   for every workspace, which takes no grants and whose value the host
 *   hands out
 * @property {InstallationKind} kind
 * @property {string} digest identifies the exact code installed
 * @property {string} allocationKey the host's idempotent vat allocation key
 * @property {ReadonlyArray<string[]>} [grants] `[power, inventory key]`
 *   pairs, resolved in the workspace before any vat exists
 * @property {Record<string, unknown>} [powers] powers the host provides
 *   the installation beside its grants, by name
 * @property {any} [access] the workspace's access facet, with the workspace
 * @property {string} [bundleDigest] an application's bundle, in the store
 * @property {string} [durableDigest] a native resource's durable bundle
 * @property {string} [ephemeralDigest] a native resource's ephemeral bundle
 *
 * @typedef {object} Installation
 * @property {string | undefined} workspace
 * @property {InstallationKind} kind
 * @property {string} digest
 * @property {string} signature the canonical grant mapping
 * @property {Array<[string, string]>} grants
 * @property {string} allocationKey
 * @property {Record<string, unknown>} powers
 * @property {any} access the workspace's access facet, or undefined for a
 *   daemon-wide installation
 * @property {string | undefined} bundleDigest
 * @property {string | undefined} durableDigest
 * @property {string | undefined} ephemeralDigest
 * @property {string | undefined} workerId
 * @property {any} worker the vat's facade, held while the installation
 *   runs so the vat stays rooted before it has a value; dropped once the
 *   value, held here and in the inventory, roots it
 * @property {'pending' | 'ready' | 'failed'} status
 * @property {string | undefined} error
 * @property {Promise<unknown> | undefined} result settles with the installed
 *   value, or with the failure
 * @property {import('@endo/promise-kit').PromiseKit<void>} issued settled
 *   once the installation has been handed to its vat: an application's
 *   factory called, a native resource's manager made
 * @property {unknown} value
 * @property {boolean} placed whether the value was put into the workspace,
 *   which a removal takes back even when a later step failed
 */

/**
 * The daemon's record of everything installed, of every kind, and the
 * driver that installs it: one name, one code digest, one grant mapping,
 * one allocation key, one vat, one outcome.
 *
 * This runs in a vat the host owns, so the driver is one async function per
 * installation whose continuation survives sleep and a host restart. Each
 * host call it makes is idempotent under the allocation key, and one that a
 * restart breaks, which carries the restart message, is simply made again;
 * the phases a host-side driver had to record are the function's own
 * progress. A workspace takes part only through its access facet: grants are
 * resolved there before any vat exists, and the installed value is put there
 * under the name when the installation completes.
 *
 * Shipped by source: this factory is evaluated in the registry vat, so it
 * may import only what the guest prelude provides, under those names.
 *
 * @param {object} powers
 * @param {any} powers.installer the host's installer resource: allocate,
 *   stage, installNativeModule, retire
 * @param {any} powers.index the host's durable index of installations, kept
 *   beside this vat so the host can list and remove them without it
 * @param {string} powers.restartMessage the message a host answer carries
 *   when a host restart broke it; only that failure is retried
 */
export const makeRegistry = ({ installer, index, restartMessage }) => {
  // Shipped by source: the guards travel with the factory, defined here.
  const KindShape = M.or('application', 'native');
  // What the supervisor accepts as a workspace name, checked here too so
  // the two boundaries agree.
  const WorkspaceNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  const DigestShape = M.string({ stringLengthLimit: 128 });
  const GrantsShape = M.arrayOf(harden([M.string(), M.string()]));
  const RequestShape = M.splitRecord(
    {
      name: M.string(),
      kind: KindShape,
      digest: DigestShape,
      allocationKey: M.string(),
    },
    {
      workspace: M.string(),
      access: M.remotable('workspace'),
      grants: GrantsShape,
      powers: M.recordOf(M.string(), M.remotable()),
      bundleDigest: DigestShape,
      durableDigest: DigestShape,
      ephemeralDigest: DigestShape,
    },
    harden({}),
  );
  const RegistryI = M.interface('Registry', {
    help: M.call().returns(M.string()),
    install: M.call(RequestShape).returns(M.promise()),
    lookup: M.call(M.string()).optional(M.string()).returns(M.opt(M.record())),
    remove: M.call(M.string()).optional(M.string()).returns(M.promise()),
    list: M.call().returns(M.arrayOf(M.record())),
    bundles: M.call().returns(M.arrayOf(M.string())),
  });

  /**
   * One name per workspace, and one daemon-wide namespace for what the host
   * provides to every workspace.
   * @param {string | undefined} workspace
   * @param {string} name
   */
  const keyOf = (workspace, name) => JSON.stringify([workspace ?? null, name]);
  /** @type {Map<string, Installation>} */
  const installed = new Map();
  // Installations and removals take turns: a removal must not race the
  // installation it removes, and two installations under one name resolve
  // to one.
  const enqueue = makeSerialQueue();

  /**
   * A host call, made again if a host restart broke its answer; every host
   * call here is idempotent under the allocation key.
   * @template T
   * @param {() => Promise<T>} thunk
   * @returns {Promise<T>}
   */
  const retrying = async thunk => {
    for (;;) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await thunk();
      } catch (error) {
        if (/** @type {Error} */ (error)?.message !== restartMessage)
          throw error;
      }
    }
  };
  /**
   * @param {ReadonlyArray<string[]>} grants already matched against
   *   GrantsShape
   */
  const canonicalGrants = grants => {
    const names = new Set();
    for (const [power] of grants) {
      !names.has(power) || Fail`Duplicate power name`;
      names.add(power);
    }
    return harden(
      [...grants]
        .map(([power, key]) => /** @type {[string, string]} */ ([power, key]))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  };
  /**
   * What the host's index keeps of an entry: enough to list it and to
   * retire its vat without this vat.
   * @param {string} name
   * @param {Installation} entry
   */
  const recordIndex = (name, entry) =>
    retrying(async () => {
      // A record made again after a restart must not revive a name a
      // removal has forgotten meanwhile.
      if (installed.get(keyOf(entry.workspace, name)) !== entry)
        return undefined;
      return E(index).record(
        entry.workspace,
        name,
        harden({
          kind: entry.kind,
          digest: entry.digest,
          grants: entry.grants,
          allocationKey: entry.allocationKey,
          ...(entry.workerId === undefined ? {} : { workerId: entry.workerId }),
          ...(entry.bundleDigest === undefined
            ? {}
            : { bundleDigest: entry.bundleDigest }),
          ...(entry.durableDigest === undefined
            ? {}
            : { durableDigest: entry.durableDigest }),
          ...(entry.ephemeralDigest === undefined
            ? {}
            : { ephemeralDigest: entry.ephemeralDigest }),
          status: entry.status,
          ...(entry.error === undefined ? {} : { error: entry.error }),
        }),
      );
    });
  /**
   * Whether an entry is still the one under its name. A removal waits for
   * the install holding the queue to be issued, so it can overtake the
   * driver only at the guest-to-guest steps after that, the factory call
   * and the placement; the checks before those are defensive.
   * @param {string} name
   * @param {Installation} entry
   */
  const assertCurrent = (name, entry) => {
    installed.get(keyOf(entry.workspace, name)) === entry ||
      Fail`Installation was removed`;
  };

  /**
   * Install, from allocation to the inventory. Resolves to the installed
   * value. Its continuation is durable, so an interruption of the host at
   * any point is resumed here, by this function itself.
   * @param {string} name
   * @param {Installation} entry
   */
  const drive = async (name, entry) => {
    const label = `${entry.kind === 'application' ? 'app' : 'native'}:${name}`;
    const vat = await retrying(() =>
      E(installer).allocate(label, entry.allocationKey),
    );
    assertCurrent(name, entry);
    entry.worker = vat;
    entry.workerId = await retrying(() => E(vat).getId());
    assertCurrent(name, entry);
    await recordIndex(name, entry);
    let value;
    if (entry.kind === 'application') {
      const bundleDigest = /** @type {string} */ (entry.bundleDigest);
      try {
        await retrying(() => E(installer).stage(entry.workerId, bundleDigest));
      } finally {
        // Staged, or failed for good: the index need not keep the bundle
        // for this installation past its next record, and the host's sweep
        // frees it at a later start.
        entry.bundleDigest = undefined;
      }
      assertCurrent(name, entry);
      const evaluator = await retrying(() => E(vat).getEvaluator());
      assertCurrent(name, entry);
      // Guest to guest from here: the factory call is not a host answer,
      // so a host restart does not break it, and the vat memoises it, so
      // nothing runs the factory twice.
      entry.issued.resolve();
      value = await E(evaluator).evaluate(
        '(globalThis.installed ??= installation.namespace.make(powers))',
        { powers: entry.powers },
      );
    } else {
      const durableDigest = /** @type {string} */ (entry.durableDigest);
      const ephemeralDigest = /** @type {string} */ (entry.ephemeralDigest);
      let kit;
      try {
        kit = await retrying(() =>
          E(installer).installNativeModule(
            entry.workerId,
            durableDigest,
            ephemeralDigest,
            entry.powers,
          ),
        );
      } finally {
        // Made, or failed for good, the manager holds its code or its
        // failure, and the launcher the host made names the ephemeral
        // bundle: the index need not keep either past its next record.
        entry.durableDigest = undefined;
        entry.ephemeralDigest = undefined;
      }
      entry.issued.resolve();
      value = kit.facet;
    }
    assertCurrent(name, entry);
    return place(name, entry, value);
  };
  /**
   * Put the installed value under its name in the workspace, guest to guest.
   * A name taken meanwhile fails the installation, like any other step
   * that fails: it keeps its vat and its identity until it is removed, and
   * the name is the user's.
   * @param {string} name
   * @param {Installation} entry
   * @param {unknown} value
   */
  const place = async (name, entry, value) => {
    if (entry.access !== undefined) await E(entry.access).put(name, value);
    if (installed.get(keyOf(entry.workspace, name)) !== entry) {
      // Removed while the value was on its way: the removal found nothing
      // to take out, so it is taken out here.
      if (entry.access !== undefined) await E(entry.access).remove(name, value);
      throw Fail`Installation was removed`;
    }
    entry.value = value;
    entry.placed = true;
    entry.status = 'ready';
    entry.error = undefined;
    entry.worker = undefined;
    await recordIndex(name, entry);
    return value;
  };

  return makeExo('Registry', RegistryI, {
    help: () =>
      "The daemon's record of installed applications and native resources, and their installer: install(request) reserves a name in a workspace, or daemon-wide, resolves its grants in the workspace, allocates a vat, stages the code and puts the value into the workspace; lookup(name, workspace?), remove(name, workspace?), list(), bundles().",
    /**
     * Reserve a name for one installation, or find the reservation a retry
     * is resuming: the same kind, code and grants, else refused. Resolves,
     * once the installation has been handed to its vat, to a record holding
     * the promise for the installed value (a record, so that awaiting the
     * hand-over does not await the factory).
     * @param {InstallRequest} request
     */
    install: request =>
      enqueue(async () => {
        await null;
        const { name, kind, digest, allocationKey, workspace, access } =
          request;
        name.length > 0 || Fail`Expected an installation name`;
        if (workspace === undefined) {
          access === undefined ||
            Fail`A daemon-wide installation has no workspace access`;
        } else {
          WorkspaceNamePattern.test(workspace) ||
            Fail`Expected a workspace name`;
          access !== undefined ||
            Fail`A workspace installation needs the workspace's access`;
        }
        const canonical = canonicalGrants(request.grants ?? harden([]));
        workspace !== undefined ||
          canonical.length === 0 ||
          Fail`A daemon-wide installation takes no grants`;
        const signature = JSON.stringify(canonical);
        const key = keyOf(workspace, name);
        let entry = installed.get(key);
        if (entry !== undefined) {
          const differs =
            entry.kind !== kind
              ? 'kind'
              : entry.digest !== digest
                ? 'code'
                : entry.signature !== signature
                  ? 'grants'
                  : undefined;
          differs === undefined ||
            Fail`Installation name has a different installation: its ${q(differs)} differs`;
          await entry.issued.promise;
          return harden({ result: entry.result });
        }
        if (kind === 'application') {
          typeof request.bundleDigest === 'string' ||
            Fail`An application names its bundle`;
        } else {
          (typeof request.durableDigest === 'string' &&
            typeof request.ephemeralDigest === 'string') ||
            Fail`A native resource names its two bundles`;
        }
        // Grants are checked before any vat exists, in the workspace; what
        // the host provides comes beside them, under names of its own.
        /** @type {Record<string, unknown>} */
        let granted = harden({});
        if (access !== undefined) {
          granted = await E(access).lookupGrants(canonical);
          !(await E(access).has(name)) ||
            Fail`Inventory name is already occupied`;
        }
        const provided = request.powers ?? harden({});
        for (const power of Object.keys(provided))
          !(power in granted) || Fail`Duplicate power name`;
        const powers = harden({ ...provided, ...granted });
        entry = {
          workspace,
          kind,
          digest,
          signature,
          grants: canonical,
          allocationKey,
          powers,
          access,
          bundleDigest: request.bundleDigest,
          durableDigest: request.durableDigest,
          ephemeralDigest: request.ephemeralDigest,
          workerId: undefined,
          worker: undefined,
          status: 'pending',
          error: undefined,
          result: undefined,
          issued: makePromiseKit(),
          value: undefined,
          placed: false,
        };
        installed.set(key, entry);
        const current = entry;
        current.result = drive(name, current).catch(error => {
          if (installed.get(key) === current) {
            current.status = 'failed';
            current.error = describeError(error);
            // Recorded for the host; a failure to record it is not the
            // installation's failure.
            void recordIndex(name, current).catch(() => {});
          }
          throw error;
        });
        // A discarded result must not become an unhandled rejection, and
        // the hand-over is settled however the driver ends.
        void current.result
          .catch(() => {})
          .then(() => current.issued.resolve());
        await recordIndex(name, current);
        await current.issued.promise;
        return harden({ result: current.result });
      }),
    /**
     * The vat behind a name, for the host, with the installed value once
     * there is one, so the host can hand a daemon-wide value to every
     * workspace; undefined for a name this registry does not hold.
     * @param {string} name
     * @param {string} [workspace]
     */
    lookup: (name, workspace = undefined) => {
      const entry = installed.get(keyOf(workspace, name));
      if (!entry) return undefined;
      return harden({
        kind: entry.kind,
        digest: entry.digest,
        workerId: entry.workerId,
        status: entry.status,
        ...(entry.error === undefined ? {} : { error: entry.error }),
        value: entry.value,
      });
    },
    /**
     * Remove an installation of either kind: retire its vat, which closes
     * the processes it launched and withdraws its start notice, then forget
     * the name and take the value out of the workspace if it is still the
     * installation's. The vat goes first, so that an interruption leaves an
     * entry a retry resolves rather than an orphaned vat. Returns whether the
     * name was installed.
     * @param {string} name
     * @param {string} [workspace]
     */
    remove: (name, workspace = undefined) =>
      enqueue(async () => {
        await null;
        const key = keyOf(workspace, name);
        const entry = installed.get(key);
        if (entry === undefined) return false;
        if (entry.workerId !== undefined)
          await retrying(() => E(installer).retire(entry.workerId));
        installed.delete(key);
        try {
          // A value placed and then failed (its index record refused) is in
          // the workspace as surely as a ready one.
          if (entry.placed && entry.access !== undefined)
            await E(entry.access).remove(name, entry.value);
        } finally {
          // The host's index forgets the name whatever the workspace, which
          // may be quarantined, made of the value.
          await retrying(() => E(index).forget(workspace, name));
        }
        return true;
      }),
    /**
     * The stored bundles the installations held here name, for the host's
     * sweep: one a request put in the store is kept from the moment this
     * vat holds the request, whatever the host's index has recorded yet.
     */
    bundles: () =>
      harden(
        [...installed.values()].flatMap(entry =>
          [
            entry.bundleDigest,
            entry.durableDigest,
            entry.ephemeralDigest,
          ].filter(digest => typeof digest === 'string'),
        ),
      ),
    list: () =>
      harden(
        [...installed].map(([key, entry]) => {
          const [, name] = JSON.parse(key);
          const { workspace, kind, digest, grants, status, error } = entry;
          return harden({
            ...(workspace === undefined ? {} : { workspace }),
            name,
            kind,
            digest,
            grants,
            status,
            error,
          });
        }),
      ),
  });
};
harden(makeRegistry);
