// @ts-check
/// <reference types="ses"/>

/**
 * Tests for the daemon's `sandbox` formula: profile normalization, the
 * slice composition the formula maker performs, and the escalation
 * ledger.
 *
 * Like `shell.test.js`, these assemble the maker's parts directly rather
 * than booting a daemon (which needs a native sqlite build unavailable in
 * some CI sandboxes). The final test opts back into the real
 * `@endo/sandbox` backend and skips when the host has no usable driver,
 * per the probe-and-skip convention in `packages/sandbox/test/bwrap.test.js`.
 */

/** @import { FormulaIdentifier, SandboxEscalationRecord, SandboxFormulaProfile } from '../src/types.js' */

import test from '@endo/ses-ava/prepare-endo.js';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeMountProjector } from '@endo/9p-server/mount-projection.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { probeBwrapUserns } from '@endo/sandbox/probe-bwrap-userns.js';

import { makeFilePowers } from '../src/manager-node-powers.js';
import { normalizeSandboxProfileForHost } from '../src/host.js';
import { makeMount } from '../src/mount.js';
import {
  makeSandboxIncarnationPath,
  makeSandboxSlice,
} from '../src/sandbox-slice.js';
import {
  assertSandboxMountGrant,
  makeSandboxEscalationLog,
  normalizeSandboxProfile,
} from '../src/sandbox.js';

/**
 * Provision a real on-disk mount, mirroring `shell.test.js`.
 *
 * `deniedSegments` defaults to the daemon's default deny set. Tests that
 * exercise the unrestricted mount shape pass `deniedSegments: []`.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {{ readOnly?: boolean, deniedSegments?: string[] }} [opts]
 */
const provisionMount = async (
  t,
  { readOnly = false, deniedSegments = undefined } = {},
) => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'sandbox-test-'),
  );
  t.teardown(() => fs.promises.rm(root, { recursive: true, force: true }));
  const filePowers = makeFilePowers({ fs, path });
  return {
    root,
    mount: makeMount({ rootPath: root, readOnly, filePowers, deniedSegments }),
  };
};

/**
 * Per-slice state root, torn down with the test.
 *
 * @param {import('ava').ExecutionContext} t
 */
const provisionStatePath = async t => {
  const statePath = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'sandbox-state-'),
  );
  t.teardown(() => fs.promises.rm(statePath, { recursive: true, force: true }));
  return statePath;
};

/**
 * A projector whose physical branch is the real one and whose 9P branch
 * is faked: the tests that reach it assert *that* a projection was
 * requested and released, not that a kernel mount happened.
 */
/**
 * @param {{ prepare?: (cap: unknown, options: any) => Promise<void> }} [opts]
 */
const makeFakeProjector = ({ prepare = async () => {} } = {}) => {
  /** @type {Array<{ mountPoint: string, released: boolean }>} */
  const projections = [];
  const projector = harden({
    /**
     * @param {unknown} cap
     * @param {any} options
     */
    projectMount: async (cap, options) => {
      const record = { mountPoint: options.mountPoint, released: false };
      projections.push(record);
      await prepare(cap, options);
      return harden({
        kind: '9p',
        hostPath: options.mountPoint,
        mountCap: cap,
        release: async () => {
          record.released = true;
          return true;
        },
      });
    },
  });
  return { projector, projections };
};

/**
 * A stand-in for `@endo/sandbox`'s factory that resolves its granted
 * mounts through the powers it was handed, exactly as the real factory
 * does, and records what it saw.
 */
/** @param {{ disposeError?: unknown }} [opts] */
const makeFakeBackend = ({ disposeError = undefined } = {}) => {
  const calls = {
    /** @type {any[]} */ factories: [],
    /** @type {any[]} */ slices: [],
    disposed: 0,
  };
  /**
   * @param {any} powers
   * @param {any} context
   * @param {any} [options]
   */
  const makeSandboxFactory = async (powers, context, options) => {
    calls.factories.push({ powers, context, options });
    return Far('FakeSandboxFactory', {
      /** @param {any} opts */
      make: async opts => {
        const scratchCap = await E(powers).provideScratchMount('scratch');
        const scratchHostPath = await E(powers).provideHostPath(scratchCap);
        /** @type {any[]} */
        const mounts = [];
        for (const mount of opts.mounts ?? []) {
          mounts.push({
            // eslint-disable-next-line no-await-in-loop
            hostPath: await E(powers).provideHostPath(mount.cap),
            innerPath: mount.innerPath,
            mode: mount.mode,
          });
        }
        const backendHandle = Far('FakeSandboxHandle', {
          dispose: async () => {
            calls.disposed += 1;
            await options?.onHandleDisposed?.();
            if (disposeError !== undefined) {
              throw disposeError;
            }
          },
        });
        calls.slices.push({ opts, mounts, scratchHostPath, backendHandle });
        return backendHandle;
      },
    });
  };
  return { calls, makeSandboxFactory };
};

