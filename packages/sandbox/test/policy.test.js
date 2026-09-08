// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  assemblePolicyArgv,
  assertSlicePolicyRequest,
  attestSlicePolicy,
  brokerNetworkArg,
  parseByteSize,
  sliceConfigFingerprint,
  SLICE_POLICY_ATTESTATION_VERSION,
} from '../src/policy.js';

const DIGEST = `sha256:${'a1'.repeat(32)}`;
const OTHER_DIGEST = `sha256:${'b2'.repeat(32)}`;

const GIB = 1024n * 1024n * 1024n;
const MIB = 1024n * 1024n;

/**
 * A request that satisfies the profile, so each negative case can name
 * the one field it breaks.
 *
 * @param {Record<string, unknown>} [overrides]
 */
const makeRequest = (overrides = {}) =>
  harden({
    profile: 'hosted-agent-v1',
    imageDigest: DIGEST,
    uid: 1000,
    gid: 1000,
    brokerSidecar: harden({ container: 'broker-sidecar-s1' }),
    resources: harden({
      memoryBytes: 4n * GIB,
      pids: 512,
      cpuCores: 4,
      openFiles: 4096,
      coreBytes: 0n,
      shmBytes: 64n * MIB,
      maxConcurrentOperations: 1,
      // Volumes are shared storage every container mounts (12 GiB);
      // the tmpfs entries and /dev/shm are per container, so they count
      // for the anchor and for the one operation.
      writableBytes: 12n * GIB + (4n * GIB + 64n * MIB) * 2n,
    }),
    mounts: harden([
      harden({
        role: 'workspace',
        kind: 'volume',
        source: 'workspace-s1',
        destination: '/workspace',
        sizeBytes: 8n * GIB,
      }),
      harden({
        role: 'codex-state',
        kind: 'volume',
        source: 'codex-state-s1',
        destination: '/codex-home',
        sizeBytes: 4n * GIB,
      }),
      harden({
        role: 'tmp',
        kind: 'tmpfs',
        destination: '/tmp',
        sizeBytes: 2n * GIB,
      }),
      harden({
        role: 'run',
        kind: 'tmpfs',
        destination: '/run',
        sizeBytes: 1n * GIB,
      }),
      harden({
        role: 'scratch',
        kind: 'tmpfs',
        destination: '/scratch',
        sizeBytes: 1n * GIB,
      }),
    ]),
    attestationArgv: harden(['/bin/sleep', 'infinity']),
    ...overrides,
  });

/**
 * Container-runtime inspect output for a container that actually got
 * everything the request asked for.
 *
 * @param {(record: any) => void} [mutate] Break exactly one thing.
 */
const makeInspect = mutate => {
  const record = {
    ImageDigest: DIGEST,
    State: { Running: true, Pid: 4242 },
    EffectiveCaps: [],
    HostConfig: {
      Privileged: false,
      ReadonlyRootfs: true,
      SecurityOpt: ['no-new-privileges'],
      Devices: [],
      Memory: 4_294_967_296,
      MemorySwap: 4_294_967_296,
      ShmSize: 67_108_864,
      PidsLimit: 512,
      CpuQuota: 400_000,
      CpuPeriod: 100_000,
      NanoCpus: 0,
      Ulimits: [
        { Name: 'RLIMIT_NOFILE', Soft: 4096, Hard: 4096 },
        { Name: 'RLIMIT_CORE', Soft: 0, Hard: 0 },
      ],
      Tmpfs: {
        '/tmp': 'rw,nosuid,nodev,size=2147483648,uid=1000,gid=1000,mode=0700',
        '/run': 'rw,nosuid,nodev,size=1073741824,uid=1000,gid=1000,mode=0700',
        '/scratch':
          'rw,nosuid,nodev,size=1073741824,uid=1000,gid=1000,mode=0700',
      },
    },
    Mounts: [
      {
        Type: 'volume',
        Name: 'workspace-s1',
        Destination: '/workspace',
        Options: ['nosuid', 'nodev', 'rprivate', 'rw'],
        RW: true,
      },
      {
        Type: 'volume',
        Name: 'codex-state-s1',
        Destination: '/codex-home',
        Options: ['nosuid', 'nodev', 'rprivate', 'rw'],
        RW: true,
      },
    ],
  };
  if (mutate !== undefined) mutate(record);
  return record;
};

/**
 * Namespace identities the kernel reports for a compliant anchor: each
 * distinct from the observer's, each with a readable identity.
 *
 * @param {Record<string, unknown>} [overrides]
 */
const makeNamespaces = (overrides = {}) =>
  harden({
    user: harden({ id: 'user-4026532100', unshared: true }),
    pid: harden({ id: 'pid-4026532101', unshared: true }),
    ipc: harden({ id: 'ipc-4026532102', unshared: true }),
    mount: harden({ id: 'mnt-4026532103', unshared: true }),
    ...overrides,
  });

