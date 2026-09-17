// @ts-check

import harden from '@endo/harden';
import { encodeUtf8 } from '@endo/utf8/encode.js';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { q } from '@endo/errors';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';

import {
  cancelPendingIterator,
  makeCancelableIterator,
} from './cancelable-iterator.js';
import {
  externalizeId,
  internalizeLocator,
  externalizeContent,
  internalizeContentLocator as parseContentLocatorGrammar,
} from './locator.js';
import { formatId } from './formula-identifier.js';
import {
  assertNamePath,
  assertNames,
  assertPetNamePath,
  namePathFrom,
  petNamePathFrom,
} from './pet-name.js';
import { makeDeferredTasks } from './deferred-tasks.js';
import { directoryHelp, readableNameHubHelp, makeHelp } from './help-text.js';

import { DirectoryInterface, ReadableNameHubInterface } from './interfaces.js';

/** @import { DaemonCore, DeferredTasks, MakeDirectoryNode, EndoDirectory, ContentLocatable, ContentIdentity, NameHub, LocatorNameChange, Context, Name, NamePath, PetName, FormulaIdentifier, NodeNumber, PetStoreNameChange, ReadableBlobDeferredTaskParams, ReadableNameHub, StoreController } from './types.js' */

// A read-only view of a name hub: a local in-daemon exo that forwards only the
// readable hub methods (help / has / list / lookup / maybeLookup) to the
// backing hub. The exo carries the canonical `ReadableNameHubInterface`
// guard, so malformed / extra / wrong-typed arguments from a less-trusted
// holder are rejected at THIS boundary — before they reach the backing hub —
// rather than only downstream. `harden`/`Far` gives passability but no argument
// guard, which is why this is a guarded `makeExo` and not a bare `Far`.
//
// This is a plain local exo rather than a worker-hosted evaluation formula: it
// carries no formula identity and pins no worker, so a less-trusted holder
// cannot loop `readOnly()` into unbounded worker spawn or an unreclaimable pin.
// The consequence — the view cannot be pet-named, stored, or independently
// revoked, and does not survive a daemon restart — is intentional for this
// directory slice; a later slice of the #1125 stack that needs a first-class,
// storable formula identity introduces it in the slice that consumes it. See
// the reconciliation note in the PR body against kriskowal's #1125 direction.
//
// `help` routes through the shared `@endo/helpdown` `makeHelp` over the
// `help.md`-generated `readableNameHubHelp` record, exactly like every other
// daemon exo (so `help.md` owns this text and it cannot drift). `makeHelp` does
// an own-property lookup, so a caller-supplied method name (`help('constructor')`,
// `help('toString')`) cannot reach an inherited `Object.prototype` value. `help`
// is a synchronous self-description of the read-only surface (the guard requires
// a string return, and a remote forward would resolve to a promise); the four
// read methods forward to the backing hub and keep their promise/any returns.
//
// `assertLive` is the liveness gate. The view forwards to a `hub` record that
// closes over the backing directory's live machinery, but it carries no formula
// identity, so formula collection's `disconnectRetainersHolding` sever path
// (which only reaches formula-backed holders) cannot reach it. Without this
// gate a holder's reads would keep resolving from the surviving closure after
// the grantor collected the backing directory — a capability the daemon
// believes it revoked. Gating every forward on the grantor's context
// cancellation makes the view severable, mirroring `mount.js`'s `assertLive()`.

/**
 * Mint a read-only `ReadableNameHub` view over a backing name hub. The view is
 * a local exo carrying the canonical `ReadableNameHubInterface` guard; it
 * forwards the five readable methods to `hub` and exposes no mutators. `help`
 * routes through the shared `makeHelp` (own-property lookup, so a caller-supplied
 * method name cannot walk `Object.prototype`). Every forward is gated on
 * `assertLive` so collection of the backing capability severs the view.
 *
 * @param {Pick<NameHub, 'has' | 'list' | 'lookup' | 'maybeLookup'>} hub
 * @param {() => void} [assertLive] Throws if the backing capability has been
 *   canceled; defaults to a no-op for a hub with no collection lifecycle.
 * @returns {ReadableNameHub}
 */
