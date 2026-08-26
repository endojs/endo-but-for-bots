// @ts-nocheck

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import url from 'url';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import popen from 'child_process';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { makeCancelKit } from '@endo/cancel';
import { makePromiseKit } from '@endo/promise-kit';
import { encodeHex } from '@endo/hex';
import { decodeBase64 } from '@endo/base64';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { start, stop, purge, makeEndoClient } from '../index.js';
import { parseId } from '../src/formula-identifier.js';
import { makeDaemon } from '../src/manager.js';
import {
  gunzip,
  makeCryptoPowers,
  makeDaemonicPowers,
  makeFilePowers,
} from '../src/manager-node-powers.js';

const { raw } = String;

const dirname = url.fileURLToPath(new URL('..', import.meta.url)).toString();

/**
 * @param {unknown} error
 * @param {string} fragment
 * @returns {boolean}
 */
const errorIncludes = (error, fragment) => {
  if (String(error).includes(fragment)) return true;
  if (error instanceof AggregateError) {
    return error.errors.some(nested => errorIncludes(nested, fragment));
  }
  return (
    error instanceof Error &&
    error.cause !== undefined &&
    errorIncludes(error.cause, fragment)
  );
};

/**
 * @param {() => Promise<boolean>} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number, message?: string }} [opts]
 */
const waitForCondition = async (predicate, opts = {}) => {
  await null;
  const { timeoutMs = 5000, intervalMs = 50, message = 'condition' } = opts;
  const startTime = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) {
      return;
    }
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Timed out waiting for ${message}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
};

/** @param {Array<string>} root */
const makeConfig = (...root) => {
  return {
    statePath: path.join(dirname, ...root, 'state'),
    ephemeralStatePath: path.join(dirname, ...root, 'run'),
    cachePath: path.join(dirname, ...root, 'cache'),
    sockPath:
      process.platform === 'win32'
        ? raw`\\?\pipe\endo-${root.join('-')}-test.sock`
        : path.join(dirname, ...root, 'endo.sock'),
    address: '127.0.0.1:0',
    pets: new Map(),
    values: new Map(),
  };
};

/** @type {Map<string, number>} */
const testNumbers = new Map();

/**
 * Mirrors the helper in endo.test.js so configs from this file
 * cannot collide with endo.test.js configs even if both run in
 * the same process.
 *
 * @param {string} testTitle
 * @param {number} testConfigIndex
 */
const getConfigDirectoryName = (testTitle, testConfigIndex) => {
  const munged = testTitle.match(/\w+/gu)?.join('-') || '';
  if (!testNumbers.has(testTitle)) testNumbers.set(testTitle, testNumbers.size);
  const testNumber = testNumbers.get(testTitle);
  const nnnn = String(testNumber).padStart(4, '0');
  const letter = (testConfigIndex + 10).toString(36);
  return `csgc-${munged.slice(0, 18)}~${nnnn}${letter}`;
};

/**
 * @param {import('ava').ExecutionContext<any>} t
 */
const prepareConfig = async t => {
  const { reject: cancel, promise: cancelled } = makePromiseKit();
  cancelled.catch(() => {});
  const config = {
    ...makeConfig('tmp', getConfigDirectoryName(t.title, t.context.length)),
    gcEnabled: true,
  };

  await purge(config);
  await start(config);

  const contextObj = { cancel, cancelled, config };
  t.context.push(contextObj);
  return { ...contextObj };
};

/**
 * @param {ReturnType<makeConfig>} config
 * @param {Promise<void>} cancelled
 */
const makeHost = async (config, cancelled) => {
  const { getBootstrap, closed } = await makeEndoClient(
    'client',
    config.sockPath,
    cancelled,
  );
  closed.catch(() => {});
  const bootstrap = getBootstrap();
  return { host: E(bootstrap).host() };
};

test.beforeEach(t => {
  t.context = [];
});

test.afterEach.always(async t => {
  const configs = t.context;
  await Promise.allSettled(configs.map(({ config }) => stop(config)));
  for (const { cancel, cancelled } of configs) {
    cancelled.catch(() => {});
    cancel(new Error('test cleanup'));
  }
});

