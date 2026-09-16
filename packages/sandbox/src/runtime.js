// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { makePodmanDriver } from './drivers/podman.js';
import { makeSandboxFactoryKit } from './factory.js';
import {
  NativeSandboxMakeOptsShape,
  SandboxMakeOptsShape,
} from './interfaces.js';
import { makeGeneratedFileStorage } from './generated-file-storage.js';
import { acquireRuntimeOwnership } from './runtime-ownership.js';

/** @import { SandboxDriver, SandboxFactory, SandboxPowers } from './types.js' */
/** @import { GeneratedFileStorage } from './generated-file-storage-types.js' */
/** @import { VolumeQuotaEvidence } from './xfs-volume-quota.js' */
/** @import { ERef } from '@endo/eventual-send' */

/**
 * @typedef {object} VolumeQuotaObserver
 * @property {(request: { name: string, mountpoint: string }) => Promise<VolumeQuotaEvidence>} observe
 */

const NativeScopeInterface = harden(
  M.interface('NativeSandboxScope', {
    // The attested path. `makeResolved` hands the runtime already-resolved
    // host paths and asks it to bind them; `make` hands it a policy and asks
    // it to prove what it built — the mount table verified against the
    // anchor's own, which is the difference between a slice that claims its
    // confinement and one that demonstrates it. An adapter on `makeResolved`
    // also cannot take runtime attaches, because nothing attests them.
    make: M.call(SandboxMakeOptsShape).returns(M.promise()),
    makeResolved: M.call(NativeSandboxMakeOptsShape).returns(M.promise()),
    close: M.call().returns(M.promise()),
  }),
);
/**
 * @param {ReturnType<typeof makeSandboxFactoryKit>} kit
 * @param {() => Promise<void>} close
 */
const makeNativeScope = (kit, close) =>
  makeExo('NativeSandboxScope', NativeScopeInterface, {
    make: opts => E(kit.factory).make(opts),
    makeResolved: opts => kit.makeResolved(opts),
    close,
  });

const NativeServiceInterface = harden(
  M.interface('NativeSandboxService', {
    provideScope: M.call(M.string()).returns(M.remotable()),
    lookupScope: M.call(M.string()).returns(M.or(M.remotable(), M.undefined())),
  }),
);

/**
 * Construct a host-owned Podman runtime before acquiring any resources.
 * Retain this controller through failed open/close attempts. On open failure,
 * call close; on close failure, retry before replacing this owner.
 *
 * One stable private directory and ownerId must identify an operator's Podman
 * cleanup scope across incarnations. Never use another directory for the same
 * live scope. Existing ownership or storage refuses startup; this controller
 * does not infer safe crash recovery from a dead parent or a container listing.
 * The directory and its replaceable ancestors must remain outside guest writes.
 *
 * The generic factory separately supports other backends. This hosted runtime
 * requires a driver with explicit host-only lifetime cleanup authority.
 *
 * @param {{ directory: string, ownerId: string, maxBytes: bigint, maxEntries: bigint, env?: Record<string, string> }} config
 * `volumeQuota` is the trusted host kernel-quota observer the Podman driver
 * requires before it admits a durable volume mount. It is configuration-derived
 * host authority, never model-facing, and an adapter that needs one (Codex's
 * XFS project quotas) has no other way to supply it: the native service's
 * `make-unconfined` entry point takes slot-free `null` powers, so an observer
 * cannot arrive as a constructor argument. A promise is accepted — the driver
 * only ever eventual-sends to it.
 *
 * @param {{ scratchProvider: SandboxPowers | null, fs?: typeof import('node:fs/promises'), makeDriver?: (storage: GeneratedFileStorage) => SandboxDriver & { close(): Promise<void> }, volumeQuota?: ERef<VolumeQuotaObserver> }} powers
 */
