// @ts-check
/// <reference types="ses"/>

/**
 * Tests for the daemon's `sandbox` formula: profile normalization, the
 * slice composition the formula maker performs, and the escalation
 * ledger.
 *
 * Like `shell.test.js`, these assemble the maker's parts directly
 * rather than booting a daemon (which needs a native sqlite build
 * unavailable in some CI sandboxes).  The privileged effects — the
 * sandbox backend and the 9P mount projector — are the maker's injected
 * seams, so a fake of each exercises the composition on any host.  The
 * final test opts back into the real `@endo/sandbox` backend and skips
 * when the host has no usable driver, following the probe-and-skip
 * convention in `packages/sandbox/test/bwrap.test.js`.
 */

/** @import { FormulaIdentifier, SandboxEscalationRecord, SandboxFormulaProfile } from '../src/types.js' */

import test from '@endo/ses-ava/prepare-endo.js';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeMountProjector } from '@endo/9p-server/mount-projection.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';

import { makeFilePowers } from '../src/manager-node-powers.js';
import { getMountBacking, makeMount } from '../src/mount.js';
import {
  allowsDirectBind,
  makeSandboxEscalationLog,
  makeSandboxSlice,
  normalizeSandboxProfile,
} from '../src/sandbox.js';

/**
 * Provision a real on-disk mount, mirroring `shell.test.js`.
 *
 * `deniedSegments` defaults to `undefined`, which selects the daemon's
 * default deny set — the same mount every `provideMount` caller gets.
 * A test that wants the physical fast path has to ask for a mount that
 * withholds nothing (`deniedSegments: []`), because a bind mount cannot
 * enforce per-segment denial.
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
 * The physical-backing resolver and the mount gate the daemon's
 * `sandbox` maker installs, restated here so the tests pin the
 * composition rather than a copy of the policy. Both defer to
 * `allowsDirectBind`, which is the policy itself and is imported, not
 * restated.
 *
 * @param {unknown} cap
 */
const resolveHostPath = async cap => {
  const backing = getMountBacking(cap);
  if (backing === undefined || !allowsDirectBind(backing)) {
    return undefined;
  }
  return backing.currentDir;
};

/**
 * @param {unknown} cap
 * @param {'ro' | 'rw'} mode
 * @param {string} innerPath
 * @param {{ kind: string }} [projection]
 */
const assertMountGrant = (cap, mode, innerPath, projection) => {
  const backing = getMountBacking(cap);
  if (backing !== undefined && backing.readOnly && mode === 'rw') {
    throw new Error(
      `Sandbox cannot bind a read-only mount read-write at ${innerPath}`,
    );
  }
  if (projection?.kind === 'physical' && !allowsDirectBind(backing)) {
    throw new Error(
      `Sandbox cannot bind ${innerPath} to the backing directory of a mount that withholds path segments`,
    );
  }
};

/**
 * A projector whose physical branch is the real one and whose 9P branch
 * is faked: the tests that reach it assert *that* a projection was
 * requested and released, not that a kernel mount happened.
 */
