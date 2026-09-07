// @ts-check
import { E } from '@endo/eventual-send';
import test from '@endo/ses-ava/test.js';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeIronhorseEngine } from '../../src/ironhorse-engine.js';
import { inspectIronhorseStore } from '../../src/inspect-ironhorse.js';
import { makeFixture } from './_fixture.js';

/** @import {ExecutionContext} from 'ava' */

/**
 * @param {ExecutionContext} t
 * @param {string} statePath
 * @param {Record<string, string>} [env]
 */
const launch = async (t, statePath, env = {}) => {
  const child = fork(
    fileURLToPath(new URL('./process-daemon.mjs', import.meta.url)),
    [statePath],
    {
      env: { ...process.env, ...env },
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  const exited = once(child, 'exit');
  let diagnostic = '';
  child.stderr?.on('data', chunk => {
    diagnostic += String(chunk);
  });
  t.teardown(async () => {
    child.kill('SIGKILL');
    await exited;
  });
  /** @type {any[]} */
  const messages = [];
  /** @type {((message: any) => void) | undefined} */
  let pending;
  child.on('message', message => {
    if (pending) {
      const resolve = pending;
      pending = undefined;
      resolve(message);
    } else messages.push(message);
  });
  const receive = async () => {
    const message = await Promise.race([
      messages.length
        ? Promise.resolve(messages.shift())
        : new Promise(resolve => {
            pending = resolve;
          }),
      exited.then(() => {
        throw Error(`daemon exited before reply: ${diagnostic}`);
      }),
    ]);
    if (message.event === 'error') throw Error(message.message);
    return message;
  };
  t.is((await receive()).event, 'ready');
  return { child, exited, receive };
};

for (const phase of ['journal', 'heap', 'output', 'snapshot']) {
  test.serial(
    `SIGKILL recovery at ${phase} preserves exactly one increment`,
    async t => {
      t.timeout(120_000);
      const path = await mkdtemp(join(tmpdir(), 'thixotrope-kill-'));
      t.teardown(() => rm(path, { recursive: true, force: true }));
      const first = await launch(t, path);
      first.child.send({ command: 'kill-at', phase });
      t.deepEqual(await first.receive(), { event: 'boundary', phase });
      first.child.kill('SIGKILL');
      const [, signal] = await first.exited;
      t.is(signal, 'SIGKILL');
      const second = await launch(t, path);
      // Recovery acquired the exclusive worker lease before reclaiming all old
      // writable copies. Reading wakes fresh incarnations from image + journal.
      t.deepEqual(await readdir(join(path, 'heaps', 'incarnations')), []);
      second.child.send({ command: 'read' });
      t.deepEqual(await second.receive(), { event: 'result', count: '1' });
      second.child.send({ command: 'stop' });
      await second.exited;
    },
  );
}

test.serial(
  'quarantined workers can be inspected without waking or modifying state',
  async t => {
    t.timeout(120_000);
    const f = await makeFixture(t);
    const burner = /** @type {any} */ (
      await f.daemon
        .getWorker(f.guestId)
        .evaluate(`Far('Burner', { spin: () => { while(true) {} } })`)
    );
    await f.daemon.getWorker(f.guestId).sleep();
    await t.throwsAsync(() => E(burner).spin(), { message: /retired/ });
    const before = await readFile(
      join(f.statePath, 'workers', f.guestId, 'meta.json'),
      'utf8',
    );
    const online = f.daemon
      .inspectWorkers()
      .find(row => row.workerId === f.guestId);
    t.regex(online?.failure ?? '', /MeterAbort/);
    t.false(online?.awake);
    const offline = await inspectIronhorseStore(f.statePath);
    t.regex(
      offline.workers.find(row => row.workerId === f.guestId)?.metadata.failure,
      /MeterAbort/,
    );
    t.is(
      await readFile(
        join(f.statePath, 'workers', f.guestId, 'meta.json'),
        'utf8',
      ),
      before,
    );
  },
);

test.serial(
  'another supervisor is refused while the directory is owned',
  async t => {
    t.timeout(120_000);
    const path = await mkdtemp(join(tmpdir(), 'thixotrope-owner-'));
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const first = await launch(t, path);
    await t.throwsAsync(() => launch(t, path), {
      message: /state directory is busy/,
    });
    first.child.send({ command: 'read' });
    t.deepEqual(await first.receive(), { event: 'result', count: '0' });
    first.child.send({ command: 'stop' });
    await first.exited;
    const next = await launch(t, path);
    next.child.send({ command: 'stop' });
    await next.exited;
  },
);

test.serial(
  'runtime is pinned during use and incompatible restart preserves stored state',
  async t => {
    t.timeout(120_000);
    const path = await mkdtemp(join(tmpdir(), 'thixotrope-profile-'));
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const boot = join(path, 'boot');
    await mkdir(boot);
    for (const name of ['boot.js', 'worker-peer.js']) {
      // eslint-disable-next-line no-await-in-loop
      await copyFile(
        fileURLToPath(new URL(`../../dist-ironhorse/${name}`, import.meta.url)),
        join(boot, name),
      );
    }
    const state = join(path, 'state');
    const env = { THIXOTROPE_BOOT_DIR: boot };
    const first = await launch(t, state, env);
    await appendFile(
      join(boot, 'worker-peer.js'),
      "\nthrow Error('modified source must not execute');\n",
    );
    first.child.send({ command: 'probe' });
    t.deepEqual(await first.receive(), { event: 'result', value: 42 });
    first.child.send({ command: 'stop' });
    await first.exited;
    const before = await inspectIronhorseStore(state);
    await t.throwsAsync(() => launch(t, state, env), {
      message: /Incompatible Ironhorse runtime/,
    });
    t.deepEqual(await inspectIronhorseStore(state), before);
    await copyFile(
      fileURLToPath(
        new URL('../../dist-ironhorse/worker-peer.js', import.meta.url),
      ),
      join(boot, 'worker-peer.js'),
    );
    await t.throwsAsync(
      () => launch(t, state, { ...env, THIXOTROPE_CRANK_BUDGET: '9999999' }),
      { message: /Incompatible Ironhorse runtime/ },
    );
    const recovered = await launch(t, state, env);
    recovered.child.send({ command: 'read' });
    t.deepEqual(await recovered.receive(), { event: 'result', count: '0' });
    recovered.child.send({ command: 'stop' });
    await recovered.exited;
  },
);

test.serial('ownership rejects an alternative heap directory', async t => {
  const path = await mkdtemp(join(tmpdir(), 'thixotrope-heap-path-'));
  t.teardown(() => rm(path, { recursive: true, force: true }));
  const engine = makeIronhorseEngine({
    workerBinary: '/unused',
    bootPaths: [],
    storePath: join(path, 'custom'),
  });
  const { acquireStore } = engine;
  if (!acquireStore) throw Error('missing ownership support');
  await t.throwsAsync(() => acquireStore(path), {
    message: /heaps must belong to the daemon state directory/,
  });
});

test.serial(
  'ownership helper loss kills a worker still booting and retains the parent lease',
  async t => {
    t.timeout(30_000);
    const path = await mkdtemp(join(tmpdir(), 'thixotrope-boot-lease-'));
    let release;
    t.teardown(async () => {
      await release?.();
      await rm(path, { recursive: true, force: true });
    });
    const binary =
      process.env.THIXOTROPE_IRONHORSE_WORKER ??
      fileURLToPath(
        new URL(
          '../../../../target/release/thixotrope-ironhorse-worker',
          import.meta.url,
        ),
      );
    // The wrapper only records PIDs; the real Rust processes acquire both locks.
    const wrapper = join(path, 'worker');
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(
      wrapper,
      `#!/bin/sh
if [ "$1" = "--lock-state" ]; then
  echo $$ > ${quote(join(path, 'helper.pid'))}
else
  echo $$ > ${quote(join(path, 'worker.pid'))}
fi
exec ${quote(binary)} "$@"
`,
      { mode: 0o700 },
    );
    const boot = join(path, 'boot.js');
    await writeFile(boot, 'while (true) {}');
    const options = {
      workerBinary: wrapper,
      bootPaths: [boot],
      storePath: join(path, 'heaps'),
    };
    const engine = makeIronhorseEngine(options);
    const { acquireStore } = engine;
    if (!acquireStore) throw Error('missing ownership support');
    release = await acquireStore(path);
    const starting = engine.start({
      snapshot: undefined,
      onOutbound: () => {},
      debugName: 'booting',
    });
    const rejected = t.throwsAsync(() => starting, {
      message: /ownership|exited|terminated|closed/i,
    });
    let workerPid;
    while (!workerPid) {
      try {
        // eslint-disable-next-line no-await-in-loop
        workerPid = Number(await readFile(join(path, 'worker.pid'), 'utf8'));
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
          throw error;
        // Wait only until the wrapper confirms startup is in progress.
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    const helperPid = Number(await readFile(join(path, 'helper.pid'), 'utf8'));
    process.kill(helperPid, 'SIGKILL');
    await rejected;
    t.throws(() => process.kill(workerPid, 0), { code: 'ESRCH' });
    const competitor = makeIronhorseEngine(options);
    const { acquireStore: acquireCompetitor } = competitor;
    if (!acquireCompetitor) throw Error('missing ownership support');
    await t.throwsAsync(() => acquireCompetitor(path), {
      message: /busy/,
    });
    await release();
    release = await acquireCompetitor(path);
  },
);
