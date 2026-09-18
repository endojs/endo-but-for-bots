// @ts-nocheck

/**
 * Unit tests for the mount caplet's mounter logic, exercised through
 * the injectable `makeFsMounter({ runProgram, makeDir, removeDir,
 * makeBridge })` seam so the privileged `mount(2)` path runs with fakes
 * — no root, no real kernel, no real 9P bridge.
 */

import '@endo/init/debug.js';

import test from 'ava';
import os from 'node:os';
import nodePath from 'node:path';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';

import {
  make,
  makeFsMounter,
  makeFsMounterKit,
  mountIdentity,
  readMountPrograms,
} from '../mount-caplet.js';

// A caller-supplied socketPath must live inside the socket directory
// (defaults to os.tmpdir() when XDG_RUNTIME_DIR is unset), so build the
// test paths there rather than hard-coding `/tmp`.
const SOCK = nodePath.join(os.tmpdir(), 's.sock');
const SOCK2 = nodePath.join(os.tmpdir(), 's2.sock');

const fakeFs = () => Far('FakeFs', {});

const flush = () => new Promise(resolve => setTimeout(resolve, 10));

for (const kind of ['presence', 'local', 'promised']) {
  test(`make returns with a live ${kind} context and observes later cancellation`, async t => {
    t.timeout(5000);
    let cancel;
    const cancelledP = new Promise((_resolve, reject) => {
      cancel = () => reject(Error('Test context cancelled'));
    });
    cancelledP.catch(() => {});
    t.teardown(() => cancel());
    const presence = Far('Context', { whenCancelled: () => cancelledP });
    const context =
      kind === 'local'
        ? harden({ cancelled: cancelledP })
        : kind === 'promised'
          ? Promise.resolve(presence)
          : presence;
    // This must return while the context is still live. The old async helper
    // assimilated cancelledP and left this constructor pending forever.
    const mounter = await make(undefined, context);
    t.deepEqual(await E(mounter).list(), []);
    cancel();
    await flush();
    // An invalid operator override also prevents native effects if the fence
    // regresses, so this entrypoint test never needs a kernel mount or socket.
    await t.throwsAsync(
      () =>
        E(mounter).mount(fakeFs(), '/not-mounted', {
          mountProgram: ['invalid'],
        }),
      { message: /mounter is cancelled/ },
    );
  });
}

test('make without a cancellation context returns an open mounter', async t => {
  t.timeout(5000);
  const mounter = await make(undefined, undefined);
  t.deepEqual(await E(mounter).list(), []);
  await t.throwsAsync(
    () =>
      E(mounter).mount(fakeFs(), '/not-mounted', {
        mountProgram: ['invalid'],
      }),
    { message: /operator configuration/ },
  );
});

/**
 * @param {object} [opts]
 * @param {Record<string, string>} [opts.env]
 * @param {Promise<never>} [opts.cancelledP]
 * @param {(bin: string, argv: string[], nth: number) => Promise<unknown>} [opts.runBehavior]
 * @param {number} [opts.uid]
 * @param {number} [opts.gid]
 */
const makeHarness = (opts = {}) => {
  const calls = { run: [], makeDir: [], removeDir: [], bridges: [] };
  const runBehavior =
    opts.runBehavior ?? (() => Promise.resolve({ stdout: '', stderr: '' }));
  const runProgram = (bin, argv) => {
    calls.run.push({ bin, argv });
    return runBehavior(bin, argv, calls.run.length);
  };
  const makeDir = (p, o) => {
    calls.makeDir.push({ p, o });
    return opts.makeDirBehavior?.() ?? Promise.resolve();
  };
  const removeDir = p => {
    calls.removeDir.push(p);
    return opts.removeDirBehavior?.() ?? Promise.resolve();
  };
  const makeBridge = ({ fs, socketPath, cancelled, uid, gid }) => {
    const rec = { fs, socketPath, cancelled, uid, gid, started: 0, stopped: 0 };
    calls.bridges.push(rec);
    return Far('FakeBridge', {
      async start() {
        rec.started += 1;
        await opts.startBehavior?.();
      },
      async stop() {
        rec.stopped += 1;
        await opts.stopBehavior?.();
      },
    });
  };
  const { mounter, close } = makeFsMounterKit({
    env: opts.env ?? {},
    cancelledP: opts.cancelledP ?? null,
    runProgram,
    makeDir,
    removeDir,
    makeBridge,
    uid: opts.uid,
    gid: opts.gid,
  });
  return { mounter, close, calls };
};

