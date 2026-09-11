// @ts-check

/**
 * Driver-level policy enforcement.
 *
 * These drive `makePodmanDriver` against a stubbed container engine and
 * captured `procfs` text, so the parts that decide whether a slice may
 * exist at all — the anchor's create argv, the digest check, the
 * fail-closed paths, and the guarantee that every later spawn runs
 * under the attested prefix — are exercised without a podman host.
 * `test/podman.test.js` covers the same ground against a real engine
 * when one is present.
 */

import test from '@endo/ses-ava/prepare-endo.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { makePodmanDriver } from '../src/drivers/podman.js';

const DIGEST = `sha256:${'a1'.repeat(32)}`;
const OTHER_DIGEST = `sha256:${'b2'.repeat(32)}`;
const IMAGE = `registry.example/agent@${DIGEST}`;
const ANCHOR_PID = 4242;
const GIB = 1024n * 1024n * 1024n;
const MIB = 1024n * 1024n;
const SIDECAR_PID = 4141;

const POLICY = harden({
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
});

/** @param {Record<string, unknown>} [overrides] */
const makeSpec = (overrides = {}) =>
  harden({
    rootfs: harden({ kind: 'oci', ref: IMAGE }),
    mounts: harden([]),
    scratchHostPath: '',
    network: 'broker-only',
    seccomp: 'default',
    env: harden({}),
    cwd: '/workspace',
    policy: POLICY,
    ...overrides,
  });