/**
 * @param {import('ava').ExecutionContext} t
 * @param {SandboxFormulaProfile} profile
 * @param {any} [overrides]
 */
const mintSlice = async (t, profile, overrides = {}) => {
  const statePath = await provisionStatePath(t);
  const filePowers = makeFilePowers({ fs, path });
  const { projector, projections } = makeFakeProjector();
  const backend = makeFakeBackend(overrides.backend);
  const escalations = makeSandboxEscalationLog();
  const minted = await makeSandboxSlice({
    profile,
    sandboxId: fakeSandboxId,
    statePath,
    provideMount: async mountId => overrides.capForId[mountId],
    projector,
    makeSandboxFactory: backend.makeSandboxFactory,
    makePath: filePowers.makePath,
    removeDirectory: filePowers.removeDirectory,
    joinPath: filePowers.joinPath,
    escalations,
    assertMountGrant: assertSandboxMountGrant,
    ...overrides.slice,
  });
  return { ...minted, statePath, backend, escalations, projections };
};

const baseEscalation = harden(
  /** @type {import('../src/types.js').SandboxEscalation} */ ({
    reason: 'OS_EFFECT',
    capability: 'pi-session',
  }),
);

// Formula identifiers are branded strings; the tests do not mint real
// ones, so brand the two fixtures once rather than at every call site.
const fakeMountId = /** @type {FormulaIdentifier} */ ('mount-id');
const fakeSandboxId = /** @type {FormulaIdentifier} */ ('sandbox-id');
const resolveFakeMountId = harden({ resolveMountId: () => fakeMountId });

test('normalizeSandboxProfile resolves mount caps to formula identifiers', async t => {
  const { mount } = await provisionMount(t);
  const profile = normalizeSandboxProfile(
    {
      rootfs: { kind: 'oci', ref: 'docker.io/library/alpine:3.19' },
      mounts: [{ cap: mount, innerPath: '/workspace', mode: 'rw' }],
      network: 'private',
      backend: 'podman',
      escalation: baseEscalation,
    },
    resolveFakeMountId,
  );
  t.deepEqual(profile.rootfs, {
    kind: 'oci',
    ref: 'docker.io/library/alpine:3.19',
  });
  t.deepEqual(profile.mounts, [
    { mountId: 'mount-id', innerPath: '/workspace', mode: 'rw' },
  ]);
  t.is(profile.network, 'private');
  t.is(profile.backend, 'podman');
  t.deepEqual(profile.escalation, { ...baseEscalation });
});

test('normalizeSandboxProfile defaults to the confined end of every ladder', t => {
  const profile = normalizeSandboxProfile(
    { rootfs: { kind: 'minimal' }, escalation: baseEscalation },
    resolveFakeMountId,
  );
  t.is(profile.network, 'none');
  t.is(profile.backend, 'auto');
  t.is(profile.seccomp, 'default');
  t.deepEqual(profile.mounts, []);
  t.deepEqual(profile.env, {});
  t.is(profile.cwd, undefined);
});

test('normalizeSandboxProfile requires an escalation reason and requester', t => {
  const resolve = resolveFakeMountId;
  t.throws(
    () => normalizeSandboxProfile({ rootfs: { kind: 'minimal' } }, resolve),
    { message: /profile.escalation is required/ },
  );
  t.throws(
    () =>
      normalizeSandboxProfile(
        {
          rootfs: { kind: 'minimal' },
          escalation: { reason: 'BECAUSE_I_SAID_SO', capability: 'x' },
        },
        resolve,
      ),
    { message: /profile.escalation.reason.*OS_EFFECT/s },
  );
  t.throws(
    () =>
      normalizeSandboxProfile(
        {
          rootfs: { kind: 'minimal' },
          escalation: { reason: 'OS_EFFECT', capability: '' },
        },
        resolve,
      ),
    { message: /profile.escalation.capability/ },
  );
});

