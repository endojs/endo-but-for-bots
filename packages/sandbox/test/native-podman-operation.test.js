// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { makePromiseKit } from '@endo/promise-kit';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { makePodmanDriver } from '../src/drivers/podman.js';
import { makeResourceRegistry } from '../src/resource-registry.js';

/** @import { ExecutionContext } from 'ava' */

const profile = harden({
  uid: 1000,
  gid: 1000,
  memoryBytes: 536_870_912n,
  pids: 128,
  cpuQuotaMicros: 200_000n,
  cpuPeriodMicros: 100_000,
  maxConcurrentOperations: 1,
});
const brokerId = 'b'.repeat(64);

/**
 * @typedef {object} ContainerRecord
 * @property {string} id
 * @property {string} name
 * @property {number} pid
 * @property {string[]} args
 * @property {number} inspections
 * @property {ReturnType<typeof spawn>} [child]
 */

// Podman and Linux observations are controlled fixtures. Only the attached
// shell gate and workload process are real; this is not native containment proof.
/** @param {ExecutionContext} t */
const fixture = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'native-operation-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  /** @type {Set<ReturnType<typeof spawn>>} */
  const children = new Set();
  /** @type {Array<Promise<unknown>>} */
  const closures = [];
  /** @type {Map<string, ContainerRecord>} */
  const containers = new Map();
  const slices = [];
  const reads = [];
  const calls = [];
  let sequence = 0;
  let defect = '';
  let removalFails = false;
  /** @type {readonly string[]} */
  let sharedNamespaces = [];
  let gateMounts = '';
  let rootless = 'true';
  let statReads = 0;
  /** @type {((acknowledge: () => void) => void) | undefined} */
  let onReleaseWrite;
  /** @type {(() => Promise<void>) | undefined} */
  let beforeControl;
  /** @type {(() => Promise<void>) | undefined} */
  let beforeKernel;
  /** @param {string[]} argv @param {import('node:child_process').StdioOptions} [stdio] */
  const startChild = (argv, stdio = 'pipe') => {
    const child = spawn('/bin/sh', argv, { env: {}, stdio });
    children.add(child);
    closures.push(new Promise(resolve => child.once('close', resolve)));
    return child;
  };
  const control = (text = '', code = 0) =>
    startChild([
      '-c',
      'printf "%s" "$1"; exit "$2"',
      'control',
      text,
      String(code),
    ]);
  const childProcess = {
    spawn(command, originalArgs, options) {
      if (command !== 'podman') throw Error(`unexpected command ${command}`);
      const args = originalArgs.slice(2);
      calls.push(args);
      if (args[0] === 'info') return control(rootless);
      if (args[0] === 'create') {
        sequence += 1;
        const id = sequence.toString(16).padStart(64, '0');
        const name = args[args.indexOf('--name') + 1];
        const record = {
          id,
          name,
          pid: 70 + sequence,
          args: args.slice(args.indexOf('test-image') + 1),
          inspections: 0,
        };
        containers.set(id, record);
        containers.set(name, record);
        return control(id);
      }
      const ref = args.at(-1);
      const record = containers.get(ref);
      const known = () => {
        if (!record) throw Error(`Unknown fixture container ${ref}`);
        return record;
      };
      if (args[0] === 'start') {
        const child = startChild(known().args, options.stdio);
        if (onReleaseWrite && child.stdin) {
          // Hold the release write's acknowledgement, not the bytes: the gate
          // receives them and the workload runs while the driver still waits.
          const hook = onReleaseWrite;
          const original = child.stdin.write.bind(child.stdin);
          Object.defineProperty(child.stdin, 'write', {
            /** @param {string} bytes @param {(error?: Error | null) => void} [callback] */
            value: (bytes, callback) =>
              original(bytes, error => hook(() => callback?.(error))),
          });
        }
        known().child = child;
        return child;
      }
      if (args[0] === 'rm' || args[0] === 'kill') {
        if (removalFails) return control('controlled removal failure', 1);
        record?.child?.kill();
        return control();
      }
      if (args[0] === 'container' && args[1] === 'inspect') {
        const format = args[args.indexOf('--format') + 1];
        if (format === '{{.State.StartedAt.IsZero}}') return control('false');
        if (ref === brokerId) {
          if (format === '{{.Id}}') return control(brokerId);
          if (format === '{{.State.Pid}}') return control('31');
        } else {
          const own = known();
          if (format === '{{.Id}}') return control(own.id);
          if (format === '{{.State.Pid}}') return control(String(own.pid));
          if (format === '{{json .}}') {
            // The native gate inspects the full record before and after its
            // kernel observations; a PID defect surfaces on the second read.
            own.inspections += 1;
            const pid =
              defect === 'pid' && own.inspections > 1 ? own.pid + 1 : own.pid;
            return control(
              JSON.stringify({
                Id: own.id,
                State: { Running: true, Pid: pid },
              }),
            );
          }
        }
      }
      throw Error(`Unexpected Podman fixture command ${args.join(' ')}`);
    },
  };
  const proc = {
    async readFile(path) {
      reads.push(path);
      if (path.endsWith('/net/dev')) return 'head\nhead\n lo: 0 0\n';
      if (path.endsWith('/net/route')) return 'Iface Destination\n';
      if (path.endsWith('/net/ipv6_route')) return '';
      if (path.endsWith('/stat')) {
        // Field 22 of proc(5), starttime: a change with the same PID means
        // the identity the gate was observed under is gone.
        statReads += 1;
        const start = defect === 'starttime' && statReads > 1 ? 124 : 123;
        return `77 (gate) ${Array(19).fill('0').join(' ')} ${start}\n`;
      }
      if (path.endsWith('/status')) {
        await beforeKernel?.();
        // The kernel reports ids in the reader's namespace; the uid_map
        // below translates the host identity back to the profile's 1000.
        const uid = Array(4).fill(process.geteuid?.()).join(' ');
        const gid = Array(4).fill(process.getegid?.()).join(' ');
        return `Uid:\t${uid}\nGid:\t${gid}\nCapEff:\t0\nCapPrm:\t0\nCapBnd:\t0\nNoNewPrivs:\t1\nSeccomp:\t2\n`;
      }
      if (path.endsWith('/uid_map')) return `1000 ${process.geteuid?.()} 1\n`;
      if (path.endsWith('/gid_map')) return `1000 ${process.getegid?.()} 1\n`;
      if (path === '/proc/self/mountinfo')
        return '34 25 0:30 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n';
      if (path.endsWith('/mountinfo'))
        return `811 701 0:90 / / ro - overlay overlay rw\n${gateMounts}`;
      if (path.endsWith('/cgroup')) return '0::/operation\n';
      await beforeControl?.();
      if (path.endsWith('/memory.max'))
        return defect === 'cgroup' ? 'max\n' : '536870912\n';
      if (path.endsWith('/memory.swap.max')) return '0\n';
      if (path.endsWith('/pids.max')) return '128\n';
      if (path.endsWith('/cpu.max')) return '200000 100000\n';
      throw Error(`Missing kernel fixture ${path}`);
    },
    async readLink(path) {
      const kind = path.split('/').at(-1);
      if (path.includes('/self/')) return `${kind}:[10]`;
      if (kind === 'net')
        return `net:[${defect === 'network' && !path.includes('/31/') ? 21 : 20}]`;
      if (defect === 'namespace' && kind === 'pid') return 'pid:[10]';
      const pid = path.split('/')[2];
      return `${kind}:[${sharedNamespaces.includes(kind) ? 99 : pid}]`;
    },
    async readInode() {
      throw Error('Unexpected inode lookup');
    },
  };
  const driver = makePodmanDriver({
    childProcess: /** @type {any} */ (childProcess),
    procfs: proc,
    ownerId: 'native-fixture',
  });
  /**
   * @param {object} [options]
   * @param {Array<{hostPath: string, innerPath: string, mode: 'ro' | 'rw'}>} [options.mounts]
   * @param {string} [options.scratchHostPath]
   * @param {unknown} [options.generatedStage]
   */
  const makeSlice = ({
    mounts = [],
    scratchHostPath = '',
    generatedStage = undefined,
  } = {}) => {
    /** @type {any} */
    const slice = {
      operations: makeResourceRegistry(),
      teardownFlight: undefined,
      spec: {
        rootfs: { kind: 'oci', ref: 'test-image' },
        mounts,
        scratchHostPath,
        network: 'join',
        networkRef: brokerId,
        seccomp: 'default',
        env: {},
        cwd: '/',
        nativeProfile: profile,
      },
      ref: 'test-image',
      runtime: '',
      netBackend: null,
      live: new Map(),
      reserved: new Set(),
      seccompTempPath: null,
      policy: null,
      join: {
        container: 'broker',
        containerId: brokerId,
        namespaceId: 'net-20',
      },
      runtimeDetails: { path: { value: '/usr/bin:/bin', source: 'fallback' } },
      generatedStage,
    };
    slices.push(slice);
    return slice;
  };
  t.teardown(async () => {
    removalFails = false;
    beforeControl = undefined;
    beforeKernel = undefined;
    for (const child of children) child.kill();
    await Promise.all(closures);
    for (const slice of slices) {
      // eslint-disable-next-line no-await-in-loop
      await driver.teardown(slice);
    }
    await driver.close();
  });
  // The workload records its start, then the first stdin line it receives:
  // that line must reach it intact, not be consumed by the gate.
  const argv = effect => [
    '/bin/sh',
    '-c',
    'printf started > "$1"; IFS= read -r finish; printf "%s" "$finish" >> "$1"',
    'app',
    effect,
  ];
  return {
    driver,
    makeSlice,
    directory,
    argv,
    reads,
    calls,
    setDefect: value => {
      defect = value;
    },
    failRemoval: value => {
      removalFails = value;
    },
    /** @param {readonly string[]} kinds procfs link names: user, pid, ipc, mnt */
    shareNamespaces: kinds => {
      sharedNamespaces = kinds;
    },
    /** @param {string} answer */
    setRootless: answer => {
      rootless = answer;
    },
    /** @param {(acknowledge: () => void) => void} hook */
    holdReleaseAcknowledgement: hook => {
      onReleaseWrite = hook;
    },
    /** @param {string} text */
    setGateMounts: text => {
      gateMounts = text;
    },
    holdKernel: callback => {
      beforeKernel = callback;
    },
    holdControls: callback => {
      beforeControl = callback;
    },
  };
};

