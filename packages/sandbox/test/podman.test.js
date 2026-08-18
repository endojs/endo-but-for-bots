// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { M } from '@endo/patterns';

import assert from 'node:assert';
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { PassThrough } from 'node:stream';

import {
  ENDO_SANDBOX_PREFIX,
  makePodmanDriver,
  parseImagePathFromConfigEnv,
  PODMAN_OPERATION_LABEL,
  PODMAN_OWNER_LABEL,
  reportsContainerGone,
  reportsContainerNotRunning,
  seccompSecurityOpt,
} from '../src/drivers/podman.js';
import { DEFAULT_PATH } from '../src/drivers/path.js';
import { makeSandboxFactory } from '../src/factory.js';

const StubMountInterface = M.interface('Mount', {
  help: M.call().returns(M.string()),
  hostPath: M.call().returns(M.string()),
});

/**
 * OCI image used for acceptance tests.  Alpine is small (~5 MiB), the
 * `apk` package manager exits 0 on a clean update, and busybox covers
 * `/bin/sh`, `/bin/cat`, `/bin/echo`, and `ls` — every command the
 * tests rely on inside the slice.
 */
const ALPINE_REF = 'docker.io/library/alpine:3.19';
const PODMAN_TEST_OWNER = 'sandbox-lifecycle-test-suite';

/**
 * Run a host-side podman command and resolve with its captured stdio.
 *
 * @param {string[]} args
 * @returns {Promise<{ code: number | null; stdout: string; stderr: string }>}
 */
const podmanRun = async args => {
  await null;
  return new Promise(resolve => {
    let child;
    try {
      child = nodeSpawn('podman', args, { stdio: 'pipe' });
    } catch (e) {
      resolve({
        code: null,
        stdout: '',
        stderr: /** @type {Error} */ (e).message,
      });
      return;
    }
    /** @type {Buffer[]} */
    const o = [];
    /** @type {Buffer[]} */
    const er = [];
    child.stdout?.on('data', c => o.push(c));
    child.stderr?.on('data', c => er.push(c));
    child.once('error', e =>
      resolve({
        code: null,
        stdout: '',
        stderr: /** @type {Error} */ (e).message,
      }),
    );
    child.once('close', code =>
      resolve({
        code,
        stdout: Buffer.concat(o).toString('utf8'),
        stderr: Buffer.concat(er).toString('utf8'),
      }),
    );
  });
};

/** @param {string} ownerId */
const listOwnedContainers = async ownerId => {
  const result = await podmanRun([
    'ps',
    '-a',
    '--filter',
    `label=${PODMAN_OWNER_LABEL}=${ownerId}`,
    '--format',
    '{{.Names}}',
  ]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim());
  }
  return result.stdout
    .split('\n')
    .map(name => name.trim())
    .filter(name => name !== '');
};

/**
 * Poll until no containers carry the owner label. A cancelled admission
 * removes its named operation asynchronously (bounded by the driver's
 * control-command deadline), so a containment assertion that races it
 * must wait rather than sample once.
 *
 * @param {string} ownerId
 * @param {number} [timeoutMs]
 */