test('normalizeSandboxProfile rejects malformed grants before a formula exists', t => {
  const resolve = resolveFakeMountId;
  const withMounts = mounts =>
    normalizeSandboxProfile(
      { rootfs: { kind: 'minimal' }, mounts, escalation: baseEscalation },
      resolve,
    );
  t.throws(() => withMounts([{ cap: {}, innerPath: 'workspace' }]), {
    message: /must be an absolute path inside the slice/,
  });
  t.throws(() => withMounts([{ cap: {}, innerPath: '/work\0space' }]), {
    message: /must not contain NUL bytes/,
  });
  t.throws(() => withMounts([{ cap: {}, innerPath: '/w', mode: 'rwx' }]), {
    message: /profile.mounts\[0\].mode/,
  });
  t.throws(
    () =>
      normalizeSandboxProfile(
        {
          rootfs: { kind: 'oci' },
          escalation: baseEscalation,
        },
        resolve,
      ),
    { message: /profile.rootfs.ref/ },
  );
  t.throws(
    () =>
      normalizeSandboxProfile(
        {
          rootfs: { kind: 'minimal' },
          network: 'host-everything',
          escalation: baseEscalation,
        },
        resolve,
      ),
    { message: /profile.network/ },
  );
  // A seccomp blob cannot survive a restart, so it is refused rather
  // than silently replaced with the default on reincarnation.
  t.throws(
    () =>
      normalizeSandboxProfile(
        {
          rootfs: { kind: 'minimal' },
          seccomp: harden({
            profile: new Uint8Array([1, 2, 3]).buffer.transferToImmutable(),
          }),
          escalation: baseEscalation,
        },
        resolve,
      ),
    { message: /profile.seccomp/ },
  );
  t.throws(
    () =>
      normalizeSandboxProfile(
        {
          rootfs: { kind: 'minimal' },
          limits: { rss: 10 },
          escalation: baseEscalation,
        },
        resolve,
      ),
    { message: /profile.limits\[.rss.\]/ },
  );
  t.throws(
    () =>
      normalizeSandboxProfile(
        {
          rootfs: { kind: 'minimal' },
          escalation: { reason: 'OS_EFFECT', capability: 'worker\0name' },
        },
        resolve,
      ),
    { message: /must not contain NUL bytes/ },
  );
});

test('host normalization rejects a daemon cap whose formula is not a mount', async t => {
  const notMount = Far('NotMount', { ping: () => 'pong' });
  await t.throwsAsync(
    normalizeSandboxProfileForHost(
      {
        rootfs: { kind: 'minimal' },
        mounts: [{ cap: notMount, innerPath: '/workspace' }],
        escalation: baseEscalation,
      },
      {
        getIdForRef: () => fakeMountId,
        getTypeForId: async () => 'http-client',
      },
    ),
    { message: /must name a mount formula.*http-client/ },
  );
});

test('host normalization verifies a remote mount by its canonical interface', async t => {
  const { mount } = await provisionMount(t);
  const profile = await normalizeSandboxProfileForHost(
    {
      rootfs: { kind: 'minimal' },
      mounts: [{ cap: mount, innerPath: '/remote' }],
      escalation: baseEscalation,
    },
    {
      getIdForRef: () => fakeMountId,
      getTypeForId: async () => 'remote',
    },
  );
  t.is(profile.mounts[0].mountId, fakeMountId);
});

test('host normalization rejects a remote mount with unknown write authority', async t => {
  const { mount } = await provisionMount(t);
  // eslint-disable-next-line no-underscore-dangle
  const methodNames = await E(/** @type {any} */ (mount)).__getMethodNames__();
  const remoteMount = Far(
    'RemoteMount',
    Object.fromEntries(
      methodNames
        .filter(name => name !== '__getMethodNames__')
        .map(name => [name, () => {}]),
    ),
  );

  await t.throwsAsync(
    normalizeSandboxProfileForHost(
      {
        rootfs: { kind: 'minimal' },
        mounts: [{ cap: remoteMount, innerPath: '/remote', mode: 'rw' }],
        escalation: baseEscalation,
      },
      {
        getIdForRef: () => fakeMountId,
        getTypeForId: async () => 'remote',
      },
    ),
    { message: /unknown write authority.*read-write/ },
  );
});

test('host normalization checks every mode of a repeated read-only cap', async t => {
  const { mount } = await provisionMount(t, { readOnly: true });
  await t.throwsAsync(
    normalizeSandboxProfileForHost(
      {
        rootfs: { kind: 'minimal' },
        mounts: [
          { cap: mount, innerPath: '/writable', mode: 'rw' },
          { cap: mount, innerPath: '/readonly', mode: 'ro' },
        ],
        escalation: baseEscalation,
      },
      {
        getIdForRef: () => fakeMountId,
        getTypeForId: async () => 'mount',
      },
    ),
    { message: /read-only mount.*read-write/ },
  );
});