/**
 * @param {import('../src/types.js').DriverProcess} operation
 * @param {string} text
 */
const writeInput = async (operation, text) => {
  if (
    !('writeStdin' in operation) ||
    typeof operation.writeStdin !== 'function'
  ) {
    throw Error('Expected native stdin owner');
  }
  await operation.writeStdin(new TextEncoder().encode(text));
};

/**
 * Resolve once the path exists; the workload that creates it is already
 * running, so this waits on its progress rather than on a timer. Bounded so
 * a workload that never writes fails the test instead of outliving it.
 * @param {string} path
 * @param {number} [attempts]
 * @returns {Promise<void>}
 */
const untilExists = (path, attempts = 500) =>
  access(path).catch(() => {
    if (attempts === 0) throw Error(`${path} never appeared`);
    return sleep(10).then(() => untilExists(path, attempts - 1));
  });

/** @param {import('../src/types.js').DriverProcess} operation */
const closeInput = async operation => {
  if (
    !('closeStdin' in operation) ||
    typeof operation.closeStdin !== 'function'
  ) {
    throw Error('Expected native stdin owner');
  }
  await operation.closeStdin();
};

test('native operation releases only after kernel observations and preserves first stdin', async t => {
  t.timeout(10_000);
  const f = await fixture(t);
  const effect = join(f.directory, 'app');
  const entered = makePromiseKit();
  const resume = makePromiseKit();
  t.teardown(() => resume.resolve(undefined));
  f.holdControls(async () => {
    entered.resolve(undefined);
    await resume.promise;
  });
  const pending = f.driver.spawn(f.makeSlice(), f.argv(effect), {});
  await entered.promise;
  await t.throwsAsync(readFile(effect), { code: 'ENOENT' });
  t.true(f.reads.some(path => path.endsWith('/status')));
  resume.resolve(undefined);
  const app = await pending;
  await writeInput(app, 'finish\n');
  await closeInput(app);
  await app.wait();
  t.is(await readFile(effect, 'utf8'), 'startedfinish');
});