/**
 * Per-process posture the kernel reports for a compliant anchor.
 *
 * @param {Record<string, unknown>} [overrides]
 */
const makeIdentity = (overrides = {}) =>
  harden({
    uid: 1000,
    gid: 1000,
    seccompMode: 2,
    noNewPrivs: true,
    effectiveCapabilities: 0n,
    permittedCapabilities: 0n,
    boundingCapabilities: 0n,
    ...overrides,
  });

/**
 * Observed kernel state for a slice that actually got isolated.
 *
 * @param {Record<string, unknown>} [overrides]
 */
const makeState = (overrides = {}) =>
  harden({
    inspect: makeInspect(),
    rootless: true,
    namespaces: makeNamespaces(),
    network: harden({
      namespaceId: 'net-4026532567',
      brokerNamespaceId: 'net-4026532567',
      interfaces: harden(['lo']),
      routableRoutes: 0,
    }),
    processIdentity: makeIdentity(),
    volumes: new Map([
      ['workspace-s1', { sizeBytes: 8n * GIB, hostPath: null }],
      ['codex-state-s1', { sizeBytes: 4n * GIB, hostPath: null }],
    ]),
    resources: harden({
      cgroupControllers: harden(['cpu', 'io', 'memory', 'pids']),
    }),
    descendantReaping: true,
    ...overrides,
  });

test('parseByteSize reads the forms container tooling writes back', t => {
  t.is(parseByteSize('4294967296'), 4_294_967_296n);
  t.is(parseByteSize('4G'), 4n * GIB);
  t.is(parseByteSize('4GiB'), 4n * GIB);
  t.is(parseByteSize('100m'), 100n * 1024n * 1024n);
  t.is(parseByteSize(4096), 4096n);
  t.is(parseByteSize(0n), 0n);
  t.is(parseByteSize('unlimited'), null);
  t.is(parseByteSize(''), null);
  t.is(parseByteSize(undefined), null);
  t.is(parseByteSize(-1), null);
});

test('a well-formed request normalizes and hardens', t => {
  const policy = assertSlicePolicyRequest(makeRequest());
  t.is(policy.profile, 'hosted-agent-v1');
  t.is(policy.imageDigest, DIGEST);
  t.true(Object.isFrozen(policy));
  t.true(Object.isFrozen(policy.mounts));
});

test('a request rejects an image that is not pinned by digest', t => {
  t.throws(
    () =>
      assertSlicePolicyRequest(
        makeRequest({ imageDigest: 'docker.io/library/alpine:3.19' }),
      ),
    { message: /pinned by SHA-256 digest/ },
  );
});

test('a request rejects uid or gid 0', t => {
  t.throws(() => assertSlicePolicyRequest(makeRequest({ uid: 0 })), {
    message: /uid/,
  });
  t.throws(() => assertSlicePolicyRequest(makeRequest({ gid: 0 })), {
    message: /gid/,
  });
});

test('a request rejects an unknown field rather than ignoring it', t => {
  t.throws(
    () => assertSlicePolicyRequest(makeRequest({ networkFiltering: 'off' })),
    { message: /unknown or missing fields/ },
  );
});

test('a request rejects a writable ceiling its mounts do not add up to', t => {
  const request = makeRequest();
  t.throws(
    () =>
      assertSlicePolicyRequest({
        ...request,
        resources: { ...request.resources, writableBytes: 32n * GIB },
      }),
    { message: /does not equal what its writable paths add up to/ },
  );
});

test('a request rejects a writable mount with no ceiling of its own', t => {
  const request = makeRequest();
  t.throws(
    () =>
      assertSlicePolicyRequest({
        ...request,
        mounts: [
          { ...request.mounts[0], sizeBytes: 0n },
          ...request.mounts.slice(1),
        ],
      }),
    { message: /positive writable ceiling/ },
  );
});

test('a request rejects a duplicated destination', t => {
  const request = makeRequest();
  t.throws(
    () =>
      assertSlicePolicyRequest({
        ...request,
        mounts: [
          ...request.mounts,
          {
            role: 'shadow',
            kind: 'tmpfs',
            destination: '/tmp',
            sizeBytes: 1n * GIB,
          },
        ],
        resources: {
          ...request.resources,
          writableBytes: 12n * GIB + (5n * GIB + 64n * MIB) * 2n,
        },
      }),
    { message: /destination .* is duplicated/ },
  );
});

test('a request rejects a traversing destination', t => {
  const request = makeRequest();
  t.throws(
    () =>
      assertSlicePolicyRequest({
        ...request,
        mounts: [
          { ...request.mounts[2], destination: '/tmp/../etc' },
          ...request.mounts.filter((_m, index) => index !== 2),
        ],
      }),
    { message: /absolute normal destination/ },
  );
});