test('a physically-backed grant is projected through 9P', async t => {
  // A mount that withholds nothing still cannot use a direct bind because
  // bind mounts do not constrain symlink traversal to the mount root.
  const { mount } = await provisionMount(t, { deniedSegments: [] });
  const profile = normalizeSandboxProfile(
    {
      rootfs: { kind: 'host-bind' },
      mounts: [{ cap: mount, innerPath: '/workspace', mode: 'rw' }],
      network: 'private',
      escalation: baseEscalation,
    },
    resolveFakeMountId,
  );

  const {
    slice: publicSlice,
    backend,
    projections,
    statePath,
    release,
  } = await mintSlice(t, profile, {
    capForId: { 'mount-id': mount },
  });

  t.is(backend.calls.slices.length, 1);
  const [slice] = backend.calls.slices;
  t.deepEqual(slice.mounts, [
    {
      hostPath: path.join(statePath, 'mnt', '0'),
      innerPath: '/workspace',
      mode: 'rw',
    },
  ]);
  t.is(projections.length, 1);
  // The scratch upper layer is per-slice and really exists on disk.
  t.is(slice.scratchHostPath, path.join(statePath, 'scratch', '0'));
  t.true(fs.existsSync(slice.scratchHostPath));

  await E(/** @type {any} */ (publicSlice)).dispose();
  t.is(backend.calls.disposed, 1);
  t.true(projections[0].released);
  t.false(fs.existsSync(statePath));

  // Context cancellation may race or follow public disposal. The complete
  // release is idempotent across both paths.
  await release();
  t.is(backend.calls.disposed, 1);
});

test('repeated grants of one mount retain distinct projections', async t => {
  const { mount } = await provisionMount(t);
  const profile = normalizeSandboxProfile(
    {
      rootfs: { kind: 'minimal' },
      mounts: [
        { cap: mount, innerPath: '/writable', mode: 'rw' },
        { cap: mount, innerPath: '/readonly', mode: 'ro' },
      ],
      escalation: baseEscalation,
    },
    resolveFakeMountId,
  );

  const { backend, statePath, release } = await mintSlice(t, profile, {
    capForId: { 'mount-id': mount },
  });
  t.deepEqual(backend.calls.slices[0].mounts, [
    {
      hostPath: path.join(statePath, 'mnt', '0'),
      innerPath: '/writable',
      mode: 'rw',
    },
    {
      hostPath: path.join(statePath, 'mnt', '1'),
      innerPath: '/readonly',
      mode: 'ro',
    },
  ]);
  await release();
});

test('sandbox incarnation state is isolated from an abandoned sibling', async t => {
  const profile = /** @type {SandboxFormulaProfile} */ (
    harden({
      rootfs: { kind: 'minimal' },
      mounts: [],
      network: 'none',
      backend: 'auto',
      seccomp: 'default',
      env: {},
      escalation: baseEscalation,
    })
  );
  const daemonStatePath = await provisionStatePath(t);
  const filePowers = makeFilePowers({ fs, path });
  const projector = makeFakeProjector().projector;
  const backend = makeFakeBackend();
  const formulaNumber = /** @type {import('../src/types.js').FormulaNumber} */ (
    'formula-number'
  );
  const incarnationNumbers = ['abandoned', 'replacement'];
  const randomHex256 = async () => {
    const number = incarnationNumbers.shift();
    t.truthy(number);
    return /** @type {string} */ (number);
  };
  const allocateStatePath = () =>
    makeSandboxIncarnationPath({
      statePath: daemonStatePath,
      formulaNumber,
      randomHex256,
      joinPath: filePowers.joinPath,
    });

  const abandonedStatePath = await allocateStatePath();
  const replacementStatePath = await allocateStatePath();
  t.not(abandonedStatePath, replacementStatePath);
  t.is(path.dirname(abandonedStatePath), path.dirname(replacementStatePath));

  await fs.promises.mkdir(abandonedStatePath, { recursive: true });
  const markerPath = path.join(abandonedStatePath, 'mounted');
  await fs.promises.writeFile(markerPath, 'belongs to another incarnation');

  const replacement = await makeSandboxSlice({
    profile,
    sandboxId: fakeSandboxId,
    statePath: replacementStatePath,
    provideMount: async () => undefined,
    projector,
    makeSandboxFactory: backend.makeSandboxFactory,
    makePath: filePowers.makePath,
    removeDirectory: filePowers.removeDirectory,
    joinPath: filePowers.joinPath,
    escalations: makeSandboxEscalationLog(),
  });

  t.true(fs.existsSync(markerPath));
  t.true(fs.existsSync(path.join(replacementStatePath, 'scratch')));

  await replacement.release();
  t.true(fs.existsSync(markerPath));
  t.false(fs.existsSync(replacementStatePath));
});

test('a mount with no physical backing reaches the driver through a projection', async t => {
  // A mount face this process cannot see the backing of stands in for
  // the peer-hosted case: `getMountBacking` returns undefined, so the
  // projector takes the 9P branch.
  const opaqueMount = Far('RemoteMount', {});
  const profile = normalizeSandboxProfile(
    {
      rootfs: { kind: 'minimal' },
      mounts: [{ cap: opaqueMount, innerPath: '/remote' }],
      escalation: baseEscalation,
    },
    resolveFakeMountId,
  );

  const { backend, projections, statePath, release } = await mintSlice(
    t,
    profile,
    { capForId: { 'mount-id': opaqueMount } },
  );

  t.is(projections.length, 1);
  t.is(projections[0].mountPoint, path.join(statePath, 'mnt', '0'));
  t.deepEqual(backend.calls.slices[0].mounts, [
    {
      hostPath: path.join(statePath, 'mnt', '0'),
      innerPath: '/remote',
      mode: 'ro',
    },
  ]);

  await release();
  t.true(projections[0].released);
});