// Both blobs (getInfo().hash) and trees (sha256()) report the content hash as
// base64; the content store keys files by the hex digest, so convert via
// storeKeyOf wherever the store address is needed.
const storeKeyOf = hashBase64 => encodeHex(decodeBase64(hashBase64));
const contentPathOf = (statePath, hashBase64) =>
  path.join(statePath, 'store-sha256', storeKeyOf(hashBase64));

const mountPathOf = (statePath, formulaNumber) =>
  path.join(statePath, 'mounts', formulaNumber);
const sandboxPathOf = (statePath, formulaNumber) =>
  path.join(statePath, 'sandboxes', formulaNumber);

/**
 * Boot a real `makeDaemon()` core in this process — no forked child, no
 * sockets — so a test can drive the genuine formula-graph and GC code in
 * `manager.js` (including the private `reclaimCollectedStorage` closure,
 * which is reachable only from a live daemon's GC sweep) while swapping
 * only the OS-privileged sandbox/mount host tools (the `@endo/sandbox`
 * bwrap/podman drivers, the 9P kernel mount) for deterministic fakes.
 *
 * Everything else — persistence, worker spawning, the formula graph, GC
 * sweeps — is the exact code `manager-node.js` wires for a real forked
 * daemon; only the two seams that need `CAP_SYS_ADMIN` / a container
 * runtime are replaced, mirroring the fake-projector/fake-backend
 * pattern `test/sandbox.test.js` already uses at the slice level.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {{ hostTools?: Partial<import('../src/types.js').HostToolPowers> }} [opts]
 */
const makeInProcessDaemon = async (t, { hostTools = {} } = {}) => {
  const config = {
    ...makeConfig('tmp', getConfigDirectoryName(t.title, t.context.length)),
    registryUrl: 'https://registry.npmjs.org',
  };
  const { cancel, cancelled } = makeCancelKit();
  cancelled.catch(() => {});

  const filePowers = makeFilePowers({ fs, path });
  const cryptoPowers = makeCryptoPowers(crypto);
  const registryPowers = {
    fetch: globalThis.fetch,
    gunzip,
    createHash: crypto.createHash,
  };

  const basePowers = await makeDaemonicPowers({
    config,
    cancelled,
    fs,
    popen,
    url,
    filePowers,
    cryptoPowers,
    registryPowers,
  });
  // `basePowers` is hardened; build a fresh record rather than mutating it
  // so only `hostTools` (the OS-privileged git/shell/sandbox seam) is
  // overridden.
  const powers = { ...basePowers, hostTools };

  await powers.persistence.initializePersistence();

  const { endoBootstrap, cancelGracePeriod } = await makeDaemon(
    powers,
    `test daemon: ${t.title}`,
    cancel,
    cancelled,
    {},
    { gcEnabled: true },
  );
  t.teardown(() => {
    cancelGracePeriod(new Error('test cleanup'));
    cancel(new Error('test cleanup'));
  });

  const host = E(endoBootstrap).host();
  return { host, config };
};

/**
 * A `hostTools.makeMountProjector` stand-in whose 9P projection never
 * confirms detachment. This is the "failing to unmount" condition
 * `mount-projection.js`'s `release()` reports as `detached: false`: the
 * real projector logs it to stderr and resolves `false` rather than
 * throwing, so `sandbox-slice.js`'s `releaseProjections()` treats it as a
 * cleanup failure and pushes a "did not confirm detachment" error. That
 * deterministically fails the sandbox's `onCancel` hook, landing the
 * sandbox in `manager.js`'s `sandboxIdsWithFailedCancellation` — the same
 * scenario `sandbox.test.js`'s "a failed 9P detach preserves state for a
 * later retry" test exercises at the slice level, here driven through a
 * real daemon's GC sweep.
 */
const makeUndetachableMountProjector = () =>
  harden({
    projectMount: async (cap, options) =>
      harden({
        kind: '9p',
        hostPath: options.mountPoint,
        mountCap: cap,
        release: async () => false,
      }),
  });

/**
 * A `hostTools.makeSandboxFactory` stand-in that mints a slice without
 * spawning bwrap/podman, mirroring `makeFakeBackend` in
 * `sandbox.test.js`. The daemon's real mount projection (and therefore
 * the cancellation-failure injection above) still runs; only the
 * container runtime is faked, so this test does not need — and does not
 * skip for lack of — a real sandbox backend.
 */