test("mountIdentity reports the worker's own uid/gid", t => {
  t.deepEqual(mountIdentity({ getuid: () => 501, getgid: () => 20 }), {
    uid: 501,
    gid: 20,
  });
});

test('mountIdentity falls back to 1000 where the platform has no uid/gid', t => {
  // Windows: `process.getuid`/`getgid` are undefined rather than throwing.
  t.deepEqual(mountIdentity({}), { uid: 1000, gid: 1000 });
});

test('mount builds the 9P mount argv, makes the dir, and starts the bridge', async t => {
  const { mounter, calls } = makeHarness({ uid: 999, gid: 998 });
  const h = await E(mounter).mount(
    fakeFs(),
    '/mnt/x',
    harden({ socketPath: SOCK }),
  );

  t.deepEqual(calls.makeDir[0], { p: '/mnt/x', o: { recursive: true } });
  t.is(calls.bridges.length, 1);
  t.is(calls.bridges[0].socketPath, SOCK);
  t.is(calls.bridges[0].uid, 999);
  t.is(calls.bridges[0].gid, 998);
  t.is(calls.bridges[0].started, 1);

  t.is(calls.run.length, 1);
  t.is(calls.run[0].bin, 'mount');
  const argv = calls.run[0].argv;
  t.deepEqual(argv.slice(0, 3), ['-t', '9p', '-o']);
  const optionString = argv[3];
  for (const part of [
    'trans=unix',
    'version=9p2000.L',
    'msize=131072',
    'access=any',
    'cache=none',
  ]) {
    t.true(optionString.includes(part), `option string has ${part}`);
  }
  // `--` terminates options so a dash-leading path can't be a flag.
  t.is(argv[4], '--');
  t.is(argv[5], SOCK);
  t.is(argv[6], '/mnt/x');

  t.is(await E(h).mountPoint(), '/mnt/x');
  t.is(await E(h).socketPath(), SOCK);
  t.is((await E(mounter).list()).length, 1);
});

test('readOnly, msize override, and extraMountOptions reach the -o string', async t => {
  const { mounter, calls } = makeHarness();
  await E(mounter).mount(
    fakeFs(),
    '/mnt/x',
    harden({
      socketPath: SOCK,
      readOnly: true,
      msize: 65_536,
      extraMountOptions: 'cache=loose',
    }),
  );
  const optionString = calls.run[0].argv[3];
  t.true(optionString.includes('msize=65536'));
  t.true(optionString.split(',').includes('ro'));
  t.true(optionString.includes('cache=loose'));
});

test('NINEP_SUDO routes mount/umount through sudo', async t => {
  const { mounter, calls } = makeHarness({ env: { NINEP_SUDO: '1' } });
  const h = await E(mounter).mount(
    fakeFs(),
    '/mnt/x',
    harden({ socketPath: SOCK }),
  );
  t.is(calls.run[0].bin, 'sudo');
  t.is(calls.run[0].argv[0], 'mount');
  await E(h).unmount();
  const umount = calls.run.find(
    c => c.bin === 'sudo' && c.argv[0] === 'umount',
  );
  t.truthy(umount);
});

test('extraMountOptions cannot override the pinned trans option', async t => {
  const { mounter } = makeHarness();
  await t.throwsAsync(
    E(mounter).mount(
      fakeFs(),
      '/mnt/x',
      harden({
        socketPath: SOCK,
        extraMountOptions: 'trans=tcp,port=564',
      }),
    ),
    { message: /may not set the pinned option .*trans/ },
  );
});

test('caller cannot choose the mount/umount program', async t => {
  const { mounter } = makeHarness();
  await t.throwsAsync(
    E(mounter).mount(
      fakeFs(),
      '/mnt/x',
      harden({ socketPath: SOCK, umountProgram: ['rm'] }),
    ),
    { message: /operator configuration/ },
  );
});

test('a socketPath outside the socket directory is rejected', async t => {
  const { mounter } = makeHarness();
  await t.throwsAsync(
    E(mounter).mount(
      fakeFs(),
      '/mnt/x',
      harden({ socketPath: '/etc/evil.sock' }),
    ),
    { message: /must be inside the socket directory/ },
  );
});

