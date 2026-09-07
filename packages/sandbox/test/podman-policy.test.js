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
    PidsLimit: 512,
    CpuQuota: 400_000,
    CpuPeriod: 100_000,
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
    'Uid:\t101000\t101000\t101000\t101000\nGid:\t101000\t101000\t101000\t101000\nNoNewPrivs:\t1\nSeccomp:\t2\nCapEff:\t0000000000000000\n',
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
  });
};

/**
 * A container engine that answers every control command this driver
 * issues. `responses` replaces one answer so a test can name the single
 * thing the host did differently.
 *
 * @param {{ calls: Array<{ command: string, args: string[] }>, responses?: Record<string, { code?: number, stdout?: string }> }} options
 */
const makeEngineStub = ({ calls, responses = {} }) => {
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
      return 'container-inspect';
    }
    if (args[0] === 'create') return 'create';
    if (args[0] === 'start') return 'start';
    if (args[0] === 'rm') return 'rm';
    if (args[0] === 'kill') return 'kill';
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
    'volume-workspace-s1': { stdout: '{"Options":{"size":"8GiB"}}\n' },
    'volume-codex-state-s1': { stdout: '{"Options":{"o":"size=4GiB"}}\n' },
    'container-inspect': { stdout: `${JSON.stringify([ANCHOR_INSPECT])}\n` },
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
      void Promise.resolve().then(() => {
        stdoutStream.end(answer.stdout ?? '');
        stderrStream.end();
        child.emit('close', answer.code ?? 0, null);
      });
      return child;
    },
  };
};

/**
 * @param {{ responses?: Record<string, { code?: number, stdout?: string }>, procfs?: any }} [options]
 */
const makeDriverUnderTest = (options = {}) => {
  /** @type {Array<{ command: string, args: string[] }>} */
  const calls = [];
  const driver = makePodmanDriver({
    childProcess: /** @type {any} */ (
      makeEngineStub({ calls, responses: options.responses })
    ),
    env: {},
    ownerId: 'formula-policy-owner',
    procfs: options.procfs ?? makeProcfs(),
  });
  return { driver, calls };
};

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
  t.deepEqual(valuesOf('--userns'), ['private']);
  t.deepEqual(valuesOf('--pid'), ['private']);
  t.deepEqual(valuesOf('--ipc'), ['private']);
  t.deepEqual(valuesOf('--cap-drop'), ['ALL']);
  t.deepEqual(valuesOf('--network'), ['container:broker-sidecar-s1']);
  t.deepEqual(valuesOf('--memory'), ['4294967296']);
  t.deepEqual(valuesOf('--memory-swap'), ['4294967296']);
  t.deepEqual(valuesOf('--pids-limit'), ['512']);
  t.deepEqual(valuesOf('--cpus'), ['4']);
  t.deepEqual(valuesOf('--ulimit'), ['nofile=4096:4096', 'core=0:0']);
  t.true(argv.includes('--read-only'));
  t.true(argv.includes('--read-only-tmpfs=false'));
  t.deepEqual(valuesOf('--security-opt'), ['no-new-privileges']);
  t.deepEqual(valuesOf('--volume'), [
    'workspace-s1:/workspace:rw,nosuid,nodev',
    'codex-state-s1:/codex-home:rw,nosuid,nodev',
  ]);
  t.deepEqual(valuesOf('--tmpfs'), [
    '/tmp:rw,nosuid,nodev,size=2147483648',
    '/run:rw,nosuid,nodev,size=1073741824',
    '/scratch:rw,nosuid,nodev,size=1073741824',
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