test('a request rejects an empty attestation argv', t => {
  t.throws(
    () => assertSlicePolicyRequest(makeRequest({ attestationArgv: [] })),
    { message: /non-empty argv/ },
  );
});

test('brokerNetworkArg joins the namespace the operator named', t => {
  t.is(
    brokerNetworkArg(harden({ container: 'broker-sidecar-s1' })),
    'container:broker-sidecar-s1',
  );
  t.is(
    brokerNetworkArg(harden({ netnsPath: '/run/netns/broker-s1' })),
    'ns:/run/netns/broker-s1',
  );
});

test('policy argv carries every ceiling the request named', t => {
  const policy = assertSlicePolicyRequest(makeRequest());
  const argv = assemblePolicyArgv(policy);
  t.deepEqual(
    [...argv],
    [
      '--user',
      '1000:1000',
      '--pid',
      'private',
      '--ipc',
      'private',
      '--security-opt',
      'no-new-privileges',
      '--cap-drop',
      'ALL',
      '--read-only',
      '--read-only-tmpfs=false',
      '--network',
      'container:broker-sidecar-s1',
      '--memory',
      '4294967296',
      '--memory-swap',
      '4294967296',
      '--pids-limit',
      '512',
      '--cpus',
      '4',
      '--ulimit',
      'nofile=4096:4096',
      '--ulimit',
      'core=0:0',
      '--shm-size',
      '67108864',
      '--volume',
      'workspace-s1:/workspace:rw,nosuid,nodev',
      '--volume',
      'codex-state-s1:/codex-home:rw,nosuid,nodev',
      '--mount',
      'type=tmpfs,destination=/tmp,rw,nosuid,nodev,tmpfs-size=2147483648,tmpfs-mode=0700,U=true,notmpcopyup',
      '--mount',
      'type=tmpfs,destination=/run,rw,nosuid,nodev,tmpfs-size=1073741824,tmpfs-mode=0700,U=true,notmpcopyup',
      '--mount',
      'type=tmpfs,destination=/scratch,rw,nosuid,nodev,tmpfs-size=1073741824,tmpfs-mode=0700,U=true,notmpcopyup',
    ],
  );
});

test('policy argv leaves no writable path the runtime chose', t => {
  const policy = assertSlicePolicyRequest(makeRequest());
  const argv = assemblePolicyArgv(policy);
  // Read-only root plus a runtime-supplied convenience tmpfs set would
  // put writable paths in the slice that no ceiling covers and no
  // attestation names.
  t.true(argv.includes('--read-only'));
  t.true(argv.includes('--read-only-tmpfs=false'));
});

test('an observed slice attests every control', t => {
  const policy = assertSlicePolicyRequest(makeRequest());
  const attestation = attestSlicePolicy(policy, makeState());
  t.is(attestation.version, SLICE_POLICY_ATTESTATION_VERSION);
  t.is(attestation.backend, 'rootless-podman');
  t.is(attestation.network, 'broker-only');
  t.is(attestation.networkNamespaceId, 'net-4026532567');
  t.is(attestation.imageDigest, DIGEST);
  t.is(attestation.uid, 1000);
  t.is(attestation.devices, 'none');
  t.is(attestation.hostHome, 'none');
  t.is(attestation.hostSockets, 'none');
  t.true(attestation.descendantReaping);
  t.deepEqual(
    { ...attestation.namespaces },
    { user: 'private', pid: 'private', ipc: 'private', mount: 'private' },
  );
  t.deepEqual(
    { ...attestation.limits },
    {
      memoryBytes: 4n * GIB,
      pids: 512,
      cpuCores: 4,
      openFiles: 4096,
      coreBytes: 0n,
      shmBytes: 64n * MIB,
      maxConcurrentOperations: 1,
      writableBytes: 12n * GIB + (4n * GIB + 64n * MIB) * 2n,
    },
  );
  t.deepEqual(
    attestation.mounts.map(mount => [mount.role, mount.source, mount.mode]),
    [
      ['workspace', 'volume:workspace-s1', 'rw'],
      ['codex-state', 'volume:codex-state-s1', 'rw'],
      ['tmp', 'tmpfs', 'rw'],
      ['run', 'tmpfs', 'rw'],
      ['scratch', 'tmpfs', 'rw'],
    ],
  );
  for (const mount of attestation.mounts) {
    t.deepEqual([...mount.options], ['nodev', 'nosuid']);
  }
  t.true(Object.isFrozen(attestation));
});

/**
 * Each of these is a host that accepted the flag and did something
 * else. The attestation has to be the thing that notices.
 *
 * @type {Array<[string, Record<string, unknown>, RegExp]>}
 */