test('NINEP_MOUNT_PROGRAM lets the operator set a custom helper', async t => {
  const { mounter, calls } = makeHarness({
    env: {
      NINEP_MOUNT_PROGRAM: 'sudo -u svc mount',
      NINEP_UMOUNT_PROGRAM: 'sudo umount',
    },
  });
  await E(mounter).mount(fakeFs(), '/mnt/x', harden({ socketPath: SOCK }));
  t.is(calls.run[0].bin, 'sudo');
  t.deepEqual(calls.run[0].argv.slice(0, 3), ['-u', 'svc', 'mount']);
});

test('a NINEP_MOUNT_PROGRAM that does not run mount is rejected at construction', t => {
  t.throws(
    () =>
      makeFsMounter({
        env: { NINEP_MOUNT_PROGRAM: 'rm -rf' },
        runProgram: () => Promise.resolve(),
        makeDir: () => Promise.resolve(),
        removeDir: () => Promise.resolve(),
        makeBridge: () =>
          Far('B', { start: async () => {}, stop: async () => {} }),
      }),
    { message: /must invoke .*mount/ },
  );
});

test('readMountPrograms is the construction-time program check, usable ahead of it', t => {
  t.deepEqual(readMountPrograms(), {
    mountProgram: ['mount'],
    umountProgram: ['umount'],
  });
  t.deepEqual(readMountPrograms({ NINEP_SUDO: '1' }), {
    mountProgram: ['sudo', 'mount'],
    umountProgram: ['sudo', 'umount'],
  });
  t.deepEqual(
    readMountPrograms({
      NINEP_SUDO: '1',
      NINEP_MOUNT_PROGRAM: ' sudo -u svc  mount ',
    }),
    {
      mountProgram: ['sudo', '-u', 'svc', 'mount'],
      umountProgram: ['sudo', 'umount'],
    },
  );
  t.throws(() => readMountPrograms({ NINEP_UMOUNT_PROGRAM: 'rm -rf' }), {
    message: /"NINEP_UMOUNT_PROGRAM" must invoke "umount"/,
  });
  t.throws(() => readMountPrograms({ NINEP_MOUNT_PROGRAM: '   ' }), {
    message: /"NINEP_MOUNT_PROGRAM" must be a non-empty array/,
  });
});

test('a failed mount stops the bridge and leaks no handle', async t => {
  const { mounter, calls } = makeHarness({
    runBehavior: bin =>
      bin === 'mount'
        ? Promise.reject(
            Object.assign(new Error('mount: permission denied'), {
              stderr: 'only root',
            }),
          )
        : Promise.resolve(),
  });
  await t.throwsAsync(
    E(mounter).mount(fakeFs(), '/mnt/x', harden({ socketPath: SOCK })),
    { message: /9p mount of .* failed/ },
  );
  t.is(calls.bridges[0].stopped, 1);
  t.is((await E(mounter).list()).length, 0);
});

test('a failed bridge.start() is cleaned up and leaks no handle', async t => {
  const calls = { run: [], bridges: [] };
  const makeBridge = ({ fs, socketPath }) => {
    const rec = { fs, socketPath, started: 0, stopped: 0 };
    calls.bridges.push(rec);
    return Far('FakeBridge', {
      async start() {
        rec.started += 1;
        throw new Error('EADDRINUSE: socket already in use');
      },
      async stop() {
        rec.stopped += 1;
      },
    });
  };
  const mounter = makeFsMounter({
    runProgram: (bin, argv) => {
      calls.run.push({ bin, argv });
      return Promise.resolve();
    },
    makeDir: () => Promise.resolve(),
    removeDir: () => Promise.resolve(),
    makeBridge,
  });
  await t.throwsAsync(
    E(mounter).mount(fakeFs(), '/mnt/x', harden({ socketPath: SOCK })),
    { message: /bridge failed to start/ },
  );
  t.is(calls.bridges[0].stopped, 1, 'bridge stopped after start() failure');
  t.is(calls.run.length, 0, 'mount never attempted');
  t.is((await E(mounter).list()).length, 0, 'no handle leaked');
});

