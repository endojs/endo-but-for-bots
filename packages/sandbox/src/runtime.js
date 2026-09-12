// @ts-check

import { Fail } from '@endo/errors';

import { makePodmanDriver } from './drivers/podman.js';
import { makeSandboxFactoryKit } from './factory.js';
import { makeGeneratedFileStorage } from './generated-file-storage.js';
import { acquireRuntimeOwnership } from './runtime-ownership.js';

/** @import { SandboxDriver, SandboxFactory, SandboxPowers } from './types.js' */
/** @import { GeneratedFileStorage } from './generated-file-storage-types.js' */

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
 * @param {{ scratchProvider: SandboxPowers, fs?: typeof import('node:fs/promises'), makeDriver?: (storage: GeneratedFileStorage) => SandboxDriver & { close(): Promise<void> } }} powers
 */
export const makeSandboxRuntime = (
  { directory, ownerId, maxBytes, maxEntries, env = {} },
  { scratchProvider, fs: fsPower, makeDriver },
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
        : makePodmanDriver({ env, ownerId, generatedFileStorage: storage });
      assertOpen();
      kit = makeSandboxFactoryKit({ drivers: [driver], scratchProvider });
      assertOpen();
      return kit.factory;
    })();
    return opening;
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
  return harden({ open, close });
};
harden(makeSandboxRuntime);