export const makeSandboxRuntime = (
  { directory, ownerId, maxBytes, maxEntries, env = {} },
  { scratchProvider, fs: fsPower, makeDriver, volumeQuota },
) => {
  let closing = false;
  /** @type {Promise<SandboxFactory> | undefined} */
  let opening;
  /** @type {Promise<void> | undefined} */
  let closeFlight;
  /** @type {Awaited<ReturnType<typeof acquireRuntimeOwnership>> | undefined} */
  let ownership;
  /** @type {GeneratedFileStorage | undefined} */
  let storage;
  /** @type {ReturnType<typeof makeSandboxFactoryKit> | undefined} */
  let kit;
  /** @type {(SandboxDriver & { close(): Promise<void> }) | undefined} */
  let driver;
  /** @type {Map<string, { scope: ReturnType<typeof makeNativeScope>, close(): Promise<void> }>} */
  const scopes = new Map();
  /** @param {{ close(): Promise<void> } | undefined} owner */
  const closeOwner = async owner => owner?.close();
  const assertOpen = () => {
    !closing || Fail`Sandbox runtime is closing`;
  };
  const open = () => {
    assertOpen();
    opening ??= (async () => {
      const path = await import('node:path');
      assertOpen();
      ownership = await acquireRuntimeOwnership(
        { directory, ownerId },
        { fs: fsPower },
      );
      assertOpen();
      storage = await makeGeneratedFileStorage(
        {
          directory: path.join(ownership.directory, `${ownerId}.files`),
          maxBytes,
          maxEntries,
        },
        { fs: fsPower },
      );
      assertOpen();
      driver = makeDriver
        ? makeDriver(storage)
        : makePodmanDriver({
            env,
            ownerId,
            generatedFileStorage: storage,
            ...(volumeQuota === undefined ? {} : { volumeQuota }),
          });
      assertOpen();
      kit = makeSandboxFactoryKit({ drivers: [driver], scratchProvider });
      assertOpen();
      return kit.factory;
    })();
    return opening;
  };
  const service = makeExo('NativeSandboxService', NativeServiceInterface, {
    provideScope: id => {
      assertOpen();
      const selectedDriver = driver;
      if (selectedDriver === undefined) throw Fail`Sandbox runtime is not open`;
      const existing = scopes.get(id);
      if (existing) return existing.scope;
      const scopedKit = makeSandboxFactoryKit({
        drivers: [selectedDriver],
        scratchProvider,
      });
      const closeScope = async () => {
        await scopedKit.close();
        if (scopes.get(id) === record) scopes.delete(id);
      };
      const scope = makeNativeScope(scopedKit, closeScope);
      const record = { scope, close: closeScope };
      scopes.set(id, record);
      return scope;
    },
    // Absence is not proof that an earlier service incarnation released native
    // resources. Recovery must use this lookup, never provision a replacement.
    lookupScope: id => scopes.get(id)?.scope,
  });
  const openNative = async () => {
    await open();
    assertOpen();
    return service;
  };
  const close = () => {
    closing = true;
    if (closeFlight !== undefined) return closeFlight;
    // Fence an already-published factory immediately; pending initialization
    // cannot publish one after the closing flag. Preserve this failure below.
    const factoryAtClose = kit;
    const driverAtClose = driver;
    const stopped = Promise.allSettled([
      closeOwner(factoryAtClose),
      closeOwner(driverAtClose),
      ...[...scopes.values()].map(closeOwner),
    ]);
    closeFlight = (async () => {
      // A failed open is historical. Release only the resources it acquired.
      await opening?.catch(() => undefined);
      const late = [];
      if (kit !== factoryAtClose) late.push(closeOwner(kit));
      if (driver !== driverAtClose) late.push(closeOwner(driver));
      const results = [...(await stopped), ...(await Promise.allSettled(late))];
      const failures = results
        .filter(result => result.status === 'rejected')
        .map(result => result.reason);
      if (failures.length) {
        throw new AggregateError(failures, 'Sandbox runtime shutdown pending');
      }
      await storage?.close();
      await ownership?.release();
    })().catch(error => {
      closeFlight = undefined;
      throw error;
    });
    return closeFlight;
  };
  return harden({ open, openNative, close });
};
harden(makeSandboxRuntime);
