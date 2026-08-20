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
import { createServer as createHttpServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { E } from '@endo/eventual-send';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { bytesWriterFromIterator } from '@endo/exo-stream/bytes-writer-from-iterator.js';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { Far } from '@endo/pass-style';

import { makeFilePowers } from '../src/manager-node-powers.js';
import { getMountBacking, makeMount } from '../src/mount.js';
import {
  makeSandboxEscalationLog,
  makeSandboxSlice,
  normalizeSandboxProfile,
} from '../src/sandbox.js';

/**
 * An HTTP listener on host loopback, standing in for whatever a consumer of
 * this primitive (a git relay, a registry broker) would put behind a dialer.
 *
 * @param {string} body
 */
const startProbeServer = async body => {
  let hits = 0;
  const server = createHttpServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  await new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  const address = server.address();
  return harden({
    port: address !== null && typeof address === 'object' ? address.port : 0,
    hits: () => hits,
    close: async () =>
      new Promise(resolve => server.close(() => resolve(undefined))),
  });
};

/**
 * The one authority a projection carries: open one more connection to one
 * daemon-side endpoint. Both ends are `@endo/exo-stream` passables, so a real
 * consumer is free to hold this from another vat.
 *
 * @param {number} port
 */
const makeLoopbackDialer = port =>
  Far('EndpointDialer', {
    help: () => `dialer for 127.0.0.1:${port}`,
    connect: async () => {
      await null;
      const socket = await new Promise((resolve, reject) => {
        const conn = netConnect(port, '127.0.0.1');
        conn.once('connect', () => resolve(conn));
        conn.once('error', reject);
      });
      const stream = /** @type {import('node:net').Socket} */ (socket);
      stream.on('error', () => stream.destroy());
      const reader = bytesReaderFromIterator(
        (async function* readConn() {
          for await (const chunk of stream) {
            yield new Uint8Array(chunk);
          }
        })(),
      );
      const writer = bytesWriterFromIterator(
        /** @type {any} */ ({
          /** @param {Uint8Array} chunk */
          next: async chunk =>
            new Promise(resolve =>
              stream.write(chunk, () =>
                resolve({ done: false, value: undefined }),
              ),
            ),
          return: async () => {
            stream.end();
            return { done: true, value: undefined };
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        }),
      );
      return harden({ reader, writer });
    },
  });

/**
 * Ask the slice to dial both endpoints and report what happened.
 */
const SLICE_PROBE_SOURCE = `
const http = require('node:http');
const get = port => new Promise(resolve => {
  const req = http.get({ host: '127.0.0.1', port, path: '/probe' }, res => {
    let body = '';
    res.on('data', d => { body += d; });
    res.on('end', () => resolve({ ok: true, body }));
  });
  req.on('error', e => resolve({ ok: false, code: e.code }));
  req.setTimeout(4000, () => { req.destroy(); resolve({ ok: false, code: 'TIMEOUT' }); });
});
(async () => {
  const origin = process.env.ENDO_PROJECTED_ORIGIN ?? null;
  process.stdout.write(JSON.stringify({
    origin,
    projected: await get(origin === null ? 1 : Number(new URL(origin).port)),
    other: await get(Number(process.env.ENDO_PROBE_OTHER_PORT)),
  }) + '\\n');
})();
`;

/**
 * @param {unknown} slice
 * @param {Record<string, string>} env
 */
const runSliceProbe = async (slice, env) => {
  const proc = await E(/** @type {any} */ (slice)).spawn(
    ['node', '-e', SLICE_PROBE_SOURCE],
    { env, timeoutMs: 30_000 },
  );
  /** @type {Uint8Array[]} */
  const chunks = [];
  for await (const chunk of iterateBytesReader(await E(proc).stdout())) {
    chunks.push(chunk);
  }
  await E(proc).wait();
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes).trim());
};

/**
 * Provision a real on-disk mount, mirroring `shell.test.js`.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {{ readOnly?: boolean }} [opts]
 */
const provisionMount = async (t, { readOnly = false } = {}) => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'sandbox-test-'),
  );
  t.teardown(() => fs.promises.rm(root, { recursive: true, force: true }));
  const filePowers = makeFilePowers({ fs, path });
  return { root, mount: makeMount({ rootPath: root, readOnly, filePowers }) };
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
 * The physical-backing resolver and the read-only gate the daemon's
 * `sandbox` maker installs, restated here so the tests pin the
 * composition rather than a copy of the policy.
 *
 * @param {unknown} cap
 */
const resolveHostPath = async cap => {
  const backing = getMountBacking(cap);
  return backing?.kind === 'physical' ? backing.currentDir : undefined;
};

/**
 * @param {unknown} cap
 * @param {'ro' | 'rw'} mode
 * @param {string} innerPath
 */
const assertMountGrant = (cap, mode, innerPath) => {
  const backing = getMountBacking(cap);
  if (backing !== undefined && backing.readOnly && mode === 'rw') {
    throw new Error(
      `Sandbox cannot bind a read-only mount read-write at ${innerPath}`,
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
  const { root, mount } = await provisionMount(t);
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
  const { mount } = await provisionMount(t);
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

  const { root, mount } = await provisionMount(t);
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

test('the real backend projects one endpoint into a network: none slice', async t => {
  const { make: makeSandboxFactory } = await import('@endo/sandbox');
  const { makeNodeHostToolPowers } =
    await import('../src/host-tool-powers-node.js');
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
  const usable = backends.find(
    backend => backend.available && backend.name === 'bwrap',
  );
  if (usable === undefined) {
    t.pass('SKIP: no bwrap backend available for endpoint projection');
    return;
  }
  t.timeout(120_000);

  // The endpoint the slice is granted, and a second one on host loopback
  // that it must not be able to reach.
  const granted = await startProbeServer('granted-endpoint');
  t.teardown(() => granted.close());
  const ungranted = await startProbeServer('SHOULD-NOT-BE-REACHABLE');
  t.teardown(() => ungranted.close());

  const { mount } = await provisionMount(t);
  const profile = normalizeSandboxProfile(
    {
      rootfs: { kind: 'host-bind' },
      mounts: [{ cap: mount, innerPath: '/workspace', mode: 'ro' }],
      backend: 'bwrap',
      network: 'none',
      escalation: baseEscalation,
    },
    resolveFakeMountId,
  );

  const statePath = await provisionStatePath(t);
  const filePowers = makeFilePowers({ fs, path });
  const { projector } = makeFakeProjector();
  // The daemon's own projection seam, not a fake: this is the half the
  // supervisor supplies through `HostToolPowers`.
  const projectionPowers = /** @type {any} */ (
    makeNodeHostToolPowers()
  ).makeSandboxProjectionPowers();
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
    projectionPowers,
  });
  t.teardown(() => release());

  const projection = await E(/** @type {any} */ (slice)).projectEndpoint(
    makeLoopbackDialer(granted.port),
  );
  const origin = await E(projection).origin();
  t.is(origin, 'http://127.0.0.1:8080');

  const reached = await runSliceProbe(slice, {
    ENDO_PROBE_OTHER_PORT: String(ungranted.port),
  });
  t.true(reached.projected.ok, JSON.stringify(reached.projected));
  t.is(reached.projected.body, 'granted-endpoint');
  t.false(reached.other.ok, 'the ungranted host listener stays unreachable');
  t.is(ungranted.hits(), 0);

  await E(projection).revoke();
  const afterRevoke = await runSliceProbe(slice, {
    ENDO_PROBE_OTHER_PORT: String(ungranted.port),
  });
  t.is(afterRevoke.origin, null);
  t.false(afterRevoke.projected.ok);
});