const ANCHOR_INSPECT = harden({
  ImageDigest: DIGEST,
  State: { Running: true, Pid: ANCHOR_PID },
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
    Ulimits: [
      { Name: 'RLIMIT_NOFILE', Soft: 4096, Hard: 4096 },
      { Name: 'RLIMIT_CORE', Soft: 0, Hard: 0 },
    ],
    Tmpfs: {
      '/tmp': 'rw,nosuid,nodev,size=2147483648,uid=1000,gid=1000,mode=0700',
      '/run': 'rw,nosuid,nodev,size=1073741824,uid=1000,gid=1000,mode=0700',
      '/scratch': 'rw,nosuid,nodev,size=1073741824,uid=1000,gid=1000,mode=0700',
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
});

const PROC_FILES = harden({
  '/proc/self/cgroup': '0::/user.slice/user-1000.slice\n',
  '/sys/fs/cgroup/user.slice/user-1000.slice/cgroup.controllers':
    'cpu io memory pids\n',
  [`/proc/${ANCHOR_PID}/net/dev`]:
    'Inter-|   Receive |  Transmit\n face |bytes\n    lo:  0 0 0 0\n',
  [`/proc/${ANCHOR_PID}/net/route`]: 'Iface\tDestination\tGateway\n',
  [`/proc/${ANCHOR_PID}/net/ipv6_route`]:
    '00000000000000000000000000000001 80 00000000000000000000000000000000 00 00000000000000000000000000000000 00000000 00000001 00000001 80200001 lo\n',
  [`/proc/${ANCHOR_PID}/status`]:
    'Uid:\t101000\t101000\t101000\t101000\nGid:\t101000\t101000\t101000\t101000\nNoNewPrivs:\t1\nSeccomp:\t2\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\n',
  // The broker's own namespace, which the anchor must have joined.
  [`/proc/${SIDECAR_PID}/net/dev`]:
    'Inter-|   Receive |  Transmit\n face |bytes\n    lo:  0 0 0 0\n',
  [`/proc/${SIDECAR_PID}/net/route`]: 'Iface\tDestination\tGateway\n',
  [`/proc/${SIDECAR_PID}/net/ipv6_route`]: '',
  [`/proc/${ANCHOR_PID}/uid_map`]: '         0     100000      65536\n',
  [`/proc/${ANCHOR_PID}/gid_map`]: '         0     100000      65536\n',
});

const PROC_LINKS = harden({
  '/proc/self/ns/user': 'user:[4026531837]',
  '/proc/self/ns/pid': 'pid:[4026531836]',
  '/proc/self/ns/ipc': 'ipc:[4026531839]',
  '/proc/self/ns/mnt': 'mnt:[4026531840]',
  [`/proc/${ANCHOR_PID}/ns/user`]: 'user:[4026532100]',
  [`/proc/${ANCHOR_PID}/ns/pid`]: 'pid:[4026532101]',
  [`/proc/${ANCHOR_PID}/ns/ipc`]: 'ipc:[4026532102]',
  [`/proc/${ANCHOR_PID}/ns/mnt`]: 'mnt:[4026532103]',
  [`/proc/${ANCHOR_PID}/ns/net`]: 'net:[4026532567]',
  [`/proc/${SIDECAR_PID}/ns/net`]: 'net:[4026532567]',
});

/**
 * @param {Record<string, string>} [fileOverrides]
 * @param {Record<string, string>} [linkOverrides]
 */
const makeProcfs = (fileOverrides = {}, linkOverrides = {}) => {
  const files = { ...PROC_FILES, ...fileOverrides };
  const links = { ...PROC_LINKS, ...linkOverrides };
  return harden({
    /** @param {string} path */
    readFile: async path => {
      await null;
      const body = files[path];
      if (body === undefined) throw new Error(`ENOENT ${path}`);
      return body;
    },
    /** @param {string} path */
    readLink: async path => {
      await null;
      const target = links[path];
      if (target === undefined) throw new Error(`ENOENT ${path}`);
      return target;
    },
    /** @param {string} path */
    readInode: async path => {
      await null;
      throw new Error(`ENOENT ${path}`);
    },
  });
};

/**
 * A container engine that answers every control command this driver
 * issues. `responses` replaces one answer so a test can name the single
 * thing the host did differently.
 *
 * `holdAttached` leaves the attached `start` child running, so an
 * operation stays live the way a long-running command does — which is
 * what a concurrency ceiling is about.
 *
 * @param {{ calls: Array<{ command: string, args: string[] }>, responses?: Record<string, { code?: number, stdout?: string }>, holdAttached?: boolean }} options
 */
const makeEngineStub = ({ calls, responses = {}, holdAttached = false }) => {
  /**
   * @param {string[]} args
   * @returns {string}
   */
  const classify = args => {
    if (args.includes('--version')) return 'version';
    if (args.includes('{{.Host.Security.Rootless}}')) return 'rootless';
    if (args.includes('{{.Host.OCIRuntime.Name}}')) return 'runtime';
    if (args[0] === 'ps') return 'ps';
    if (args[0] === 'image' && args[1] === 'exists') return 'image-exists';
    if (args.includes('{{json .Config.Env}}')) return 'image-env';
    if (args.includes('{{.Digest}}')) return 'image-digest';
    if (args[0] === 'volume') return `volume-${args[args.length - 1]}`;
    if (args[0] === 'container' && args[1] === 'inspect') {
      if (args.includes('{{.State.Pid}}')) return 'sidecar-pid';
      if (args.includes('{{.Id}}')) return 'container-id';
      return 'container-inspect';
    }
    if (args[0] === 'create') return 'create';
    if (args[0] === 'start') return 'start';
    if (args[0] === 'rm') return 'rm';
    if (args[0] === 'kill') return 'kill';
    if (args[0] === 'exec') return 'resolver-read';
    return 'other';
  };

  /** @type {Record<string, { code?: number, stdout?: string }>} */
  const defaults = {
    version: { stdout: 'podman version 5.8.0\n' },
    rootless: { stdout: 'true\n' },
    runtime: { stdout: 'crun\n' },
    ps: { stdout: '' },
    'image-exists': {},
    'image-env': { stdout: '["PATH=/usr/local/bin:/usr/bin:/bin"]\n' },
    'image-digest': { stdout: `${DIGEST}\n` },
    'volume-workspace-s1': {
      stdout:
        '{"Mountpoint":"/volumes/workspace-s1/_data","Options":{"size":"8GiB"}}\n',
    },
    'volume-codex-state-s1': {
      stdout:
        '{"Mountpoint":"/volumes/codex-state-s1/_data","Options":{"o":"size=4GiB"}}\n',
    },
    'container-inspect': { stdout: `${JSON.stringify([ANCHOR_INSPECT])}\n` },
    'sidecar-pid': { stdout: `${SIDECAR_PID}\n` },
    'container-id': { stdout: 'a1b2c3d4e5f6a7b8\n' },
    create: {},
    start: {},
    rm: {},
    kill: {},
    other: { code: 1 },
  };

  return {
    /**
     * @param {string} command
     * @param {string[]} args
     */
    spawn(command, args) {
      calls.push({ command, args: [...args] });
      const kind = command === 'podman' ? classify(args) : 'other';
      const answer = responses[kind] ?? defaults[kind] ?? { code: 1 };
      const child = new EventEmitter();
      const stdoutStream = new PassThrough();
      const stderrStream = new PassThrough();
      Object.assign(child, {
        pid: 1234,
        stdout: stdoutStream,
        stderr: stderrStream,
        stdin: new PassThrough(),
      });
      const attached = kind === 'start' && args.includes('--attach');
      void Promise.resolve().then(() => {
        stdoutStream.end(answer.stdout ?? '');
        stderrStream.end();
        if (attached && holdAttached) return;
        // Control commands settle on 'close'; an attached `start` child
        // is awaited on 'exit'.
        child.emit('exit', answer.code ?? 0, null);
        child.emit('close', answer.code ?? 0, null);
      });
      return child;
    },
  };
};

/**
 * @param {{ responses?: Record<string, { code?: number, stdout?: string }>, procfs?: any, holdAttached?: boolean, volumeQuota?: any }} [options]
 */
const makeDriverUnderTest = (options = {}) => {
  /** @type {Array<{ command: string, args: string[] }>} */
  const calls = [];
  const driver = makePodmanDriver({
    childProcess: /** @type {any} */ (
      makeEngineStub({
        calls,
        responses: options.responses,
        holdAttached: options.holdAttached,
      })
    ),
    env: {},
    ownerId: 'formula-policy-owner',
    procfs: options.procfs ?? makeProcfs(),
    volumeQuota: Object.hasOwn(options, 'volumeQuota')
      ? options.volumeQuota
      : harden({
          observe: async ({ name, mountpoint }) =>
            harden({
              version: 'VolumeQuotaEvidenceV1',
              name,
              mountpoint,
              device: '12',
              inode: name === 'workspace-s1' ? '11' : '12',
              projectId: name === 'workspace-s1' ? 11 : 12,
              hardBytes: name === 'workspace-s1' ? 8n * GIB : 4n * GIB,
              enforced: true,
              projectInherited: true,
            }),
        }),
  });
  return { driver, calls };
};

for (const contents of [
  'nameserver 127.0.0.53\noptions attempts:1 timeout:2\n',
  'unexpected resolver\n',
]) {
  test(`resolver attestation reads the bounded effective container file: ${contents.startsWith('nameserver') ? 'accepted' : 'denied'}`, async t => {
    const resolver = harden({
      role: 'resolver',
      kind: 'resolver',
      source: '/private/provider/public-resolv.conf',
      destination: '/etc/resolv.conf',
      mode: 'ro',
    });
    const spec = makeSpec({
      policy: { ...POLICY, mounts: [...POLICY.mounts, resolver] },
    });
    const inspect = {
      ...ANCHOR_INSPECT,
      Mounts: [
        ...ANCHOR_INSPECT.Mounts,
        {
          Type: 'bind',
          Source: resolver.source,
          Destination: resolver.destination,
          Options: ['ro', 'nodev', 'nosuid'],
          RW: false,
        },
      ],
    };
    const { driver, calls } = makeDriverUnderTest({
      responses: {
        'container-inspect': { stdout: JSON.stringify([inspect]) },
        'resolver-read': { stdout: contents },
      },
      procfs: makeProcfs({
        [`/proc/${ANCHOR_PID}/mountinfo`]:
          '37 24 8:1 /public-resolv.conf /etc/resolv.conf ro,nosuid,nodev - ext4 /dev/sda1 rw\n',
      }),
    });
    if (contents.startsWith('nameserver')) {
      const slice = await driver.prepareSlice(/** @type {any} */ (spec));
      t.teardown(() => driver.teardown(slice));
    } else {
      await t.throwsAsync(driver.prepareSlice(/** @type {any} */ (spec)), {
        message: /resolver mount/,
      });
    }
    const read = calls.find(call => call.args[0] === 'exec');
    t.deepEqual(read?.args.slice(-4), [
      '/bin/head',
      '-c',
      '1025',
      '/etc/resolv.conf',
    ]);
    t.false(calls.some(call => call.args.includes(resolver.source)));
  });
}

/** @param {Array<{ command: string, args: string[] }>} calls */
const createCalls = calls => calls.filter(call => call.args[0] === 'create');

test('a policy slice is attested from the live anchor', async t => {
  const { driver, calls } = makeDriverUnderTest();
  const slice = await driver.prepareSlice(/** @type {any} */ (makeSpec()));
  const attestation = await /** @type {any} */ (driver).policy(slice);

  t.is(attestation.version, 'SlicePolicyAttestationV1');
  t.is(attestation.backend, 'rootless-podman');
  t.is(attestation.network, 'broker-only');
  t.is(attestation.networkNamespaceId, 'net-4026532567');
  t.is(attestation.imageDigest, DIGEST);
  t.is(attestation.uid, 1000);
  t.is(attestation.gid, 1000);
  t.deepEqual(
    attestation.mounts.map((/** @type {any} */ mount) => mount.destination),
    ['/workspace', '/codex-home', '/tmp', '/run', '/scratch'],
  );

  // The anchor really was started and inspected: the attestation is a
  // reading of a live container, not of the flags it was created with.
  t.true(calls.some(call => call.args[0] === 'start'));
  t.true(
    calls.some(
      call => call.args[0] === 'container' && call.args[1] === 'inspect',
    ),
  );
});

test('the anchor is created under the whole policy prefix', async t => {
  const { driver, calls } = makeDriverUnderTest();
  await driver.prepareSlice(/** @type {any} */ (makeSpec()));
  const [anchor] = createCalls(calls);
  t.truthy(anchor);
  const argv = anchor.args;

  /**
   * @param {string} flag
   * @returns {string[]}
   */
  const valuesOf = flag =>
    argv.flatMap((arg, index) => (arg === flag ? [argv[index + 1]] : []));

  t.deepEqual(valuesOf('--user'), ['1000:1000']);
  t.deepEqual(valuesOf('--pid'), ['private']);
  // Deliberately absent: see `assemblePolicyArgv`. The user namespace
  // is proved from the kernel, not asked for with a flag a rootless
  // engine cannot satisfy.
  t.deepEqual(valuesOf('--userns'), []);
  t.deepEqual(valuesOf('--ipc'), ['private']);
  t.deepEqual(valuesOf('--cap-drop'), ['ALL']);
  t.deepEqual(valuesOf('--network'), ['container:broker-sidecar-s1']);
  t.deepEqual(valuesOf('--memory'), ['4294967296']);
  t.deepEqual(valuesOf('--memory-swap'), ['4294967296']);
  t.deepEqual(valuesOf('--pids-limit'), ['512']);
  t.deepEqual(valuesOf('--cpus'), ['4']);
  t.deepEqual(valuesOf('--ulimit'), ['nofile=4096:4096', 'core=0:0']);
  t.deepEqual(valuesOf('--shm-size'), ['67108864']);
  t.true(argv.includes('--read-only'));
  t.true(argv.includes('--read-only-tmpfs=false'));
  t.deepEqual(valuesOf('--security-opt'), ['no-new-privileges']);
  t.deepEqual(valuesOf('--volume'), [
    'workspace-s1:/workspace:rw,nosuid,nodev',
    'codex-state-s1:/codex-home:rw,nosuid,nodev',
  ]);
  t.deepEqual(valuesOf('--mount'), [
    'type=tmpfs,destination=/tmp,rw,nosuid,nodev,tmpfs-size=2147483648,tmpfs-mode=0700,U=true,notmpcopyup',
    'type=tmpfs,destination=/run,rw,nosuid,nodev,tmpfs-size=1073741824,tmpfs-mode=0700,U=true,notmpcopyup',
    'type=tmpfs,destination=/scratch,rw,nosuid,nodev,tmpfs-size=1073741824,tmpfs-mode=0700,U=true,notmpcopyup',
  ]);
  // The anchor runs the argv the caller named from the pinned image.
  t.deepEqual(argv.slice(-3), [IMAGE, '/bin/sleep', 'infinity']);
});

test('an operation runs under the same prefix the anchor was attested at', async t => {
  const { driver, calls } = makeDriverUnderTest();
  const slice = await driver.prepareSlice(/** @type {any} */ (makeSpec()));
  await driver.spawn(slice, ['/bin/echo', 'hi'], {});

  const [anchor, operation] = createCalls(calls);
  t.truthy(operation);
  /** @param {string[]} argv */
  const policyPortion = argv => {
    // Everything from the first policy flag to the image reference is
    // the configuration the attestation stands for; the labels and name
    // before it and the argv after it are per-operation.
    const start = argv.indexOf('--user');
    const end = argv.lastIndexOf(IMAGE);
    return argv.slice(start, end).filter(arg => !arg.startsWith('-e'));
  };
  t.deepEqual(policyPortion(operation.args), policyPortion(anchor.args));
  t.deepEqual(operation.args.slice(-3), [IMAGE, '/bin/echo', 'hi']);
});

test('a slice with no policy has no attestation to report', async t => {
  const { driver } = makeDriverUnderTest();
  const slice = await driver.prepareSlice(
    /** @type {any} */ (
      makeSpec({ network: 'none', policy: undefined, cwd: undefined })
    ),
  );
  await t.throwsAsync(/** @type {any} */ (driver).policy(slice), {
    message: /was not created under a policy/,
  });
});

test('broker-only without a policy names the namespace nobody supplied', async t => {
  const { driver } = makeDriverUnderTest();
  await t.throwsAsync(
    driver.prepareSlice(/** @type {any} */ (makeSpec({ policy: undefined }))),
    { message: /must be requested together/ },
  );
});

test('a policy on any other network profile is refused', async t => {
  const { driver } = makeDriverUnderTest();
  await t.throwsAsync(
    driver.prepareSlice(/** @type {any} */ (makeSpec({ network: 'private' }))),
    { message: /must be requested together/ },
  );
});

const makeJoinSpec = (overrides = {}) =>
  makeSpec({
    network: 'join',
    networkRef: 'broker-sidecar-s1',
    policy: undefined,
    cwd: undefined,
    ...overrides,
  });

test('network join admits a loopback-only target and wires --network container:', async t => {
  const { driver, calls } = makeDriverUnderTest();
  const slice = await driver.prepareSlice(/** @type {any} */ (makeJoinSpec()));
  await driver.spawn(slice, ['/bin/echo', 'hi'], {});
  const [operation] = createCalls(calls);
  t.truthy(operation);
  const argv = operation.args;
  const network = argv.flatMap((arg, index) =>
    arg === '--network' ? [argv[index + 1]] : [],
  );
  // The immutable id, not the caller's name: the name cannot be swapped
  // between the namespace check and podman resolving the reference.
  t.deepEqual(network, ['container:a1b2c3d4e5f6a7b8']);
  t.is(
    slice.runtimeDetails.rootlessNet.reason,
    'network join shares the named container namespace',
  );
});

for (const [label, fileOverrides, message] of [
  [
    'a target exposing a non-loopback interface is refused',
    {
      [`/proc/${SIDECAR_PID}/net/dev`]:
        'Inter-|   Receive |  Transmit\n face |bytes\n    lo:  0 0 0 0\n  eth0: 0 0 0 0\n',
    },
    /must expose only loopback/,
  ],
  [
    'a target with a routable route is refused',
    {
      [`/proc/${SIDECAR_PID}/net/route`]:
        'Iface\tDestination\tGateway\tFlags\neth0\t00000000\t0100000A\t0003\n',
    },
    /must not have routable routes/,
  ],
]) {
  test(label, async t => {
    const { driver } = makeDriverUnderTest({
      procfs: makeProcfs(fileOverrides),
    });
    await t.throwsAsync(
      driver.prepareSlice(/** @type {any} */ (makeJoinSpec())),
      { message },
    );
  });
}

test('network join refuses an absent or misused container reference', async t => {
  const { driver, calls } = makeDriverUnderTest();
  await t.throwsAsync(
    driver.prepareSlice(
      /** @type {any} */ (makeJoinSpec({ networkRef: undefined })),
    ),
    { message: /requires a networkRef container/ },
  );
  t.is(calls.length, 0, 'rejected before the engine is touched');
  await t.throwsAsync(
    driver.prepareSlice(
      /** @type {any} */ (makeSpec({ network: 'none', networkRef: 'x' })),
    ),
    { message: /no other profile accepts one/ },
  );
  await t.throwsAsync(
    driver.prepareSlice(
      /** @type {any} */ (makeSpec({ network: 'join', networkRef: 'x' })),
    ),
    { message: /cannot be combined with a slice policy/ },
  );
});

test('network join refuses a target that is not running', async t => {
  const { driver } = makeDriverUnderTest({
    responses: { 'sidecar-pid': { code: 1, stdout: '' } },
  });
  await t.throwsAsync(
    driver.prepareSlice(/** @type {any} */ (makeJoinSpec())),
    { message: /is not a running container/ },
  );
});

test('network join refuses a target replaced after admission', async t => {
  const otherPid = 4143;
  const responses = { 'sidecar-pid': { stdout: `${SIDECAR_PID}\n` } };
  const { driver } = makeDriverUnderTest({
    responses,
    procfs: makeProcfs(
      {
        [`/proc/${otherPid}/net/dev`]:
          'Inter-|   Receive |  Transmit\n face |bytes\n    lo:  0 0 0 0\n',
        [`/proc/${otherPid}/net/route`]: 'Iface\tDestination\tGateway\n',
        [`/proc/${otherPid}/net/ipv6_route`]: '',
      },
      { [`/proc/${otherPid}/ns/net`]: 'net:[4026539999]' },
    ),
  });
  const slice = await driver.prepareSlice(/** @type {any} */ (makeJoinSpec()));
  responses['sidecar-pid'] = { stdout: `${otherPid}\n` };
  await t.throwsAsync(driver.spawn(slice, ['/bin/echo', 'hi'], {}), {
    message: /was replaced after the slice was admitted/,
  });
});

test('a policy refuses a granted mount alongside its own table', async t => {
  const { driver } = makeDriverUnderTest();
  await t.throwsAsync(
    driver.prepareSlice(
      /** @type {any} */ (
        makeSpec({
          mounts: harden([
            harden({
              hostPath: '/home/operator/data',
              innerPath: '/data',
              mode: 'ro',
            }),
          ]),
        })
      ),
    ),
    { message: /declares the whole mount table/ },
  );
});

test('a policy refuses a scratch layer alongside its own table', async t => {
  const { driver } = makeDriverUnderTest();
  await t.throwsAsync(
    driver.prepareSlice(
      /** @type {any} */ (makeSpec({ scratchHostPath: '/tmp/scratch-xyz' })),
    ),
    { message: /declares the whole mount table/ },
  );
});

test('a policy refuses a seccomp profile it cannot stand behind', async t => {
  const { driver } = makeDriverUnderTest();
  await t.throwsAsync(
    driver.prepareSlice(
      /** @type {any} */ (makeSpec({ seccomp: 'unconfined' })),
    ),
    { message: /default seccomp profile/ },
  );
});

test('an image whose stored digest is not the approved one fails closed', async t => {
  const { driver, calls } = makeDriverUnderTest({
    responses: { 'image-digest': { stdout: `${OTHER_DIGEST}\n` } },
  });
  await t.throwsAsync(driver.prepareSlice(/** @type {any} */ (makeSpec())), {
    message: /is not the digest podman resolved/,
  });
  // Nothing was created: the check happens before the anchor exists.
  t.deepEqual(createCalls(calls), []);
});

test('an anchor that never started leaves nothing behind', async t => {
  const { driver, calls } = makeDriverUnderTest({
    responses: { start: { code: 125, stdout: 'no such container' } },
  });
  await t.throwsAsync(driver.prepareSlice(/** @type {any} */ (makeSpec())), {
    message: /policy anchor start failed/,
  });
  const anchorName = createCalls(calls)[0].args[2];
  t.true(
    calls.some(call => call.args[0] === 'rm' && call.args.includes(anchorName)),
    'the anchor this failure minted is removed',
  );
});

test('an unproved control fails slice construction, not just the report', async t => {
  const { driver, calls } = makeDriverUnderTest({
    // A namespace the slice shares with the daemon: the runtime still
    // echoes `--pid private`, only the kernel disagrees.
    procfs: makeProcfs(
      {},
      { [`/proc/${ANCHOR_PID}/ns/pid`]: 'pid:[4026531836]' },
    ),
  });
  await t.throwsAsync(driver.prepareSlice(/** @type {any} */ (makeSpec())), {
    message: /pid namespace/,
  });
  const anchorName = createCalls(calls)[0].args[2];
  t.true(
    calls.some(call => call.args[0] === 'rm' && call.args.includes(anchorName)),
  );
});

test('a routable interface in the joined namespace fails construction', async t => {
  const { driver } = makeDriverUnderTest({
    procfs: makeProcfs({
      [`/proc/${ANCHOR_PID}/net/dev`]:
        'Inter-|   Receive |  Transmit\n face |bytes\n    lo:  0 0\n  eth0:  0 0\n',
    }),
  });
  await t.throwsAsync(driver.prepareSlice(/** @type {any} */ (makeSpec())), {
    message: /broker-only network/,
  });
});

test('a volume with no recorded quota fails construction', async t => {
  const { driver } = makeDriverUnderTest({
    responses: { 'volume-workspace-s1': { code: 125 } },
  });
  await t.throwsAsync(driver.prepareSlice(/** @type {any} */ (makeSpec())), {
    message: /mount workspace storage ceiling/,
  });
});

test('a host that cannot delegate the controllers fails construction', async t => {
  const { driver } = makeDriverUnderTest({
    procfs: makeProcfs({
      '/sys/fs/cgroup/user.slice/user-1000.slice/cgroup.controllers': 'io\n',
    }),
  });
  await t.throwsAsync(driver.prepareSlice(/** @type {any} */ (makeSpec())), {
    message: /cgroup delegation/,
  });
});

test('teardown removes the anchor along with the operations', async t => {
  const { driver, calls } = makeDriverUnderTest();
  const slice = await driver.prepareSlice(/** @type {any} */ (makeSpec()));
  const anchorName = createCalls(calls)[0].args[2];
  await driver.teardown(slice);
  t.true(
    calls.some(call => call.args[0] === 'rm' && call.args.includes(anchorName)),
  );
});

test('a slice whose kernel loaded no seccomp filter fails construction', async t => {
  const { driver } = makeDriverUnderTest({
    // The engine still reports its default profile in `SecurityOpt`;
    // only the kernel says whether a filter is actually loaded.
    procfs: makeProcfs({
      [`/proc/${ANCHOR_PID}/status`]:
        'Uid:\t101000\t101000\t101000\t101000\nGid:\t101000\t101000\t101000\t101000\nNoNewPrivs:\t1\nSeccomp:\t0\nCapEff:\t0000000000000000\n',
    }),
  });
  await t.throwsAsync(driver.prepareSlice(/** @type {any} */ (makeSpec())), {
    message: /seccomp/,
  });
});

test('a slice that joined some namespace other than the broker fails', async t => {
  const { driver } = makeDriverUnderTest({
    // The anchor is loopback-only and well-formed — it is simply not in
    // the namespace the broker's listener is in. Nothing about the
    // interface inventory distinguishes the two.
    procfs: makeProcfs(
      {},
      { [`/proc/${SIDECAR_PID}/ns/net`]: 'net:[4026539999]' },
    ),
  });
  await t.throwsAsync(driver.prepareSlice(/** @type {any} */ (makeSpec())), {
    message: /broker namespace identity/,
  });
});

test('a broker sidecar that is not running fails construction', async t => {
  const { driver, calls } = makeDriverUnderTest({
    responses: { 'sidecar-pid': { code: 125, stdout: 'no such container' } },
  });
  await t.throwsAsync(driver.prepareSlice(/** @type {any} */ (makeSpec())), {
    message: /broker sidecar .* is not a running container/,
  });
  // The anchor this attempt minted does not outlive it.
  const anchor = createCalls(calls)[0];
  if (anchor !== undefined) {
    t.true(
      calls.some(
        call => call.args[0] === 'rm' && call.args.includes(anchor.args[2]),
      ),
    );
  } else {
    t.pass('the sidecar was resolved before any anchor existed');
  }
});

test('a rootful engine fails construction even without the probe gate', async t => {
  const { driver } = makeDriverUnderTest({
    // `prepareSlice` is a public entry point; a consumer that skips the
    // factory's probe must not get an attestation stamped
    // `rootless-podman` with nothing having checked.
    responses: { rootless: { stdout: 'false\n' } },
  });
  await t.throwsAsync(driver.prepareSlice(/** @type {any} */ (makeSpec())), {
    message: /rootless backend/,
  });
});

test('the orphan sweep runs before the anchor it is evidence about', async t => {
  // The sweep removes every container carrying this driver's exact
  // owner label. Run after the anchor is created it would take the
  // anchor — and any sibling slice's live operations — as orphans, and
  // then attest a container that no longer exists.
  const { driver, calls } = makeDriverUnderTest();
  await driver.prepareSlice(/** @type {any} */ (makeSpec()));
  const sweepAt = calls.findIndex(call => call.args[0] === 'ps');
  const createAt = calls.findIndex(call => call.args[0] === 'create');
  t.true(sweepAt >= 0, 'the sweep ran');
  t.true(createAt >= 0, 'the anchor was created');
  t.true(sweepAt < createAt, 'the sweep ran first');
});

test('attested anchor and operation preserve stdin at create and attach', async t => {
  const { driver, calls } = makeDriverUnderTest();
  const slice = await driver.prepareSlice(/** @type {any} */ (makeSpec()));
  t.teardown(() => driver.teardown(slice));
  const proc = await driver.spawn(slice, ['/bin/cat'], {});
  await proc.wait();
  const created = createCalls(calls);
  t.is(created.length, 2);
  for (const call of created) t.true(call.args.includes('--interactive'));
  const attach = calls.find(
    call => call.args[0] === 'start' && call.args.includes('--attach'),
  );
  t.true(attach?.args.includes('--interactive'));
});

test('an operation the engine resolved differently is refused', async t => {
  let inspectCount = 0;
  const { driver } = makeDriverUnderTest({
    responses: {
      'container-inspect': {
        get stdout() {
          inspectCount += 1;
          // The anchor is inspected before start and twice around procfs
          // reads; the operation's inspect is the fourth, and this host
          // has quietly stopped applying the pid ceiling by then.
          const record =
            inspectCount >= 4
              ? {
                  ...ANCHOR_INSPECT,
                  HostConfig: { ...ANCHOR_INSPECT.HostConfig, PidsLimit: 0 },
                }
              : ANCHOR_INSPECT;
          return `${JSON.stringify([record])}\n`;
        },
      },
    },
  });
  const slice = await driver.prepareSlice(/** @type {any} */ (makeSpec()));
  await t.throwsAsync(driver.spawn(slice, ['/bin/echo', 'hi'], {}), {
    message: /resolved this operation's configuration differently/,
  });
});

test('a slice admits only the operations its policy declared', async t => {
  const { driver } = makeDriverUnderTest({ holdAttached: true });
  const slice = await driver.prepareSlice(/** @type {any} */ (makeSpec()));
  // Every ceiling is applied per container, so the attested slice-wide
  // aggregate is only true while the live count is the one it was
  // computed for.
  await driver.spawn(slice, ['/bin/sleep', '60'], {});
  await t.throwsAsync(driver.spawn(slice, ['/bin/sleep', '60'], {}), {
    message: /admits 1 concurrent operations/,
  });
});

test('an anchor that stopped while it was read is not attested', async t => {
  let inspectCount = 0;
  const { driver } = makeDriverUnderTest({
    responses: {
      'container-inspect': {
        get stdout() {
          inspectCount += 1;
          // The third inspect is the re-check after the procfs reads:
          // an `attestationArgv` that did not in fact block has exited,
          // and the kernel may have handed that pid to someone else.
          const record =
            inspectCount >= 3
              ? { ...ANCHOR_INSPECT, State: { Running: false, Pid: 0 } }
              : ANCHOR_INSPECT;
          return `${JSON.stringify([record])}\n`;
        },
      },
    },
  });
  await t.throwsAsync(driver.prepareSlice(/** @type {any} */ (makeSpec())), {
    message: /did not stay running while it was read/,
  });
});

test('two slices cannot both attest a namespace they share', async t => {
  const { driver } = makeDriverUnderTest();
  await driver.prepareSlice(/** @type {any} */ (makeSpec()));
  // The stub hands every anchor the same namespace inodes. "Not the
  // daemon's" is what procfs answers; "nobody else's" takes comparing
  // against the slices already in play.
  await t.throwsAsync(driver.prepareSlice(/** @type {any} */ (makeSpec())), {
    message: /already held by another live slice/,
  });
});

test('concurrent spawns cannot both slip past the operation ceiling', async t => {
  const { driver } = makeDriverUnderTest({ holdAttached: true });
  const slice = await driver.prepareSlice(/** @type {any} */ (makeSpec()));
  // Reading the live count and registering the entry are many awaits
  // apart. Without a synchronous reservation both of these observe an
  // empty slice, both are admitted, and the slice runs one container
  // more than every per-container ceiling was computed for.
  const results = await Promise.allSettled([
    driver.spawn(slice, ['/bin/sleep', '60'], {}),
    driver.spawn(slice, ['/bin/sleep', '60'], {}),
  ]);
  t.is(results.filter(result => result.status === 'fulfilled').length, 1);
  const [rejected] = results.filter(result => result.status === 'rejected');
  t.regex(
    /** @type {any} */ (rejected).reason.message,
    /admits 1 concurrent operations/,
  );
});

test('a refused operation gives its reservation back', async t => {
  let inspectCount = 0;
  const { driver } = makeDriverUnderTest({
    responses: {
      'container-inspect': {
        get stdout() {
          inspectCount += 1;
          // Refuse the first operation only: the second must still be
          // admissible, which it is not if the first kept its slot.
          const record =
            inspectCount === 4
              ? {
                  ...ANCHOR_INSPECT,
                  HostConfig: { ...ANCHOR_INSPECT.HostConfig, PidsLimit: 0 },
                }
              : ANCHOR_INSPECT;
          return `${JSON.stringify([record])}\n`;
        },
      },
    },
  });
  const slice = await driver.prepareSlice(/** @type {any} */ (makeSpec()));
  await t.throwsAsync(driver.spawn(slice, ['/bin/echo', 'hi'], {}), {
    message: /resolved this operation's configuration differently/,
  });
  await t.notThrowsAsync(driver.spawn(slice, ['/bin/echo', 'hi'], {}));
});

test('an operation is refused when the host stopped delegating a controller', async t => {
  let controllerReads = 0;
  const procfs = makeProcfs();
  const narrowing = harden({
    ...procfs,
    /** @param {string} path */
    readFile: async path => {
      await null;
      if (path.endsWith('cgroup.controllers')) {
        controllerReads += 1;
        // Delegated when the slice was attested, narrowed afterwards.
        // The runtime still echoes every ceiling back, so the
        // fingerprint is identical and only this says otherwise.
        return controllerReads > 1 ? 'cpu io pids\n' : 'cpu io memory pids\n';
      }
      return procfs.readFile(path);
    },
  });
  const { driver } = makeDriverUnderTest({ procfs: narrowing });
  const slice = await driver.prepareSlice(/** @type {any} */ (makeSpec()));
  await t.throwsAsync(driver.spawn(slice, ['/bin/echo', 'hi'], {}), {
    message: /no longer delegates the cgroup controllers/,
  });
});

test('an anchor that will not go away is not a clean teardown', async t => {
  const { driver, calls } = makeDriverUnderTest({
    responses: {
      rm: { code: 125, stdout: 'container is in an unknown state' },
    },
  });
  const slice = await driver.prepareSlice(/** @type {any} */ (makeSpec()));
  t.truthy(createCalls(calls)[0]);
  // The anchor holds the slice's join to the broker's namespace, so a
  // removal that failed silently would let dispose() report proven
  // containment over a container still in it.
  await t.throwsAsync(driver.teardown(slice), {
    message: /policy anchor removal failed/,
  });
});

test('an image reference that podman would read as a flag is refused', async t => {
  const { driver, calls } = makeDriverUnderTest();
  // The reference is a positional argument, after every flag, so one
  // beginning with `-` becomes a flag and the next token becomes the
  // image — an argument injection into the command that establishes
  // the confinement, adding flags the attestation does not read back.
  await t.throwsAsync(
    driver.prepareSlice(
      /** @type {any} */ (
        makeSpec({
          rootfs: harden({
            kind: 'oci',
            ref: '--security-opt=unmask=ALL',
          }),
        })
      ),
    ),
    { message: /digest-pinned image reference/ },
  );
  t.deepEqual(createCalls(calls), [], 'nothing was created');
});

test('a tag-shaped image reference is refused under a policy', async t => {
  const { driver } = makeDriverUnderTest();
  await t.throwsAsync(
    driver.prepareSlice(
      /** @type {any} */ (
        makeSpec({
          rootfs: harden({ kind: 'oci', ref: 'docker.io/library/alpine:3.19' }),
        })
      ),
    ),
    { message: /digest-pinned image reference/ },
  );
});

test('a removal that never settles does not burn an admission slot', async t => {
  let removals = 0;
  const { driver } = makeDriverUnderTest({
    responses: {
      // A removal that reports failure rather than success. The reap
      // surfaces it, and `live.size` is what admission counts, so an
      // entry deleted only on the success path would burn a slot on an
      // otherwise healthy slice for as long as it lives.
      rm: {
        get code() {
          removals += 1;
          return removals === 1 ? 125 : 0;
        },
      },
    },
  });
  const slice = await driver.prepareSlice(/** @type {any} */ (makeSpec()));
  const proc = await driver.spawn(slice, ['/bin/echo', 'hi'], {});
  await proc.wait().catch(() => undefined);
  // The slot is back even though the reap reported a failure.
  await t.notThrowsAsync(driver.spawn(slice, ['/bin/echo', 'hi'], {}));
});

test('an unrelated controller losing delegation does not refuse an operation', async t => {
  let controllerReads = 0;
  const procfs = makeProcfs();
  const narrowing = harden({
    ...procfs,
    /** @param {string} path */
    readFile: async path => {
      await null;
      if (path.endsWith('cgroup.controllers')) {
        controllerReads += 1;
        // `io` goes away; no attested ceiling is applied through it.
        return controllerReads > 1
          ? 'cpu memory pids\n'
          : 'cpu io memory pids\n';
      }
      return procfs.readFile(path);
    },
  });
  const { driver } = makeDriverUnderTest({ procfs: narrowing });
  const slice = await driver.prepareSlice(/** @type {any} */ (makeSpec()));
  await t.notThrowsAsync(driver.spawn(slice, ['/bin/echo', 'hi'], {}));
});

test('a broker-only slice does not probe for a rootless network backend', async t => {
  const { driver, calls } = makeDriverUnderTest();
  await driver.prepareSlice(/** @type {any} */ (makeSpec()));
  // It joins the namespace the policy names and never consults one.
  t.false(calls.some(call => ['slirp4netns', 'pasta'].includes(call.command)));
});

test('recorded volume size cannot substitute for kernel quota evidence', async t => {
  const { driver } = makeDriverUnderTest({ volumeQuota: undefined });
  await t.throwsAsync(driver.prepareSlice(/** @type {any} */ (makeSpec())), {
    message: /storage ceiling/,
  });
});

test('quota evidence for a different physical volume fails construction', async t => {
  const { driver } = makeDriverUnderTest({
    volumeQuota: harden({
      observe: async ({ name }) =>
        harden({
          version: 'VolumeQuotaEvidenceV1',
          name,
          mountpoint: '/other/_data',
          device: '12',
          inode: '11',
          projectId: 11,
          hardBytes: 8n * GIB,
          enforced: true,
          projectInherited: true,
        }),
    }),
  });
  await t.throwsAsync(driver.prepareSlice(/** @type {any} */ (makeSpec())), {
    message: /storage ceiling/,
  });
});

// ---------------------------------------------------------------------------
// Runtime attaches (designs/runtime-container-fs-mount.md): the driver reads
// the anchor's own mount table to prove a declared bind is a 9P projection.
// ---------------------------------------------------------------------------

const ATTACH_SOURCE = '/host/mounts/claude-attach-a1';
const ATTACH_POLICY = harden({
  ...POLICY,
  mounts: harden([
    ...POLICY.mounts,
    harden({
      role: 'attach-a1',
      kind: 'attach',
      source: ATTACH_SOURCE,
      destination: '/mnt/project',
      mode: 'rw',
    }),
  ]),
});
const ATTACH_INSPECT = harden({
  ...ANCHOR_INSPECT,
  Mounts: harden([
    ...ANCHOR_INSPECT.Mounts,
    harden({
      Type: 'bind',
      Source: ATTACH_SOURCE,
      Destination: '/mnt/project',
      Options: harden(['nosuid', 'nodev', 'rprivate', 'rw', 'rbind']),
      RW: true,
    }),
  ]),
});
/** @param {string} fstype */
const anchorMountInfo = fstype => `\
28 1 0:24 / / rw,relatime - overlay overlay rw
101 28 0:47 / /workspace rw,nosuid,nodev,relatime - xfs /dev/mapper/ws rw,prjquota
102 28 0:48 / /codex-home rw,nosuid,nodev,relatime - xfs /dev/mapper/cs rw,prjquota
103 28 0:52 / /mnt/project rw,nosuid,nodev,relatime - ${fstype} endo-fs rw,trans=unix
`;

test('a declared attach is attested when the kernel sees a 9P projection there', async t => {
  const { driver, calls } = makeDriverUnderTest({
    responses: {
      'container-inspect': { stdout: `${JSON.stringify([ATTACH_INSPECT])}\n` },
    },
    procfs: makeProcfs({
      [`/proc/${ANCHOR_PID}/mountinfo`]: anchorMountInfo('9p'),
    }),
  });
  const slice = await driver.prepareSlice(
    /** @type {any} */ (makeSpec({ policy: ATTACH_POLICY })),
  );
  const attestation = await /** @type {any} */ (driver).policy(slice);
  t.deepEqual(attestation.mounts.at(-1), {
    role: 'attach-a1',
    source: `attach:${ATTACH_SOURCE}`,
    destination: '/mnt/project',
    mode: 'rw',
    options: ['nodev', 'nosuid'],
  });
  // The anchor was created under the bind, as one of the policy's own flags.
  const create = calls.find(call => call.args[0] === 'create');
  t.truthy(create);
  t.true(
    /** @type {any} */ (create).args.some((/** @type {string} */ arg) =>
      arg.startsWith(
        `type=bind,source=${ATTACH_SOURCE},destination=/mnt/project,rw,`,
      ),
    ),
  );
});

test('a declared attach that the kernel says is host data fails construction', async t => {
  // The runtime reports the same bind either way; only the kernel can say
  // the source was an ext4 directory rather than a 9P mount.
  const { driver } = makeDriverUnderTest({
    responses: {
      'container-inspect': { stdout: `${JSON.stringify([ATTACH_INSPECT])}\n` },
    },
    procfs: makeProcfs({
      [`/proc/${ANCHOR_PID}/mountinfo`]: anchorMountInfo('ext4'),
    }),
  });
  await t.throwsAsync(
    () =>
      driver.prepareSlice(
        /** @type {any} */ (makeSpec({ policy: ATTACH_POLICY })),
      ),
    { message: /ext4 rather than a 9p projection/ },
  );
});

test('a policy that declares no attach never reads the mount table', async t => {
  // Without an attach in the table, the proof needs nothing from
  // mountinfo — and a fixture that lacks it must not fail construction.
  const { driver } = makeDriverUnderTest();
  const slice = await driver.prepareSlice(/** @type {any} */ (makeSpec()));
  const attestation = await /** @type {any} */ (driver).policy(slice);
  t.is(attestation.mounts.length, 5);
});