test('non-rootless engine refuses before any container is created', async t => {
  t.timeout(10_000);
  const f = await fixture(t);
  f.setRootless('false');
  await t.throwsAsync(
    f.driver.spawn(f.makeSlice(), f.argv(join(f.directory, 'app')), {}),
    { message: /rootless engine/ },
  );
  t.false(f.calls.some(args => args[0] === 'create'));
});

const defects = harden({
  cgroup: /unbounded or unrecognized native cgroup control/,
  network: /did not join its original broker network/,
  pid: /identity changed during observation/,
  starttime: /identity changed during observation/,
  namespace: /namespace is not private from the observer/,
});

for (const [defect, message] of Object.entries(defects)) {
  test(`native operation refuses ${defect} mismatch before application execution`, async t => {
    t.timeout(10_000);
    const f = await fixture(t);
    f.setDefect(defect);
    const effect = join(f.directory, 'app');
    await t.throwsAsync(f.driver.spawn(f.makeSlice(), f.argv(effect), {}), {
      message,
    });
    await t.throwsAsync(readFile(effect), { code: 'ENOENT' });
  });
}

test('cancelled native operation cannot release after a held kernel read', async t => {
  t.timeout(10_000);
  const f = await fixture(t);
  const effect = join(f.directory, 'app');
  const entered = makePromiseKit();
  const resume = makePromiseKit();
  /** @type {ReturnType<typeof makePromiseKit<never>>} */
  const cancellation = makePromiseKit();
  void cancellation.promise.catch(() => {});
  t.teardown(() => resume.resolve(undefined));
  f.holdKernel(async () => {
    entered.resolve(undefined);
    await resume.promise;
  });
  const pending = f.driver.spawn(
    f.makeSlice(),
    f.argv(effect),
    {},
    {
      cancelled: cancellation.promise,
    },
  );
  const rejected = t.throwsAsync(pending);
  await entered.promise;
  cancellation.reject(Error('cancel before gate release'));
  resume.resolve(undefined);
  await rejected;
  await t.throwsAsync(readFile(effect), { code: 'ENOENT' });
});