const unprovedStates = [
  ['a rootful engine', { rootless: false }, /rootless backend/],
  [
    'an anchor that is not running',
    {
      inspect: makeInspect(record => {
        record.State.Running = false;
      }),
    },
    /live slice anchor/,
  ],
  [
    'a shared pid namespace',
    { namespaces: makeNamespaces({ pid: { id: 'pid-1', unshared: false } }) },
    /pid namespace/,
  ],
  [
    'a shared user namespace',
    { namespaces: makeNamespaces({ user: { id: null, unshared: true } }) },
    /user namespace/,
  ],
  [
    'a routable interface in the joined namespace',
    {
      network: harden({
        namespaceId: 'net-4026532567',
        brokerNamespaceId: 'net-4026532567',
        interfaces: harden(['lo', 'eth0']),
        routableRoutes: 1,
      }),
    },
    /broker-only network/,
  ],
  [
    'a default route that survived',
    {
      network: harden({
        namespaceId: 'net-4026532567',
        brokerNamespaceId: 'net-4026532567',
        interfaces: harden(['lo']),
        routableRoutes: 2,
      }),
    },
    /broker-only network/,
  ],
  [
    'a process running as a different identity',
    {
      processIdentity: makeIdentity({ uid: 0, gid: 0 }),
    },
    /uid/,
  ],
  [
    'an image that is not the approved one',
    {
      inspect: makeInspect(record => {
        record.ImageDigest = OTHER_DIGEST;
      }),
    },
    /image digest/,
  ],
  [
    'a writable root',
    {
      inspect: makeInspect(record => {
        record.HostConfig.ReadonlyRootfs = false;
      }),
    },
    /read-only root/,
  ],
  [
    'privileges that can be regained',
    {
      processIdentity: makeIdentity({ noNewPrivs: false }),
    },
    /no-new-privileges/,
  ],
  [
    'a kernel that reports no no-new-privileges flag',
    {
      processIdentity: makeIdentity({ noNewPrivs: null }),
    },
    /no-new-privileges/,
  ],
  [
    'a process with no seccomp filter loaded',
    {
      processIdentity: makeIdentity({ seccompMode: 0 }),
    },
    /seccomp/,
  ],
  [
    'a kernel that reports no seccomp mode at all',
    {
      processIdentity: makeIdentity({ seccompMode: null }),
    },
    /seccomp/,
  ],
  [
    'a capability the container kept',
    {
      processIdentity: makeIdentity({ effectiveCapabilities: 0x2000n }),
    },
    /dropped capabilities/,
  ],
  [
    'a kernel that reports no capability mask',
    {
      processIdentity: makeIdentity({ effectiveCapabilities: null }),
    },
    /dropped capabilities/,
  ],
  [
    'a device passed through',
    {
      inspect: makeInspect(record => {
        record.HostConfig.Devices = [{ PathInContainer: '/dev/kvm' }];
      }),
    },
    /device isolation/,
  ],
  [
    'a memory ceiling the host ignored',
    {
      inspect: makeInspect(record => {
        record.HostConfig.Memory = 0;
      }),
    },
    /memory ceiling/,
  ],
  [
    'swap the slice can spill into',
    {
      inspect: makeInspect(record => {
        record.HostConfig.MemorySwap = 8_589_934_592;
      }),
    },
    /swap ceiling/,
  ],
  [
    'a pid ceiling the host ignored',
    {
      inspect: makeInspect(record => {
        record.HostConfig.PidsLimit = 0;
      }),
    },
    /pid ceiling/,
  ],
  [
    'a cpu ceiling the host ignored',
    {
      inspect: makeInspect(record => {
        record.HostConfig.CpuQuota = 0;
        record.HostConfig.CpuPeriod = 0;
      }),
    },
    /cpu ceiling/,
  ],
  [
    'an open-file ceiling the host ignored',
    {
      inspect: makeInspect(record => {
        record.HostConfig.Ulimits = [];
      }),
    },
    /nofile ceiling/,
  ],
  [
    'core dumps the slice can still write',
    {
      inspect: makeInspect(record => {
        record.HostConfig.Ulimits[1] = {
          Name: 'RLIMIT_CORE',
          Soft: -1,
          Hard: -1,
        };
      }),
    },
    /core ceiling/,
  ],
  [
    'a host that cannot delegate the controllers',
    { resources: harden({ cgroupControllers: harden(['io']) }) },
    // Names what the host does delegate as well as what it does not:
    // the missing set alone reads as though those were the ones it had.
    /cgroup delegation.*delegated io, needs memory,pids,cpu/,
  ],
  [
    'an undeclared bind mount',
    {
      inspect: makeInspect(record => {
        record.Mounts.push({
          Type: 'bind',
          Source: '/home/operator',
          Destination: '/home/agent',
          Options: ['rw'],
          RW: true,
        });
      }),
    },
    /mount table/,
  ],
  [
    'a host bind mount at a declared destination',
    {
      inspect: makeInspect(record => {
        record.Mounts[0] = {
          Type: 'bind',
          Source: '/home/operator/workspace',
          Destination: '/workspace',
          Options: ['nosuid', 'nodev', 'rw'],
          RW: true,
        };
      }),
    },
    /host bind mount/,
  ],
  [
    'an undeclared tmpfs the runtime added',
    {
      inspect: makeInspect(record => {
        record.HostConfig.Tmpfs['/var/tmp'] = 'rw,size=1073741824';
      }),
    },
    /undeclared tmpfs/,
  ],
  [
    'a mount that lost nosuid',
    {
      inspect: makeInspect(record => {
        record.Mounts[0].Options = ['nodev', 'rw'];
      }),
    },
    /mount workspace/,
  ],
  [
    'a tmpfs with no size ceiling',
    {
      inspect: makeInspect(record => {
        record.HostConfig.Tmpfs['/tmp'] = 'rw,nosuid,nodev';
      }),
    },
    /mount tmp storage ceiling/,
  ],
  [
    'a volume with no recorded quota',
    {
      volumes: new Map([
        ['codex-state-s1', { sizeBytes: 4n * GIB, hostPath: null }],
      ]),
    },
    /mount workspace storage ceiling/,
  ],
  [
    'a volume whose quota is not the declared one',
    {
      volumes: new Map([
        ['workspace-s1', { sizeBytes: 64n * GIB, hostPath: null }],
        ['codex-state-s1', { sizeBytes: 4n * GIB, hostPath: null }],
      ]),
    },
    /mount workspace storage ceiling/,
  ],
  [
    'a permitted capability the process can raise back',
    { processIdentity: makeIdentity({ permittedCapabilities: 0x2000n }) },
    /dropped capabilities/,
  ],
  [
    'a bounding set a descendant could acquire from',
    { processIdentity: makeIdentity({ boundingCapabilities: 0x3fn }) },
    /dropped capabilities/,
  ],
  [
    "a loopback-only namespace that is not the broker's",
    {
      network: harden({
        namespaceId: 'net-4026539999',
        brokerNamespaceId: 'net-4026532567',
        interfaces: harden(['lo']),
        routableRoutes: 0,
      }),
    },
    /broker namespace identity/,
  ],
  [
    'a shared-memory tmpfs the runtime sized on its own',
    {
      inspect: makeInspect(record => {
        record.HostConfig.ShmSize = 134_217_728;
      }),
    },
    /shared-memory ceiling/,
  ],
  [
    'a runtime that reports no shared-memory size at all',
    {
      inspect: makeInspect(record => {
        delete record.HostConfig.ShmSize;
      }),
    },
    /shared-memory ceiling/,
  ],
  [
    'descendants nothing reaps',
    { descendantReaping: false },
    /descendant reaping/,
  ],
];