test('a remote mount cannot be bound read-write during reincarnation', async t => {
  const opaqueMount = Far('RemoteMount', {});
  const profile = /** @type {SandboxFormulaProfile} */ (
    harden({
      rootfs: { kind: 'minimal' },
      mounts: [{ mountId: fakeMountId, innerPath: '/remote', mode: 'rw' }],
      network: 'none',
      backend: 'auto',
      seccomp: 'default',
      env: {},
      escalation: baseEscalation,
    })
  );

  await t.throwsAsync(
    mintSlice(t, profile, { capForId: { 'mount-id': opaqueMount } }),
    { message: /unknown write authority.*read-write/ },
  );
});

test('a mount that withholds segments is projected, not bound', async t => {
  // The default deny set, so this is the ordinary case: binding would
  // hand the slice the `.ssh` the mount exists to withhold.
  const { root, mount } = await provisionMount(t);
  await fs.promises.mkdir(path.join(root, '.ssh'));
  await fs.promises.writeFile(path.join(root, '.ssh', 'id_rsa'), 'PRIVATE');

  const profile = normalizeSandboxProfile(
    {
      rootfs: { kind: 'host-bind' },
      mounts: [{ cap: mount, innerPath: '/workspace', mode: 'rw' }],
      escalation: baseEscalation,
    },
    resolveFakeMountId,
  );
  const { backend, projections, statePath, escalations } = await mintSlice(
    t,
    profile,
    { capForId: { 'mount-id': mount } },
  );

  t.is(projections.length, 1);
  // The driver receives the projection's mountpoint, never the backing
  // directory itself.
  t.deepEqual(backend.calls.slices[0].mounts, [
    {
      hostPath: path.join(statePath, 'mnt', '0'),
      innerPath: '/workspace',
      mode: 'rw',
    },
  ]);
  t.not(backend.calls.slices[0].mounts[0].hostPath, root);
  t.deepEqual(escalations.list()[0].projections, [
    { innerPath: '/workspace', kind: '9p' },
  ]);
});

test('what 9P serves for such a mount denies the restricted segments', async t => {
  // The other half of the previous test: 9P serves *through* the mount,
  // so its denials reach the slice. Capture the filesystem the mounter
  // would have attached; a real kernel mount needs privileges here.
  const { root, mount } = await provisionMount(t);
  await fs.promises.mkdir(path.join(root, '.ssh'));
  await fs.promises.writeFile(path.join(root, '.ssh', 'id_rsa'), 'PRIVATE');
  await fs.promises.writeFile(path.join(root, 'README.md'), '# readme');
  const outside = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'sandbox-escape-'),
  );
  t.teardown(() => fs.promises.rm(outside, { recursive: true, force: true }));
  await fs.promises.writeFile(path.join(outside, 'secret'), 'SECRET');
  await fs.promises.symlink(outside, path.join(root, 'escape'));

  /** @type {any} */
  let served;
  const projector = makeMountProjector({
    resolveHostPath: async () => undefined,
    mounter: harden({
      /**
       * @param {unknown} fs9p
       * @param {string} mountPoint
       */
      mount: async (fs9p, mountPoint) => {
        served = fs9p;
        return harden({ unmount: async () => {}, mountPoint });
      },
    }),
  });

  const statePath = await provisionStatePath(t);
  const projection = await projector.projectMount(mount, {
    mountPoint: path.join(statePath, 'mnt', '0'),
    readOnly: false,
    label: '/workspace',
  });
  t.is(projection.kind, '9p');

  const servedRoot = await E(served).root();
  t.truthy(await E(servedRoot).lookup('README.md'));
  await t.throwsAsync(() => E(servedRoot).lookup('.ssh'), {
    message: /Access denied/,
  });
  // Nor by a multi-segment walk that names the restricted segment on
  // the way to a file under it.
  await t.throwsAsync(() => E(servedRoot).lookup(['.ssh', 'id_rsa']), {
    message: /Access denied/,
  });
  await t.throwsAsync(() => E(servedRoot).lookup(['escape', 'secret']), {
    message: /ENOENT|escapes mount root/,
  });
});