const waitForNoOwnedContainers = async (ownerId, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  await null;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const names = await listOwnedContainers(ownerId);
    if (names.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`containers still present: ${names.join(', ')}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 200));
  }
};

/**
 * @typedef {object} PodmanAvailability
 * @property {boolean} available    Whether the suite can exercise podman.
 * @property {string} [version]     Podman version string when present.
 * @property {boolean} [imagePresent]  Whether the alpine image is in
 *                                  the user's local storage already.
 *                                  Tests gate any `apk` / network case
 *                                  on this so a CI host without
 *                                  internet access still passes.
 * @property {string} [reason]      Human-readable reason when
 *                                  unavailable.
 */

/**
 * Probe `podman --version`, rootless mode, and image presence so each
 * test can decide whether to skip gracefully.
 *
 * @returns {Promise<PodmanAvailability>}
 */
const probePodman = async () => {
  const version = await podmanRun(['--version']);
  if (version.code !== 0) {
    return {
      available: false,
      reason: `podman --version exit ${version.code}: ${version.stderr.trim()}`,
    };
  }
  const rootless = await podmanRun([
    'info',
    '--format',
    '{{.Host.Security.Rootless}}',
  ]);
  if (rootless.code !== 0 || rootless.stdout.trim() !== 'true') {
    return {
      available: false,
      reason: `podman not rootless: ${rootless.stdout.trim() || rootless.stderr.trim()}`,
    };
  }
  // Snapshot whether the alpine image is already present.  Tests that
  // need the image but cannot reach the registry will skip rather than
  // flake; tests that only need probe() / orphan reap still run.
  const imageExists = await podmanRun(['image', 'exists', ALPINE_REF]);
  const m = version.stdout.match(/(\d+(?:\.\d+){0,3})/);
  return {
    available: true,
    version: m ? m[1] : version.stdout.trim(),
    imagePresent: imageExists.code === 0,
  };
};

/** @type {PodmanAvailability} */
let podmanAvailability = { available: false, reason: 'not yet probed' };

test.serial.before(async _t => {
  podmanAvailability = await probePodman();
});

test('podman probe fails closed without an exact cleanup scope', async t => {
  const driver = makePodmanDriver({ env: {} });
  const probe = await driver.probe();
  t.false(probe.available);
  t.regex(probe.reason ?? '', /stable ownerId/);
  t.false(probe.details?.lifecycle?.crashCleanup ?? true);
});

test('podman reconciliation uses only the exact owner label', async t => {
  /** @type {Array<{ command: string, args: string[] }>} */
  const calls = [];
  const childProcess = {
    /**
     * @param {string} command
     * @param {string[]} args
     */
    spawn(command, args) {
      calls.push({ command, args: [...args] });
      let code = 0;
      let stdout = '';
      if (command === 'podman' && args.includes('--version')) {
        stdout = 'podman version 5.8.0\n';
      } else if (args.includes('{{.Host.Security.Rootless}}')) {
        stdout = 'true\n';
      } else if (args.includes('{{.Host.OCIRuntime.Name}}')) {
        stdout = 'crun\n';
      } else if (args.includes('ps')) {
        stdout = 'owned-operation\n';
      } else if (command !== 'podman') {
        code = 1;
      }

      const child = new EventEmitter();
      const stdoutStream = new PassThrough();
      const stderrStream = new PassThrough();
      Object.assign(child, {
        stdout: stdoutStream,
        stderr: stderrStream,
      });
      void Promise.resolve().then(() => {
        stdoutStream.end(stdout);
        stderrStream.end();
        child.emit('close', code, null);
      });
      return child;
    },
  };
  const ownerId = 'formula-exact-owner';
  const driver = makePodmanDriver({
    childProcess: /** @type {any} */ (childProcess),
    env: {},
    ownerId,
  });
  const probe = await driver.probe();
  t.true(probe.available, probe.reason);

  const listing = calls.find(call => call.args.includes('ps'));
  t.deepEqual(listing, {
    command: 'podman',
    args: [
      'ps',
      '-a',
      '--filter',
      `label=${PODMAN_OWNER_LABEL}=${ownerId}`,
      '--format',
      '{{.Names}}',
    ],
  });
  t.deepEqual(
    calls
      .filter(call => call.args.includes('rm'))
      .map(call => call.args.at(-1)),
    ['owned-operation'],
  );
});

/**
 * @returns {{
 *   powers: any,
 *   makeMountCapForPath: (path: string) => any,
 *   tmpdirs: string[],
 * }}
 */
const makeStubScratchProvider = () => {
  /** @type {string[]} */
  const tmpdirs = [];
  /** @type {WeakMap<object, string>} */
  const capToHostPath = new WeakMap();

  /** @param {string} hostPath */
  const wrapAsCap = hostPath => {
    const cap = makeExo('Mount', StubMountInterface, {
      help: () => `stub Mount @ ${hostPath}`,
      hostPath: () => hostPath,
    });
    capToHostPath.set(cap, hostPath);
    return cap;
  };

  /** @param {string} path */
  const makeMountCapForPath = path => wrapAsCap(path);

  const powers = harden({
    /** @param {string} petName */
    provideScratchMount: async petName => {
      const dir = nodeFs.mkdtempSync(
        nodePath.join(nodeOs.tmpdir(), `endo-sandbox-podman-${petName}-`),
      );
      tmpdirs.push(dir);
      return wrapAsCap(dir);
    },
    /** @param {any} cap */
    provideHostPath: async cap => {
      const path = capToHostPath.get(cap);
      if (path === undefined) {
        throw new Error('stub provideHostPath: unknown cap');
      }
      return path;
    },
  });

  return { powers, makeMountCapForPath, tmpdirs };
};

/**
 * @param {string[]} tmpdirs
 */
const cleanupTmpdirs = tmpdirs => {
  for (const dir of tmpdirs) {
    try {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
};

/**
 * Drain a ReaderRef-shaped exo into a Buffer.
 *
 * @param {any} reader
 * @returns {Promise<Buffer>}
 */
const drainReader = async reader => {
  await null;
  /** @type {Uint8Array[]} */
  const chunks = [];
  for await (const chunk of iterateBytesReader(reader)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c)));
};

test.serial('podman probe reports rootless availability + version', async t => {
  if (!podmanAvailability.available) {
    t.pass(`podman not available: ${podmanAvailability.reason}`);
    return;
  }
  // The test owner id scopes the boot-time sweep to this suite's own
  // containers, so other tests can manage their fixtures predictably.
  const driver = makePodmanDriver({ env: {}, ownerId: PODMAN_TEST_OWNER });
  const probe = await driver.probe();
  t.true(probe.available, `probe should report available: ${probe.reason}`);
  t.is(typeof probe.version, 'string');
  t.regex(probe.version ?? '', /\d+\.\d+/);
  t.truthy(probe.details, 'probe carries details');
  t.true(
    probe.details?.rootless?.available,
    'rootless flag is reported in details',
  );
});

test.serial(
  'listBackends() reports podman available via the factory',
  async t => {
    if (!podmanAvailability.available) {
      t.pass(`podman not available: ${podmanAvailability.reason}`);
      return;
    }
    const driver = makePodmanDriver({ env: {}, ownerId: PODMAN_TEST_OWNER });
    const { powers } = makeStubScratchProvider();
    const factory = makeSandboxFactory({
      drivers: harden([driver]),
      scratchProvider: powers,
    });
    const backends = await E(factory).listBackends();
    t.is(backends.length, 1);
    t.is(backends[0].name, 'podman');
    t.true(backends[0].available);
  },
);

test.serial('alpine OCI slice spawns /bin/echo hello', async t => {
  if (!podmanAvailability.available || !podmanAvailability.imagePresent) {
    t.pass(
      `podman or alpine image not available: ${podmanAvailability.reason ?? 'image absent'}`,
    );
    return;
  }
  const driver = makePodmanDriver({ env: {}, ownerId: PODMAN_TEST_OWNER });
  const { powers, tmpdirs } = makeStubScratchProvider();
  const factory = makeSandboxFactory({
    drivers: harden([driver]),
    scratchProvider: powers,
  });

  const handle = await E(factory).make(
    harden({
      rootfs: { kind: 'oci', ref: ALPINE_REF },
      network: 'none',
      backend: 'podman',
    }),
  );
  t.teardown(async () => {
    await E(handle).dispose();
    cleanupTmpdirs(tmpdirs);
  });

  const proc = await E(handle).spawn(harden(['/bin/echo', 'hello']));
  const stdoutPromise = drainReader(await E(proc).stdout());
  const exit = await E(proc).wait();
  const stdout = await stdoutPromise;
  t.is(exit.code, 0, `exit code 0, got ${exit.code}`);
  t.true(stdout.toString('utf8').startsWith('hello'));
});

test.serial(
  'read-only mount rejects writes from inside the alpine slice',
  async t => {
    if (!podmanAvailability.available || !podmanAvailability.imagePresent) {
      t.pass(
        `podman or alpine image not available: ${podmanAvailability.reason ?? 'image absent'}`,
      );
      return;
    }
    const driver = makePodmanDriver({ env: {}, ownerId: PODMAN_TEST_OWNER });
    const { powers, makeMountCapForPath, tmpdirs } = makeStubScratchProvider();
    const factory = makeSandboxFactory({
      drivers: harden([driver]),
      scratchProvider: powers,
    });

    const roHost = nodeFs.mkdtempSync(
      nodePath.join(nodeOs.tmpdir(), 'endo-sandbox-podman-ro-'),
    );
    tmpdirs.push(roHost);
    nodeFs.writeFileSync(nodePath.join(roHost, 'sentinel'), 'baseline\n');

    const roMountCap = makeMountCapForPath(roHost);
    const handle = await E(factory).make(
      harden({
        rootfs: { kind: 'oci', ref: ALPINE_REF },
        mounts: [{ cap: roMountCap, innerPath: '/ro', mode: 'ro' }],
        network: 'none',
        backend: 'podman',
      }),
    );
    t.teardown(async () => {
      await E(handle).dispose();
      cleanupTmpdirs(tmpdirs);
    });

    const proc = await E(handle).spawn(
      harden(['/bin/sh', '-c', 'echo nope > /ro/should-fail']),
    );
    const stderr = await drainReader(await E(proc).stderr());
    const exit = await E(proc).wait();
    t.not(exit.code, 0, 'write to /ro should fail');
    t.regex(
      stderr.toString('utf8'),
      /Read-only file system|Permission denied|read-only/i,
      'stderr should mention read-only',
    );

    const proc2 = await E(handle).spawn(harden(['/bin/cat', '/ro/sentinel']));
    const stdout2 = await drainReader(await E(proc2).stdout());
    const exit2 = await E(proc2).wait();
    t.is(exit2.code, 0);
    t.is(stdout2.toString('utf8'), 'baseline\n');
  },
);

test.serial('network: none blocks external reach in alpine slice', async t => {
  if (!podmanAvailability.available || !podmanAvailability.imagePresent) {
    t.pass(
      `podman or alpine image not available: ${podmanAvailability.reason ?? 'image absent'}`,
    );
    return;
  }
  const driver = makePodmanDriver({ env: {}, ownerId: PODMAN_TEST_OWNER });
  const { powers, tmpdirs } = makeStubScratchProvider();
  const factory = makeSandboxFactory({
    drivers: harden([driver]),
    scratchProvider: powers,
  });

  const handle = await E(factory).make(
    harden({
      rootfs: { kind: 'oci', ref: ALPINE_REF },
      network: 'none',
      backend: 'podman',
    }),
  );
  t.teardown(async () => {
    await E(handle).dispose();
    cleanupTmpdirs(tmpdirs);
  });

  // Alpine ships busybox `ls` and `cat` — enumerate /sys/class/net to
  // confirm only `lo` is present (mirrors the bwrap network-none case).
  const proc = await E(handle).spawn(
    harden(['/bin/sh', '-c', 'ls /sys/class/net 2>/dev/null || true']),
  );
  const stdout = await drainReader(await E(proc).stdout());
  await E(proc).wait();
  const ifaces = stdout
    .toString('utf8')
    .split('\n')
    .map(s => s.trim())
    .filter(s => s !== '');
  t.deepEqual(
    ifaces.filter(i => i !== 'lo').sort(),
    [],
    'no non-loopback interfaces in network: none',
  );
});

test.serial(
  'network: private mounts a routable interface other than lo',
  async t => {
    if (!podmanAvailability.available || !podmanAvailability.imagePresent) {
      t.pass(
        `podman or alpine image not available: ${podmanAvailability.reason ?? 'image absent'}`,
      );
      return;
    }
    // Skip when neither slirp4netns nor pasta is on PATH — pure
    // Phase 1 hosts may not have either.
    const slirpProbe = await podmanRun(['unshare', '--', 'true']);
    void slirpProbe;
    const driver = makePodmanDriver({ env: {}, ownerId: PODMAN_TEST_OWNER });
    const { powers, tmpdirs } = makeStubScratchProvider();
    const factory = makeSandboxFactory({
      drivers: harden([driver]),
      scratchProvider: powers,
    });
    let handle;
    try {
      handle = await E(factory).make(
        harden({
          rootfs: { kind: 'oci', ref: ALPINE_REF },
          network: 'private',
          backend: 'podman',
        }),
      );
    } catch (e) {
      // The driver throws a structured error when neither pasta nor
      // slirp4netns is on PATH; treat that case as a graceful skip
      // rather than a flake.
      if (/slirp4netns or pasta/.test(/** @type {Error} */ (e).message)) {
        t.pass(
          `rootless network backend missing: ${/** @type {Error} */ (e).message}`,
        );
        return;
      }
      throw e;
    }
    t.teardown(async () => {
      await E(handle).dispose();
      cleanupTmpdirs(tmpdirs);
    });
    // Inside a `private` slice pasta / slirp4netns brings up at least
    // one tap interface besides `lo`.  We don't assert a specific
    // name (tap0 / eth0 / ns0) — only that the slice has more than
    // just loopback, which is the user-visible difference between
    // `none` and `private`.
    const proc = await E(handle).spawn(
      harden(['/bin/sh', '-c', 'ls /sys/class/net 2>/dev/null || true']),
    );
    const stdout = await drainReader(await E(proc).stdout());
    await E(proc).wait();
    const ifaces = stdout
      .toString('utf8')
      .split('\n')
      .map(s => s.trim())
      .filter(s => s !== '');
    t.true(ifaces.includes('lo'), 'loopback present inside private slice');
    t.true(
      ifaces.some(i => i !== 'lo'),
      `non-loopback interface should be present: ${ifaces.join(', ')}`,
    );
  },
);

test.serial('apk update succeeds inside a private alpine slice', async t => {
  await null;
  if (!podmanAvailability.available || !podmanAvailability.imagePresent) {
    t.pass(
      `podman or alpine image not available: ${podmanAvailability.reason ?? 'image absent'}`,
    );
    return;
  }
  const driver = makePodmanDriver({ env: {}, ownerId: PODMAN_TEST_OWNER });
  const { powers, tmpdirs } = makeStubScratchProvider();
  const factory = makeSandboxFactory({
    drivers: harden([driver]),
    scratchProvider: powers,
  });
  let handle;
  try {
    handle = await E(factory).make(
      harden({
        rootfs: { kind: 'oci', ref: ALPINE_REF },
        network: 'private',
        backend: 'podman',
      }),
    );
  } catch (e) {
    if (/slirp4netns or pasta/.test(/** @type {Error} */ (e).message)) {
      t.pass(
        `rootless network backend missing: ${/** @type {Error} */ (e).message}`,
      );
      return;
    }
    throw e;
  }
  t.teardown(async () => {
    await E(handle).dispose();
    cleanupTmpdirs(tmpdirs);
  });
  // `apk update` is the Alpine analog of `apt update`.  We cannot
  // claim public mirror reachability on every CI host, so the test
  // accepts both: a code-0 success and a network-error skip.  When
  // the test passes, the upgraded package metadata lives in the
  // container's writable layer (or /scratch when bound) — never in
  // the host's image-store layer, which is `--read-only`.
  const proc = await E(handle).spawn(harden(['/sbin/apk', 'update']));
  const stdout = await drainReader(await E(proc).stdout());
  const stderr = await drainReader(await E(proc).stderr());
  const exit = await E(proc).wait();
  if (exit.code !== 0) {
    // Common offline failures: DNS miss, ENETUNREACH, certificate
    // verification.  Surface them as a soft skip so the test stays
    // useful in air-gapped CI.
    const why = stderr.toString('utf8') || stdout.toString('utf8');
    t.pass(`apk update could not reach the mirrors: ${why.slice(0, 200)}`);
    return;
  }
  t.regex(
    stdout.toString('utf8'),
    /OK:|fetch /,
    'apk update output should mention fetch / OK',
  );
});

test.serial('orphan reap uses exact owner labels', async t => {
  if (!podmanAvailability.available || !podmanAvailability.imagePresent) {
    t.pass(
      `podman or alpine image not available: ${podmanAvailability.reason ?? 'image absent'}`,
    );
    return;
  }
  // Pre-create a sentinel container with the documented prefix so the
  // boot-time sweep has something to reap.  The container exits
  // immediately (`/bin/true`) so we are reaping an exited record, not
  // a running namespace.
  const sentinelName = `${ENDO_SANDBOX_PREFIX}stale-${Date.now().toString(16)}`;
  const unrelatedName = `${ENDO_SANDBOX_PREFIX}unrelated-${Date.now().toString(16)}`;
  const created = await podmanRun([
    'create',
    '--name',
    sentinelName,
    '--label',
    `${PODMAN_OWNER_LABEL}=${PODMAN_TEST_OWNER}`,
    '--label',
    `${PODMAN_OPERATION_LABEL}=stale-fixture`,
    ALPINE_REF,
    '/bin/true',
  ]);
  const unrelatedCreated = await podmanRun([
    'create',
    '--name',
    unrelatedName,
    '--label',
    `${PODMAN_OWNER_LABEL}=some-other-formula`,
    ALPINE_REF,
    '/bin/true',
  ]);
  t.teardown(async () => {
    // Best-effort cleanup in case the test fails before the reap.
    await podmanRun(['rm', '-f', sentinelName]);
    await podmanRun(['rm', '-f', unrelatedName]);
  });
  if (created.code !== 0 || unrelatedCreated.code !== 0) {
    t.pass(
      `could not pre-create sentinels: ${created.stderr.trim()} ${unrelatedCreated.stderr.trim()}`,
    );
    return;
  }

  const driver = makePodmanDriver({ env: {}, ownerId: PODMAN_TEST_OWNER });
  const probe = await driver.probe();
  t.true(probe.available);

  const after = await podmanRun([
    'ps',
    '-a',
    '--filter',
    `name=${sentinelName}`,
    '--format',
    '{{.Names}}',
  ]);
  t.is(
    after.stdout.trim(),
    '',
    `sentinel ${sentinelName} should have been reaped, podman ps reports: ${after.stdout.trim() || '(empty)'}`,
  );
  const unrelatedAfter = await podmanRun([
    'ps',
    '-a',
    '--filter',
    `name=${unrelatedName}`,
    '--format',
    '{{.Names}}',
  ]);
  t.is(
    unrelatedAfter.stdout.trim(),
    unrelatedName,
    'exact-label cleanup must leave an unrelated prefixed container intact',
  );
});

test.serial(
  'podman driver rejects non-OCI rootfs at slice construction',
  async t => {
    if (!podmanAvailability.available) {
      t.pass(`podman not available: ${podmanAvailability.reason}`);
      return;
    }
    const driver = makePodmanDriver({ env: {}, ownerId: PODMAN_TEST_OWNER });
    const { powers, tmpdirs } = makeStubScratchProvider();
    const factory = makeSandboxFactory({
      drivers: harden([driver]),
      scratchProvider: powers,
    });
    await t.throwsAsync(
      () =>
        E(factory).make(
          harden({
            rootfs: { kind: 'host-bind' },
            network: 'none',
            backend: 'podman',
          }),
        ),
      { message: /podman driver only supports rootfs/ },
    );
    cleanupTmpdirs(tmpdirs);
  },
);

test.serial(
  'slice.help() reports the rootless and rootless-net layers',
  async t => {
    if (!podmanAvailability.available || !podmanAvailability.imagePresent) {
      t.pass(
        `podman or alpine image not available: ${podmanAvailability.reason ?? 'image absent'}`,
      );
      return;
    }
    const driver = makePodmanDriver({ env: {}, ownerId: PODMAN_TEST_OWNER });
    const { powers, tmpdirs } = makeStubScratchProvider();
    const factory = makeSandboxFactory({
      drivers: harden([driver]),
      scratchProvider: powers,
    });
    const handle = await E(factory).make(
      harden({
        rootfs: { kind: 'oci', ref: ALPINE_REF },
        network: 'none',
        backend: 'podman',
      }),
    );
    t.teardown(async () => {
      await E(handle).dispose();
      cleanupTmpdirs(tmpdirs);
    });
    const help = await E(handle).help();
    t.regex(help, /Hardening layers in effect:/);
    t.regex(help, /network: none/);
    t.regex(help, /rootless: yes/);
    // rootless-net only matters for `private`; for `none` the row
    // still renders with the detected backend (or "none" when neither
    // is on PATH).
    t.regex(help, /rootless-net: (slirp4netns|pasta|none)/);
  },
);

test.serial('fork() throws notImplemented before Phase 3', async t => {
  if (!podmanAvailability.available || !podmanAvailability.imagePresent) {
    t.pass(
      `podman or alpine image not available: ${podmanAvailability.reason ?? 'image absent'}`,
    );
    return;
  }
  const driver = makePodmanDriver({ env: {}, ownerId: PODMAN_TEST_OWNER });
  const { powers, tmpdirs } = makeStubScratchProvider();
  const factory = makeSandboxFactory({
    drivers: harden([driver]),
    scratchProvider: powers,
  });
  const handle = await E(factory).make(
    harden({
      rootfs: { kind: 'oci', ref: ALPINE_REF },
      network: 'none',
      backend: 'podman',
    }),
  );
  t.teardown(async () => {
    await E(handle).dispose();
    cleanupTmpdirs(tmpdirs);
  });
  await t.throwsAsync(() => E(handle).fork(), {
    message: /Phase 3/,
  });
});

test.serial(
  'podman serializes spawn and dispose in both orderings',
  async t => {
    t.timeout(20_000);
    if (!podmanAvailability.available || !podmanAvailability.imagePresent) {
      t.pass(
        `podman or alpine image not available: ${podmanAvailability.reason ?? 'image absent'}`,
      );
      return;
    }
    const ownerId = `${PODMAN_TEST_OWNER}-race`;
    const driver = makePodmanDriver({ env: {}, ownerId });
    const { powers, tmpdirs } = makeStubScratchProvider();
    const factory = makeSandboxFactory({
      drivers: harden([driver]),
      scratchProvider: powers,
    });
    t.teardown(() => cleanupTmpdirs(tmpdirs));

    const spawnFirst = await E(factory).make(
      harden({
        rootfs: { kind: 'oci', ref: ALPINE_REF },
        network: 'none',
        backend: 'podman',
      }),
    );
    const spawned = E(spawnFirst).spawn(
      harden(['/bin/sleep', '300']),
      harden({ captureStdout: false, captureStderr: false }),
    );
    const disposed = E(spawnFirst).dispose();
    // Disposal cancels a still-pending admission, so the spawn either
    // rejects as disposed or yields a handle whose wait() reports the
    // disposal; either way no labelled container may survive.
    /** @type {Awaited<typeof spawned> | undefined} */
    let proc;
    /** @type {Error | undefined} */
    let admissionError;
    try {
      proc = await spawned;
    } catch (e) {
      admissionError = /** @type {Error} */ (e);
    }
    await disposed;
    if (proc !== undefined) {
      await t.throwsAsync(() => E(proc).wait(), { message: /disposed/ });
    } else {
      t.regex(/** @type {Error} */ (admissionError).message, /disposed/);
    }
    await t.notThrowsAsync(() => waitForNoOwnedContainers(ownerId));
    await E(spawnFirst).dispose();

    const disposeFirst = await E(factory).make(
      harden({
        rootfs: { kind: 'oci', ref: ALPINE_REF },
        network: 'none',
        backend: 'podman',
      }),
    );
    await E(disposeFirst).dispose();
    await t.throwsAsync(() => E(disposeFirst).spawn(harden(['/bin/true'])), {
      message: /disposed/,
    });
    t.deepEqual(await listOwnedContainers(ownerId), []);
  },
);

test.serial('podman keeps split UTF-8 stdout separate from stderr', async t => {
  t.timeout(20_000);
  if (!podmanAvailability.available || !podmanAvailability.imagePresent) {
    t.pass(
      `podman or alpine image not available: ${podmanAvailability.reason ?? 'image absent'}`,
    );
    return;
  }
  const ownerId = `${PODMAN_TEST_OWNER}-split-streams`;
  const driver = makePodmanDriver({ env: {}, ownerId });
  const { powers, tmpdirs } = makeStubScratchProvider();
  const factory = makeSandboxFactory({
    drivers: harden([driver]),
    scratchProvider: powers,
  });
  const handle = await E(factory).make(
    harden({
      rootfs: { kind: 'oci', ref: ALPINE_REF },
      network: 'none',
      backend: 'podman',
    }),
  );
  t.teardown(async () => {
    await E(handle).dispose();
    cleanupTmpdirs(tmpdirs);
  });
  const proc = await E(handle).spawn(
    harden([
      '/bin/sh',
      '-c',
      "printf '\\342'; sleep 0.05; printf '\\202\\254'; printf err >&2",
    ]),
    harden({ stdoutByteLimit: 4n, stderrByteLimit: 4n }),
  );
  const [stdout, stderr, status] = await Promise.all([
    drainReader(await E(proc).stdout()),
    drainReader(await E(proc).stderr()),
    E(proc).wait(),
  ]);
  t.is(stdout.toString('utf8'), '€');
  t.is(stderr.toString('utf8'), 'err');
  t.deepEqual(status, { code: 0, signal: null });
  t.deepEqual(await listOwnedContainers(ownerId), []);
});

test.serial(
  'podman output cap kills a soft-refusing container with a pipe-holding descendant',
  async t => {
    t.timeout(20_000);
    if (!podmanAvailability.available || !podmanAvailability.imagePresent) {
      t.pass(
        `podman or alpine image not available: ${podmanAvailability.reason ?? 'image absent'}`,
      );
      return;
    }
    const ownerId = `${PODMAN_TEST_OWNER}-output-cap`;
    const driver = makePodmanDriver({ env: {}, ownerId });
    const { powers, tmpdirs } = makeStubScratchProvider();
    const factory = makeSandboxFactory({
      drivers: harden([driver]),
      scratchProvider: powers,
    });
    const handle = await E(factory).make(
      harden({
        rootfs: { kind: 'oci', ref: ALPINE_REF },
        network: 'none',
        backend: 'podman',
      }),
    );
    t.teardown(async () => {
      await E(handle).dispose();
      cleanupTmpdirs(tmpdirs);
    });
    const proc = await E(handle).spawn(
      harden([
        '/bin/sh',
        '-c',
        'trap "" TERM; (trap "" TERM; while :; do sleep 60; done) & printf 1234; while :; do sleep 60; done',
      ]),
      harden({ stdoutByteLimit: 4n, stderrByteLimit: 1024n }),
    );
    const stdout = drainReader(await E(proc).stdout()).catch(e => e);
    await t.throwsAsync(() => E(proc).wait(), {
      message: /stdout.*byte limit/,
    });
    await stdout;
    t.deepEqual(await listOwnedContainers(ownerId), []);
  },
);

test.serial(
  'podman timeout and repeated cancellation reap containers',
  async t => {
    t.timeout(30_000);
    if (!podmanAvailability.available || !podmanAvailability.imagePresent) {
      t.pass(
        `podman or alpine image not available: ${podmanAvailability.reason ?? 'image absent'}`,
      );
      return;
    }
    const ownerId = `${PODMAN_TEST_OWNER}-termination`;
    const driver = makePodmanDriver({ env: {}, ownerId });
    const { powers, tmpdirs } = makeStubScratchProvider();
    const factory = makeSandboxFactory({
      drivers: harden([driver]),
      scratchProvider: powers,
    });
    const handle = await E(factory).make(
      harden({
        rootfs: { kind: 'oci', ref: ALPINE_REF },
        network: 'none',
        backend: 'podman',
      }),
    );
    t.teardown(async () => {
      await E(handle).dispose();
      cleanupTmpdirs(tmpdirs);
    });

    // A 25 ms timeout usually fires while `podman create` is still
    // running, in which case the cancelled admission rejects the spawn
    // itself; when the container wins the race, wait() reports the
    // timeout instead. Either way nothing labelled may survive.
    /** @type {Error | undefined} */
    let admissionError;
    const timed = await E(handle)
      .spawn(
        harden(['/bin/sh', '-c', 'trap "" TERM; while :; do sleep 60; done']),
        harden({ timeoutMs: 25, captureStdout: false, captureStderr: false }),
      )
      .catch(e => {
        admissionError = /** @type {Error} */ (e);
        return undefined;
      });
    if (timed !== undefined) {
      await t.throwsAsync(() => E(timed).wait(), { message: /timed out/ });
    } else {
      t.regex(/** @type {Error} */ (admissionError).message, /timed out/);
    }
    await t.notThrowsAsync(() => waitForNoOwnedContainers(ownerId));

    const cancelled = await E(handle).spawn(
      harden(['/bin/sleep', '300']),
      harden({ captureStdout: false, captureStderr: false }),
    );
    await Promise.all([E(cancelled).kill(), E(cancelled).kill()]);
    await t.throwsAsync(() => E(cancelled).wait(), { message: /cancelled/ });
    await t.notThrowsAsync(() => waitForNoOwnedContainers(ownerId));
  },
);

test.serial('podman owner crash is reconciled by exact label', async t => {
  t.timeout(30_000);
  if (!podmanAvailability.available || !podmanAvailability.imagePresent) {
    t.pass(
      `podman or alpine image not available: ${podmanAvailability.reason ?? 'image absent'}`,
    );
    return;
  }
  const ownerId = `${PODMAN_TEST_OWNER}-owner-${Date.now().toString(16)}`;
  const scratch = nodeFs.mkdtempSync(
    nodePath.join(nodeOs.tmpdir(), 'endo-sandbox-podman-owner-'),
  );
  const fixture = new URL('./fixtures/podman-owner.js', import.meta.url);
  const owner = nodeSpawn(
    process.execPath,
    [fixture.pathname, ownerId, ALPINE_REF, scratch],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.teardown(async () => {
    try {
      owner.kill('SIGKILL');
    } catch {
      // already gone
    }
    const cleanupDriver = makePodmanDriver({ env: {}, ownerId });
    await cleanupDriver.probe();
    nodeFs.rmSync(scratch, { recursive: true, force: true });
  });
  /** @type {Buffer[]} */
  const stderr = [];
  owner.stderr?.on('data', chunk => stderr.push(chunk));
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error('podman owner fixture did not become ready')),
      15_000,
    );
    owner.stdout?.on('data', chunk => {
      output += String(chunk);
      if (output.includes('ready')) {
        clearTimeout(timer);
        resolve(undefined);
      }
    });
    owner.once('exit', code => {
      clearTimeout(timer);
      reject(
        new Error(
          `podman owner fixture exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`,
        ),
      );
    });
  });
  t.is((await listOwnedContainers(ownerId)).length, 1);
  const ownerExit = new Promise(resolve => owner.once('exit', resolve));
  owner.kill('SIGKILL');
  await ownerExit;

  const cleanupDriver = makePodmanDriver({ env: {}, ownerId });
  const cleanupProbe = await cleanupDriver.probe();
  t.true(cleanupProbe.available, cleanupProbe.reason);
  t.deepEqual(await listOwnedContainers(ownerId), []);
});

// ---------------------------------------------------------------------------
// $PATH synthesis
// ---------------------------------------------------------------------------

test('parseImagePathFromConfigEnv: extracts PATH from Config.Env', t => {
  // Shape mirrors `podman image inspect --format '{{json .Config.Env}}'`.
  const json = JSON.stringify([
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'LANG=C.UTF-8',
  ]);
  t.is(
    parseImagePathFromConfigEnv(json),
    '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  );
});

test('parseImagePathFromConfigEnv: returns null when no PATH key', t => {
  t.is(parseImagePathFromConfigEnv(JSON.stringify(['LANG=C.UTF-8'])), null);
  // Mapping onto DEFAULT_PATH is `resolveSlicePath`'s job; the parser
  // just signals "no PATH found" via null.
});

test('parseImagePathFromConfigEnv: tolerates malformed JSON', t => {
  t.is(parseImagePathFromConfigEnv('not json'), null);
  t.is(parseImagePathFromConfigEnv('{}'), null);
  t.is(parseImagePathFromConfigEnv('null'), null);
});

test('parseImagePathFromConfigEnv: tolerates non-string entries', t => {
  // A hostile or buggy image might surface non-string entries; the
  // parser must skip them rather than throw.
  t.is(parseImagePathFromConfigEnv(JSON.stringify([null, 42, {}])), null);
  t.is(parseImagePathFromConfigEnv(JSON.stringify([null, 'PATH=/x'])), '/x');
});

test('parseImagePathFromConfigEnv: empty PATH is honoured as empty string', t => {
  // An image that explicitly sets `ENV PATH=` is opting out — surface
  // the empty string so `resolveSlicePath` can fall back to DEFAULT_PATH
  // (its `imagePath !== ''` guard treats this case as "no image PATH").
  t.is(parseImagePathFromConfigEnv(JSON.stringify(['PATH='])), '');
});

test.serial(
  'alpine slice spawn sees the image-derived PATH (source: image)',
  async t => {
    if (!podmanAvailability.available || !podmanAvailability.imagePresent) {
      t.pass(
        `podman or alpine image not available: ${podmanAvailability.reason ?? 'image absent'}`,
      );
      return;
    }
    // Discover the image's own PATH so the assertion does not bake in
    // a particular Alpine release's choice; this also exercises the
    // same `podman image inspect` path the driver uses internally.
    const inspect = await podmanRun([
      'image',
      'inspect',
      '--format',
      '{{json .Config.Env}}',
      ALPINE_REF,
    ]);
    if (inspect.code !== 0) {
      t.pass(`podman image inspect failed: ${inspect.stderr.trim()}`);
      return;
    }
    const expectedPath = parseImagePathFromConfigEnv(inspect.stdout.trim());
    t.is(
      typeof expectedPath,
      'string',
      'alpine image is expected to declare a PATH in Config.Env',
    );
    // node:assert narrows expectedPath from `string | null` to `string`
    // for the type-checker; ava's t.is above already handled the
    // user-facing failure case.
    assert(typeof expectedPath === 'string');

    const driver = makePodmanDriver({ env: {}, ownerId: PODMAN_TEST_OWNER });
    const { powers, tmpdirs } = makeStubScratchProvider();
    const factory = makeSandboxFactory({
      drivers: harden([driver]),
      scratchProvider: powers,
    });
    const handle = await E(factory).make(
      harden({
        rootfs: { kind: 'oci', ref: ALPINE_REF },
        network: 'none',
        backend: 'podman',
      }),
    );
    t.teardown(async () => {
      await E(handle).dispose();
      cleanupTmpdirs(tmpdirs);
    });

    const proc = await E(handle).spawn(harden(['/bin/printenv', 'PATH']));
    const stdout = await drainReader(await E(proc).stdout());
    const exit = await E(proc).wait();
    t.is(exit.code, 0, 'printenv PATH should succeed');
    t.is(stdout.toString('utf8').trimEnd(), expectedPath);
    // Sanity: the image-derived PATH differs from our canonical
    // fallback (alpine puts /usr/local/sbin first), so this assertion
    // also confirms we did not silently slip into the fallback branch.
    t.not(
      stdout.toString('utf8').trimEnd(),
      DEFAULT_PATH,
      'image PATH should differ from DEFAULT_PATH for alpine',
    );

    const help = await E(handle).help();
    t.regex(
      help,
      new RegExp(
        `path: ${expectedPath?.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')} \\(source: image\\)`,
      ),
      'help() reports the image-derived PATH',
    );
  },
);