test('cancellation after the release write is issued removes a workload that ran', async t => {
  t.timeout(10_000);
  const f = await fixture(t);
  const effect = join(f.directory, 'app');
  const issued = makePromiseKit();
  /** @type {(() => void) | undefined} */
  let acknowledge;
  f.holdReleaseAcknowledgement(hook => {
    acknowledge = hook;
    issued.resolve(undefined);
  });
  /** @type {ReturnType<typeof makePromiseKit<never>>} */
  const cancellation = makePromiseKit();
  void cancellation.promise.catch(() => {});
  const slice = f.makeSlice();
  const pending = f.driver.spawn(
    slice,
    f.argv(effect),
    {},
    {
      cancelled: cancellation.promise,
    },
  );
  const rejected = t.throwsAsync(pending);
  await issued.promise;
  // The bytes reached the gate: the workload demonstrably starts before the
  // driver learns anything more. Cancellation now cannot mean it never ran.
  await untilExists(effect);
  const reason = Error('cancel after release issued');
  cancellation.reject(reason);
  await Promise.resolve();
  await Promise.resolve();
  acknowledge?.();
  t.is(await rejected, reason);
  t.true(f.calls.some(args => args[0] === 'rm'));
  t.is(slice.live.size + slice.reserved.size, 0);
  t.is(await readFile(effect, 'utf8'), 'started');
});