const makeNoopSandboxFactory = () => async (_powers, _context, options) =>
  Far('FakeSandboxFactory', {
    make: async () =>
      Far('FakeSandboxHandle', {
        // The escalation ledger records the driver a mint resolved to,
        // so a handle that cannot name one does not become a slice.
        backend: () => 'bwrap',
        dispose: async () => {
          await options?.onHandleDisposed?.();
        },
      }),
  });

test.serial(
  'GC preserves a scratch-mount whose sandbox failed to cancel in the same batch',
  async t => {
    const { host, config } = await makeInProcessDaemon(t, {
      hostTools: {
        makeMountProjector: makeUndetachableMountProjector,
        makeSandboxFactory: makeNoopSandboxFactory(),
      },
    });

    await E(host).provideScratchMount('gc-scratch');
    const scratch = await E(host).lookup(['gc-scratch']);
    const scratchId = await E(host).identify('gc-scratch');
    const { number: scratchFormulaNumber } = parseId(scratchId);
    const scratchDirPath = mountPathOf(config.statePath, scratchFormulaNumber);
    t.true(fs.existsSync(scratchDirPath), 'scratch backing dir created');

    // The sandbox's profile.mounts records the scratch-mount's formula id,
    // giving reclaimCollectedStorage the dependency edge it must walk
    // (manager.js's scratchMountIdsToPreserve) to protect a live
    // dependency of a sandbox whose cancellation failed.
    await E(host).provideSandbox('gc-sandbox', {
      rootfs: { kind: 'minimal' },
      mounts: [{ cap: scratch, innerPath: '/data', mode: 'rw' }],
      escalation: { reason: 'OS_EFFECT', capability: 'gc-test' },
    });
    const sandboxId = await E(host).identify('gc-sandbox');
    const { number: sandboxFormulaNumber } = parseId(sandboxId);
    const sandboxDirPath = sandboxPathOf(
      config.statePath,
      sandboxFormulaNumber,
    );
    t.true(fs.existsSync(sandboxDirPath), 'sandbox state dir created');

    // Drop the scratch mount's own pet name first: it is still kept alive
    // by the sandbox's profile.mounts dependency edge (manager.js's
    // extractLabeledDeps for 'sandbox'), so this alone must not collect
    // it yet.
    await E(host).remove('gc-scratch');
    await new Promise(resolve => setTimeout(resolve, 200));
    t.true(
      fs.existsSync(scratchDirPath),
      'scratch backing dir survives while the sandbox still depends on it',
    );

    // Removing the sandbox's own name makes the sandbox — and, once its
    // dependency edge drops, the now-unreferenced scratch-mount —
    // collectible in the same GC batch. The fake mount projector's
    // release() never confirms detachment, so the sandbox's cancellation
    // hook rejects and both directories must be preserved for operator
    // recovery.
    await E(host).remove('gc-sandbox');

    // Give the async collection-cleanup phase (cancellation, then
    // reclaimCollectedStorage) a moment to run its course.
    await new Promise(resolve => setTimeout(resolve, 300));

    t.true(
      fs.existsSync(sandboxDirPath),
      'sandbox state preserved for operator recovery after a failed cancellation',
    );
    t.true(
      fs.existsSync(scratchDirPath),
      'scratch-mount backing dir preserved: still reachable from the ' +
        'preserved sandbox even though both formulas were collected in ' +
        'the same GC batch',
    );
  },
);

test('content-store blob is reclaimed when its only formula is collected', async t => {
  const { cancelled, config } = await prepareConfig(t);
  const { host } = await makeHost(config, cancelled);

  const readerRef = bytesReaderFromIterator([
    new TextEncoder().encode('blob-content'),
  ]);
  const blob = await E(host).storeBlob(readerRef, 'lonely-blob');
  const sha256 = (await E(blob).getInfo()).hash;

  const filePath = contentPathOf(config.statePath, sha256);
  t.true(fs.existsSync(filePath), 'blob file written to content store');

  await E(host).remove('lonely-blob');

  await waitForCondition(async () => !fs.existsSync(filePath), {
    message: `${filePath} to be removed`,
  });
  t.false(fs.existsSync(filePath), 'blob file pruned after formula collection');
});