test('cancellation during an in-flight mount unmounts it (no orphan)', async t => {
  let rejectCancelled;
  const cancelledP = new Promise((_resolve, reject) => {
    rejectCancelled = reject;
  });
  cancelledP.catch(() => {});
  // Fire teardown *during* the mount shell-out and let its sweep run
  // before mount() resumes — the deterministic version of the
  // "settle between the last await and handles.add" race.
  const { mounter, calls } = makeHarness({
    cancelledP,
    runBehavior: async bin => {
      if (bin === 'mount') {
        rejectCancelled(new Error('teardown'));
        await flush();
      }
    },
  });
  await t.throwsAsync(
    E(mounter).mount(fakeFs(), '/mnt/x', harden({ socketPath: SOCK })),
    { message: /cancelled during mount/ },
  );
  t.truthy(
    calls.run.find(c => c.bin === 'umount'),
    'the mount was unmounted',
  );
  t.is(calls.bridges[0].stopped, 1, 'bridge stopped');
  t.is((await E(mounter).list()).length, 0, 'no orphan handle');
});

test('unmount detaches with `umount -- <mp>`, stops the bridge, drops the handle', async t => {
  const { mounter, calls } = makeHarness();
  const h = await E(mounter).mount(
    fakeFs(),
    '/mnt/x',
    harden({ socketPath: SOCK }),
  );
  await E(h).unmount();
  const umount = calls.run.find(c => c.bin === 'umount');
  t.deepEqual(umount.argv, ['--', '/mnt/x']);
  t.is(calls.bridges[0].stopped, 1);
  t.is((await E(mounter).list()).length, 0);
});

test('a failed umount (EBUSY) keeps the bridge up and the handle, and is retryable', async t => {
  let umountAttempts = 0;
  const { mounter, calls } = makeHarness({
    runBehavior: bin => {
      if (bin === 'umount') {
        umountAttempts += 1;
        if (umountAttempts === 1) {
          return Promise.reject(
            Object.assign(new Error('target is busy'), { stderr: 'EBUSY' }),
          );
        }
      }
      return Promise.resolve();
    },
  });
  const h = await E(mounter).mount(
    fakeFs(),
    '/mnt/x',
    harden({ socketPath: SOCK }),
  );
  await t.throwsAsync(E(h).unmount(), { message: /busy/ });
  // The mount must not outlive its transport: bridge still up, handle retained.
  t.is(calls.bridges[0].stopped, 0);
  t.is((await E(mounter).list()).length, 1);
  // Retry succeeds.
  await E(h).unmount();
  t.is(calls.bridges[0].stopped, 1);
  t.is((await E(mounter).list()).length, 0);
});

for (const env of [{}, { NINEP_LAZY_UMOUNT: '1' }]) {
  test(`lazy unmount is rejected before native effects (${JSON.stringify(env)})`, async t => {
    const { mounter, calls, close } = makeHarness({ env });
    t.teardown(close);
    await t.throwsAsync(
      E(mounter).mount(
        fakeFs(),
        '/mnt/x',
        harden(env.NINEP_LAZY_UMOUNT ? {} : { lazyUnmount: true }),
      ),
      { message: /cannot prove filesystem release/ },
    );
    t.is(calls.makeDir.length, 0);
    t.is(calls.bridges.length, 0);
    t.is(calls.run.length, 0);
  });
}

test('default socket paths are distinct across concurrent-ish mounts', async t => {
  const { mounter } = makeHarness();
  const h1 = await E(mounter).mount(fakeFs(), '/mnt/a', harden({}));
  const h2 = await E(mounter).mount(fakeFs(), '/mnt/b', harden({}));
  t.not(await E(h1).socketPath(), await E(h2).socketPath());
});

test('generated socket fits the hosted Codex session directory', async t => {
  const socketDir =
    '/var/lib/endo/codex-subscription-v2/sessions/mu59t5ik-ftuwid-84a7a67b6c05/9p';
  const { mounter, close } = makeHarness({
    env: { NINEP_SOCKET_DIR: socketDir },
  });
  t.teardown(close);
  const handle = await E(mounter).mount(fakeFs(), '/mnt/a', harden({}));
  const socketPath = await E(handle).socketPath();
  t.is(nodePath.dirname(socketPath), socketDir);
  t.regex(nodePath.basename(socketPath), /^endo-9p-[A-Za-z0-9_-]{16}$/);
  t.true(new TextEncoder().encode(socketPath).byteLength <= 103);
});