test('a persisted profile cannot smuggle a direct bind past the gate', async t => {
  // A rogue projector reaches a direct bind the installed resolver never
  // would: the gate refuses it and releases what it stood up.
  const { root, mount } = await provisionMount(t);
  const profile = /** @type {SandboxFormulaProfile} */ (
    harden({
      rootfs: { kind: 'minimal' },
      mounts: [{ mountId: fakeMountId, innerPath: '/workspace', mode: 'rw' }],
      network: 'none',
      backend: 'auto',
      seccomp: 'default',
      env: {},
      escalation: baseEscalation,
    })
  );
  const statePath = await provisionStatePath(t);
  const filePowers = makeFilePowers({ fs, path });
  let released = 0;
  const rogueProjector = harden({
    projectMount: async (/** @type {unknown} */ cap) =>
      harden({
        kind: 'physical',
        hostPath: root,
        mountCap: cap,
        release: async () => {
          released += 1;
        },
      }),
  });

  await t.throwsAsync(
    makeSandboxSlice({
      profile,
      sandboxId: fakeSandboxId,
      statePath,
      provideMount: async () => mount,
      projector: rogueProjector,
      makeSandboxFactory: async () => {
        throw new Error('the gate should have refused before the backend');
      },
      makePath: filePowers.makePath,
      removeDirectory: filePowers.removeDirectory,
      joinPath: filePowers.joinPath,
      escalations: makeSandboxEscalationLog(),
      assertMountGrant: assertSandboxMountGrant,
    }),
    { message: /kernel-enforced symlink confinement/ },
  );
  t.is(released, 1);
});

test('the slice can resolve only the mounts its profile names', async t => {
  const { mount } = await provisionMount(t);
  const other = await provisionMount(t);
  const profile = normalizeSandboxProfile(
    {
      rootfs: { kind: 'minimal' },
      mounts: [{ cap: mount, innerPath: '/workspace', mode: 'rw' }],
      escalation: baseEscalation,
    },
    resolveFakeMountId,
  );
  const { backend } = await mintSlice(t, profile, {
    capForId: { 'mount-id': mount },
  });
  const [{ powers }] = backend.calls.factories;
  await t.throwsAsync(E(powers).provideHostPath(other.mount), {
    message: /was not granted this mount/,
  });
});

test('a read-only mount cannot be bound read-write', async t => {
  const { mount } = await provisionMount(t, { readOnly: true });
  // The host-side gate: `provideSandbox` refuses before a formula is
  // persisted.
  t.throws(
    () =>
      normalizeSandboxProfile(
        {
          rootfs: { kind: 'minimal' },
          mounts: [{ cap: mount, innerPath: '/workspace', mode: 'rw' }],
          escalation: baseEscalation,
        },
        {
          resolveMountId: (cap, label) => {
            assertSandboxMountGrant(cap, 'rw', label);
            return fakeMountId;
          },
        },
      ),
    { message: /read-only mount read-write/ },
  );

  // The reincarnation-time gate: a persisted profile cannot smuggle one
  // past the maker.
  const profile = /** @type {SandboxFormulaProfile} */ (
    harden({
      rootfs: { kind: 'minimal' },
      mounts: [{ mountId: fakeMountId, innerPath: '/workspace', mode: 'rw' }],
      network: 'none',
      backend: 'auto',
      seccomp: 'default',
      env: {},
      escalation: baseEscalation,
    })
  );
  await t.throwsAsync(
    mintSlice(t, profile, { capForId: { 'mount-id': mount } }),
    { message: /read-only mount read-write/ },
  );
});

test('every mint records an escalation with the projections it needed', async t => {
  const { mount } = await provisionMount(t, { deniedSegments: [] });
  const profile = normalizeSandboxProfile(
    {
      rootfs: { kind: 'host-bind' },
      mounts: [{ cap: mount, innerPath: '/workspace', mode: 'rw' }],
      network: 'private',
      backend: 'podman',
      escalation: { reason: 'RESOURCE_LIMIT', capability: 'batch-runner' },
    },
    resolveFakeMountId,
  );
  const { escalations } = await mintSlice(t, profile, {
    capForId: { 'mount-id': mount },
  });
  const records = escalations.list();
  t.is(records.length, 1);
  t.like(records[0], {
    sandboxId: 'sandbox-id',
    reason: 'RESOURCE_LIMIT',
    capability: 'batch-runner',
    backend: 'podman',
    network: 'private',
  });
  t.deepEqual(records[0].projections, [
    { innerPath: '/workspace', kind: '9p' },
  ]);
});

test('the escalation ledger is bounded and ordered oldest-first', t => {
  const escalations = makeSandboxEscalationLog({ limit: 2 });
  for (const capability of ['first', 'second', 'third']) {
    escalations.record(
      /** @type {SandboxEscalationRecord} */ (
        harden({
          sandboxId: /** @type {FormulaIdentifier} */ (`id-${capability}`),
          reason: 'NATIVE_IMPLEMENTATION',
          capability,
          backend: 'auto',
          network: 'none',
          projections: [],
        })
      ),
    );
  }
  t.deepEqual(
    escalations.list().map(record => record.capability),
    ['second', 'third'],
  );
});