test('content-store blob survives when a sibling formula still references the same hash', async t => {
  const { cancelled, config } = await prepareConfig(t);
  const { host } = await makeHost(config, cancelled);

  const bytes = new TextEncoder().encode('shared-content');

  const blobA = await E(host).storeBlob(
    bytesReaderFromIterator([bytes]),
    'twin-a',
  );
  const blobB = await E(host).storeBlob(
    bytesReaderFromIterator([bytes]),
    'twin-b',
  );

  const shaA = (await E(blobA).getInfo()).hash;
  const shaB = (await E(blobB).getInfo()).hash;
  t.is(shaA, shaB, 'both blobs dedupe to the same content hash');

  const filePath = contentPathOf(config.statePath, shaA);
  t.true(fs.existsSync(filePath), 'shared blob file present after both stores');

  await E(host).remove('twin-a');

  // Wait for the formula GC pass to settle.  We want to assert
  // that the content file does NOT disappear, so we give it a
  // moment to potentially do the wrong thing, then check.
  await new Promise(resolve => setTimeout(resolve, 200));

  t.true(
    fs.existsSync(filePath),
    'shared blob file retained while sibling formula survives',
  );

  // Verify the surviving sibling can still read the content.
  const survivor = await E(host).lookup(['twin-b']);
  const text = await E(survivor).text();
  t.is(text, 'shared-content');

  // Now collect the survivor too and verify the file is gone.
  await E(host).remove('twin-b');
  await waitForCondition(async () => !fs.existsSync(filePath), {
    message: `${filePath} to be removed after both formulas collected`,
  });
  t.false(fs.existsSync(filePath), 'shared blob pruned after last reference');
});

test('scratch-mount backing directory is reclaimed when its formula is collected', async t => {
  const { cancelled, config } = await prepareConfig(t);
  const { host } = await makeHost(config, cancelled);

  await E(host).provideScratchMount('throwaway-scratch');
  const scratch = await E(host).lookup(['throwaway-scratch']);
  await E(scratch).writeText(['draft.txt'], 'pending');

  const scratchId = await E(host).identify('throwaway-scratch');
  const { number: formulaNumber } = parseId(scratchId);
  const dirPath = mountPathOf(config.statePath, formulaNumber);
  t.true(fs.existsSync(dirPath), 'scratch backing dir created');

  await E(host).remove('throwaway-scratch');

  await waitForCondition(async () => !fs.existsSync(dirPath), {
    message: `${dirPath} to be removed`,
  });
  t.false(
    fs.existsSync(dirPath),
    'scratch backing dir pruned after formula collection',
  );
});

test.serial(
  'sandbox state is reclaimed when its formula is collected',
  async t => {
    const { cancelled, config } = await prepareConfig(t);
    const { host } = await makeHost(config, cancelled);

    try {
      await E(host).provideSandbox('throwaway-sandbox', {
        rootfs: { kind: 'minimal' },
        // A minimal rootfs is the bwrap driver's surface.  Podman only
        // accepts OCI rootfs specs, and auto selection may choose Podman on a
        // host where bwrap is unavailable.
        backend: 'bwrap',
        escalation: { reason: 'OS_EFFECT', capability: 'gc-test' },
      });
    } catch (error) {
      const message = String(error);
      if (errorIncludes(error, 'no backend available')) {
        t.pass(`SKIP: sandbox backend unavailable: ${message}`);
        return;
      }
      throw error;
    }

    const sandboxId = await E(host).identify('throwaway-sandbox');
    const { number: formulaNumber } = parseId(sandboxId);
    const dirPath = sandboxPathOf(config.statePath, formulaNumber);
    t.true(fs.existsSync(dirPath), 'sandbox state dir created');

    await E(host).remove('throwaway-sandbox');

    await waitForCondition(async () => !fs.existsSync(dirPath), {
      message: `${dirPath} to be removed after sandbox collection`,
      timeoutMs: 10_000,
    });
    t.false(fs.existsSync(dirPath), 'sandbox state pruned after collection');
  },
);

