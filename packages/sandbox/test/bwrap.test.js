// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { M } from '@endo/patterns';

import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { setTimeout } from 'node:timers';

import { assembleSliceArgv, makeBwrapDriver } from '../src/drivers/bwrap.js';
import { DEFAULT_PATH } from '../src/drivers/path.js';
import { makeSandboxFactory } from '../src/factory.js';
import { probeBwrapUserns } from '../src/probe-bwrap-userns.js';

const StubMountInterface = M.interface('Mount', {
  help: M.call().returns(M.string()),
  hostPath: M.call().returns(M.string()),
});

/**
 * Probe `bwrap --version`. Tests only run when bwrap is available on
 * the host. Returns a Promise so the caller can `await` it from a
 * `test.serial.before` hook.
 *
 * @returns {Promise<{ available: boolean; version?: string; reason?: string }>}
 */
const probeBwrap = async () => {
  await null;
  try {
    const result = nodeSpawn('bwrap', ['--version']);
    /** @type {Buffer[]} */
    const stdoutChunks = [];
    return await new Promise(resolve => {
      result.stdout?.on('data', c => stdoutChunks.push(c));
      result.once('error', e =>
        resolve({ available: false, reason: /** @type {Error} */ (e).message }),
      );
      result.once('close', code => {
        if (code !== 0) {
          resolve({ available: false, reason: `bwrap --version exit ${code}` });
          return;
        }
        const text = Buffer.concat(stdoutChunks).toString('utf8').trim();
        const m = text.match(/(\d+(?:\.\d+){0,3})/);
        resolve({ available: true, version: m ? m[1] : text });
      });
    });
  } catch (e) {
    return { available: false, reason: /** @type {Error} */ (e).message };
  }
};

/**
 * Combined availability flag.  `available` is true only when both the
 * `--version` probe and the user-namespace smoke test succeed.  When
 * the smoke test fails we keep the parsed version (so the "probe
 * reports available with a version" test still asserts the right
 * thing) but mark the slice tests as skipped with the smoke-test
 * stderr as the reason.
 *
 * @param {import('ava').ExecutionContext} t
 * @returns {Promise<boolean>}
 */
const bwrapCheck = async t => {
  const versionProbe = await probeBwrap();
  if (!versionProbe.available) {
    t.pass(`SKIP: bwrap version unavailable: ${versionProbe.reason}`);
    return false;
  }

  const usernsProbe = await probeBwrapUserns();
  if (!usernsProbe.available) {
    t.pass(`SKIP: bwrap slice unavailable: ${usernsProbe.reason}`);
    return false;
  }

  return true;
};

/**
 * Pretty-print stdout / stderr captures for inclusion in test
 * failure messages.  Trims trailing newlines and replaces empty
 * captures with "(empty)" so a missing stream is visually obvious.
 *
 * @param {string} label
 * @param {string} text
 * @returns {string}
 */
const formatCapture = (label, text) => {
  const trimmed = text.replace(/\n+$/, '');
  return `${label}=${trimmed === '' ? '(empty)' : JSON.stringify(trimmed)}`;
};

/**
 * Build a stub `SandboxPowers` that:
 *   1. mints a real tmpdir for `provideScratchMount` (returning a
 *      Mount-shaped fake whose only requirement is that
 *      `provideHostPath` can map it back to a host path),
 *   2. resolves any granted Mount cap to a real host path via the
 *      capToHostPath WeakMap.
 *
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
        nodePath.join(nodeOs.tmpdir(), `endo-sandbox-${petName}-`),
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

/**
 * @param {number} pid
 * @param {number} [timeoutMs]
 */
const waitForProcessGroupGone = async (pid, timeoutMs = 3000) => {
  await null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ESRCH') return;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`process group ${pid} survived bounded cleanup`);
};

test.serial('bwrap probe reports available with a version', async t => {
  // eslint-disable-next-line @jessie.js/safe-await-separator
  if (!(await bwrapCheck(t))) {
    return;
  }
  const driver = makeBwrapDriver({ env: {} });
  const probe = await driver.probe();
  t.true(probe.available, `probe should report available: ${probe.reason}`);
  t.is(typeof probe.version, 'string');
  t.regex(probe.version ?? '', /\d+\.\d+/);
});

test.serial(
  'listBackends() reports bwrap available via the factory',
  async t => {
    // eslint-disable-next-line @jessie.js/safe-await-separator
    if (!(await bwrapCheck(t))) {
      return;
    }
    const driver = makeBwrapDriver({ env: {} });
    const { powers } = makeStubScratchProvider();
    const factory = makeSandboxFactory({
      drivers: harden([driver]),
      scratchProvider: powers,
    });
    const backends = await E(factory).listBackends();
    t.is(backends.length, 1);
    t.is(backends[0].name, 'bwrap');
    t.true(backends[0].available);
    t.regex(backends[0].version ?? '', /\d+\.\d+/);
  },
);

/**
 * Match a bwrap-level diagnostic on stderr (line begins with `bwrap:`).
 * The argv-validation, mount-setup and namespace-creation paths all
 * emit this prefix, so this captures every case where bwrap itself —
 * not the in-slice command — produced the failure.
 */
const BWRAP_DIAGNOSTIC_RE = /^bwrap: .+$/m;

/**
 * Match the subset of bwrap-level failures that are environment-
 * transient: kernel namespace allocator returns EAGAIN ("Resource
 * temporarily unavailable"), ENOMEM ("Cannot allocate memory"), or
 * the slice is denied a PID ("Too many open files" via inotify
 * exhaustion).  These are not test bugs — they reflect contention
 * between concurrent userns operations on the host.  Retry; if they
 * persist, skip the test rather than failing it.
 */
const BWRAP_TRANSIENT_RE =
  /bwrap:.*(Resource temporarily unavailable|Cannot allocate memory|Too many open files)/i;

/**
 * Spawn a command in the slice and drain stdout / stderr fully so a
 * failed assertion can quote both streams.  Without this every test
 * that just checks `exit.code` reports "exit code 1" with no clue
 * whether bwrap itself failed (e.g. blocked userns), the user's argv
 * was wrong, or the in-slice command actually exited non-zero.
 *
 * Three classes of outcome:
 *   1. The slice ran the command — return `{ exit, stdout, stderr }`
 *      verbatim (callers may legitimately expect a non-zero exit).
 *   2. bwrap itself failed with a transient kernel-namespace error
 *      (EAGAIN / ENOMEM).  Retry with exponential backoff up to
 *      ~6 seconds total; if it still fails, mark the test as a
 *      pass-with-skip via `t.pass()` and return `null` so the caller
 *      can bail out before further assertions fire.
 *   3. bwrap itself failed with a definitive (non-transient) error.
 *      Fail the test with the bwrap diagnostic quoted so the cause
 *      is visible, and return the result so the caller still sees
 *      what happened.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {any} handle
 * @param {string[]} argv
 * @returns {Promise<{
 *   exit: { code: number | null, signal: string | null },
 *   stdout: string,
 *   stderr: string,
 * } | null>}
 */