test('oversized explicit and generated sockets fail before native effects', async t => {
  for (const socketDir of [`/${'a'.repeat(104)}`, `/${'é'.repeat(52)}`]) {
    const { mounter, calls, close } = makeHarness({
      env: { NINEP_SOCKET_DIR: socketDir },
    });
    t.teardown(close);
    for (const options of [{}, { socketPath: `${socketDir}/s` }]) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(
        E(mounter).mount(fakeFs(), '/mnt/a', harden(options)),
        { message: /socket path exceeds 103 bytes/ },
      );
    }
    t.is(calls.makeDir.length, 0);
    t.is(calls.bridges.length, 0);
    t.is(calls.run.length, 0);
  }
});

test('cancellation unmounts live mounts and refuses new ones', async t => {
  let rejectCancelled;
  const cancelledP = new Promise((_resolve, reject) => {
    rejectCancelled = reject;
  });
  cancelledP.catch(() => {});
  const { mounter, calls } = makeHarness({ cancelledP });
  await E(mounter).mount(fakeFs(), '/mnt/x', harden({ socketPath: SOCK }));

  rejectCancelled(new Error('teardown'));
  await flush();

  t.truthy(calls.run.find(c => c.bin === 'umount'));
  t.is(calls.bridges[0].stopped, 1);
  t.is((await E(mounter).list()).length, 0);

  await t.throwsAsync(
    E(mounter).mount(fakeFs(), '/mnt/y', harden({ socketPath: SOCK2 })),
    { message: /cancelled/ },
  );
});

// These held effects model cleanup barriers; no kernel mount is performed.
const deferred = () => {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
};

test('bridge stop failure retains handle and retries without repeating umount', async t => {
  let attempts = 0;
  const { mounter, calls, close } = makeHarness({
    stopBehavior: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('bridge still draining');
    },
  });
  t.teardown(close);
  const handle = await E(mounter).mount(fakeFs(), '/mnt/x');
  await t.throwsAsync(E(handle).unmount(), { message: /still draining/ });
  t.is((await E(mounter).list()).length, 1);
  await close();
  t.is(calls.run.filter(c => c.bin === 'umount').length, 1);
  t.is(calls.bridges[0].stopped, 2);
  t.is((await E(mounter).list()).length, 0);
});

test('directory removal failure remains owned after bridge drain', async t => {
  let attempts = 0;
  const { mounter, calls, close } = makeHarness({
    removeDirBehavior: async () => {
      attempts += 1;
      if (attempts === 1)
        throw Object.assign(new Error('directory busy'), { code: 'EBUSY' });
    },
  });
  t.teardown(close);
  const handle = await E(mounter).mount(
    fakeFs(),
    '/mnt/x',
    harden({ removeMountPointOnUnmount: true }),
  );
  await t.throwsAsync(E(handle).unmount(), { message: /directory busy/ });
  t.is((await E(mounter).list()).length, 1);
  await close();
  t.is(calls.bridges[0].stopped, 1);
  t.is(calls.removeDir.length, 2);
  t.is((await E(mounter).list()).length, 0);
});

test('failed acquisition retains uncertain kernel mount for host close retry', async t => {
  let busy = true;
  const { mounter, calls, close } = makeHarness({
    runBehavior: async bin => {
      if (bin === 'mount')
        throw new Error('mount command failed after attachment');
      if (busy) throw new Error('still mounted');
    },
  });
  t.teardown(() => {
    busy = false;
    return close();
  });
  await t.throwsAsync(E(mounter).mount(fakeFs(), '/mnt/x'), {
    instanceOf: AggregateError,
    message: /cleanup remains pending/,
  });
  t.is(calls.bridges[0].stopped, 0);
  await t.throwsAsync(close(), { instanceOf: AggregateError });
  t.is(calls.bridges[0].stopped, 0);
  busy = false;
  await close();
  t.is(calls.bridges[0].stopped, 1);
  await t.throwsAsync(E(mounter).mount(fakeFs(), '/mnt/y'), {
    message: /cancelled/,
  });
});