test('native operations retain failed cleanup in admission counts', async t => {
  t.timeout(10_000);
  const f = await fixture(t);
  const slice = f.makeSlice();
  const effect = join(f.directory, 'app');
  const entered = makePromiseKit();
  const resume = makePromiseKit();
  t.teardown(() => resume.resolve(undefined));
  f.holdKernel(async () => {
    entered.resolve(undefined);
    await resume.promise;
  });
  const pending = f.driver.spawn(slice, f.argv(effect), {});
  await t.throwsAsync(f.driver.spawn(slice, f.argv(effect), {}), {
    message: /already admitted/,
  });
  await entered.promise;
  f.setDefect('cgroup');
  f.failRemoval(true);
  const rejected = t.throwsAsync(pending, { message: /cleanup pending/ });
  resume.resolve(undefined);
  await rejected;
  t.is(slice.live.size + slice.reserved.size, 1);
  await t.throwsAsync(f.driver.spawn(slice, f.argv(effect), {}), {
    message: /already admitted/,
  });
  f.failRemoval(false);
  await f.driver.teardown(slice);
  t.is(slice.live.size + slice.reserved.size, 0);
});

test('siblings may share a keep-id user namespace but not pid, ipc or mount', async t => {
  t.timeout(10_000);
  const f = await fixture(t);
  f.shareNamespaces(['user']);
  const a = await f.driver.spawn(
    f.makeSlice(),
    f.argv(join(f.directory, 'a')),
    {},
  );
  const b = await f.driver.spawn(
    f.makeSlice(),
    f.argv(join(f.directory, 'b')),
    {},
  );
  await Promise.all(
    [a, b].map(async app => {
      await closeInput(app);
      await app.wait();
    }),
  );
  t.is(await readFile(join(f.directory, 'b'), 'utf8'), 'started');
});

test('sibling namespace collision refuses until original operation closes', async t => {
  t.timeout(10_000);
  const f = await fixture(t);
  f.shareNamespaces(['pid', 'ipc', 'mnt']);
  const first = f.makeSlice();
  const second = f.makeSlice();
  const a = await f.driver.spawn(first, f.argv(join(f.directory, 'a')), {});
  await t.throwsAsync(
    f.driver.spawn(second, f.argv(join(f.directory, 'b')), {}),
    { message: /already held/ },
  );
  await closeInput(a);
  await a.wait();
  const b = await f.driver.spawn(second, f.argv(join(f.directory, 'b')), {});
  await closeInput(b);
  await b.wait();
});

/** @param {string} path @param {string} options */
const gateMount = (path, options) =>
  `812 811 0:91 / ${path} ${options} - ext4 source rw\n`;

/** @type {Parameters<Awaited<ReturnType<typeof fixture>>['makeSlice']>[0]} */
const declared = harden({
  mounts: [
    { hostPath: '/host/workspace', innerPath: '/workspace', mode: 'rw' },
  ],
  scratchHostPath: '/host/scratch',
});

test('declared mounts launch with nodev and are observed before release', async t => {
  t.timeout(10_000);
  const f = await fixture(t);
  f.setGateMounts(
    [
      gateMount('/workspace', 'rw,nosuid,nodev'),
      gateMount('/scratch', 'rw,nosuid,nodev'),
    ].join(''),
  );
  const effect = join(f.directory, 'app');
  const app = await f.driver.spawn(f.makeSlice(declared), f.argv(effect), {});
  await closeInput(app);
  await app.wait();
  t.is(await readFile(effect, 'utf8'), 'started');
  const create = f.calls.find(args => args[0] === 'create') ?? [];
  t.true(create.includes('--image-volume=ignore'));
  const mountFlags = create.filter((_, i) => create[i - 1] === '--mount');
  for (const target of ['/workspace', '/scratch']) {
    t.true(
      mountFlags.some(
        flag =>
          flag.includes(`target=${target}`) &&
          flag.includes('nosuid') &&
          flag.includes('nodev'),
      ),
      `${target} launches with nosuid,nodev`,
    );
  }
});