const runInSlice = async (t, handle, argv) => {
  // Up to 6 attempts with exponential backoff: 200, 400, 800, 1600,
  // 3200ms — ~6.2s of cumulative waiting before we give up and skip.
  // This is much more aggressive than the previous 1.5s budget and
  // covers the case where another concurrent process (rootless
  // podman, another bwrap, a CI build step) is contending for
  // user-namespace allocations on the host.
  const transientRetries = 6;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  /**
   * @param {number} n
   * @returns {Promise<{
   *   exit: { code: number | null, signal: string | null },
   *   stdout: string,
   *   stderr: string,
   * } | null>}
   */
  const attempt = async n => {
    const proc = await E(handle).spawn(harden(argv));
    const stdoutPromise = drainReader(await E(proc).stdout());
    const stderrPromise = drainReader(await E(proc).stderr());
    const exit = await E(proc).wait();
    const [stdoutBytes, stderrBytes] = await Promise.all([
      stdoutPromise,
      stderrPromise,
    ]);
    const result = {
      exit,
      stdout: stdoutBytes.toString('utf8'),
      stderr: stderrBytes.toString('utf8'),
    };

    // Success or in-slice (non-bwrap) failure: hand back to caller.
    // Non-zero exits without a `bwrap:` diagnostic on stderr are the
    // in-slice command's exit code (e.g. /bin/sh failing to write to
    // a read-only mount), which is exactly what some tests assert on.
    if (result.exit.code === 0 || !BWRAP_DIAGNOSTIC_RE.test(result.stderr)) {
      return result;
    }

    // bwrap-level definitive failure: surface the diagnostic.
    if (!BWRAP_TRANSIENT_RE.test(result.stderr)) {
      const m = result.stderr.match(BWRAP_DIAGNOSTIC_RE);
      t.fail(
        `${argv}: bwrap itself failed (exit ${result.exit.code}): ${m ? m[0] : result.stderr.trim()}`,
      );
      return result;
    }

    // Transient kernel-namespace failure: backoff and retry.
    if (n < transientRetries) {
      return delay(200 * 2 ** (n - 1)).then(() => attempt(n + 1));
    }

    // Retries exhausted — skip rather than fail.  This is an
    // environment limitation (concurrent userns contention), not a
    // regression in the sandbox code under test.
    const m = result.stderr.match(BWRAP_DIAGNOSTIC_RE);
    t.pass(
      `SKIP: ${argv}: persistent transient bwrap failure after ${transientRetries} attempts (${m ? m[0] : result.stderr.trim()})`,
    );
    return null;
  };

  return attempt(1);
};

