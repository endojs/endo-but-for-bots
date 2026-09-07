// @ts-check
import test from '@endo/ses-ava/test.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectLocalControl } from '../../src/local-control.js';

/** @import { ExecutionContext } from 'ava' */
const cli = fileURLToPath(new URL('../../bin/thix.js', import.meta.url));

/** @param {ExecutionContext} t @param {string} path */
const start = async (t, path) => {
  const child = spawn(process.execPath, [cli, 'serve', path], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.teardown(async () => {
    child.kill('SIGKILL');
    await exited;
  });
  let diagnostic = '';
  child.stderr.on('data', data => {
    diagnostic += String(data);
  });
  await Promise.race([
    new Promise(resolve => {
      child.stdout.on('data', data => {
        if (String(data).includes('Thixotrope listening')) resolve(undefined);
      });
    }),
    exited.then(() => {
      throw Error(`serve exited: ${diagnostic}`);
    }),
  ]);
  return { child, exited };
};

/** @param {ExecutionContext} t @param {string} path */
const connect = async (t, path) => {
  const client = await connectLocalControl(join(path, 'control.sock'));
  t.teardown(() => client.close());
  return client;
};

test.serial(
  'interrupted workspace selection and publication reuse the same roots',
  async t => {
    t.timeout(120_000);
    const path = await mkdtemp('/tmp/thix-init-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const first = await start(t, path);
    const initial = await connect(t, path);
    const workerId = (await initial.call('status')).workspace;
    t.is(await initial.call('evaluate', 'globalThis.retained = 91'), '91');
    await initial.call('stop');
    t.is((await first.exited)[0], 0);
    const hubPath = join(path, 'hub.json');
    const configPath = join(path, 'workspace.json');
    const publications = JSON.parse(
      await readFile(hubPath, 'utf8'),
    ).publications;
    t.is(Object.keys(publications).length, 1);

    // A worker allocation exists, but its selection record did not commit.
    await rm(configPath);
    const second = await start(t, path);
    const recoveredSelection = await connect(t, path);
    const status = await recoveredSelection.call('status');
    t.is(status.workspace, workerId);
    t.is(status.workers.length, 1);
    t.is(await recoveredSelection.call('evaluate', 'retained'), '91');
    await recoveredSelection.call('stop');
    t.is((await second.exited)[0], 0);
    t.deepEqual(
      JSON.parse(await readFile(hubPath, 'utf8')).publications,
      publications,
    );

    // The root publication committed, but initialization completion did not.
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.initialized = false;
    await writeFile(configPath, JSON.stringify(config));
    const third = await start(t, path);
    const recoveredPublication = await connect(t, path);
    t.is((await recoveredPublication.call('status')).workspace, workerId);
    t.is(await recoveredPublication.call('evaluate', 'retained'), '91');
    await recoveredPublication.call('stop');
    t.is((await third.exited)[0], 0);
    t.deepEqual(
      JSON.parse(await readFile(hubPath, 'utf8')).publications,
      publications,
    );
    t.is(JSON.parse(await readFile(configPath, 'utf8')).initialized, true);
  },
);

test.serial(
  'failed socket removal still parks workers and releases ownership',
  async t => {
    t.timeout(120_000);
    const path = await mkdtemp('/tmp/thix-unlink-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const first = await start(t, path);
    const client = await connect(t, path);
    t.is(await client.call('evaluate', 'globalThis.saved = 17'), '17');
    const socketPath = join(path, 'control.sock');
    await rm(socketPath);
    await mkdir(socketPath);
    t.is(await client.call('stop'), 'Stopping supervisor');
    t.is((await first.exited)[0], 1, 'unlink failure must be reported');
    t.deepEqual(
      await readdir(join(path, 'heaps', 'incarnations')),
      [],
      'no worker survives failed endpoint cleanup',
    );
    // Repair only the directory deliberately installed by this test.
    await rm(socketPath, { recursive: true });
    const second = await start(t, path);
    const restored = await connect(t, path);
    t.is(await restored.call('evaluate', 'saved'), '17');
    await restored.call('stop');
    t.is((await second.exited)[0], 0);
  },
);

test.serial(
  'local workspace retains a cross-vat counter through detach and supervisor restart',
  async t => {
    t.timeout(120_000);
    const path = await mkdtemp('/tmp/thix-serve-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const first = await start(t, path);
    const client = await connect(t, path);
    const before = await client.call('status');
    t.is(
      await client.call(
        'evaluate',
        `(async () => {
    globalThis.other = await E(vats).createWorker('counter');
    globalThis.counter = await E(other).evaluate("(() => { let count = 0n; return Far('Counter', { incr: () => ++count }); })()");
    return E(counter).incr();
  })()`,
      ),
      '1n',
    );
    client.close();
    const reattached = await connect(t, path);
    t.is(await reattached.call('evaluate', 'E(counter).incr()'), '2n');
    t.is(await reattached.call('stop'), 'Stopping supervisor');
    t.is((await first.exited)[0], 0);
    const second = await start(t, path);
    const restored = await connect(t, path);
    t.is((await restored.call('status')).workspace, before.workspace);
    t.is(await restored.call('evaluate', 'E(counter).incr()'), '3n');
    const after = await restored.call('status');
    t.is(after.workers.length, 2);
    t.not(after.timings.delivery.count, '0');
    // Only the supervisor reads the store; client access is confined to socket.
    // eslint-disable-next-line no-bitwise
    t.is((await stat(join(path, 'control.sock'))).mode & 0o777, 0o600);
    second.child.kill('SIGTERM');
    t.is((await second.exited)[0], 0);
  },
);

test.serial(
  'disconnect reports an uncertain evaluation and a killed supervisor can reclaim its socket',
  async t => {
    t.timeout(120_000);
    const path = await mkdtemp('/tmp/thix-disconnect-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const first = await start(t, path);
    const client = await connect(t, path);
    const workerId = (await client.call('status')).workspace;
    const pending = client.call('evaluate', 'new Promise(() => {})');
    const rejected = t.throwsAsync(() => pending, {
      message: /outcome may be unknown.*No retry/,
    });
    first.child.kill('SIGKILL');
    await first.exited;
    await rejected;
    const second = await start(t, path);
    const next = await connect(t, path);
    t.is((await next.call('status')).workspace, workerId);
    t.is(await next.call('evaluate', '6 * 7'), '42');
    const config = JSON.parse(
      await readFile(join(path, 'workspace.json'), 'utf8'),
    );
    t.is(config.workerId, workerId);
    await next.call('stop');
    t.is((await second.exited)[0], 0);
  },
);

/**
 * @param {ExecutionContext} t
 * @param {string} path
 * @param {string} source
 * @param {string} [command]
 */
const transcript = async (t, path, source, command = 'attach') => {
  const child = spawn(process.execPath, [cli, command, path], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.teardown(async () => {
    child.kill('SIGKILL');
    await exited;
  });
  let output = '';
  let diagnostic = '';
  child.stdout.on('data', data => {
    output += String(data);
  });
  child.stderr.on('data', data => {
    diagnostic += String(data);
  });
  child.stdin.end(source);
  const [code] = await exited;
  return { output, diagnostic, code };
};

test.serial(
  'piped attach returns results and failure exit status without stopping the supervisor',
  async t => {
    t.timeout(120_000);
    const path = await mkdtemp('/tmp/thix-cli-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const supervisor = await start(t, path);
    const good = await transcript(
      t,
      path,
      'globalThis.answer = 40\nanswer + 2\n',
    );
    t.is(good.code, 0);
    t.is(good.output, '40\n42\n');
    const status = await transcript(t, path, '', 'status');
    t.is(status.code, 0);
    t.is(typeof JSON.parse(status.output).timings.delivery.count, 'string');
    const bad = await transcript(
      t,
      path,
      "throw Error('deliberate failure')\n",
    );
    t.is(bad.code, 1);
    t.regex(bad.diagnostic, /deliberate failure/);
    const client = await connect(t, path);
    t.is(await client.call('evaluate', 'answer'), '40');
    const stop = await transcript(t, path, '', 'stop');
    t.is(stop.code, 0);
    t.regex(stop.output, /Stopping supervisor/);
    t.is((await supervisor.exited)[0], 0);
  },
);