test('a failed mint releases the projections it had already made', async t => {
  const opaqueMount = Far('RemoteMount', {});
  const profile = /** @type {SandboxFormulaProfile} */ (
    harden({
      rootfs: { kind: 'minimal' },
      mounts: [{ mountId: fakeMountId, innerPath: '/remote', mode: 'ro' }],
      network: 'none',
      backend: 'auto',
      seccomp: 'default',
      env: {},
      escalation: baseEscalation,
    })
  );
  const statePath = await provisionStatePath(t);
  const filePowers = makeFilePowers({ fs, path });
  const { projector, projections } = makeFakeProjector();
  await t.throwsAsync(
    makeSandboxSlice({
      profile,
      sandboxId: fakeSandboxId,
      statePath,
      provideMount: async () => opaqueMount,
      projector,
      makeSandboxFactory: async () => {
        throw new Error('no backend available for "auto"');
      },
      makePath: filePowers.makePath,
      removeDirectory: filePowers.removeDirectory,
      joinPath: filePowers.joinPath,
      escalations: makeSandboxEscalationLog(),
    }),
    { message: /no backend available/ },
  );
  t.is(projections.length, 1);
  t.true(projections[0].released);
});

test('cleanup reports the directory failure instead of mutating a frozen array', async t => {
  const profile = /** @type {SandboxFormulaProfile} */ (
    harden({
      rootfs: { kind: 'minimal' },
      mounts: [],
      network: 'none',
      backend: 'auto',
      seccomp: 'default',
      env: {},
      escalation: baseEscalation,
    })
  );
  const directoryFailure = new Error('directory cleanup failed');
  let removals = 0;
  const minted = await mintSlice(t, profile, {
    slice: {
      removeDirectory: async statePath => {
        removals += 1;
        if (removals > 1) throw directoryFailure;
        await fs.promises.rm(statePath, { recursive: true, force: true });
      },
    },
  });

  const failure = await t.throwsAsync(minted.release());
  const nestedFailures =
    failure instanceof AggregateError ? failure.errors : [failure];
  t.true(nestedFailures.includes(directoryFailure));
  t.false(nestedFailures.some(error => error instanceof TypeError));
});

test('daemon wrapper refuses unmediated dynamic slice operations', async t => {
  const profile = /** @type {SandboxFormulaProfile} */ (
    harden({
      rootfs: { kind: 'minimal' },
      mounts: [],
      network: 'none',
      backend: 'auto',
      seccomp: 'default',
      env: {},
      escalation: baseEscalation,
    })
  );
  const minted = await mintSlice(t, profile);
  const cap = Far('DynamicMount', {});

  await t.throwsAsync(
    () => E(/** @type {any} */ (minted.slice)).mount(cap, '/mnt'),
    {
      message: /dynamic mount.*not implemented/,
    },
  );
  await t.throwsAsync(
    () => E(/** @type {any} */ (minted.slice)).scratch('/tmp'),
    {
      message: /dynamic scratch.*not implemented/,
    },
  );
  await t.throwsAsync(() => E(/** @type {any} */ (minted.slice)).fork(), {
    message: /fork is not implemented/,
  });
});

test('scratch provider keeps distinct names on distinct tokens and paths', async t => {
  const profile = /** @type {SandboxFormulaProfile} */ (
    harden({
      rootfs: { kind: 'minimal' },
      mounts: [],
      network: 'none',
      backend: 'auto',
      seccomp: 'default',
      env: {},
      escalation: baseEscalation,
    })
  );
  const minted = await mintSlice(t, profile);
  const { powers } = minted.backend.calls.factories[0];

  const first = await E(powers).provideScratchMount('first');
  const second = await E(powers).provideScratchMount('second');
  t.not(first, second);
  t.not(
    await E(powers).provideHostPath(first),
    await E(powers).provideHostPath(second),
  );
});

test('backend self-disposal releases daemon-owned state', async t => {
  const profile = /** @type {SandboxFormulaProfile} */ (
    harden({
      rootfs: { kind: 'minimal' },
      mounts: [],
      network: 'none',
      backend: 'auto',
      seccomp: 'default',
      env: {},
      escalation: baseEscalation,
    })
  );
  const minted = await mintSlice(t, profile);

  await E(minted.backend.calls.slices[0].backendHandle).dispose();
  t.false(fs.existsSync(minted.statePath));
});