test('content-store blob from a readable-tree formula is reclaimed when the tree is collected', async t => {
  const { cancelled, config } = await prepareConfig(t);
  const { host } = await makeHost(config, cancelled);

  const remoteTree = Far('TestTree', {
    list: async () => ['only.txt'],
    lookup: async (/** @type {string} */ name) => {
      if (name !== 'only.txt') {
        throw new TypeError(`Unknown name: ${JSON.stringify(name)}`);
      }
      return bytesReaderFromIterator([
        new TextEncoder().encode('tree-only-content'),
      ]);
    },
    has: async (/** @type {string} */ name) => name === 'only.txt',
  });

  await E(host).storeTree(remoteTree, 'lonely-tree');
  const tree = await E(host).lookup(['lonely-tree']);
  const sha256 = await E(tree).sha256();

  // getInfo() is the uniform identity accessor on the real content store:
  // its base64 hash equals sha256() and the cheap size() path yields the
  // manifest byte length as a bigint.
  const info =
    /** @type {{ algorithm: string, hash: string, size: bigint }} */ (
      await E(tree).getInfo()
    );
  t.is(info.algorithm, 'sha256');
  t.is(info.hash, sha256);
  t.is(typeof info.size, 'bigint');
  t.true(info.size > 0n);

  const filePath = contentPathOf(config.statePath, sha256);
  t.true(fs.existsSync(filePath), 'tree root JSON written to content store');

  await E(host).remove('lonely-tree');

  await waitForCondition(async () => !fs.existsSync(filePath), {
    message: `${filePath} to be removed`,
  });
  t.false(
    fs.existsSync(filePath),
    'tree root JSON pruned after formula collection',
  );
});

/**
 * Construct a remote readable-tree Exo from a literal `{ name: bytes }`
 * map of blob children.  The tree only supports `list`, `lookup`, and
 * `has` of its own children; sub-trees are written as separate
 * `makeRemoteBlobTree` instances and passed via `subtrees`.
 *
 * @param {Record<string, Uint8Array>} blobs
 * @param {Record<string, unknown>} [subtrees]
 */
const makeRemoteBlobTree = (blobs, subtrees = {}) => {
  const blobNames = Object.keys(blobs);
  const subtreeNames = Object.keys(subtrees);
  const allNames = [...blobNames, ...subtreeNames].sort();
  return Far('TestTree', {
    list: async () => allNames,
    lookup: async (/** @type {string} */ name) => {
      if (Object.prototype.hasOwnProperty.call(blobs, name)) {
        const bytes = blobs[name];
        return bytesReaderFromIterator([bytes]);
      }
      if (Object.prototype.hasOwnProperty.call(subtrees, name)) {
        return subtrees[name];
      }
      throw new TypeError(`Unknown name: ${JSON.stringify(name)}`);
    },
    has: async (/** @type {string} */ name) => allNames.includes(name),
  });
};

const storeDirEntries = statePath =>
  fs.readdirSync(path.join(statePath, 'store-sha256'));

test('readable-tree collection reclaims transitively-referenced child blob hashes', async t => {
  const { cancelled, config } = await prepareConfig(t);
  const { host } = await makeHost(config, cancelled);

  const remoteTree = makeRemoteBlobTree({
    'a.txt': new TextEncoder().encode('alpha-payload'),
    'b.txt': new TextEncoder().encode('beta-payload'),
  });

  await E(host).storeTree(remoteTree, 'leafy-tree');
  const tree = await E(host).lookup(['leafy-tree']);
  const rootSha256 = await E(tree).sha256();

  // Three distinct content-store entries should now exist: the tree
  // root JSON and one blob per leaf.  Capture them before collection
  // so the assertion can name the leaked candidates explicitly.
  const beforeEntries = storeDirEntries(config.statePath);
  t.true(
    beforeEntries.includes(storeKeyOf(rootSha256)),
    'tree root JSON present before collection',
  );
  const rootKey = storeKeyOf(rootSha256);
  const leafHashesBefore = beforeEntries.filter(name => name !== rootKey);
  t.is(
    leafHashesBefore.length,
    2,
    'two leaf blob hashes present before collection',
  );

  await E(host).remove('leafy-tree');

  await waitForCondition(
    async () => storeDirEntries(config.statePath).length === 0,
    {
      message: `content store to be empty (had ${beforeEntries.length} entries)`,
    },
  );
  const afterEntries = storeDirEntries(config.statePath);
  t.deepEqual(
    afterEntries,
    [],
    `transitive child blobs leaked: ${afterEntries.join(', ')}`,
  );
});

