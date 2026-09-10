// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makePodmanProviderListenerRuntime } from '../src/provider-listener-runtime.js';

const digest = `sha256:${'b'.repeat(64)}`;
const limits = harden({
  maxConnections: 1,
  maxRequestBytes: 1024n,
  maxResponseBytes: 1024n,
  timeoutMs: 1000,
});

/** @param {any} t */
const fixture = async t => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), 'provider-runtime-test-'),
  );
  t.teardown(() => rm(stateDirectory, { recursive: true, force: true }));
  const children = new Map();
  const removals = [];
  let wrongNamespace = false;
  let removeFails = false;
  let orphan = '';
  let inspections = 0;
  let racePid = false;
  const host = {
    async readStart(pid) {
      return pid === process.pid ? '123' : null;
    },
    async run(args) {
      if (args[0] === 'ps') return { stdout: orphan };
      if (args[0] === 'rm') {
        if (removeFails) throw Error('removal failed');
        const name = args.at(-1);
        removals.push(name);
        children.get(name)?.kill();
        return { stdout: '' };
      }
      if (args[0] === 'inspect') {
        inspections += 1;
        return {
          stdout: JSON.stringify({
            State: {
              Running: true,
              Pid: racePid && inspections % 2 === 0 ? 4243 : 4242,
            },
            ImageDigest: digest,
            Config: { Labels: { 'io.endo.provider.owner': 'test-owner' } },
            HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true },
          }),
        };
      }
      throw Error('unexpected host operation');
    },
    launch(args) {
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {startProviderListenerWorker} from ${JSON.stringify(new URL('../src/provider-worker.js', import.meta.url).href)}; await startProviderListenerWorker({input:process.stdin,output:process.stdout});`,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      children.set(args[args.indexOf('--name') + 1], child);
      return child;
    },
    procfs: {
      async readLink(path) {
        const type = path.split('/').at(-1);
        return `${type === 'mount' ? 'mnt' : type}:[${path.includes('/self/') || wrongNamespace ? '10' : '20'}]`;
      },
      async readFile(path) {
        if (path.endsWith('/net/dev')) return 'heading\nheading\n lo: 0 0\n';
        if (path.endsWith('/net/route')) return 'Iface Destination\n';
        if (path.endsWith('/net/ipv6_route')) return '';
        if (path.endsWith('_map')) return '0 0 65536\n';
        if (path.endsWith('/status'))
          return 'Uid:\t1000 1000 1000 1000\nGid:\t1000 1000 1000 1000\nNoNewPrivs:\t1\nSeccomp:\t2\nCapEff:\t0\nCapPrm:\t0\nCapBnd:\t0\n';
        throw Error('unexpected procfs path');
      },
    },
  };
  const options = {
    imageRef: `localhost/listener@${digest}`,
    ownerId: 'test-owner',
    stateDirectory,
    host,
  };
  t.teardown(() => {
    for (const child of children.values()) child.kill();
  });
  return {
    options,
    removals,
    racePid: () => {
      racePid = true;
    },
    wrongNamespace: () => {
      wrongNamespace = true;
    },
    failRemoval: () => {
      removeFails = true;
    },
    allowRemoval: () => {
      removeFails = false;
    },
    orphan: () => {
      orphan = 'abcdef123456\n';
    },
  };
};

test('runtime excludes a second live owner and permits reacquisition after disposal', async t => {
  const f = await fixture(t);
  const runtime = await makePodmanProviderListenerRuntime(f.options);
  t.teardown(runtime.dispose);
  await t.throwsAsync(() => makePodmanProviderListenerRuntime(f.options), {
    message: /already active/,
  });
  await runtime.dispose();
  await runtime.dispose();
  const again = await makePodmanProviderListenerRuntime(f.options);
  await again.dispose();
});

test('runtime recovers a dead owner and sweeps only its exactly labelled orphan', async t => {
  const f = await fixture(t);
  await symlink('999999-1', join(f.options.stateDirectory, 'test-owner.lock'));
  f.orphan();
  const runtime = await makePodmanProviderListenerRuntime(f.options);
  t.teardown(runtime.dispose);
  t.deepEqual(f.removals, ['abcdef123456']);
});

test.serial(
  'controlled namespace admission preserves live workers until explicit disposal',
  async t => {
    // Two workers each permit two 10s startup handshakes and up to 6s
    // shutdown. Keep one finite deadline above that combined 52s budget,
    // including some headroom for scheduling and filesystem work in CI.
    t.timeout(60_000);
    t.log('creating runtime fixture');
    const f = await fixture(t);
    t.log('acquiring runtime');
    const runtime = await makePodmanProviderListenerRuntime(f.options);
    t.teardown(runtime.dispose);
    t.log('starting first worker');
    const first = await runtime.start({
      endpoint: Far('inference', {}),
      limits,
    });
    t.log('retrying cleanup with first worker live');
    await runtime.retryCleanup();
    t.is(f.removals.length, 0);
    t.log('starting second worker');
    const second = await runtime.start({
      endpoint: Far('inference', {}),
      limits,
    });
    t.log('observing both workers');
    t.not(
      (await first.observe()).containerName,
      (await second.observe()).containerName,
    );
    t.log('disposing both workers');
    await runtime.dispose();
    t.log('disposal completed');
    t.is(f.removals.length, 2);
  },
);

test.serial(
  'controlled namespace mismatch refuses admission and retries failed removal',
  async t => {
    // Startup permits two 10s handshakes, then cleanup can spend 1s per
    // stop attempt and 5s waiting for the child. Keep a finite test deadline
    // that lets those runtime deadlines finish on a busy CI worker.
    t.timeout(30_000);
    const f = await fixture(t);
    const runtime = await makePodmanProviderListenerRuntime(f.options);
    t.teardown(runtime.dispose);
    f.wrongNamespace();
    f.failRemoval();
    const error = await t.throwsAsync(
      () => runtime.start({ endpoint: Far('inference', {}), limits }),
      { instanceOf: AggregateError },
    );
    t.regex(error.errors[0].message, /isolation is not proved/);
    t.regex(error.errors[1].message, /removal failed/);
    f.allowRemoval();
    await runtime.retryCleanup();
    t.is(f.removals.length, 1);
  },
);

test.serial(
  'controlled PID replacement during procfs reads refuses admission',
  async t => {
    t.timeout(5000);
    const f = await fixture(t);
    const runtime = await makePodmanProviderListenerRuntime(f.options);
    t.teardown(runtime.dispose);
    f.racePid();
    await t.throwsAsync(
      () => runtime.start({ endpoint: Far('inference', {}), limits }),
      { message: /startup failed/ },
    );
    t.is(f.removals.length, 1);
  },
);