test('a failed 9P detach preserves state for a later retry', async t => {
  const opaqueMount = Far('RemoteMount', {});
  const profile = /** @type {SandboxFormulaProfile} */ (
    harden({
      rootfs: { kind: 'minimal' },
      mounts: [{ mountId: fakeMountId, innerPath: '/remote', mode: 'ro' }],
      network: 'none',
      backend: 'auto',
      seccomp: 'default',
      env: {},
      escalation: baseEscalation,
    })
  );
  const statePath = await provisionStatePath(t);
  const filePowers = makeFilePowers({ fs, path });
  let detached = false;
  const projector = harden({
    projectMount: async () =>
      harden({
        kind: '9p',
        hostPath: path.join(statePath, 'mnt', '0'),
        release: async () => detached,
      }),
  });
  const backend = makeFakeBackend();
  const minted = await makeSandboxSlice({
    profile,
    sandboxId: fakeSandboxId,
    statePath,
    provideMount: async () => opaqueMount,
    projector,
    makeSandboxFactory: backend.makeSandboxFactory,
    makePath: filePowers.makePath,
    removeDirectory: filePowers.removeDirectory,
    joinPath: filePowers.joinPath,
    escalations: makeSandboxEscalationLog(),
  });

  await t.throwsAsync(minted.release(), {
    message: /did not confirm detachment/,
  });
  t.true(fs.existsSync(statePath));
  t.is(backend.calls.disposed, 1);

  detached = true;
  await minted.release();
  t.false(fs.existsSync(statePath));
});

test('backend disposal failure is reported after state cleanup', async t => {
  const profile = /** @type {SandboxFormulaProfile} */ (
    harden({
      rootfs: { kind: 'minimal' },
      mounts: [],
      network: 'none',
      backend: 'auto',
      seccomp: 'default',
      env: {},
      escalation: baseEscalation,
    })
  );
  const disposeError = new Error('backend disposal failed');
  const minted = await mintSlice(t, profile, {
    backend: { disposeError },
  });

  await t.throwsAsync(minted.release(), {
    message: /backend disposal failed/,
  });
  t.false(fs.existsSync(minted.statePath));
});

test('a supervisor with no host tools refuses to mint a slice', async t => {
  const { provideHostToolPowers } = await import('../src/host-tool-powers.js');
  const hostTools = provideHostToolPowers();
  t.throws(() => hostTools.makeSandboxFactory({}, null), {
    message: /makeSandboxFactory.*not supported here/s,
  });
  t.throws(() => hostTools.makeMountProjector({}), {
    message: /makeMountProjector.*not supported here/s,
  });
});

test.serial('real bwrap mints over a daemon-minted mount', async t => {
  // Opt back into the production backend after the shared runtime smoke
  // probe. Factory creation performs the remaining version/lifecycle probe.
  const { make: makeSandboxFactory } = await import('@endo/sandbox');
  const runtimeProbe = await probeBwrapUserns();
  if (!runtimeProbe.available) {
    t.pass(`SKIP: bwrap slice unavailable: ${runtimeProbe.reason}`);
    return;
  }

  // The real backend binds the directory, which only a mount that
  // withholds nothing is eligible for.
  const { root, mount } = await provisionMount(t, { deniedSegments: [] });
  await fs.promises.writeFile(path.join(root, 'hello.txt'), 'from the host\n');
  const profile = normalizeSandboxProfile(
    {
      rootfs: { kind: 'host-bind' },
      mounts: [{ cap: mount, innerPath: '/workspace', mode: 'ro' }],
      backend: 'bwrap',
      cwd: '/workspace',
      escalation: baseEscalation,
    },
    resolveFakeMountId,
  );

  const statePath = await provisionStatePath(t);
  const filePowers = makeFilePowers({ fs, path });
  const { projector } = makeFakeProjector({
    prepare: async (_cap, options) => {
      await filePowers.makePath(options.mountPoint);
      for (const entry of await fs.promises.readdir(root)) {
        // eslint-disable-next-line no-await-in-loop
        await fs.promises.cp(
          path.join(root, entry),
          path.join(options.mountPoint, entry),
          { recursive: true },
        );
      }
    },
  });
  const { slice, release } = await makeSandboxSlice({
    profile,
    sandboxId: fakeSandboxId,
    statePath,
    provideMount: async () => mount,
    projector,
    makeSandboxFactory: /** @type {any} */ (makeSandboxFactory),
    makePath: filePowers.makePath,
    removeDirectory: filePowers.removeDirectory,
    joinPath: filePowers.joinPath,
    escalations: makeSandboxEscalationLog(),
    assertMountGrant: assertSandboxMountGrant,
  });
  t.teardown(() => release());

  const process1 = await E(/** @type {any} */ (slice)).spawn([
    '/bin/cat',
    '/workspace/hello.txt',
  ]);
  const result = await E(process1).wait();
  t.is(result.code, 0);
});