test('close waits for admitted mount and bridge drain before directory release', async t => {
  t.timeout(2000);
  const mounting = deferred();
  const mounted = deferred();
  const stopping = deferred();
  const stopped = deferred();
  const { mounter, calls, close } = makeHarness({
    runBehavior: async bin => {
      if (bin === 'mount') {
        mounting.resolve();
        await mounted.promise;
      }
    },
    stopBehavior: async () => {
      stopping.resolve();
      await stopped.promise;
    },
  });
  t.teardown(() => {
    mounted.resolve();
    stopped.resolve();
    return close();
  });
  const result = t.throwsAsync(
    E(mounter).mount(
      fakeFs(),
      '/mnt/x',
      harden({ removeMountPointOnUnmount: true }),
    ),
    { message: /cancelled during mount/ },
  );
  await mounting.promise;
  let closed = false;
  const closing = close().then(() => {
    closed = true;
  });
  await flush();
  t.false(closed);
  t.is(calls.bridges[0].stopped, 0);
  t.is(calls.bridges[0].cancelled, undefined);
  mounted.resolve();
  await stopping.promise;
  t.false(closed);
  t.is(calls.removeDir.length, 0);
  t.is(calls.run.filter(c => c.bin === 'umount').length, 1);
  stopped.resolve();
  await Promise.all([result, closing]);
  t.true(closed);
  t.is(calls.removeDir.length, 1);
});

test('close during mkdir fences bridge construction and waits for directory cleanup', async t => {
  t.timeout(2000);
  const entered = deferred();
  const ready = deferred();
  const { mounter, calls, close } = makeHarness({
    makeDirBehavior: async () => {
      entered.resolve();
      await ready.promise;
    },
  });
  t.teardown(() => {
    ready.resolve();
    return close();
  });
  const result = t.throwsAsync(
    E(mounter).mount(
      fakeFs(),
      '/mnt/x',
      harden({ removeMountPointOnUnmount: true }),
    ),
    { message: /cancelled during mount/ },
  );
  await entered.promise;
  const closing = close();
  ready.resolve();
  await Promise.all([result, closing]);
  t.is(calls.bridges.length, 0);
  t.is(calls.run.length, 0);
  t.is(calls.removeDir.length, 1);
});

test('invalid mount options cannot acquire native resources', async t => {
  const { mounter, calls, close } = makeHarness();
  t.teardown(close);
  await t.throwsAsync(
    E(mounter).mount(
      fakeFs(),
      '/mnt/x',
      harden({ extraMountOptions: 'trans=tcp' }),
    ),
    { message: /pinned option/ },
  );
  t.is(calls.makeDir.length, 0);
  t.is(calls.bridges.length, 0);
  t.is(calls.run.length, 0);
});

test('path reservations survive failed cleanup and prevent successor interference', async t => {
  let busy = true;
  const { mounter, calls, close } = makeHarness({
    stopBehavior: async () => {
      if (busy) throw new Error('still draining');
    },
  });
  t.teardown(() => {
    busy = false;
    return close();
  });
  const first = await E(mounter).mount(
    fakeFs(),
    '/mnt/x',
    harden({ socketPath: SOCK }),
  );
  await t.throwsAsync(E(first).unmount(), { message: /still draining/ });
  await t.throwsAsync(
    E(mounter).mount(fakeFs(), '/mnt/./x', harden({ socketPath: SOCK2 })),
    { message: /mount point is already owned/ },
  );
  await t.throwsAsync(
    E(mounter).mount(fakeFs(), '/mnt/y', harden({ socketPath: SOCK })),
    { message: /socket path is already owned/ },
  );
  t.is(calls.bridges.length, 1);
  busy = false;
  await E(first).unmount();
  const second = await E(mounter).mount(
    fakeFs(),
    '/mnt/x',
    harden({ socketPath: SOCK }),
  );
  await E(first).unmount();
  t.is(
    calls.bridges[1].stopped,
    0,
    'released predecessor cannot affect successor',
  );
  await E(second).unmount();
});

test('pending acquisition reserves its paths before native effects', async t => {
  t.timeout(2000);
  const entered = deferred();
  const ready = deferred();
  const { mounter, calls, close } = makeHarness({
    makeDirBehavior: async () => {
      entered.resolve();
      await ready.promise;
    },
  });
  t.teardown(() => {
    ready.resolve();
    return close();
  });
  const first = E(mounter).mount(
    fakeFs(),
    '/mnt/x',
    harden({ socketPath: SOCK }),
  );
  await entered.promise;
  await t.throwsAsync(
    E(mounter).mount(fakeFs(), '/mnt/x', harden({ socketPath: SOCK2 })),
    { message: /mount point is already owned/ },
  );
  await t.throwsAsync(
    E(mounter).mount(fakeFs(), '/mnt/y', harden({ socketPath: SOCK })),
    { message: /socket path is already owned/ },
  );
  t.is(calls.makeDir.length, 1);
  ready.resolve();
  const handle = await first;
  await E(handle).unmount();
});