const stage = harden({
  prepare: async () =>
    harden([
      { hostPath: '/host/stage/0', innerPath: '/etc/resolv.conf', mode: 'ro' },
    ]),
  release: async () => {},
});

test('driver-staged generated files are declared read-only and observed', async t => {
  t.timeout(10_000);
  const f = await fixture(t);
  f.setGateMounts(
    [
      gateMount('/workspace', 'rw,nosuid,nodev'),
      gateMount('/scratch', 'rw,nosuid,nodev'),
      gateMount('/etc/resolv.conf', 'ro,nosuid,nodev'),
    ].join(''),
  );
  const effect = join(f.directory, 'app');
  const app = await f.driver.spawn(
    f.makeSlice({ ...declared, generatedStage: stage }),
    f.argv(effect),
    {},
  );
  await closeInput(app);
  await app.wait();
  t.is(await readFile(effect, 'utf8'), 'started');
  const create = f.calls.find(args => args[0] === 'create') ?? [];
  const mountFlags = create.filter((_, i) => create[i - 1] === '--mount');
  t.true(
    mountFlags.some(
      flag =>
        flag.includes('source=/host/stage/0') &&
        flag.includes('target=/etc/resolv.conf') &&
        flag.includes('readonly') &&
        flag.includes('nosuid') &&
        flag.includes('nodev'),
    ),
  );
});

test('a staged generated file missing at the gate refuses before execution', async t => {
  t.timeout(10_000);
  const f = await fixture(t);
  f.setGateMounts(
    [
      gateMount('/workspace', 'rw,nosuid,nodev'),
      gateMount('/scratch', 'rw,nosuid,nodev'),
    ].join(''),
  );
  const effect = join(f.directory, 'app');
  await t.throwsAsync(
    f.driver.spawn(
      f.makeSlice({ ...declared, generatedStage: stage }),
      f.argv(effect),
      {},
    ),
    { message: /declared mount is missing at "\/etc\/resolv.conf"/ },
  );
  await t.throwsAsync(readFile(effect), { code: 'ENOENT' });
});

/** @type {readonly [string, string, RegExp][]} */
const mountDefects = harden([
  [
    'a missing declared mount',
    gateMount('/workspace', 'rw,nosuid,nodev'),
    /declared mount is missing at "\/scratch"/,
  ],
  [
    'a declared mount that permits devices',
    [
      gateMount('/workspace', 'rw,nosuid'),
      gateMount('/scratch', 'rw,nosuid,nodev'),
    ].join(''),
    /permits devices at "\/workspace"/,
  ],
  [
    'a writable cgroup filesystem',
    [
      gateMount('/workspace', 'rw,nosuid,nodev'),
      gateMount('/scratch', 'rw,nosuid,nodev'),
      '813 811 0:92 / /sys/fs/cgroup rw,nosuid,nodev - cgroup2 cgroup rw\n',
    ].join(''),
    /writable or unproved cgroup mount/,
  ],
]);

for (const [name, table, message] of mountDefects) {
  test(`native operation refuses ${name} before application execution`, async t => {
    t.timeout(10_000);
    const f = await fixture(t);
    f.setGateMounts(table);
    const effect = join(f.directory, 'app');
    await t.throwsAsync(
      f.driver.spawn(f.makeSlice(declared), f.argv(effect), {}),
      { message },
    );
    await t.throwsAsync(readFile(effect), { code: 'ENOENT' });
  });
}

test('captureStdout false still gates and drains workload output', async t => {
  t.timeout(10_000);
  const f = await fixture(t);
  const effect = join(f.directory, 'app');
  const app = await f.driver.spawn(
    f.makeSlice(),
    [
      '/bin/sh',
      '-c',
      'printf started > "$1"; head -c 262144 /dev/zero',
      'app',
      effect,
    ],
    { captureStdout: false },
  );
  await app.wait();
  t.is(await readFile(effect, 'utf8'), 'started');
  t.true(f.reads.some(path => path.endsWith('/memory.max')));
});