for (const [label, overrides, message] of unprovedStates) {
  test(`attestation refuses ${label}`, t => {
    const policy = assertSlicePolicyRequest(makeRequest());
    t.throws(() => attestSlicePolicy(policy, makeState(overrides)), {
      message,
    });
  });
}

test('attestation refuses a runtime whose report it cannot read', t => {
  const policy = assertSlicePolicyRequest(makeRequest());
  // A shape we do not recognize is "this control is not proved", never
  // "this control is fine": every field is missing at once here.
  t.throws(() => attestSlicePolicy(policy, makeState({ inspect: {} })), {
    message: /is not enforced/,
  });
});

test('a request rejects /dev/shm in the mount table', t => {
  const request = makeRequest();
  // The runtime takes its size from `--shm-size` and would ignore a
  // second declaration of the same path, so the table is the wrong
  // place to write it and saying so beats silently losing the ceiling.
  t.throws(
    () =>
      assertSlicePolicyRequest({
        ...request,
        mounts: [
          ...request.mounts,
          {
            role: 'shm',
            kind: 'tmpfs',
            destination: '/dev/shm',
            sizeBytes: 64n * MIB,
          },
        ],
      }),
    { message: /belongs in resources.shmBytes/ },
  );
});

test('the writable total counts the shared-memory ceiling too', t => {
  const request = makeRequest();
  t.throws(
    () =>
      assertSlicePolicyRequest({
        ...request,
        // Exactly the mount-table sum, which now leaves shmBytes
        // uncovered — the aggregate must account for every writable
        // path, not only the ones in the table.
        resources: {
          ...request.resources,
          // The mount table's own sum, which now leaves both the
          // shared-memory ceiling and the second container uncovered.
          writableBytes: 16n * GIB,
        },
      }),
    { message: /does not equal what its writable paths add up to/ },
  );
});