test.serial(
  'caller spec.env.PATH overrides the image-derived PATH (source: env)',
  async t => {
    if (!podmanAvailability.available || !podmanAvailability.imagePresent) {
      t.pass(
        `podman or alpine image not available: ${podmanAvailability.reason ?? 'image absent'}`,
      );
      return;
    }
    const callerPath = '/opt/myapp/bin:/usr/bin';
    const driver = makePodmanDriver({ env: {}, ownerId: PODMAN_TEST_OWNER });
    const { powers, tmpdirs } = makeStubScratchProvider();
    const factory = makeSandboxFactory({
      drivers: harden([driver]),
      scratchProvider: powers,
    });
    const handle = await E(factory).make(
      harden({
        rootfs: { kind: 'oci', ref: ALPINE_REF },
        network: 'none',
        backend: 'podman',
        env: { PATH: callerPath },
      }),
    );
    t.teardown(async () => {
      await E(handle).dispose();
      cleanupTmpdirs(tmpdirs);
    });

    const proc = await E(handle).spawn(harden(['/bin/printenv', 'PATH']));
    const stdout = await drainReader(await E(proc).stdout());
    const exit = await E(proc).wait();
    t.is(exit.code, 0);
    t.is(stdout.toString('utf8').trimEnd(), callerPath);

    const help = await E(handle).help();
    t.regex(
      help,
      new RegExp(
        `path: ${callerPath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')} \\(source: env\\)`,
      ),
      'help() reports the caller-supplied PATH',
    );
  },
);