const makeFakeProjector = () => {
  /** @type {Array<{ mountPoint: string, released: boolean }>} */
  const projections = [];
  const projector = harden({
    /**
     * @param {unknown} cap
     * @param {any} options
     */
    projectMount: async (cap, options) => {
      const hostPath = await resolveHostPath(cap);
      if (hostPath !== undefined) {
        return harden({
          kind: 'physical',
          hostPath,
          mountCap: cap,
          release: async () => {},
        });
      }
      const record = { mountPoint: options.mountPoint, released: false };
      projections.push(record);
      return harden({
        kind: '9p',
        hostPath: options.mountPoint,
        mountCap: cap,
        release: async () => {
          record.released = true;
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
const makeFakeBackend = () => {
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
        calls.slices.push({ opts, mounts, scratchHostPath });
        return Far('FakeSandboxHandle', {
          dispose: async () => {
            calls.disposed += 1;
          },
        });
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
  const backend = makeFakeBackend();
  const escalations = makeSandboxEscalationLog();
  const minted = await makeSandboxSlice({
    profile,
    sandboxId: fakeSandboxId,
    statePath,
    provideMount: async mountId => overrides.capForId[mountId],
    projector,
    makeSandboxFactory: backend.makeSandboxFactory,
    makePath: filePowers.makePath,
    joinPath: filePowers.joinPath,
    escalations,
    assertMountGrant,
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
          seccomp: { profile: new Uint8Array([1, 2, 3]) },
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
});

test('a physically-backed grant reaches the driver as its own directory', async t => {
  // A mount that withholds nothing: the bind exposes exactly what the
  // capability does, so the fast path is available.
  const { root, mount } = await provisionMount(t, { deniedSegments: [] });
  const profile = normalizeSandboxProfile(
    {
      rootfs: { kind: 'host-bind' },
      mounts: [{ cap: mount, innerPath: '/workspace', mode: 'rw' }],
      network: 'private',
      escalation: baseEscalation,
    },
    resolveFakeMountId,
  );

  const { backend, projections, statePath, release } = await mintSlice(
    t,
    profile,
    { capForId: { 'mount-id': mount } },
  );

  t.is(backend.calls.slices.length, 1);
  const [slice] = backend.calls.slices;
  t.deepEqual(slice.mounts, [
    { hostPath: root, innerPath: '/workspace', mode: 'rw' },
  ]);
  // No 9P projection was needed for a mount that already names a
  // directory.
  t.is(projections.length, 0);
  // The scratch upper layer is per-slice and really exists on disk.
  t.is(slice.scratchHostPath, path.join(statePath, 'scratch'));
  t.true(fs.existsSync(slice.scratchHostPath));

  await release();
  t.is(backend.calls.disposed, 1);
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

test('a mount that withholds segments is projected, not bound', async t => {
  // The default deny set is what every `provideMount` caller gets, so
  // this is the ordinary case: binding the directory would hand the
  // slice `.ssh`, `.aws`, `.gnupg` and the rest, which the mount exists
  // to withhold.  It takes the 9P branch instead.
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
  // The other half of the previous test: the 9P branch serves *through*
  // the mount capability, so a path the mount denies is denied to the
  // slice too.  Drive the real projection layer with a mounter that
  // captures the filesystem it would have attached — a kernel mount
  // needs privileges this test does not assume — and read through it.
  const { root, mount } = await provisionMount(t);
  await fs.promises.mkdir(path.join(root, '.ssh'));
  await fs.promises.writeFile(path.join(root, '.ssh', 'id_rsa'), 'PRIVATE');
  await fs.promises.writeFile(path.join(root, 'README.md'), '# readme');

  /** @type {any} */
  let served;
  const projector = makeMountProjector({
    resolveHostPath,
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
});

test('a persisted profile cannot smuggle a direct bind past the gate', async t => {
  // Reincarnation: the maker rebuilds the slice from the persisted
  // profile, so the gate has to re-derive the posture from the live
  // mount rather than trust anything the formula carries.  A projector
  // that hands back a direct bind of a mount that withholds segments —
  // a resolver this formula did not install — is refused, and the
  // projection it stood up is released.
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
      joinPath: filePowers.joinPath,
      escalations: makeSandboxEscalationLog(),
      assertMountGrant,
    }),
    { message: /withholds path segments/ },
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
            assertMountGrant(cap, 'rw', label);
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
    { innerPath: '/workspace', kind: 'physical' },
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
      joinPath: filePowers.joinPath,
      escalations: makeSandboxEscalationLog(),
    }),
    { message: /no backend available/ },
  );
  t.is(projections.length, 1);
  t.true(projections[0].released);
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

test('the real backend mints a slice over a daemon-minted mount', async t => {
  // Opt back into the production backend: `@endo/sandbox`'s entry point
  // with its probe-gated drivers. Skips on a host with no usable
  // driver, per the convention in `packages/sandbox/test/bwrap.test.js`.
  const { make: makeSandboxFactory } = await import('@endo/sandbox');
  const probeFactory = await makeSandboxFactory(
    /** @type {any} */ (
      harden({
        provideScratchMount: async () => {
          throw new Error('unused during probe');
        },
      })
    ),
    null,
    {},
  );
  const backends = await E(probeFactory).listBackends();
  const usable = backends.find(backend => backend.available);
  if (usable === undefined) {
    t.pass(
      `SKIP: no sandbox backend available: ${backends
        .map(backend => `${backend.name}: ${backend.reason ?? 'unavailable'}`)
        .join('; ')}`,
    );
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
      backend: usable.name,
      cwd: '/workspace',
      escalation: baseEscalation,
    },
    resolveFakeMountId,
  );

  const statePath = await provisionStatePath(t);
  const filePowers = makeFilePowers({ fs, path });
  const { projector } = makeFakeProjector();
  const { slice, release } = await makeSandboxSlice({
    profile,
    sandboxId: fakeSandboxId,
    statePath,
    provideMount: async () => mount,
    projector,
    makeSandboxFactory: /** @type {any} */ (makeSandboxFactory),
    makePath: filePowers.makePath,
    joinPath: filePowers.joinPath,
    escalations: makeSandboxEscalationLog(),
    assertMountGrant,
  });
  t.teardown(() => release());

  const process1 = await E(/** @type {any} */ (slice)).spawn([
    '/bin/cat',
    '/workspace/hello.txt',
  ]);
  const result = await E(process1).wait();
  t.is(result.code, 0);
});