test.serial('host-bind slice spawns /bin/echo hello', async t => {
  // eslint-disable-next-line @jessie.js/safe-await-separator
  if (!(await bwrapCheck(t))) {
    return;
  }
  const driver = makeBwrapDriver({ env: {} });
  const { powers, tmpdirs } = makeStubScratchProvider();
  const factory = makeSandboxFactory({
    drivers: harden([driver]),
    scratchProvider: powers,
  });

  const handle = await E(factory).make(
    harden({
      rootfs: { kind: 'host-bind' },
      network: 'none',
    }),
  );
  t.teardown(async () => {
    await E(handle).dispose();
    for (const dir of tmpdirs) {
      try {
        nodeFs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  const result = await runInSlice(t, handle, ['/bin/echo', 'hello']);
  if (result === null) return;
  t.is(
    result.exit.code,
    0,
    `exit code 0, got ${result.exit.code}; ${formatCapture('stdout', result.stdout)} ${formatCapture('stderr', result.stderr)}`,
  );
  t.true(
    result.stdout.startsWith('hello'),
    `stdout should start with "hello"; ${formatCapture('stdout', result.stdout)} ${formatCapture('stderr', result.stderr)}`,
  );
});

test.serial('read-only mount rejects writes from inside the slice', async t => {
  // eslint-disable-next-line @jessie.js/safe-await-separator
  if (!(await bwrapCheck(t))) {
    return;
  }
  const driver = makeBwrapDriver({ env: {} });
  const { powers, makeMountCapForPath, tmpdirs } = makeStubScratchProvider();
  const factory = makeSandboxFactory({
    drivers: harden([driver]),
    scratchProvider: powers,
  });

  // Set up a real host directory that we'll grant as read-only.
  const roHost = nodeFs.mkdtempSync(
    nodePath.join(nodeOs.tmpdir(), 'endo-sandbox-ro-'),
  );
  tmpdirs.push(roHost);
  nodeFs.writeFileSync(nodePath.join(roHost, 'sentinel'), 'baseline\n');

  const roMountCap = makeMountCapForPath(roHost);
  const handle = await E(factory).make(
    harden({
      rootfs: { kind: 'host-bind' },
      mounts: [{ cap: roMountCap, innerPath: '/ro', mode: 'ro' }],
      network: 'none',
    }),
  );
  t.teardown(async () => {
    await E(handle).dispose();
    for (const dir of tmpdirs) {
      try {
        nodeFs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  // Attempt to write to /ro — should fail with non-zero exit.
  const result = await runInSlice(t, handle, [
    '/bin/sh',
    '-c',
    'echo nope > /ro/should-fail',
  ]);
  if (result === null) return;
  t.not(
    result.exit.code,
    0,
    `write to /ro should fail; ${formatCapture('stdout', result.stdout)} ${formatCapture('stderr', result.stderr)}`,
  );
  t.regex(
    result.stderr,
    /Read-only file system|Permission denied|read-only/i,
    `stderr should mention read-only; ${formatCapture('stderr', result.stderr)}`,
  );

  // Sanity: the RO file is still readable from inside.
  const sanity = await runInSlice(t, handle, ['/bin/cat', '/ro/sentinel']);
  if (sanity === null) return;
  t.is(
    sanity.exit.code,
    0,
    `cat /ro/sentinel exit 0, got ${sanity.exit.code}; ${formatCapture('stderr', sanity.stderr)}`,
  );
  t.is(sanity.stdout, 'baseline\n');
});

test.serial('network: none blocks loopback reach', async t => {
  // eslint-disable-next-line @jessie.js/safe-await-separator
  if (!(await bwrapCheck(t))) {
    return;
  }
  const driver = makeBwrapDriver({ env: {} });
  const { powers, tmpdirs } = makeStubScratchProvider();
  const factory = makeSandboxFactory({
    drivers: harden([driver]),
    scratchProvider: powers,
  });

  const handle = await E(factory).make(
    harden({
      rootfs: { kind: 'host-bind' },
      network: 'none',
    }),
  );
  t.teardown(async () => {
    await E(handle).dispose();
    for (const dir of tmpdirs) {
      try {
        nodeFs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  // Verify the slice cannot reach any non-loopback network: under
  // bwrap's `--unshare-all` (which `network: 'none'` triggers), the
  // private netns has only `lo`; external interfaces are absent, so
  // a TCP connect to a non-loopback host is unreachable.  The kernel
  // brings up `lo` automatically inside a user-netns, so we cannot
  // claim 127.0.0.1 is unreachable here — that is the
  // `host-loopback` profile's job, deferred to Phase 1.5.  What we
  // can claim is that an external address (e.g. 10.0.0.1, an
  // RFC 1918 address that is almost certainly NOT routable from a
  // fresh netns with no interfaces) returns ENETUNREACH.
  const cmd =
    'if exec 3<>/dev/tcp/10.0.0.1/1 2>/dev/null; then echo connected; else echo blocked; fi';
  const result = await runInSlice(t, handle, ['/bin/bash', '-c', cmd]);
  if (result === null) return;
  t.regex(
    result.stdout,
    /blocked/,
    `connect to external host should fail; ${formatCapture('stdout', result.stdout)} ${formatCapture('stderr', result.stderr)}`,
  );
  t.notRegex(
    result.stdout,
    /connected/,
    `connect should not have succeeded; ${formatCapture('stdout', result.stdout)}`,
  );

  // Verify there are no non-loopback interfaces.  The fresh netns
  // should only have `lo`.
  const ifaceResult = await runInSlice(t, handle, [
    '/bin/sh',
    '-c',
    'ls /sys/class/net 2>/dev/null || true',
  ]);
  if (ifaceResult === null) return;
  const ifaces = ifaceResult.stdout
    .split('\n')
    .map(s => s.trim())
    .filter(s => s !== '');
  t.deepEqual(
    ifaces.filter(i => i !== 'lo').sort(),
    [],
    `no non-loopback interfaces in network: none; ${formatCapture('stdout', ifaceResult.stdout)} ${formatCapture('stderr', ifaceResult.stderr)}`,
  );
});

test.serial(
  'private network profile is accepted but pasta wiring is Phase 1.5',
  async t => {
    // eslint-disable-next-line @jessie.js/safe-await-separator
    if (!(await bwrapCheck(t))) {
      return;
    }
    // Phase 1 accepts `network: 'private'` for slice construction;
    // the egress filter is documented in src/net/private-egress.nft.
    // Full wiring (pasta + nft) lands alongside the first consumer.
    const driver = makeBwrapDriver({ env: {} });
    const { powers, tmpdirs } = makeStubScratchProvider();
    const factory = makeSandboxFactory({
      drivers: harden([driver]),
      scratchProvider: powers,
    });
    const handle = await E(factory).make(
      harden({
        rootfs: { kind: 'host-bind' },
        network: 'private',
      }),
    );
    t.teardown(async () => {
      await E(handle).dispose();
      for (const dir of tmpdirs) {
        try {
          nodeFs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    });
    t.truthy(handle, 'private slice constructed');
  },
);

test.serial(
  'host-net profile shares the host net namespace (Phase 1.5)',
  async t => {
    // eslint-disable-next-line @jessie.js/safe-await-separator
    if (!(await bwrapCheck(t))) {
      return;
    }
    const driver = makeBwrapDriver({ env: {} });
    const { powers, tmpdirs } = makeStubScratchProvider();
    const factory = makeSandboxFactory({
      drivers: harden([driver]),
      scratchProvider: powers,
    });
    const handle = await E(factory).make(
      harden({
        rootfs: { kind: 'host-bind' },
        network: 'host-net',
      }),
    );
    t.teardown(async () => {
      await E(handle).dispose();
      for (const dir of tmpdirs) {
        try {
          nodeFs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    });
    // host-net keeps the host's network namespace, so the slice sees
    // every interface the host has (at least `lo` plus typically a
    // physical / veth interface). We read `/proc/net/dev`, which is
    // per-netns: it shows the host's interfaces when the netns is
    // shared and only `lo` when it is not.  Sysfs is not bind-mounted
    // into the slice (the rootfs only binds /usr, /lib, /etc, etc.),
    // so we cannot use `/sys/class/net` here.
    const result = await runInSlice(t, handle, ['/bin/cat', '/proc/net/dev']);
    if (result === null) return;
    t.is(
      result.exit.code,
      0,
      `cat /proc/net/dev should succeed; ${formatCapture('stdout', result.stdout)} ${formatCapture('stderr', result.stderr)}`,
    );
    // /proc/net/dev format:
    //   Inter-|   Receive                                                |  Transmit
    //    face |bytes    packets errs drop fifo frame compressed multicast|bytes ...
    //       lo: ...
    //     eth0: ...
    const ifaces = result.stdout
      .split('\n')
      .slice(2) // skip the two header rows
      .map(line => line.trim().split(':')[0]?.trim() ?? '')
      .filter(name => name !== '');
    t.true(
      ifaces.includes('lo'),
      `host loopback visible inside host-net slice; ${formatCapture('stdout', result.stdout)}`,
    );
    // We do not assert a specific non-loopback interface name (CI may
    // run without one); we only assert the slice could enumerate the
    // host's interfaces, which proves the netns is shared.
  },
);

test.serial('host-loopback profile is accepted', async t => {
  // eslint-disable-next-line @jessie.js/safe-await-separator
  if (!(await bwrapCheck(t))) {
    return;
  }
  const driver = makeBwrapDriver({ env: {} });
  const { powers, tmpdirs } = makeStubScratchProvider();
  const factory = makeSandboxFactory({
    drivers: harden([driver]),
    scratchProvider: powers,
  });
  const handle = await E(factory).make(
    harden({
      rootfs: { kind: 'host-bind' },
      network: 'host-loopback',
    }),
  );
  t.teardown(async () => {
    await E(handle).dispose();
    for (const dir of tmpdirs) {
      try {
        nodeFs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
  // Slice constructs and can enumerate interfaces; the actual
  // host-loopback firewall (drop everything except 127.0.0.0/8 / ::1)
  // is the operator's responsibility because rootless slices lack
  // CAP_NET_ADMIN. See README § "Host network profiles".
  const result = await runInSlice(t, handle, ['/bin/echo', 'ok']);
  if (result === null) return;
  t.is(
    result.exit.code,
    0,
    `host-loopback slice spawns successfully; ${formatCapture('stdout', result.stdout)} ${formatCapture('stderr', result.stderr)}`,
  );
});

test.serial('host-lan profile is accepted', async t => {
  // eslint-disable-next-line @jessie.js/safe-await-separator
  if (!(await bwrapCheck(t))) {
    return;
  }
  const driver = makeBwrapDriver({ env: {} });
  const { powers, tmpdirs } = makeStubScratchProvider();
  const factory = makeSandboxFactory({
    drivers: harden([driver]),
    scratchProvider: powers,
  });
  const handle = await E(factory).make(
    harden({
      rootfs: { kind: 'host-bind' },
      network: 'host-lan',
    }),
  );
  t.teardown(async () => {
    await E(handle).dispose();
    for (const dir of tmpdirs) {
      try {
        nodeFs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
  const result = await runInSlice(t, handle, ['/bin/echo', 'ok']);
  if (result === null) return;
  t.is(
    result.exit.code,
    0,
    `host-lan slice spawns successfully; ${formatCapture('stdout', result.stdout)} ${formatCapture('stderr', result.stderr)}`,
  );
});

test.serial(
  'slice.help() reports the Landlock and prlimit hardening layers',
  async t => {
    // eslint-disable-next-line @jessie.js/safe-await-separator
    if (!(await bwrapCheck(t))) {
      return;
    }
    const driver = makeBwrapDriver({ env: {} });
    const { powers, tmpdirs } = makeStubScratchProvider();
    const factory = makeSandboxFactory({
      drivers: harden([driver]),
      scratchProvider: powers,
    });
    const handle = await E(factory).make(
      harden({
        rootfs: { kind: 'host-bind' },
        network: 'none',
      }),
    );
    t.teardown(async () => {
      await E(handle).dispose();
      for (const dir of tmpdirs) {
        try {
          nodeFs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    });
    const help = await E(handle).help();
    t.regex(help, /Hardening layers in effect:/);
    t.regex(help, /network: none/);
    // Landlock line is always present — the kernel may or may not
    // support it, but the report row is unconditional.
    t.regex(help, /landlock: (available|unavailable|not detected)/);
    t.regex(help, /cgroup2: (available|unavailable|not detected)/);
    // The factory applies DEFAULT_LIMITS (which always includes nproc
    // and as), so prlimit always shows at least one applied flag.
    t.regex(help, /prlimit: prlimit /);
    t.regex(help, /--nproc=/);
  },
);

test.serial('prlimit nproc cap is enforced inside the slice', async t => {
  // eslint-disable-next-line @jessie.js/safe-await-separator
  if (!(await bwrapCheck(t))) {
    return;
  }
  // Ask for an `nproc` ceiling that is comfortably above the
  // ambient process count for this user (so the slice itself can
  // start) but well below what a fork bomb would try to reach. We
  // pick a per-uid budget anchored on the current user's process
  // count; if the host is too noisy we skip rather than flake.
  let baselineProcs;
  try {
    baselineProcs = nodeFs
      .readdirSync('/proc')
      .filter(name => /^\d+$/.test(name)).length;
  } catch {
    t.pass('cannot read /proc to size the nproc test');
    return;
  }
  // Add a generous cushion so test infra processes are not the
  // ones that hit the cap.  RLIMIT_NPROC is per-uid for the host
  // UID after the userns mapping; this is the documented and
  // expected behaviour.
  const cap = baselineProcs + 32;
  const driver = makeBwrapDriver({ env: {} });
  const { powers, tmpdirs } = makeStubScratchProvider();
  const factory = makeSandboxFactory({
    drivers: harden([driver]),
    scratchProvider: powers,
  });
  const handle = await E(factory).make(
    harden({
      rootfs: { kind: 'host-bind' },
      network: 'none',
      limits: { nproc: cap },
    }),
  );
  t.teardown(async () => {
    await E(handle).dispose();
    for (const dir of tmpdirs) {
      try {
        nodeFs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
  // /bin/sh's `ulimit -u` reports RLIMIT_NPROC, the same value
  // prlimit set.  We assert the cap is in effect rather than
  // running an actual fork bomb (which would also stress the host
  // the test process is running on).
  const result = await runInSlice(t, handle, ['/bin/sh', '-c', 'ulimit -u']);
  if (result === null) return;
  t.is(
    result.exit.code,
    0,
    `ulimit -u exit code 0 (got ${result.exit.code}); ${formatCapture('stdout', result.stdout)} ${formatCapture('stderr', result.stderr)}`,
  );
  const reported = Number(result.stdout.trim());
  t.is(
    reported,
    cap,
    `slice should observe RLIMIT_NPROC=${cap}, got ${reported}; ${formatCapture('stdout', result.stdout)} ${formatCapture('stderr', result.stderr)}`,
  );
});

test.serial('fork() throws notImplemented before Phase 3', async t => {
  // eslint-disable-next-line @jessie.js/safe-await-separator
  if (!(await bwrapCheck(t))) {
    return;
  }
  const driver = makeBwrapDriver({ env: {} });
  const { powers, tmpdirs } = makeStubScratchProvider();
  const factory = makeSandboxFactory({
    drivers: harden([driver]),
    scratchProvider: powers,
  });
  const handle = await E(factory).make(
    harden({
      rootfs: { kind: 'host-bind' },
      network: 'none',
    }),
  );
  t.teardown(async () => {
    await E(handle).dispose();
    for (const dir of tmpdirs) {
      try {
        nodeFs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
  await t.throwsAsync(() => E(handle).fork(), {
    message: /Phase 3/,
  });
});

test.serial('bwrap serializes spawn and dispose in both orderings', async t => {
  t.timeout(10_000);
  // eslint-disable-next-line @jessie.js/safe-await-separator
  if (!(await bwrapCheck(t))) return;
  const driver = makeBwrapDriver({ env: {} });
  const { powers, tmpdirs } = makeStubScratchProvider();
  const factory = makeSandboxFactory({
    drivers: harden([driver]),
    scratchProvider: powers,
  });
  t.teardown(() => {
    for (const dir of tmpdirs)
      nodeFs.rmSync(dir, { recursive: true, force: true });
  });

  const spawnFirst = await E(factory).make(
    harden({ rootfs: { kind: 'host-bind' }, network: 'none' }),
  );
  const spawned = E(spawnFirst).spawn(
    harden(['/bin/sleep', '300']),
    harden({ captureStdout: false, captureStderr: false }),
  );
  const disposed = E(spawnFirst).dispose();
  // If disposal wins before spawn settles, spawn rejects; otherwise wait()
  // reports disposal. Either arm must leave the process group gone.
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
    const pid = await E(proc).pid();
    await t.throwsAsync(() => E(proc).wait(), { message: /disposed/ });
    await waitForProcessGroupGone(pid);
  } else {
    t.regex(/** @type {Error} */ (admissionError).message, /disposed/);
  }
  await E(spawnFirst).dispose();

  const disposeFirst = await E(factory).make(
    harden({ rootfs: { kind: 'host-bind' }, network: 'none' }),
  );
  await E(disposeFirst).dispose();
  await t.throwsAsync(() => E(disposeFirst).spawn(harden(['/bin/true'])), {
    message: /disposed/,
  });
});

test.serial('bwrap keeps split UTF-8 stdout separate from stderr', async t => {
  t.timeout(10_000);
  // eslint-disable-next-line @jessie.js/safe-await-separator
  if (!(await bwrapCheck(t))) return;
  const driver = makeBwrapDriver({ env: {} });
  const { powers, tmpdirs } = makeStubScratchProvider();
  const factory = makeSandboxFactory({
    drivers: harden([driver]),
    scratchProvider: powers,
  });
  const handle = await E(factory).make(
    harden({ rootfs: { kind: 'host-bind' }, network: 'none' }),
  );
  t.teardown(async () => {
    await E(handle).dispose();
    for (const dir of tmpdirs)
      nodeFs.rmSync(dir, { recursive: true, force: true });
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
});

test.serial(
  'bwrap output cap kills a soft-refusing group with a pipe-holding descendant',
  async t => {
    t.timeout(10_000);
    // eslint-disable-next-line @jessie.js/safe-await-separator
    if (!(await bwrapCheck(t))) return;
    const driver = makeBwrapDriver({ env: {} });
    const { powers, tmpdirs } = makeStubScratchProvider();
    const factory = makeSandboxFactory({
      drivers: harden([driver]),
      scratchProvider: powers,
    });
    const handle = await E(factory).make(
      harden({ rootfs: { kind: 'host-bind' }, network: 'none' }),
    );
    t.teardown(async () => {
      await E(handle).dispose();
      for (const dir of tmpdirs)
        nodeFs.rmSync(dir, { recursive: true, force: true });
    });
    const proc = await E(handle).spawn(
      harden([
        '/bin/sh',
        '-c',
        'trap "" TERM; (trap "" TERM; while :; do sleep 60; done) & printf 1234; while :; do sleep 60; done',
      ]),
      harden({ stdoutByteLimit: 4n, stderrByteLimit: 1024n }),
    );
    const pid = await E(proc).pid();
    const stdout = drainReader(await E(proc).stdout()).catch(e => e);
    await t.throwsAsync(() => E(proc).wait(), {
      message: /stdout.*byte limit/,
    });
    await stdout;
    await waitForProcessGroupGone(pid);
  },
);

test.serial(
  'bwrap timeout and repeated cancellation reap process groups',
  async t => {
    t.timeout(15_000);
    // eslint-disable-next-line @jessie.js/safe-await-separator
    if (!(await bwrapCheck(t))) return;
    const driver = makeBwrapDriver({ env: {} });
    const { powers, tmpdirs } = makeStubScratchProvider();
    const factory = makeSandboxFactory({
      drivers: harden([driver]),
      scratchProvider: powers,
    });
    const handle = await E(factory).make(
      harden({ rootfs: { kind: 'host-bind' }, network: 'none' }),
    );
    t.teardown(async () => {
      await E(handle).dispose();
      for (const dir of tmpdirs)
        nodeFs.rmSync(dir, { recursive: true, force: true });
    });

    // Timeout may win before spawn settles (spawn rejects) or afterwards
    // (wait() reports timeout); either arm must leave the process group gone.
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
      const timedPid = await E(timed).pid();
      await t.throwsAsync(() => E(timed).wait(), { message: /timed out/ });
      await waitForProcessGroupGone(timedPid);
    } else {
      t.regex(/** @type {Error} */ (admissionError).message, /timed out/);
    }

    const cancelled = await E(handle).spawn(
      harden(['/bin/sleep', '300']),
      harden({ captureStdout: false, captureStderr: false }),
    );
    const cancelledPid = await E(cancelled).pid();
    await Promise.all([E(cancelled).kill(), E(cancelled).kill()]);
    await t.throwsAsync(() => E(cancelled).wait(), { message: /cancelled/ });
    await waitForProcessGroupGone(cancelledPid);
  },
);

test.serial('bwrap parent death leaves no owned process group', async t => {
  t.timeout(10_000);
  // eslint-disable-next-line @jessie.js/safe-await-separator
  if (!(await bwrapCheck(t))) return;
  const scratch = nodeFs.mkdtempSync(
    nodePath.join(nodeOs.tmpdir(), 'endo-sandbox-owner-death-'),
  );
  const fixture = new URL('./fixtures/bwrap-owner.js', import.meta.url);
  const owner = nodeSpawn(process.execPath, [fixture.pathname, scratch], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.teardown(() => {
    try {
      owner.kill('SIGKILL');
    } catch {
      // already gone
    }
    nodeFs.rmSync(scratch, { recursive: true, force: true });
  });
  /** @type {Buffer[]} */
  const stderr = [];
  owner.stderr?.on('data', chunk => stderr.push(chunk));
  const pid = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error('bwrap owner fixture did not become ready')),
      5000,
    );
    owner.stdout?.on('data', chunk => {
      output += String(chunk);
      const match = output.match(/^(\d+)$/m);
      if (match !== null) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    owner.once('exit', code => {
      clearTimeout(timer);
      reject(
        new Error(
          `bwrap owner fixture exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`,
        ),
      );
    });
  });
  owner.kill('SIGKILL');
  await new Promise(resolve => owner.once('close', resolve));
  await waitForProcessGroupGone(/** @type {number} */ (pid));
  t.pass('parent death reaped the owned process group');
});

// --- PATH synthesis tests --------------------------------------------------
//
// These exercise `assembleSliceArgv` directly without spawning bwrap so
// they run on every host (including non-Linux CI matrix entries).  They
// assert the `--setenv PATH …` argv slot reflects the `$PATH` synthesis
// rules (see § "$PATH semantics" in the README) for each rootfs shape.

/**
 * Pull the `--setenv PATH …` value out of an argv produced by
 * `assembleSliceArgv`.  Returns `undefined` when no `PATH` setenv pair
 * is present.
 *
 * @param {string[]} argv
 * @returns {string | undefined}
 */
const extractSetenvPath = argv => {
  for (let i = 0; i < argv.length - 2; i += 1) {
    if (argv[i] === '--setenv' && argv[i + 1] === 'PATH') {
      return argv[i + 2];
    }
  }
  return undefined;
};

/**
 * Build a minimal `SliceSpec` for the synthesis tests.  The factory's
 * defaults (limits, seccomp, scratch) are irrelevant here because we
 * bypass the factory and call `assembleSliceArgv` directly.
 *
 * @param {Partial<import('../src/types.js').SliceSpec> & { rootfs: import('../src/types.js').SliceSpec['rootfs'] }} overrides
 * @returns {import('../src/types.js').SliceSpec}
 */
const makeStubSpec = overrides =>
  /** @type {any} */ (
    harden({
      mounts: [],
      scratchHostPath: '',
      network: 'none',
      seccomp: 'default',
      env: {},
      ...overrides,
    })
  );

test('PATH synthesis: host-bind seeds the canonical user-first default', async t => {
  const argv = await assembleSliceArgv(
    makeStubSpec({ rootfs: { kind: 'host-bind' } }),
    {
      seccompFd: null,
      ambientPath: '',
      exists: () => true,
    },
  );
  const path = extractSetenvPath(argv);
  t.is(
    path,
    DEFAULT_PATH,
    'host-bind without ambient PATH should match the canonical default',
  );
  // Sanity: the canonical default is user-first.
  t.true(
    /** @type {string} */ (path).indexOf('/usr/bin') <
      /** @type {string} */ (path).indexOf('/sbin'),
    'user bin dirs should appear before /sbin in the default PATH',
  );
});

test('PATH synthesis: host-bind appends ambient survivors after canonical bins', async t => {
  const ambientPath = [
    '/opt/local/bin',
    '/snap/bin',
    '/var/lib/flatpak/exports/bin',
    '/home/alice/bin', // dropped — under /home
    '/tmp/bin', // dropped — under /tmp
    'relative/bin', // dropped — not absolute
    '/usr/bin', // dropped — already in canonical set
    '/opt/foo/../bar', // dropped — contains ..
  ].join(':');
  const argv = await assembleSliceArgv(
    makeStubSpec({ rootfs: { kind: 'host-bind' } }),
    {
      seccompFd: null,
      ambientPath,
      exists: () => true,
    },
  );
  const path = extractSetenvPath(argv);
  t.true(
    /** @type {string} */ (path).startsWith(DEFAULT_PATH),
    'canonical default should be the prefix',
  );
  t.regex(
    /** @type {string} */ (path),
    /\/opt\/local\/bin/,
    '/opt entries should be inherited',
  );
  t.regex(/** @type {string} */ (path), /\/snap\/bin/);
  t.regex(/** @type {string} */ (path), /\/var\/lib\/flatpak\/exports\/bin/);
  t.notRegex(
    /** @type {string} */ (path),
    /\/home\//,
    '/home entries must be dropped from synthesised PATH',
  );
  t.notRegex(
    /** @type {string} */ (path),
    /\/tmp\//,
    '/tmp entries must be dropped from synthesised PATH',
  );
  t.notRegex(/** @type {string} */ (path), /\.\./, 'no .. segments survive');
  // Survivors are elevated to a package-root mount (the bin dir alone
  // exposes dangling symlinks into siblings like `lib/`), so the
  // `--ro-bind-try` pair binds the parent and the bin-dir entry only
  // appears on `$PATH`.
  t.true(
    argv.includes('/opt/local'),
    'survivor /opt/local/bin should be elevated to /opt/local for binding',
  );
  t.false(
    argv.includes('/opt/local/bin'),
    'the unelevated bin dir should not be bound separately',
  );
  // The argv pattern is `--ro-bind-try src dst`; check src AND dst for
  // the elevated `/snap` mount that covers `/snap/bin`.
  for (let i = 0; i < argv.length - 2; i += 1) {
    if (argv[i] === '--ro-bind-try' && argv[i + 1] === '/snap') {
      t.is(argv[i + 2], '/snap', 'binds elevated host path to itself');
      return;
    }
  }
  t.fail('/snap/bin survivor should appear as /snap in a --ro-bind-try pair');
});

test('mount dedup: survivors under canonical roots do not emit redundant binds', async t => {
  // `/usr/bin/site_perl` and `/usr/lib/jvm/default/bin` are PATH
  // entries that survive the textual filter (they are not literal
  // CANONICAL_BIN_PATHS) but live entirely under `/usr`, which the
  // host-bind rootfs already mounts.  The dedup logic must collapse
  // them so we never emit a second `--ro-bind-try` for a path the
  // parent mount already covers.
  const argv = await assembleSliceArgv(
    makeStubSpec({ rootfs: { kind: 'host-bind' } }),
    {
      seccompFd: null,
      ambientPath: '/usr/bin/site_perl:/usr/lib/jvm/default/bin:/opt/rocm/bin',
      exists: () => true,
    },
  );
  // Count `--ro-bind-try` pairs whose host path starts with `/usr`.
  // The canonical `/usr` bind from HOST_BIND_ROOTFS_PATHS is one; no
  // survivor under it should add another.
  let usrBindCount = 0;
  for (let i = 0; i < argv.length - 2; i += 1) {
    if (
      argv[i] === '--ro-bind-try' &&
      typeof argv[i + 1] === 'string' &&
      (argv[i + 1] === '/usr' || argv[i + 1].startsWith('/usr/'))
    ) {
      usrBindCount += 1;
    }
  }
  t.is(usrBindCount, 1, '/usr bind appears once even with /usr/* survivors');
  // The PATH entries are still recorded so commands resolve at the
  // operator-supplied locations.
  const path = /** @type {string} */ (extractSetenvPath(argv));
  t.regex(path, /\/usr\/bin\/site_perl/);
  t.regex(path, /\/usr\/lib\/jvm\/default\/bin/);
  // /opt/rocm/bin elevates to /opt/rocm; the bin dir is on PATH but
  // the mount is the package root.
  t.true(
    argv.includes('/opt/rocm'),
    '/opt/rocm/bin survivor elevates to /opt/rocm mount',
  );
  t.false(
    argv.includes('/opt/rocm/bin'),
    'unelevated /opt/rocm/bin is not bound separately',
  );
  t.regex(path, /\/opt\/rocm\/bin/, '/opt/rocm/bin still appears on PATH');
});

test('mount dedup: flatpak survivor elevates past /exports', async t => {
  // `/var/lib/flatpak/exports/bin/foo` is a shell wrapper that execs
  // into `/var/lib/flatpak/app/...`; binding only `/var/lib/flatpak/exports`
  // would still leave dangling references.  Elevate one extra level
  // past the trailing `/exports` segment so the slice can resolve the
  // wrapper's downstream paths.
  const argv = await assembleSliceArgv(
    makeStubSpec({ rootfs: { kind: 'host-bind' } }),
    {
      seccompFd: null,
      ambientPath: '/var/lib/flatpak/exports/bin',
      exists: () => true,
    },
  );
  t.true(
    argv.includes('/var/lib/flatpak'),
    'flatpak bin dir elevates to the package root',
  );
  t.false(
    argv.includes('/var/lib/flatpak/exports'),
    'intermediate /exports parent is not the elevation target',
  );
  t.false(
    argv.includes('/var/lib/flatpak/exports/bin'),
    'unelevated bin dir is not bound separately',
  );
  // PATH still points at the operator-supplied bin dir inside the
  // elevated mount.
  const path = /** @type {string} */ (extractSetenvPath(argv));
  t.regex(path, /\/var\/lib\/flatpak\/exports\/bin/);
});

test('mount dedup: HOST_BIND_ROOTFS_PATHS entries deduplicate against /usr', async t => {
  // The default HOST_BIND_ROOTFS_PATHS list is already arranged so
  // `/usr` precedes `/lib`, `/lib32`, `/lib64`, `/bin`, `/sbin`, and
  // `/etc`.  Those siblings are NOT redundant against `/usr` (they
  // are top-level paths, not children), so each gets its own bind.
  // A subsequent survivor under `/usr` *would* be redundant; this test
  // pins the non-redundant case to guard against an over-eager dedup
  // that swallows the legitimate sibling binds.
  const argv = await assembleSliceArgv(
    makeStubSpec({ rootfs: { kind: 'host-bind' } }),
    {
      seccompFd: null,
      ambientPath: '',
      exists: () => true,
    },
  );
  for (const expected of [
    '/usr',
    '/lib',
    '/lib32',
    '/lib64',
    '/bin',
    '/sbin',
    '/etc',
  ]) {
    let found = false;
    for (let i = 0; i < argv.length - 2; i += 1) {
      if (
        argv[i] === '--ro-bind-try' &&
        argv[i + 1] === expected &&
        argv[i + 2] === expected
      ) {
        found = true;
        break;
      }
    }
    t.true(found, `${expected} should appear as a --ro-bind-try pair`);
  }
});

test('PATH synthesis: host-bind drops ambient entries that do not exist', async t => {
  // The exists() probe simulates `/opt/extant` present and
  // `/opt/missing` absent.  Only the extant entry should land in PATH
  // and the bind list.
  const argv = await assembleSliceArgv(
    makeStubSpec({ rootfs: { kind: 'host-bind' } }),
    {
      seccompFd: null,
      ambientPath: '/opt/missing:/opt/extant',
      exists: p => p === '/opt/extant',
    },
  );
  const path = extractSetenvPath(argv);
  t.regex(/** @type {string} */ (path), /\/opt\/extant/);
  t.notRegex(
    /** @type {string} */ (path),
    /\/opt\/missing/,
    'missing host paths should not appear in synthesised PATH',
  );
});

test('PATH synthesis: host-bind drops ambient entries whose realpath lands in a blocked prefix', async t => {
  // `/opt/eve` is a symlink to `/tmp/attacker` — the textual prefix
  // check passes on the literal `/opt/eve`, but the resolved path is
  // under `/tmp/` and must be rejected.  `/opt/safe` resolves to
  // itself and is preserved.
  const argv = await assembleSliceArgv(
    makeStubSpec({ rootfs: { kind: 'host-bind' } }),
    {
      seccompFd: null,
      ambientPath: '/opt/eve:/opt/safe',
      exists: () => true,
      realpath: async p => {
        if (p === '/opt/eve') return '/tmp/attacker';
        return p;
      },
    },
  );
  const path = /** @type {string} */ (extractSetenvPath(argv));
  t.notRegex(
    path,
    /\/opt\/eve/,
    'symlink-via-/opt to /tmp/* must be dropped after realpath',
  );
  t.notRegex(path, /\/tmp/, 'resolved /tmp target must not appear');
  t.regex(path, /\/opt\/safe/, 'genuine /opt entries survive realpath');
  t.false(
    argv.includes('/opt/eve'),
    'symlinked entry should not be bound into the slice',
  );
});

test('PATH synthesis: host-bind drops ambient entries whose realpath fails', async t => {
  // A realpath that throws (ENOENT/EACCES) drops the entry — we will
  // not gamble on the textual form when the daemon cannot
  // canonicalise.
  const argv = await assembleSliceArgv(
    makeStubSpec({ rootfs: { kind: 'host-bind' } }),
    {
      seccompFd: null,
      ambientPath: '/opt/broken:/opt/ok',
      exists: () => true,
      realpath: async p => {
        if (p === '/opt/broken') throw new Error('ENOENT');
        return p;
      },
    },
  );
  const path = /** @type {string} */ (extractSetenvPath(argv));
  t.notRegex(path, /\/opt\/broken/);
  t.regex(path, /\/opt\/ok/);
});

test('PATH synthesis: mount rootfs probes for canonical bin dirs', async t => {
  // Probe says only `/usr/bin` and `/bin` exist under the rootfs.
  // The synthesised PATH should reflect those slice-internal paths
  // (NOT the host-prefixed paths).
  const hostPath = '/srv/myrootfs';
  const presentInner = new Set(['/usr/bin', '/bin']);
  const argv = await assembleSliceArgv(
    makeStubSpec({
      rootfs: /** @type {any} */ ({ kind: 'mount', hostPath, mode: 'ro' }),
    }),
    {
      seccompFd: null,
      ambientPath: '',
      exists: p => {
        if (!p.startsWith(hostPath)) return false;
        const inner = p.slice(hostPath.length);
        return presentInner.has(inner);
      },
    },
  );
  const path = extractSetenvPath(argv);
  t.is(
    path,
    '/usr/bin:/bin',
    'mount-rootfs probe should yield slice-internal canonical paths in user-first order',
  );
});

test('PATH synthesis: mount rootfs with empty probe yields empty PATH', async t => {
  // The probe demonstrated that none of the canonical bin dirs exist
  // inside the rootfs; falling back to `DEFAULT_PATH` would point at
  // directories the slice does not contain, so we synthesise an
  // empty `$PATH` and leave it to the caller to set `spec.env.PATH`.
  const argv = await assembleSliceArgv(
    makeStubSpec({
      rootfs: /** @type {any} */ ({
        kind: 'mount',
        hostPath: '/srv/empty',
        mode: 'ro',
      }),
    }),
    {
      seccompFd: null,
      ambientPath: '',
      exists: () => false,
    },
  );
  t.is(
    extractSetenvPath(argv),
    '',
    'empty mount rootfs should not falsely advertise host bin dirs',
  );
});

test('PATH synthesis: relative mount rootfs hostPath is skipped', async t => {
  // A relative `hostPath` would otherwise have its probe resolve
  // against the daemon CWD; bail out early so the synthesised PATH
  // does not reflect a probe with no bearing on the slice.
  const probedPaths = [];
  const argv = await assembleSliceArgv(
    makeStubSpec({
      rootfs: /** @type {any} */ ({
        kind: 'mount',
        hostPath: 'srv/relative',
        mode: 'ro',
      }),
    }),
    {
      seccompFd: null,
      ambientPath: '',
      exists: p => {
        probedPaths.push(p);
        return true;
      },
    },
  );
  t.is(
    extractSetenvPath(argv),
    '',
    'relative hostPath probe is skipped, falls back to empty PATH',
  );
  t.deepEqual(probedPaths, [], 'no canonical-bin probes against relative CWD');
});

test('PATH synthesis: minimal rootfs falls back to DEFAULT_PATH', async t => {
  const argv = await assembleSliceArgv(
    makeStubSpec({ rootfs: { kind: 'minimal' } }),
    {
      seccompFd: null,
      ambientPath: '',
      exists: () => true,
    },
  );
  t.is(extractSetenvPath(argv), DEFAULT_PATH);
});

test('PATH synthesis: caller-granted bin-shaped mounts append after rootfs defaults', async t => {
  const argv = await assembleSliceArgv(
    makeStubSpec({
      rootfs: { kind: 'host-bind' },
      mounts: harden([
        // Inner path ends in /bin → mount itself is a bin-dir.
        { hostPath: '/srv/tools', innerPath: '/opt/tools/bin', mode: 'ro' },
        // Mount with a `bin/` subdir (probed via exists).
        { hostPath: '/srv/extra', innerPath: '/opt/extra', mode: 'ro' },
      ]),
    }),
    {
      seccompFd: null,
      ambientPath: '',
      // `/srv/extra/bin` is the only existence query that matters
      // here; other probes can return whatever.
      exists: p => p === '/srv/extra/bin',
    },
  );
  const path = /** @type {string} */ (extractSetenvPath(argv));
  // Must START with the canonical default — caller bin dirs cannot
  // shadow /usr/bin.
  t.true(
    path.startsWith(DEFAULT_PATH),
    'caller bin dirs must not shadow rootfs defaults',
  );
  t.regex(path, /\/opt\/tools\/bin/, 'inner-path-suffix /bin recognised');
  t.regex(
    path,
    /\/opt\/extra\/bin/,
    'bin/ subdir recognised under caller mount',
  );
  // /usr/bin must come before /opt/tools/bin in the synthesised string.
  t.true(
    path.indexOf('/usr/bin') < path.indexOf('/opt/tools/bin'),
    'rootfs canonical /usr/bin must come before caller-supplied /opt/tools/bin',
  );
});

test('PATH synthesis: caller-mount innerPath with embedded colon is split, not smuggled', async t => {
  // A caller-granted mount with `innerPath = '/opt/tools/bin:/foo'`
  // would otherwise feed a `/opt/tools/bin:/foo` segment into
  // joinPathEntries, smuggling `/foo` onto $PATH.  joinPathEntries
  // must split the entry and process each part as an independent
  // segment (which here means `/foo` lands in the synthesised PATH
  // explicitly — but as a known, separate segment, not as a
  // smuggle-by-concatenation).
  const argv = await assembleSliceArgv(
    makeStubSpec({
      rootfs: { kind: 'host-bind' },
      mounts: harden([
        {
          hostPath: '/srv/tools',
          innerPath: '/opt/tools/bin:/foo',
          mode: 'ro',
        },
      ]),
    }),
    {
      seccompFd: null,
      ambientPath: '',
      exists: () => true,
    },
  );
  const path = /** @type {string} */ (extractSetenvPath(argv));
  // Each segment of the synthesised PATH must be a clean, non-empty
  // path with no embedded `:`.
  for (const segment of path.split(':')) {
    t.notRegex(
      segment,
      /:/,
      `segment ${segment} should not contain embedded colons`,
    );
  }
  t.regex(path, /\/opt\/tools\/bin/);
  t.regex(path, /\/foo/);
});

test('PATH synthesis: caller-mount innerPath with newline is fatal', async t => {
  // Newlines in `innerPath` corrupt the `--setenv PATH …` argv slot
  // in arbitrary ways; `joinPathEntries` raises a structured error so
  // the bug is visible at slice-prep time rather than at exec time.
  await t.throwsAsync(
    () =>
      assembleSliceArgv(
        makeStubSpec({
          rootfs: { kind: 'host-bind' },
          mounts: harden([
            {
              hostPath: '/srv/tools',
              innerPath: '/opt/tools/bin\ninjected',
              mode: 'ro',
            },
          ]),
        }),
        {
          seccompFd: null,
          ambientPath: '',
          exists: () => true,
        },
      ),
    { message: /control characters/ },
  );
});

test('PATH synthesis: caller-supplied env.PATH always wins', async t => {
  const argv = await assembleSliceArgv(
    makeStubSpec({
      rootfs: { kind: 'host-bind' },
      env: harden({ PATH: '/only/this' }),
    }),
    {
      seccompFd: null,
      // Even with a fat ambient PATH, the caller's explicit value
      // takes precedence.
      ambientPath: '/opt/local/bin:/snap/bin',
      exists: () => true,
    },
  );
  // Find the LAST `--setenv PATH …` pair — caller's env iteration runs
  // before the synthesis fallback would, but the synthesis fallback
  // is gated by `hadPath`.  The expected behaviour is exactly one
  // `--setenv PATH …` pair, with the caller's value.
  /** @type {string[]} */
  const pathValues = [];
  for (let i = 0; i < argv.length - 2; i += 1) {
    if (argv[i] === '--setenv' && argv[i + 1] === 'PATH') {
      pathValues.push(argv[i + 2]);
    }
  }
  t.deepEqual(
    pathValues,
    ['/only/this'],
    'caller-supplied PATH must be the only --setenv PATH pair',
  );
});

test('PATH synthesis: ambient PATH undefined is not an error', async t => {
  // The bwrap driver may be constructed without an `env` (or with one
  // that omits PATH).  The synthesis should degrade gracefully to the
  // canonical default rather than throwing.
  const argv = await assembleSliceArgv(
    makeStubSpec({ rootfs: { kind: 'host-bind' } }),
    {
      seccompFd: null,
      ambientPath: undefined,
      exists: () => true,
    },
  );
  t.is(extractSetenvPath(argv), DEFAULT_PATH);
});

// --- teardown bounding -----------------------------------------------------
//
// These drive `teardown` against an injected `child_process` stub, so
// they run on every host.  The scenario under test is the one the
// driver's `'close'`-based liveness tracking exists to detect: the slice
// child has exited, but a descendant that escaped the process group
// still holds the inherited pipe, so `'close'` never arrives and the
// child never leaves `slice.live`.

/**
 * Build a `child_process`-shaped stub whose `spawn` returns a fake child
 * that has already exited (so `killProcessGroup` correctly declines to
 * signal a pid it no longer owns) and whose stdio behaviour is dictated
 * by `closeOnKill`:
 *
 *   - `false` — `'close'` never fires, the escaped-fd case.
 *   - `true`  — `'close'` fires on the next turn, the ordinary case.
 *
 * @param {{ closeOnKill: boolean }} opts
 * @returns {{ childProcess: any, children: any[] }}
 */
const makeStubChildProcess = ({ closeOnKill }) => {
  /** @type {any[]} */
  const children = [];
  const childProcess = {
    spawn: () => {
      /** @type {any} */
      const child = new EventEmitter();
      // A pid Node has already reaped: `exitCode !== null` makes
      // `killProcessGroup` decline to signal, so no real process group
      // on the test host is ever touched.
      child.pid = 999_999;
      child.exitCode = 0;
      child.signalCode = null;
      child.stdin = null;
      child.stdout = null;
      child.stderr = null;
      if (closeOnKill) {
        setTimeout(() => child.emit('close', 0, null), 0);
      }
      children.push(child);
      return child;
    },
  };
  return { childProcess, children };
};

/**
 * Drive `prepareSlice` + one `spawn` against a stubbed child process.
 *
 * @param {any} childProcess
 * @returns {Promise<{ driver: any, slice: any }>}
 */
const prepareStubbedSlice = async childProcess => {
  const driver = /** @type {any} */ (
    makeBwrapDriver({ env: {}, childProcess })
  );
  const slice = await driver.prepareSlice(
    makeStubSpec({ rootfs: { kind: 'host-bind' } }),
  );
  await driver.spawn(slice, ['/bin/true'], {});
  return { driver, slice };
};

test('teardown gives up on a child whose stdio never closes', async t => {
  // Guards the hang: `slice.live` drops a child only on `'close'`, so
  // without a bound this teardown never settles and `dispose()` wedges
  // the whole shutdown path.
  t.timeout(10_000);
  const { childProcess, children } = makeStubChildProcess({
    closeOnKill: false,
  });
  const { driver, slice } = await prepareStubbedSlice(childProcess);
  t.is(children.length, 1, 'the stub should have produced one child');
  t.is(slice.live.size, 1, 'the child should still be live at teardown');
  // `spawn` leaves its own liveness listener attached; the assertion
  // below is that teardown's bounded wait adds none of its own on top.
  const listenersBefore = children[0].listenerCount('close');

  const started = Date.now();
  await t.throwsAsync(driver.teardown(slice), {
    message: /could not prove containment/,
  });
  const elapsed = Date.now() - started;
  t.true(
    elapsed < 5000,
    `teardown must settle within its own bound, took ${elapsed}ms`,
  );

  t.is(slice.live.size, 0, 'teardown must not keep the straggler live');
  t.is(
    children[0].listenerCount('close'),
    listenersBefore,
    "a bounded-out child must not retain teardown's close listener",
  );
});

test('teardown resolves as soon as the child stdio closes', async t => {
  // The bound is a ceiling, not a floor: the ordinary path must not
  // wait it out.
  t.timeout(10_000);
  const { childProcess, children } = makeStubChildProcess({
    closeOnKill: true,
  });
  const { driver, slice } = await prepareStubbedSlice(childProcess);

  const started = Date.now();
  await t.notThrowsAsync(driver.teardown(slice));
  const elapsed = Date.now() - started;
  t.true(
    elapsed < 500,
    `teardown should settle on 'close', not on the bound; took ${elapsed}ms`,
  );
  t.is(slice.live.size, 0);
  t.is(
    children[0].listenerCount('close'),
    0,
    'a closed child must not retain a close listener',
  );
});