test('a volume that is really a host bind is refused, not attested', t => {
  const policy = assertSlicePolicyRequest(makeRequest());
  // `podman volume create --opt device=/home/agent --opt o=bind` makes
  // something the runtime reports as Type: 'volume', so the mount
  // table's "no host binds" rule walks straight past it — and the
  // attestation would stamp hostHome: 'none' over the operator's home.
  t.throws(
    () =>
      attestSlicePolicy(
        policy,
        makeState({
          volumes: new Map([
            [
              'workspace-s1',
              { sizeBytes: 8n * GIB, hostPath: '/home/operator' },
            ],
            ['codex-state-s1', { sizeBytes: 4n * GIB, hostPath: null }],
          ]),
        }),
      ),
    { message: /backed by the host path/ },
  );
});

test('a request rejects a netns path that could name a second network', t => {
  const request = makeRequest();
  // A runtime that reads `--network` as a comma-separated list would
  // attach the slice to a network the policy never named.
  t.throws(
    () =>
      assertSlicePolicyRequest({
        ...request,
        brokerSidecar: { netnsPath: '/run/netns/broker-s1,podman' },
      }),
    { message: /absolute normal path/ },
  );
});

test('a mount label is quoted once, not twice', t => {
  const request = makeRequest();
  t.throws(
    () =>
      assertSlicePolicyRequest({
        ...request,
        mounts: [
          { ...request.mounts[2], surprise: 1 },
          ...request.mounts.slice(3),
        ],
      }),
    { message: /^slice policy "mount tmp" has unknown or missing fields/ },
  );
});

test('the fingerprint ignores key order but not configuration', t => {
  const one = makeInspect();
  const other = makeInspect(record => {
    // Same configuration, serialized with its keys the other way round.
    record.HostConfig = Object.fromEntries(
      Object.entries(record.HostConfig).reverse(),
    );
  });
  t.is(sliceConfigFingerprint(one), sliceConfigFingerprint(other));
  const weaker = makeInspect(record => {
    record.HostConfig.PidsLimit = 0;
  });
  t.not(sliceConfigFingerprint(one), sliceConfigFingerprint(weaker));
});

test('the fingerprint covers the capability configuration', t => {
  const one = makeInspect(record => {
    record.HostConfig.CapDrop = ['ALL'];
  });
  const other = makeInspect(record => {
    record.HostConfig.CapDrop = [];
    record.HostConfig.CapAdd = ['CAP_SYS_ADMIN'];
  });
  // Capabilities are proved from the kernel for the anchor only, so an
  // operation whose capability configuration differs must not be able
  // to fingerprint identically to it.
  t.not(sliceConfigFingerprint(one), sliceConfigFingerprint(other));
});

test('a tmpfs table it cannot read is unproved, not empty', t => {
  const policy = assertSlicePolicyRequest(makeRequest());
  // Dropping an unreadable entry would let an undeclared writable path
  // pass the exactness check by being invisible to it.
  t.throws(
    () =>
      attestSlicePolicy(
        policy,
        makeState({
          inspect: makeInspect(record => {
            record.HostConfig.Tmpfs['/host-data'] = null;
          }),
        }),
      ),
    { message: /unreadable tmpfs entry at \/host-data/ },
  );
  t.throws(
    () =>
      attestSlicePolicy(
        policy,
        makeState({
          inspect: makeInspect(record => {
            record.HostConfig.Tmpfs = 'rw,nosuid,nodev';
          }),
        }),
      ),
    { message: /mount table/ },
  );
});

test('a security option the policy never asked for is refused', t => {
  const policy = assertSlicePolicyRequest(makeRequest());
  // `unmask=` re-exposes /proc paths the runtime masks. Neither
  // kernel-proved control — a loaded seccomp filter, no-new-privileges
  // — says anything about it, so nothing else would notice.
  t.throws(
    () =>
      attestSlicePolicy(
        policy,
        makeState({
          inspect: makeInspect(record => {
            record.HostConfig.SecurityOpt = ['no-new-privileges', 'unmask=ALL'];
          }),
        }),
      ),
    { message: /security options/ },
  );
  t.throws(
    () =>
      attestSlicePolicy(
        policy,
        makeState({
          inspect: makeInspect(record => {
            record.HostConfig.SecurityOpt = ['label=disable'];
          }),
        }),
      ),
    { message: /security options/ },
  );
  // The two the policy does ask for are fine, in either spelling.
  t.notThrows(() =>
    attestSlicePolicy(
      policy,
      makeState({
        inspect: makeInspect(record => {
          record.HostConfig.SecurityOpt = [
            'no-new-privileges:true',
            'seccomp=/tmp/profile.json',
          ];
        }),
      }),
    ),
  );
});

