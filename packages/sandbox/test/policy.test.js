// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  assemblePolicyArgv,
  assertSlicePolicyRequest,
  attestSlicePolicy,
  brokerNetworkArg,
  parseByteSize,
  SLICE_POLICY_ATTESTATION_VERSION,
} from '../src/policy.js';

const DIGEST = `sha256:${'a1'.repeat(32)}`;
const OTHER_DIGEST = `sha256:${'b2'.repeat(32)}`;

const GIB = 1024n * 1024n * 1024n;

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
      writableBytes: 16n * GIB,
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
      PidsLimit: 512,
      CpuQuota: 400_000,
      CpuPeriod: 100_000,
      NanoCpus: 0,
      Ulimits: [
        { Name: 'RLIMIT_NOFILE', Soft: 4096, Hard: 4096 },
        { Name: 'RLIMIT_CORE', Soft: 0, Hard: 0 },
      ],
      Tmpfs: {
        '/tmp': 'rw,nosuid,nodev,size=2147483648',
        '/run': 'rw,nosuid,nodev,size=1073741824',
        '/scratch': 'rw,nosuid,nodev,size=1073741824',
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
 * Observed kernel state for a slice that actually got isolated.
 *
 * @param {Record<string, unknown>} [overrides]
 */
const makeState = (overrides = {}) =>
  harden({
    inspect: makeInspect(),
    rootless: true,
    unsharedNamespaces: harden({
      user: true,
      pid: true,
      ipc: true,
      mount: true,
    }),
    network: harden({
      namespaceId: 'net-4026532567',
      interfaces: harden(['lo']),
      routableRoutes: 0,
    }),
    processIdentity: harden({ uid: 1000, gid: 1000 }),
    volumeQuotas: new Map([
      ['workspace-s1', 8n * GIB],
      ['codex-state-s1', 4n * GIB],
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
    { message: /does not equal the sum of its writable mounts/ },
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
        resources: { ...request.resources, writableBytes: 17n * GIB },
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
      '--userns',
      'private',
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
      '--volume',
      'workspace-s1:/workspace:rw,nosuid,nodev',
      '--volume',
      'codex-state-s1:/codex-home:rw,nosuid,nodev',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=2147483648',
      '--tmpfs',
      '/run:rw,nosuid,nodev,size=1073741824',
      '--tmpfs',
      '/scratch:rw,nosuid,nodev,size=1073741824',
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
      writableBytes: 16n * GIB,
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
    {
      unsharedNamespaces: harden({
        user: true,
        pid: false,
        ipc: true,
        mount: true,
      }),
    },
    /pid namespace/,
  ],
  [
    'a shared user namespace',
    {
      unsharedNamespaces: harden({
        user: false,
        pid: true,
        ipc: true,
        mount: true,
      }),
    },
    /user namespace/,
  ],
  [
    'a routable interface in the joined namespace',
    {
      network: harden({
        namespaceId: 'net-4026532567',
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
        interfaces: harden(['lo']),
        routableRoutes: 2,
      }),
    },
    /broker-only network/,
  ],
  [
    'a process running as a different identity',
    { processIdentity: harden({ uid: 0, gid: 0 }) },
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
      inspect: makeInspect(record => {
        record.HostConfig.SecurityOpt = [];
      }),
    },
    /no-new-privileges/,
  ],
  [
    'seccomp switched off',
    {
      inspect: makeInspect(record => {
        record.HostConfig.SecurityOpt = [
          'no-new-privileges',
          'seccomp=unconfined',
        ];
      }),
    },
    /seccomp/,
  ],
  [
    'a capability the container kept',
    {
      inspect: makeInspect(record => {
        record.EffectiveCaps = ['CAP_NET_RAW'];
      }),
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
    /cgroup delegation/,
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
    { volumeQuotas: new Map([['codex-state-s1', 4n * GIB]]) },
    /mount workspace storage ceiling/,
  ],
  [
    'a volume whose quota is not the declared one',
    {
      volumeQuotas: new Map([
        ['workspace-s1', 64n * GIB],
        ['codex-state-s1', 4n * GIB],
      ]),
    },
    /mount workspace storage ceiling/,
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