test.serial(
  'image with no Config.Env PATH falls back to DEFAULT_PATH (source: fallback)',
  async t => {
    // Building a custom OCI image at test time is impractical here, so
    // we exercise the fallback branch through the driver's
    // `inspectImagePath` cache: stub the `child_process` module so
    // `podman image inspect` returns an empty `Config.Env`, then
    // observe `resolveSlicePath` picking `DEFAULT_PATH`.
    //
    // The integration counterpart (a real custom image) is covered in
    // the parser unit tests above; what matters here is that the
    // driver's full prepare path honours that branch and surfaces
    // `source: fallback` to `slice.help()`.
    if (!podmanAvailability.available || !podmanAvailability.imagePresent) {
      t.pass(
        `podman or alpine image not available: ${podmanAvailability.reason ?? 'image absent'}`,
      );
      return;
    }
    // Use an image whose Config.Env has no PATH by stripping it via a
    // throw-away tagged image.  `podman tag` is cheap; the new tag
    // points at the same layers but we override Config.Env via
    // `--config` on `podman commit`.  When that is unsupported on the
    // host's podman, fall back to a pass-through skip.
    const tag = `localhost/endo-sandbox-test-no-path:${Date.now().toString(16)}`;
    const created = await podmanRun([
      'create',
      '--name',
      `endo-sandbox-test-seed-${Date.now().toString(16)}`,
      ALPINE_REF,
      '/bin/true',
    ]);
    if (created.code !== 0) {
      t.pass(`could not seed temp container: ${created.stderr.trim()}`);
      return;
    }
    const seedName = created.stdout.trim();
    t.teardown(async () => {
      await podmanRun(['rm', '-f', seedName]);
      await podmanRun(['rmi', '-f', tag]);
    });
    // `podman commit -c "ENV PATH="` would set PATH to the empty
    // string; `--change "ENV "` is rejected.  The cleanest way to
    // produce a Config.Env without PATH is `--change-config` JSON
    // patching, which podman does not support directly.  We sidestep
    // this by committing with `PATH=` (empty value) — the parser
    // returns `''` for that, and `resolveSlicePath` then falls back
    // to DEFAULT_PATH (its `imagePath !== ''` guard).
    const committed = await podmanRun([
      'commit',
      '--change',
      'ENV PATH=',
      seedName,
      tag,
    ]);
    if (committed.code !== 0) {
      t.pass(`podman commit unsupported here: ${committed.stderr.trim()}`);
      return;
    }

    const driver = makePodmanDriver({ env: {}, ownerId: PODMAN_TEST_OWNER });
    const { powers, tmpdirs } = makeStubScratchProvider();
    const factory = makeSandboxFactory({
      drivers: harden([driver]),
      scratchProvider: powers,
    });
    const handle = await E(factory).make(
      harden({
        rootfs: { kind: 'oci', ref: tag },
        network: 'none',
        backend: 'podman',
      }),
    );
    t.teardown(async () => {
      await E(handle).dispose();
      cleanupTmpdirs(tmpdirs);
    });

    const proc = await E(handle).spawn(harden(['/bin/printenv', 'PATH']));
    const stdout = await drainReader(await E(proc).stdout());
    const exit = await E(proc).wait();
    t.is(exit.code, 0);
    t.is(stdout.toString('utf8').trimEnd(), DEFAULT_PATH);

    const help = await E(handle).help();
    t.regex(help, /path: .* \(source: fallback\)/);
  },
);