for (const option of ['uid=0', 'gid=0', 'mode=0777']) {
  test(`tmpfs ownership drift ${option} fails attestation`, t => {
    const field = option.split('=')[0];
    const inspect = makeInspect(record => {
      record.HostConfig.Tmpfs['/tmp'] = record.HostConfig.Tmpfs['/tmp']
        .split(',')
        .filter(part => !part.startsWith(`${field}=`))
        .concat(option)
        .join(',');
    });
    t.throws(
      () =>
        attestSlicePolicy(
          assertSlicePolicyRequest(makeRequest()),
          makeState({ inspect }),
        ),
      {
        message: /mount tmp ownership/,
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Runtime attaches: the one bind the table admits, and only once the kernel
// says what it was bound from (designs/runtime-container-fs-mount.md).
// ---------------------------------------------------------------------------

const ATTACH = harden({
  role: 'attach-a1',
  kind: 'attach',
  source: '/host/mounts/claude-attach-a1',
  destination: '/mnt/project',
  mode: 'rw',
});

/** A request that also declares one attach. */
const makeAttachRequest = (overrides = {}) =>
  makeRequest({
    mounts: harden([
      ...makeRequest().mounts,
      harden({ ...ATTACH, ...overrides }),
    ]),
  });

/**
 * Inspect output for a container whose runtime bound the attach as asked,
 * plus the kernel's view of it.
 *
 * @param {{ ro?: boolean, kernelFstype?: string, kernelRoot?: string, kernelOptions?: string[], runtimeOptions?: string[], omitKernel?: boolean }} [changes]
 */
const makeAttachState = ({
  ro = false,
  kernelFstype = '9p',
  kernelRoot,
  kernelOptions,
  runtimeOptions,
  omitKernel = false,
} = {}) =>
  makeState({
    inspect: makeInspect(record => {
      record.Mounts.push({
        Type: 'bind',
        Source: '/host/mounts/claude-attach-a1',
        Destination: '/mnt/project',
        Options: runtimeOptions ?? [
          'nosuid',
          'nodev',
          'rprivate',
          ro ? 'ro' : 'rw',
          'rbind',
        ],
        RW: !ro,
      });
    }),
    ...(omitKernel
      ? {}
      : {
          attachMounts: new Map([
            [
              '/mnt/project',
              harden({
                fstype: kernelFstype,
                root: kernelRoot ?? '/',
                options: harden(
                  kernelOptions ?? [
                    ro ? 'ro' : 'rw',
                    'nosuid',
                    'nodev',
                    'relatime',
                  ],
                ),
              }),
            ],
          ]),
        }),
  });

test('an attach is validated as a bounded /mnt/ bind with a declared mode', t => {
  const policy = assertSlicePolicyRequest(makeAttachRequest());
  t.deepEqual(policy.mounts.at(-1), ATTACH);
  // An attach is not host storage, so it adds nothing to the writable
  // ceiling the table bounds — the aggregate is unchanged.
  t.is(policy.resources.writableBytes, makeRequest().resources.writableBytes);

  /** @type {[string, Record<string, unknown>, RegExp][]} */
  const rejected = [
    [
      'a destination outside /mnt/',
      { destination: '/workspace' },
      /under \/mnt\//,
    ],
    ['/mnt itself', { destination: '/mnt' }, /under \/mnt\//],
    [
      'a traversing destination',
      { destination: '/mnt/../etc' },
      /under \/mnt\//,
    ],
    ['a relative source', { source: 'claude-attach-a1' }, /host mountpoint/],
    ['a source with a separator', { source: '/host/a,b' }, /host mountpoint/],
    ['an unknown mode', { mode: 'rwx' }, /mode must be/],
    ['a storage ceiling', { sizeBytes: 1n }, /unknown or missing fields/],
  ];
  for (const [label, overrides, message] of rejected) {
    t.throws(
      () => assertSlicePolicyRequest(makeAttachRequest(overrides)),
      { message },
      label,
    );
  }
  // The same host mountpoint bound twice is a duplicate, like a volume.
  t.throws(
    () =>
      assertSlicePolicyRequest(
        makeRequest({
          mounts: harden([
            ...makeRequest().mounts,
            ATTACH,
            harden({ ...ATTACH, role: 'attach-a2', destination: '/mnt/other' }),
          ]),
        }),
      ),
    { message: /mounted twice/ },
  );
});

test('an attach is assembled as a hardened private bind', t => {
  const argv = assemblePolicyArgv(
    assertSlicePolicyRequest(makeAttachRequest()),
  );
  t.true(
    argv.includes(
      'type=bind,source=/host/mounts/claude-attach-a1,destination=/mnt/project,rw,nosuid,nodev,bind-propagation=rprivate',
    ),
  );
  const ro = assemblePolicyArgv(
    assertSlicePolicyRequest(makeAttachRequest({ mode: 'ro' })),
  );
  t.true(ro.some(arg => arg.includes('destination=/mnt/project,ro,')));
});

test('an attach is attested from the runtime bind and the kernel filesystem type', t => {
  const policy = assertSlicePolicyRequest(makeAttachRequest());
  const attestation = attestSlicePolicy(policy, makeAttachState());
  t.deepEqual(attestation.mounts.at(-1), {
    role: 'attach-a1',
    source: 'attach:/host/mounts/claude-attach-a1',
    destination: '/mnt/project',
    mode: 'rw',
    options: ['nodev', 'nosuid'],
  });
  // A read-only attach attests read-only, at both layers.
  const roPolicy = assertSlicePolicyRequest(makeAttachRequest({ mode: 'ro' }));
  t.is(
    attestSlicePolicy(roPolicy, makeAttachState({ ro: true })).mounts.at(-1)
      ?.mode,
    'ro',
  );
  // The host-bind exclusion still holds for every other bind: the same
  // bind at a destination the table did not declare as an attach.
  t.throws(
    () =>
      attestSlicePolicy(
        makeRequest() && assertSlicePolicyRequest(makeRequest()),
        makeAttachState(),
      ),
    { message: /undeclared mount at \/mnt\/project/ },
  );
});

test('an attach the kernel does not vouch for is not proved', t => {
  const policy = assertSlicePolicyRequest(makeAttachRequest());
  /** @type {[string, any, RegExp][]} */
  const unproved = [
    // The runtime bound a plain host directory: the kernel sees the host
    // filesystem at the destination, not a 9P projection.
    [
      'a host directory',
      makeAttachState({ kernelFstype: 'ext4' }),
      /ext4 rather than a 9p projection/,
    ],
    [
      'no kernel evidence',
      makeAttachState({ omitKernel: true }),
      /absent from the anchor mount table/,
    ],
    // A bind of one subtree of the projection carries the same filesystem
    // type as the whole of it, so type alone cannot tell them apart — and
    // the slice would see a different tree than the capability names.
    [
      'a bind of a subtree rather than the projection',
      makeAttachState({ kernelRoot: '/elsewhere' }),
      /a bind of \/elsewhere within the projection rather than the whole of it/,
    ],
    // The runtime says rw but the kernel mounted it ro — or the reverse.
    [
      'a kernel mode the runtime did not report',
      makeAttachState({ kernelOptions: ['ro', 'nosuid', 'nodev'] }),
      /kernel mounted it read-only/,
    ],
    [
      'a kernel mount without the hardening',
      makeAttachState({ kernelOptions: ['rw', 'relatime'] }),
      /kernel mount missing nodev,nosuid/,
    ],
    [
      'the wrong mode at the runtime',
      makeAttachState({ ro: true }),
      /attached read-only/,
    ],
  ];
  for (const [label, state, message] of unproved) {
    t.throws(() => attestSlicePolicy(policy, state), { message }, label);
  }
  // The wrong host path at the runtime.
  t.throws(
    () =>
      attestSlicePolicy(
        policy,
        makeState({
          inspect: makeInspect(record => {
            record.Mounts.push({
              Type: 'bind',
              Source: '/home/operator',
              Destination: '/mnt/project',
              Options: ['nosuid', 'nodev', 'rw'],
              RW: true,
            });
          }),
          attachMounts: new Map([
            [
              '/mnt/project',
              harden({
                fstype: '9p',
                root: '/',
                options: harden(['rw', 'nosuid', 'nodev']),
              }),
            ],
          ]),
        }),
      ),
    { message: /\/home\/operator/ },
  );
});

test('an attach attests the hardening the kernel shows, not the one the runtime claims', t => {
  const policy = assertSlicePolicyRequest(makeAttachRequest());
  // `noexec` is attested but required nowhere, so it is exactly the control
  // a runtime could assert unilaterally. The record must follow the kernel:
  // a runtime that claims noexec over a mount the kernel will execute from
  // would otherwise have its claim attested as fact.
  const attestation = attestSlicePolicy(
    policy,
    makeAttachState({
      runtimeOptions: ['nosuid', 'nodev', 'noexec', 'rprivate', 'rw', 'rbind'],
      kernelOptions: ['rw', 'nosuid', 'nodev', 'relatime'],
    }),
  );
  const attach = attestation.mounts.find(mount => mount.role === 'attach-a1');
  t.deepEqual(attach?.options, ['nodev', 'nosuid']);
  t.false(attach?.options.includes('noexec'));
});