export const makeReadOnlyDirectoryView = (hub, assertLive = () => {}) => {
  const help = makeHelp(readableNameHubHelp);
  return /** @type {ReadableNameHub} */ (
    /** @type {unknown} */ (
      makeExo(
        'ReadableNameHub',
        ReadableNameHubInterface,
        /** @type {any} */ ({
          help: (/** @type {string | undefined} */ method) => help(method),
          has: (...path) => {
            assertLive();
            return E(hub).has(...path);
          },
          list: (...path) => {
            assertLive();
            return E(hub).list(...path);
          },
          lookup: path => {
            assertLive();
            return E(hub).lookup(path);
          },
          maybeLookup: path => {
            assertLive();
            return E(hub).maybeLookup(path);
          },
        }),
      )
    )
  );
};

/**
 * @param {object} args
 * @param {DaemonCore['provide']} args.provide
 * @param {(storeId: FormulaIdentifier) => Promise<StoreController>} args.provideStoreController
 * @param {DaemonCore['getIdForRef']} args.getIdForRef
 * @param {DaemonCore['getTypeForId']} args.getTypeForId
 * @param {DaemonCore['getContentIdentityForId']} args.getContentIdentityForId
 * @param {DaemonCore['formulateDirectory']} args.formulateDirectory
 * @param {DaemonCore['formulateReadableBlob']} args.formulateReadableBlob
 * @param {DaemonCore['pinTransient']} args.pinTransient
 * @param {DaemonCore['unpinTransient']} args.unpinTransient
 */