// ---------------------------------------------------------------------------
// Unit coverage for the driver's pure helpers and for probe-path behaviour
// driven through a stubbed child_process, so these run on hosts without
// podman.
// ---------------------------------------------------------------------------

test('reportsContainerGone recognises the already-removed family', t => {
  t.true(
    reportsContainerGone({
      stdout: '',
      stderr: 'Error: no such container 9f2a1c\n',
    }),
  );
  t.true(reportsContainerGone({ stdout: '', stderr: 'Error: no such object' }));
  t.true(
    reportsContainerGone({
      stdout: '',
      stderr: 'Error: container 9f2a1c does not exist in database',
    }),
  );
  // Live backend failures must reach the supervisor untouched.
  t.false(
    reportsContainerGone({
      stdout: '',
      stderr: 'Error: unlinking layer: permission denied',
    }),
  );
});

test('reportsContainerNotRunning tolerates an exited-but-unreaped container', t => {
  // podman's verbatim refusal when the operation handled SIGTERM but its
  // `rm -f` has not completed yet.
  t.true(
    reportsContainerNotRunning({
      stdout: '',
      stderr:
        'Error: can only kill running containers. 9f2a1c is in state exited: container state improper\n',
    }),
  );
  // A container that was created but never started refuses the same way.
  t.true(
    reportsContainerNotRunning({
      stdout: '',
      stderr: '9f2a1c is in state configured: container state improper',
    }),
  );
});

