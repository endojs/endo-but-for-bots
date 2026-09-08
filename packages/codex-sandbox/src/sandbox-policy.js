// @ts-check

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import {
  assertBrokerLeaseV1,
  assertContainerMounts,
  assertHostedAgentPolicyV1,
  makeCodexResourceProvisioner,
} from './backend-factory.js';
import { makeBrokerAppServerArgv } from './broker-launch.js';
import { makeCodexRuntimeVerifier } from './runtime-verifier.js';

const GiB = 1024n ** 3n;
const MiB = 1024n ** 2n;
// One policy anchor and one admitted operation have independent cgroups.
// Reserve half the aggregate memory, PID, and CPU budget for each.
const resources = harden({
  memoryBytes: 2n * GiB,
  pids: 256,
  cpuCores: 2,
  openFiles: 4096,
  coreBytes: 0n,
  shmBytes: 64n * MiB,
  maxConcurrentOperations: 1,
  writableBytes: 16n * GiB,
});
const approvedEnvironment = harden({
  CODEX_HOME: '/codex-home',
  HOME: '/home/node',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TEMP: '/tmp',
  TMP: '/tmp',
  TMPDIR: '/tmp',
  TZ: 'UTC',
});
const keys = record =>
  Object.keys(record || {})
    .sort()
    .join(',');
const assertExact = (actual, expected, label) => {
  keys(actual) === keys(expected) ||
    Fail`${q(label)} has unknown or missing fields`;
  for (const [key, value] of Object.entries(expected)) {
    if (typeof value === 'object' && value !== null) {
      assertExact(actual[key], value, `${label}.${key}`);
    } else {
      actual[key] === value || Fail`${q(`${label}.${key}`)} is not proved`;
    }
  }
};

/**
 * Compose observed outer confinement with independent trusted broker/runtime
 * evidence. None of these evidence authorities may be supplied by a session.
 * A production deployment must implement the verifiers with live observation;
 * returning the requested record from a verifier is not an implementation.
 *
 * `volumeProvider.describe(workspaceMount, spec)` binds actual quota-backed
 * volume names to this logical session. The broker lease's `sandboxEvidence()`
 * supplies its namespace selector and credential-handling guarantees.
 * `runtimeVerifier.attest(context)` must inspect the exact slice passed to it,
 * including its effective environment, image and inner command boundary.
 *
 * The adapter owns only the newly created slice. Its caller owns the workspace
 * and broker lease and unwinds those when this function rejects.
 * Failed slice disposal remains owned by this factory. Call
 * `makeSlice.retryCleanup()` to retry it; new admissions first retry all pending
 * cleanup and cannot proceed while that cleanup fails.
 *
 * @param {{sandbox: any, volumeProvider: any, runtimeVerifier?: any,
 * imageRef: string, imageDigest: string, providerOrigin: string,
 * accountRef: string}} powers
 */