export const makeDirectoryMaker = ({
  provide,
  provideStoreController,
  getIdForRef,
  getTypeForId,
  getContentIdentityForId,
  formulateDirectory,
  formulateReadableBlob,
  pinTransient,
  unpinTransient,
}) => {
  /** @type {MakeDirectoryNode} */
  const makeDirectoryNode = (
    controller,
    agentNodeNumber,
    isLocalKey,
    getNetworkAddresses,
    getContentSources,
  ) => {
    /** @type {EndoDirectory['lookup']} */
    const lookup = petNamePath => {
      const namePath = namePathFrom(petNamePath);
      const [headName, ...tailNames] = namePath;

      const id = controller.identifyLocal(headName);
      if (id === undefined) {
        throw new TypeError(`Unknown pet name: ${q(headName)}`);
      }
      const value = /** @type {Promise<NameHub>} */ (
        provide(/** @type {FormulaIdentifier} */ (id), 'hub')
      );
      /** @type {any} */
      let directory = value;
      for (const petName of tailNames) {
        directory = E(directory).lookup(petName);
      }
      return /** @type {Promise<unknown>} */ (directory);
    };

    /** @type {EndoDirectory['maybeLookup']} */
    const maybeLookup = petNamePath => {
      const namePath = namePathFrom(petNamePath);
      const [headName, ...tailNames] = namePath;

      const id = controller.identifyLocal(headName);
      if (id === undefined) {
        return undefined;
      }
      const value = provide(/** @type {FormulaIdentifier} */ (id), 'hub');
      return tailNames.reduce(
        (directory, petName) =>
          /** @type {Promise<NameHub>} */ (
            /** @type {unknown} */ (E(directory).lookup(petName))
          ),
        /** @type {Promise<NameHub>} */ (/** @type {unknown} */ (value)),
      );
    };

    /** @type {EndoDirectory['reverseLookup']} */
    const reverseLookup = async presence => {
      await null;
      const id = getIdForRef(await presence);
      if (id === undefined) {
        return harden([]);
      }
      return controller.reverseIdentify(id);
    };

    /**
     * @param {NamePath} petNamePath
     * @returns {Promise<{ hub: NameHub, name: Name }>}
     */
    const lookupTailNameHub = async petNamePath => {
      assertNamePath(petNamePath);
      const tailName = petNamePath[petNamePath.length - 1];
      if (petNamePath.length === 1) {
        // eslint-disable-next-line no-use-before-define
        return { hub: directory, name: tailName };
      }
      const prefixPath = petNamePath.slice(0, -1);
      const hub = /** @type {NameHub} */ (await lookup(prefixPath));
      return { hub, name: tailName };
    };

    /** @type {EndoDirectory['has']} */
    const has = async (...petNamePath) => {
      assertNames(petNamePath);
      if (petNamePath.length === 1) {
        const petName = petNamePath[0];
        return controller.has(petName);
      }
      const { hub, name } = await lookupTailNameHub(
        /** @type {NamePath} */ (petNamePath),
      );
      return E(hub).has(name);
    };

    /** @type {EndoDirectory['identify']} */
    const identify = async (...petNamePath) => {
      assertNames(petNamePath);
      if (petNamePath.length === 1) {
        const petName = petNamePath[0];
        return controller.identifyLocal(petName);
      }
      const { hub, name } = await lookupTailNameHub(
        /** @type {NamePath} */ (petNamePath),
      );
      return E(hub).identify(name);
    };

    /** @type {EndoDirectory['locate']} */
    const locate = async (...petNamePath) => {
      assertNames(petNamePath);
      const id = await identify(...petNamePath);
      if (id === undefined) {
        return undefined;
      }

      const formulaType = await getTypeForId(
        /** @type {FormulaIdentifier} */ (id),
      );
      const addresses = await getNetworkAddresses();
      return externalizeId(
        /** @type {FormulaIdentifier} */ (id),
        formulaType,
        agentNodeNumber,
        addresses,
      );
    };

    /** @type {EndoDirectory['reverseLocate']} */
    const reverseLocate = async locator => {
      const { id } = internalizeLocator(locator);
      return controller.reverseIdentify(id);
    };

    /** @type {EndoDirectory['followLocatorNameChanges']} */
    const followLocatorNameChanges = async function* followLocatorNameChanges(
      locator,
    ) {
      const { id } = internalizeLocator(locator);
      for await (const idNameChange of controller.followIdNameChanges(id)) {
        /** @type {any} */
        const locatorNameChange = {
          ...idNameChange,
          ...(Object.hasOwn(idNameChange, 'add')
            ? { add: locator }
            : { remove: locator }),
        };

        yield /** @type {LocatorNameChange} */ (locatorNameChange);
      }
    };

    /** @type {EndoDirectory['list']} */
    const list = async (...petNamePath) => {
      assertNames(petNamePath);
      if (petNamePath.length === 0) {
        return controller.list();
      }
      const hub = /** @type {NameHub} */ (await lookup(petNamePath));
      return E(hub).list();
    };

    /** @type {EndoDirectory['listValues']} */
    const listValues = async () => {
      // Capture every value through the same lookup path clients use, but do
      // all name enumeration and root lookup synchronously in this exo turn.
      // This is an atomic snapshot with respect to other directory messages:
      // no mutation can interleave between list() and the lookup of a name.
      const names = controller.list();
      const values = names.map(name => {
        try {
          return lookup(name);
        } catch (error) {
          return Promise.reject(error);
        }
      });
      return harden(values);
    };

    /** @type {EndoDirectory['listIdentifiers']} */
    const listIdentifiers = async (...petNamePath) => {
      assertNames(petNamePath);
      const names = await list(...petNamePath);
      const identities = new Set();
      await Promise.all(
        names.map(async name => {
          const id = await identify(...petNamePath, name);
          if (id !== undefined) {
            identities.add(id);
          }
        }),
      );
      return harden(Array.from(identities).sort());
    };

    /** @type {EndoDirectory['listLocators']} */
    const listLocators = async (...petNamePath) => {
      assertNames(petNamePath);
      if (petNamePath.length === 0) {
        const names = await controller.list();
        /** @type {Record<string, string>} */
        const record = {};
        await Promise.all(
          names.map(async name => {
            const locator = await locate(name);
            if (locator !== undefined) {
              record[name] = locator;
            }
          }),
        );
        return harden(record);
      }
      const hub = /** @type {NameHub} */ (await lookup(petNamePath));
      return E(hub).listLocators();
    };

    // Content locators (magnet URNs). The content-side analogue of `locate` /
    // `listLocators` / `reverseLocate`
    // (`designs/endo-content-locators-magnet-urn.md`, § Interface extension):
    // resolve a content-bearing pet name — a readable-blob or readable-tree —
    // to a `magnet:` URN that names the content by its SHA-256 content address
    // (`xt`), independent of location. A non-content formula type is rejected,
    // the same way `parseLocator` rejects an unknown query parameter.
    //
    // An empty per-agent `@planes` directory resolves to no source hints, so
    // every locator remains `xt`-only until a data plane is registered and
    // vended into that directory.

    /**
     * Build the content locator (magnet URN) for an already-resolved content
     * identity. This is the single point where the Phase 3 `@planes` source
     * hints will thread in.
     *
     * @param {ContentIdentity} identity
     * @returns {Promise<string>}
     */
    const contentLocatorFromIdentity = async identity => {
      const { hash, kind } = identity;
      const sources = await getContentSources(identity);
      return externalizeContent(hash, kind, sources);
    };

    /** @type {ContentLocatable['locateContent']} */
    const locateContent = async (...petNamePath) => {
      assertNames(petNamePath);
      const id = await identify(...petNamePath);
      if (id === undefined) {
        return undefined;
      }
      const identity = await getContentIdentityForId(
        /** @type {FormulaIdentifier} */ (id),
      );
      if (identity === undefined) {
        throw new Error(
          `Cannot locate content for ${q(petNamePath)}: not a content-bearing formula (readable-blob or readable-tree)`,
        );
      }
      return contentLocatorFromIdentity(identity);
    };

    /** @type {ContentLocatable['listContent']} */
    const listContent = async (...petNamePath) => {
      assertNames(petNamePath);
      const names = await list(...petNamePath);
      /** @type {Record<string, string>} */
      const record = {};
      await Promise.all(
        names.map(async name => {
          const id = await identify(...petNamePath, name);
          if (id === undefined) {
            return;
          }
          const identity = await getContentIdentityForId(
            /** @type {FormulaIdentifier} */ (id),
          );
          if (identity === undefined) {
            // Not a content-bearing formula: omit it (the content analogue of
            // `listLocators` listing every name, but restricted to content).
            return;
          }
          record[name] = await contentLocatorFromIdentity(identity);
        }),
      );
      return harden(record);
    };

    /** @type {ContentLocatable['storeContent']} */
    const storeContent = async (...petNamePath) => {
      assertNames(petNamePath);
      const id = await identify(...petNamePath);
      if (id === undefined) {
        return undefined;
      }
      const identity = await getContentIdentityForId(
        /** @type {FormulaIdentifier} */ (id),
      );
      if (identity === undefined) {
        throw new Error(
          `Cannot store content for ${q(petNamePath)}: not a content-bearing formula (readable-blob or readable-tree)`,
        );
      }
      // Each resolver receives its `@planes` sharing capability and starts
      // serving content if its plane supports this identity. With an empty
      // directory this remains the same `xt`-only result as locateContent.
      return contentLocatorFromIdentity(identity);
    };

    /** @type {ContentLocatable['reverseLocateContent']} */
    const reverseLocateContent = async contentLocator => {
      const { hash, kind } = parseContentLocatorGrammar(contentLocator);
      const names = controller.list();
      /** @type {Set<Name>} */
      const matches = new Set();
      await Promise.all(
        names.map(async name => {
          const id = controller.identifyLocal(name);
          if (id === undefined) {
            return;
          }
          const identity = await getContentIdentityForId(
            /** @type {FormulaIdentifier} */ (id),
          );
          if (
            identity !== undefined &&
            identity.hash === hash &&
            identity.kind === kind
          ) {
            matches.add(name);
          }
        }),
      );
      return harden(Array.from(matches).sort());
    };

    /** @type {ContentLocatable['internalizeContentLocator']} */
    const internalizeContentLocator = async contentLocator =>
      harden(parseContentLocatorGrammar(contentLocator));

    /**
     * Enrich a name-change event with the formula type of the named value.
     * The `type` field is additive and appears only on `add` events; old
     * consumers that destructure only `add` or `remove` are unaffected.
     * Remote values whose type cannot be determined locally surface as
     * `'remote'` (mirroring the locator-`type` convention).
     *
     * @param {PetStoreNameChange} change
     * @returns {Promise<PetStoreNameChange>}
     */
    const enrichWithType = async change => {
      if (!('add' in change)) {
        return change;
      }
      const { value } = change;
      if (value === undefined) {
        return change;
      }
      const id = formatId(value);
      const formulaType = await getTypeForId(id).catch(() => undefined);
      if (formulaType === undefined) {
        return change;
      }
      return harden({ ...change, type: formulaType });
    };

    /** @type {EndoDirectory['followNameChanges']} */
    const followNameChanges = (...petNamePath) =>
      makeCancelableIterator(async function* followChanges(setCancelPending) {
        assertNames(petNamePath);
        if (petNamePath.length === 0) {
          const subscription = controller.followNameChanges();
          try {
            const cancellation = setCancelPending(() =>
              cancelPendingIterator(subscription),
            );
            if (cancellation !== undefined) await cancellation;
            for await (const change of subscription) {
              yield await enrichWithType(change);
            }
          } finally {
            await subscription.return(undefined);
          }
          return undefined;
        }
        // Remote hubs expose their own stream protocol; cancellation here only
        // reaches local root subscriptions, not a remote hub's pending work.
        const hub = /** @type {NameHub} */ (await lookup(petNamePath));
        for await (const change of /** @type {AsyncIterable<PetStoreNameChange>} */ (
          await E(hub).followNameChanges()
        )) {
          yield await enrichWithType(change);
        }
        return undefined;
      });

    /** @type {EndoDirectory['remove']} */
    const remove = async (...petNamePath) => {
      const { prefixPath, petName } = assertPetNamePath(petNamePath);
      await null;
      if (prefixPath.length === 0) {
        await controller.remove(petName);
        return;
      }
      const hub = /** @type {NameHub} */ (await lookup(prefixPath));
      await E(hub).remove(petName);
    };

    /** @type {EndoDirectory['move']} */
    const move = async (fromPath, toPath) => {
      const { prefixPath: fromPrefixPath, petName: fromPetName } =
        assertPetNamePath(fromPath);
      const { prefixPath: toPrefixPath, petName: toPetName } =
        assertPetNamePath(toPath);
      await null;

      // Optimize for same-hub moves (rename)
      if (fromPrefixPath.length === toPrefixPath.length) {
        const samePrefix = fromPrefixPath.every(
          (name, i) => name === toPrefixPath[i],
        );
        if (samePrefix) {
          if (fromPrefixPath.length === 0) {
            await controller.rename(fromPetName, toPetName);
          } else {
            const hub = /** @type {NameHub} */ (await lookup(fromPrefixPath));
            await E(hub).move([fromPetName], [toPetName]);
          }
          return;
        }
      }

      // Cross-hub move: copy then remove
      const id = await identify(...fromPath);
      if (id === undefined) {
        throw new Error(`Unknown name: ${q(fromPath)}`);
      }
      // First write to the "to" hub so that the original name is preserved on the
      // "from" hub in case of failure.
      await storeIdentifier(toPath, id);
      await remove(...fromPath);
    };

    /** @type {EndoDirectory['copy']} */
    const copy = async (fromPath, toPath) => {
      assertNamePath(fromPath);
      assertPetNamePath(toPath);
      const fromNamePath = /** @type {NamePath} */ (fromPath);
      const { hub: fromHub, name: fromName } =
        await lookupTailNameHub(fromNamePath);
      const id = await E(fromHub).identify(fromName);
      if (id === undefined) {
        throw new Error(`Unknown name: ${q(fromPath)}`);
      }
      await storeIdentifier(toPath, id);
    };

    /**
     * Store a formula identifier at a pet name path (internal).
     * @param {string | string[]} petNamePath
     * @param {string} id
     */
    const storeIdentifier = async (petNamePath, id) => {
      const { prefixPath, petName } = petNamePathFrom(petNamePath);
      await null;
      if (prefixPath.length === 0) {
        await controller.storeIdentifier(petName, id);
        return;
      }
      const hub = /** @type {NameHub} */ (await lookup(prefixPath));
      await E(hub).storeIdentifier([petName], id);
    };

    /**
     * Store a locator (endo:// URL) at a pet name path.
     * @param {string | string[]} petNamePath
     * @param {string} locator
     */
    const storeLocator = async (petNamePath, locator) => {
      if (!locator.startsWith('endo://')) {
        throw new Error(
          `storeLocator requires an endo:// locator, got ${q(locator)}`,
        );
      }
      const { id } = internalizeLocator(locator);
      await storeIdentifier(petNamePath, id);
    };

    /** @type {EndoDirectory['makeDirectory']} */
    const makeDirectory = async directoryPetNamePath => {
      const { value: newDirectory, id } = await formulateDirectory();
      pinTransient(id);
      try {
        await storeIdentifier(directoryPetNamePath, id);
      } finally {
        unpinTransient(id);
      }
      return newDirectory;
    };

    /** @type {EndoDirectory['readText']} */
    const readText = async petNameOrPath => {
      const namePath = namePathFrom(petNameOrPath);
      if (namePath.length < 2) {
        const blob = await lookup(namePath);
        return E(/** @type {any} */ (blob)).text();
      }
      const { hub, name } = await lookupTailNameHub(namePath);
      return E(/** @type {any} */ (hub)).readText(name);
    };

    /** @type {EndoDirectory['maybeReadText']} */
    const maybeReadText = async petNameOrPath => {
      const namePath = namePathFrom(petNameOrPath);
      if (namePath.length < 2) {
        const blob = await maybeLookup(namePath);
        if (blob === undefined || blob === null) {
          return undefined;
        }
        return E(/** @type {any} */ (blob)).text();
      }
      const { hub, name } = await lookupTailNameHub(namePath);
      return E(/** @type {any} */ (hub)).maybeReadText(name);
    };

    /** @type {EndoDirectory['writeText']} */
    const writeText = async (petNameOrPath, content) => {
      // Coerce for branching only; the store funnels through this
      // directory's own storeIdentifier, which enforces a pet-name leaf.
      const namePath = namePathFrom(petNameOrPath);
      if (namePath.length < 2) {
        const bytes = encodeUtf8(content);
        const readerRef = bytesReaderFromIterator([bytes]);
        /** @type {DeferredTasks<ReadableBlobDeferredTaskParams>} */
        const tasks = makeDeferredTasks();
        tasks.push(identifiers =>
          storeIdentifier(namePath, identifiers.readableBlobId),
        );
        await formulateReadableBlob(/** @type {any} */ (readerRef), tasks);
        return;
      }
      const { hub, name } = await lookupTailNameHub(namePath);
      await E(/** @type {any} */ (hub)).writeText(name, content);
    };

    /** @type {EndoDirectory & ContentLocatable} */
    const directory = {
      has,
      identify,
      locate,
      reverseLocate,
      followLocatorNameChanges,
      list,
      listValues,
      listIdentifiers,
      listLocators,
      locateContent,
      listContent,
      storeContent,
      reverseLocateContent,
      internalizeContentLocator,
      followNameChanges,
      lookup,
      maybeLookup,
      reverseLookup,
      storeIdentifier,
      storeLocator,
      move,
      remove,
      copy,
      makeDirectory,
      readText,
      maybeReadText,
      writeText,
    };
    return directory;
  };

  /**
   * @param {object} args
   * @param {FormulaIdentifier} args.petStoreId
   * @param {Context} args.context
   * @param {NodeNumber} args.agentNodeNumber
   * @param {(node: string) => boolean} args.isLocalKey
   */
  const makeIdentifiedDirectory = async ({
    petStoreId,
    context,
    agentNodeNumber,
    isLocalKey,
  }) => {
    // TODO thread context

    const petStore = await provideStoreController(petStoreId);
    const noNetworkAddresses = async () => [];
    const noContentSources = async () => [];
    const directory = makeDirectoryNode(
      petStore,
      agentNodeNumber,
      isLocalKey,
      noNetworkAddresses,
      noContentSources,
    );

    const help = makeHelp(directoryHelp);

    const {
      has,
      identify,
      locate,
      reverseLocate,
      list,
      listValues,
      listIdentifiers,
      listLocators,
      lookup,
      reverseLookup,
      remove,
      move,
      copy,
      makeDirectory,
    } = directory;

    // The read-only view is memoized per directory: the first `readOnly()` call
    // mints the local exo; every later call returns the same object. The view is
    // a plain in-daemon exo (no worker, no formula, no pin). Because
    // `@endo/captp` defaults `gcImports = false`, a guest looping `readOnly()`
    // over an unmemoized mint would retain one export-table slot per call until
    // the connection closes, so this memo is that bound, not merely a stable
    // identity convenience.
    /** @type {ReadableNameHub | undefined} */
    let readOnlyView;

    // Liveness gate for the read-only view: the view carries no formula identity,
    // so formula collection's sever path cannot reach it. Trip a flag when this
    // directory's context is canceled so the view stops forwarding reads once
    // the backing directory is collected — a capability handed to a less-trusted
    // holder must not outlive revocation of the capability it attenuates. Key the
    // gate off `context.cancelled` (rejected synchronously inside `cancel`) rather
    // than an `onCancel` hook: the hook drain is serial over `hooks.reverse()`, so
    // a hook-driven flag would flip only behind every later-registered peer hook —
    // a peer that awaits a slow teardown, or never settles, would keep this view
    // forwarding to an already-revoked directory. `.catch` on `cancelled` trips the
    // flag one microtask after rejection regardless of drain order.
    let cancelled = false;
    void context.cancelled.catch(() => {
      cancelled = true;
    });
    const assertReadOnlyViewLive = () => {
      if (cancelled) {
        throw new Error('Directory has been revoked');
      }
    };

    return makeExo(
      'EndoDirectory',
      DirectoryInterface,
      /** @type {any} */ ({
        help,
        has,
        identify,
        locate,
        reverseLocate,
        followLocatorNameChanges: locator =>
          readerFromIterator(directory.followLocatorNameChanges(locator)),
        list,
        listValues,
        listIdentifiers,
        listLocators,
        followNameChanges: () => {
          const iterator = directory.followNameChanges();
          return readerFromIterator(iterator, {
            cancelPending: () => cancelPendingIterator(iterator),
          });
        },
        lookup,
        maybeLookup: directory.maybeLookup,
        reverseLookup,
        storeIdentifier: directory.storeIdentifier,
        storeLocator: directory.storeLocator,
        remove,
        move,
        copy,
        makeDirectory,
        readText: directory.readText,
        maybeReadText: directory.maybeReadText,
        writeText: directory.writeText,
        // Mint a read-only `ReadableNameHub` view. Attenuation is SHALLOW:
        // the view withholds this directory's OWN mutators, but `lookup`/
        // `maybeLookup` on it forward to the backing directory and return any
        // nested directory / agent handle / worker as the live, fully-writable
        // object — not a further-attenuated view. The narrowing therefore
        // reaches only one hop: a holder can mutate any writable capability the
        // backing directory names, including a name bound back to this directory
        // itself or an ancestor, which voids the narrowing entirely. This is
        // documented on `ReadableNameHub.lookup` in types.d.ts; callers needing
        // a recursively read-only surface must re-attenuate results themselves.
        readOnly: async () => {
          assertReadOnlyViewLive();
          if (readOnlyView === undefined) {
            readOnlyView = makeReadOnlyDirectoryView(
              harden({ has, list, lookup, maybeLookup: directory.maybeLookup }),
              assertReadOnlyViewLive,
            );
          }
          return readOnlyView;
        },
      }),
    );
  };

  return { makeIdentifiedDirectory, makeDirectoryNode };
};