test('reportsContainerNotRunning keeps live backend failures distinguishable', t => {
  // The opposite state verdict shares podman's `container state improper`
  // sentinel, so the predicate must not key on that sentinel alone.
  t.false(
    reportsContainerNotRunning({
      stdout: '',
      stderr:
        'Error: cannot remove container 9f2a1c as it is running - running or paused containers cannot be removed without force: container state improper',
    }),
  );
  t.false(
    reportsContainerNotRunning({
      stdout: '',
      stderr: 'Error: writing blob: storage: no space left on device',
    }),
  );
  t.false(
    reportsContainerNotRunning({
      stdout: '',
      stderr:
        'Cannot connect to Podman. Please verify your connection: connection refused',
    }),
  );
  t.false(
    reportsContainerNotRunning({
      stdout: '',
      stderr: 'Error: OCI runtime error: permission denied',
    }),
  );
});

test('seccompSecurityOpt fails closed on an unmaterialised caller profile', t => {
  t.throws(
    () =>
      seccompSecurityOpt(harden({ profile: '{"defaultAction":"..."}' }), null),
    { message: /caller-supplied seccomp profile/ },
    'a requested profile with no path must not silently become the default',
  );
  t.is(
    seccompSecurityOpt(harden({ profile: '{}' }), '/tmp/endo/profile.json'),
    'seccomp=/tmp/endo/profile.json',
  );
});