test('readable-tree collection preserves a child blob hash that a surviving readable-blob still references', async t => {
  const { cancelled, config } = await prepareConfig(t);
  const { host } = await makeHost(config, cancelled);

  const sharedBytes = new TextEncoder().encode('shared-leaf-payload');

  // Independently store the same bytes as a top-level readable-blob
  // and as a leaf inside a readable-tree.  checkinTree dedupes on
  // sha256, so both formulas reference the same content-store hash.
  const sharedBlob = await E(host).storeBlob(
    bytesReaderFromIterator([sharedBytes]),
    'shared-leaf-blob',
  );
  const sharedSha256 = (await E(sharedBlob).getInfo()).hash;

  const remoteTree = makeRemoteBlobTree({
    'shared.txt': sharedBytes,
    'unique.txt': new TextEncoder().encode('unique-to-tree'),
  });

  await E(host).storeTree(remoteTree, 'shared-leaf-tree');
  const tree = await E(host).lookup(['shared-leaf-tree']);
  const rootSha256 = await E(tree).sha256();

  const beforeEntries = storeDirEntries(config.statePath);
  t.true(
    beforeEntries.includes(storeKeyOf(rootSha256)),
    'tree root JSON present before collection',
  );
  t.true(
    beforeEntries.includes(storeKeyOf(sharedSha256)),
    'shared blob hash present before collection',
  );

  await E(host).remove('shared-leaf-tree');

  // The tree root JSON and the unique-to-tree leaf must be gone.
  // The shared leaf must remain because the readable-blob formula
  // still references it.
  await waitForCondition(
    async () => !fs.existsSync(contentPathOf(config.statePath, rootSha256)),
    { message: 'tree root JSON to be reclaimed' },
  );
  await waitForCondition(
    async () => storeDirEntries(config.statePath).length === 1,
    { message: 'content store to settle to a single shared entry' },
  );

  const afterEntries = storeDirEntries(config.statePath);
  t.deepEqual(
    afterEntries,
    [storeKeyOf(sharedSha256)],
    'only the shared blob hash remains; tree-only entries reclaimed',
  );

  // Verify the surviving sibling can still read the content.
  const survivor = await E(host).lookup(['shared-leaf-blob']);
  const text = await E(survivor).text();
  t.is(text, 'shared-leaf-payload');
});

test('readable-tree collection walks nested subtrees and reclaims grandchild hashes', async t => {
  const { cancelled, config } = await prepareConfig(t);
  const { host } = await makeHost(config, cancelled);

  const innerTree = makeRemoteBlobTree({
    'grand.txt': new TextEncoder().encode('grandchild-payload'),
  });
  const outerTree = makeRemoteBlobTree(
    { 'top.txt': new TextEncoder().encode('top-payload') },
    { sub: innerTree },
  );

  await E(host).storeTree(outerTree, 'nested-tree');
  const tree = await E(host).lookup(['nested-tree']);
  const rootSha256 = await E(tree).sha256();

  // Expect four distinct entries: outer tree JSON, inner tree JSON,
  // top.txt blob, grand.txt blob.
  const beforeEntries = storeDirEntries(config.statePath);
  t.true(
    beforeEntries.includes(storeKeyOf(rootSha256)),
    'outer tree root JSON present before collection',
  );
  t.is(
    beforeEntries.length,
    4,
    'four entries (outer JSON, inner JSON, two leaf blobs) before collection',
  );

  await E(host).remove('nested-tree');

  await waitForCondition(
    async () => storeDirEntries(config.statePath).length === 0,
    {
      message: `content store to be empty (had ${beforeEntries.length} entries)`,
    },
  );
  const afterEntries = storeDirEntries(config.statePath);
  t.deepEqual(
    afterEntries,
    [],
    `transitive nested-tree hashes leaked: ${afterEntries.join(', ')}`,
  );
});