export const makeAttestedCodexSliceFactory = powers => {
  const { imageDigest, imageRef } = powers;
  const runtimeVerifier = powers.runtimeVerifier ?? makeCodexRuntimeVerifier();
  /^sha256:[0-9a-f]{64}$/.test(imageDigest) ||
    Fail`Image digest must be pinned`;
  (/^[a-z0-9][a-z0-9._-]*(?::\d{1,5})?(?:\/[a-z0-9][a-z0-9._-]*)*@sha256:[0-9a-f]{64}$/.test(
    imageRef,
  ) &&
    imageRef.endsWith(`@${imageDigest}`)) ||
    Fail`Image reference must match digest`;
  // Retain cleanup authority even when admission fails before the caller can
  // register its inverse. Serialize admission and explicit retries so another
  // session cannot overtake an unresolved rollback.
  const pendingCleanup = new Set();
  let admission = Promise.resolve();
  const retryPending = async () => {
    await null;
    for (const cleanup of [...pendingCleanup]) {
      // eslint-disable-next-line no-await-in-loop
      await cleanup();
    }
  };
  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const enqueue = operation => {
    const result = admission.then(operation);
    admission = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const create = async ({ spec, workspaceMount, brokerLease }) => {
    const { sessionId } = spec;
    (typeof sessionId === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) ||
      Fail`Session identity must be a portable name`;
    const containerMounts = assertContainerMounts(spec.containerMounts);
    const volumes = await E(powers.volumeProvider).describe(
      workspaceMount,
      harden({ sessionId }),
    );
    (keys(volumes) === 'sessionId,stateVolume,workspaceVolume' &&
      volumes.sessionId === sessionId) ||
      Fail`Volume evidence has the wrong session identity`;
    for (const volume of [volumes.workspaceVolume, volumes.stateVolume]) {
      (typeof volume === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(volume)) ||
        Fail`Volume evidence must identify an actual named volume`;
    }
    volumes.workspaceVolume !== volumes.stateVolume ||
      Fail`Session volumes must be distinct`;
    const lease = await E(brokerLease).attestation();
    assertBrokerLeaseV1(lease, {
      sessionId,
      imageDigest,
      networkNamespaceId: lease?.networkNamespaceId,
      providerOrigin: powers.providerOrigin,
      accountRef: powers.accountRef,
      ...(spec.model ? { model: spec.model } : {}),
    });
    const launchArgv = makeBrokerAppServerArgv(lease.endpoint);
    const broker = await E(brokerLease).sandboxEvidence();
    const brokerSidecar = broker?.brokerSidecar;
    const selector = keys(brokerSidecar);
    (selector === 'container' &&
      typeof brokerSidecar.container === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(brokerSidecar.container)) ||
      (selector === 'netnsPath' &&
        typeof brokerSidecar.netnsPath === 'string' &&
        /^(\/[A-Za-z0-9][A-Za-z0-9_.-]*)+$/.test(brokerSidecar.netnsPath)) ||
      Fail`Broker namespace selector is invalid`;
    assertExact(
      broker,
      {
        version: 'CodexBrokerSandboxEvidenceV1',
        sessionId,
        imageDigest,
        leaseId: lease.leaseId,
        networkNamespaceId: lease.networkNamespaceId,
        brokerSidecar,
        credentialInjection: 'broker-only',
        brokerTransport: 'loopback-sidecar',
      },
      'broker evidence',
    );
    /** @type {readonly import('@endo/sandbox/types.js').SlicePolicyMount[]} */
    const mounts = harden([
      {
        role: 'workspace',
        kind: 'volume',
        source: volumes.workspaceVolume,
        destination: '/workspace',
        sizeBytes: 8n * GiB,
      },
      {
        role: 'codex-state',
        kind: 'volume',
        source: volumes.stateVolume,
        destination: '/codex-home',
        sizeBytes: 4n * GiB,
      },
      { role: 'tmp', kind: 'tmpfs', destination: '/tmp', sizeBytes: GiB },
      {
        role: 'run',
        kind: 'tmpfs',
        destination: '/run',
        sizeBytes: 256n * MiB,
      },
      {
        role: 'scratch',
        kind: 'tmpfs',
        destination: '/scratch',
        sizeBytes: 704n * MiB,
      },
      // Runtime attaches (designs/runtime-container-fs-mount.md): the
      // binds the table admits beyond its fixed five, each of a host 9P
      // mountpoint a bridge minted for a capability the session holds. The
      // sandbox refuses to attest one unless the anchor's own mount table
      // shows 9P at the destination, so the slice cannot be handed host
      // data under an attach's name.
      ...containerMounts.map(attach => ({
        role: `attach-${attach.key}`,
        kind: /** @type {const} */ ('attach'),
        source: attach.source,
        destination: attach.destination,
        mode: attach.mode,
      })),
    ]);
    const slice = await E(powers.sandbox).make(
      harden({
        rootfs: { kind: 'oci', ref: imageRef },
        network: 'broker-only',
        cwd: '/workspace',
        env: {},
        policy: {
          profile: 'hosted-agent-v1',
          imageDigest,
          uid: 1000,
          gid: 1000,
          brokerSidecar,
          resources,
          mounts,
          attestationArgv: ['/bin/sleep', 'infinity'],
        },
      }),
    );
    let closing = false;
    let disposed = false;
    let disposal;
    const dispose = () => {
      closing = true;
      if (disposed) return Promise.resolve();
      if (disposal) return disposal;
      pendingCleanup.add(dispose);
      disposal = E(slice)
        .dispose()
        .then(
          () => {
            disposed = true;
            pendingCleanup.delete(dispose);
          },
          error => {
            disposal = undefined;
            throw error;
          },
        );
      return disposal;
    };
    const assertOpen = () => {
      !closing || Fail`Slice disposal has started`;
    };
    try {
      const outer = await E(slice).policy();
      const outerMounts = mounts.map(mount => ({
        role: mount.role,
        source:
          mount.kind === 'volume'
            ? `volume:${mount.source}`
            : mount.kind === 'attach'
              ? `attach:${mount.source}`
              : 'tmpfs',
        destination: mount.destination,
        mode: mount.kind === 'attach' ? mount.mode : 'rw',
        options: ['nodev', 'nosuid'],
      }));
      assertExact(
        outer,
        {
          version: 'SlicePolicyAttestationV1',
          profile: 'hosted-agent-v1',
          backend: 'rootless-podman',
          imageDigest,
          network: 'broker-only',
          networkNamespaceId: lease.networkNamespaceId,
          uid: 1000,
          gid: 1000,
          readOnlyRoot: true,
          noNewPrivileges: true,
          dropAllCapabilities: true,
          seccomp: true,
          devices: 'none',
          hostSockets: 'none',
          hostHome: 'none',
          descendantReaping: true,
          namespaces: {
            user: 'private',
            pid: 'private',
            ipc: 'private',
            mount: 'private',
          },
          limits: resources,
          mounts: outerMounts,
        },
        'outer policy',
      );
      const runtime = await E(runtimeVerifier).attest(
        harden({
          slice,
          sessionId,
          imageDigest,
          leaseId: lease.leaseId,
          networkNamespaceId: outer.networkNamespaceId,
          launchArgv,
          launchEnvironment: approvedEnvironment,
          brokerEndpoint: lease.endpoint,
        }),
      );
      assertExact(
        runtime,
        {
          version: 'CodexRuntimeEvidenceV1',
          sessionId,
          imageDigest,
          leaseId: lease.leaseId,
          networkNamespaceId: outer.networkNamespaceId,
          toolSandbox: 'codex-workspace-write',
          toolCodexHomeAccess: 'read-only',
          toolBrokerAccess: 'denied',
          environment: 'credential-and-proxy-free',
        },
        'runtime evidence',
      );
      const { limits, mounts: observedMounts } = outer;
      const controls = Object.fromEntries(
        Object.entries(outer).filter(
          ([key]) => !['version', 'profile', 'limits', 'mounts'].includes(key),
        ),
      );
      // Each byte value here has already been checked against the small exact
      // profile above. Conversion cannot lose precision.
      const policy = assertHostedAgentPolicyV1(
        harden({
          ...controls,
          version: 'HostedAgentPolicyV1',
          sessionId,
          credentialInjection: broker.credentialInjection,
          brokerTransport: broker.brokerTransport,
          toolSandbox: runtime.toolSandbox,
          toolCodexHomeAccess: runtime.toolCodexHomeAccess,
          toolBrokerAccess: runtime.toolBrokerAccess,
          limits: {
            memoryBytes: Number(limits.memoryBytes * 2n),
            pids: limits.pids * 2,
            cpuCores: limits.cpuCores * 2,
            openFiles: limits.openFiles,
            coreBytes: Number(limits.coreBytes),
            writableBytes: Number(limits.writableBytes),
          },
          mounts: observedMounts.map(mount => ({
            ...mount,
            // Hosted policy names durable state by session and an attach by
            // its key, so the record carries no host path: the bridge's
            // layout is the host's business, and the key is what a
            // registrar's records and an audit entry refer to.
            source:
              mount.role === 'workspace' || mount.role === 'codex-state'
                ? `${mount.role}:${sessionId}`
                : mount.role.startsWith('attach-')
                  ? `attach:${mount.role.slice('attach-'.length)}`
                  : mount.source,
          })),
        }),
        { sessionId, imageDigest, containerMounts },
      );
      return makeExo(
        'AttestedCodexSlice',
        M.interface('AttestedCodexSlice', {
          policy: M.callWhen().returns(M.record()),
          spawn: M.callWhen(M.array(), M.record()).returns(M.remotable()),
          dispose: M.callWhen().returns(M.any()),
        }),
        {
          policy: async () => {
            assertOpen();
            const current = await E(slice).policy();
            assertOpen();
            assertExact(current, outer, 'current outer policy');
            return policy;
          },
          spawn: (argv, options) => {
            assertOpen();
            assertExact(options.env, approvedEnvironment, 'spawn environment');
            options.cwd === '/workspace' || Fail`Spawn cwd must be /workspace`;
            assertExact(argv, launchArgv, 'spawn argv');
            return E(slice).spawn(argv, options);
          },
          dispose,
        },
      );
    } catch (error) {
      try {
        await dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Slice verification and rollback failed',
          { cause: cleanupError },
        );
      }
      throw error;
    }
  };
  const makeSlice = options =>
    enqueue(async () => {
      await retryPending();
      return create(options);
    });
  return harden(
    Object.assign(makeSlice, {
      retryCleanup: () => enqueue(retryPending),
    }),
  );
};
harden(makeAttestedCodexSliceFactory);

/**
 * Wire attested slice creation into the complete resource lifecycle. Retain
 * this operator-owned callable to retry cleanup after a provisioning failure.
 *
 * @param {Omit<Parameters<typeof makeCodexResourceProvisioner>[0], 'makeSlice'> & Parameters<typeof makeAttestedCodexSliceFactory>[0]} powers
 */
export const makeAttestedCodexResourceProvisioner = powers => {
  const makeSlice = makeAttestedCodexSliceFactory(powers);
  const provision = makeCodexResourceProvisioner({
    ...powers,
    makeSlice,
    retrySliceCleanup: makeSlice.retryCleanup,
  });
  return harden(
    Object.assign(spec => provision(spec), {
      retryCleanup: provision.retryCleanup,
    }),
  );
};
harden(makeAttestedCodexResourceProvisioner);