test('seccompSecurityOpt leaves the built-in policies unchanged', t => {
  t.is(seccompSecurityOpt('default', null), undefined);
  t.is(seccompSecurityOpt('unconfined', null), 'seccomp=unconfined');
  // `unconfined` is explicit, so a stray materialised path cannot
  // upgrade or downgrade it.
  t.is(
    seccompSecurityOpt('unconfined', '/tmp/endo/profile.json'),
    'seccomp=unconfined',
  );
});

/**
 * Build a `child_process` stub that answers the podman probe path
 * (`--version`, `info`, the orphan sweep's `ps` / `rm -f`).
 *
 * @param {object} [options]
 * @param {string[]} [options.containers]  Names the orphan listing reports.
 * @param {(name: string) => { code: number, stderr: string }} [options.rm]
 *   Outcome for `podman rm -f <name>`; defaults to success.
 * @returns {{ childProcess: any, calls: Array<{ command: string, args: string[] }> }}
 */
const makeProbeStub = ({
  containers = [],
  rm = () => ({ code: 0, stderr: '' }),
} = {}) => {
  /** @type {Array<{ command: string, args: string[] }>} */
  const calls = [];
  const childProcess = {
    /**
     * @param {string} command
     * @param {string[]} args
     */
    spawn(command, args) {
      calls.push({ command, args: [...args] });
      let code = 0;
      let stdout = '';
      let stderr = '';
      if (command !== 'podman') {
        code = 1;
      } else if (args.includes('--version')) {
        stdout = 'podman version 5.8.0\n';
      } else if (args.includes('{{.Host.Security.Rootless}}')) {
        stdout = 'true\n';
      } else if (args.includes('{{.Host.OCIRuntime.Name}}')) {
        stdout = 'crun\n';
      } else if (args.includes('ps')) {
        stdout = containers.map(name => `${name}\n`).join('');
      } else if (args.includes('rm')) {
        ({ code, stderr } = rm(String(args.at(-1))));
      }

      const child = new EventEmitter();
      const stdoutStream = new PassThrough();
      const stderrStream = new PassThrough();
      Object.assign(child, { stdout: stdoutStream, stderr: stderrStream });
      void Promise.resolve().then(() => {
        stdoutStream.end(stdout);
        stderrStream.end(stderr);
        child.emit('close', code, null);
      });
      return child;
    },
  };
  return { childProcess, calls };
};

test('orphan sweep tolerates a container another sweep already removed', async t => {
  // Two probes race; the loser's `rm -f` finds the container gone. That is
  // the desired state, not a reason to report the backend unavailable.
  const { childProcess } = makeProbeStub({
    containers: ['owned-operation'],
    rm: name => ({
      code: 1,
      stderr: `Error: no such container ${name}\n`,
    }),
  });
  const driver = makePodmanDriver({
    childProcess,
    env: {},
    ownerId: 'formula-exact-owner',
  });
  const probe = await driver.probe();
  t.true(probe.available, probe.reason);
});

test('orphan sweep still fails closed on a live removal failure', async t => {
  const { childProcess } = makeProbeStub({
    containers: ['owned-operation'],
    rm: () => ({
      code: 1,
      stderr: 'Error: unlinking layer: permission denied\n',
    }),
  });
  const driver = makePodmanDriver({
    childProcess,
    env: {},
    ownerId: 'formula-exact-owner',
  });
  const probe = await driver.probe();
  t.false(probe.available);
  t.regex(probe.reason ?? '', /orphan removal failed/);
  t.false(probe.details?.lifecycle?.crashCleanup ?? true);
});

test('concurrent probes share one orphan sweep', async t => {
  const { childProcess, calls } = makeProbeStub({
    containers: ['owned-operation'],
  });
  const driver = makePodmanDriver({
    childProcess,
    env: {},
    ownerId: 'formula-exact-owner',
  });
  const [first, second] = await Promise.all([driver.probe(), driver.probe()]);
  t.true(first.available, first.reason);
  t.true(second.available, second.reason);
  const sweeps = calls.filter(call => call.args[0] === 'ps');
  // A second sweep could list and remove a container that a concurrently
  // admitted operation already spawned, so the memo must hold across the
  // whole listing, not just up to the first await.
  t.is(sweeps.length, 1);
  const removals = calls.filter(call => call.args[0] === 'rm');
  t.is(removals.length, 1);

  // The memo survives later probes too.
  const third = await driver.probe();
  t.true(third.available, third.reason);
  t.is(calls.filter(call => call.args[0] === 'ps').length, 1);
});

test('a failed orphan sweep is retried by the next probe', async t => {
  let attempt = 0;
  const { childProcess, calls } = makeProbeStub({
    containers: ['owned-operation'],
    rm: () => {
      attempt += 1;
      return attempt === 1
        ? { code: 1, stderr: 'Error: unlinking layer: permission denied\n' }
        : { code: 0, stderr: '' };
    },
  });
  const driver = makePodmanDriver({
    childProcess,
    env: {},
    ownerId: 'formula-exact-owner',
  });
  const failed = await driver.probe();
  t.false(failed.available);
  // A transient reconciliation failure must not condemn the driver for
  // the rest of its lifetime.
  const recovered = await driver.probe();
  t.true(recovered.available, recovered.reason);
  t.is(calls.filter(call => call.args[0] === 'ps').length, 2);
});
