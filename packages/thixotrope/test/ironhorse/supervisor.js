// @ts-check
import test from '@endo/ses-ava/test.js';
import { Far } from '@endo/far';
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

import { bundleApplication } from '../../src/bundle-application.js';
import { connectLocalControl } from '../../src/local-control.js';

import { makeNodePowers } from '../../src/platform/node-powers.js';

const nodePowers = makeNodePowers();

/** @import { ExecutionContext } from 'ava' */
const cli = fileURLToPath(new URL('../../bin/thix.js', import.meta.url));

/**
 * @param {ExecutionContext} t @param {string} path
 * @param path
 */
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
  return { child, exited, diagnostic: () => diagnostic };
};

/**
 * @param {ExecutionContext} t @param {string} path
 * @param path
 */
const connect = async (t, path) => {
  const client = await connectLocalControl(
    nodePowers,
    join(path, 'control.sock'),
  );
  t.teardown(() => client.close());
  return client;
};

for (const phase of ['subscribe', 'unsubscribe']) {
  test.serial(
    `supervisor stop is bounded when inventory ${phase} stalls`,
    async t => {
      t.timeout(30_000);
      const path = await mkdtemp('/tmp/thix-stalled-view-');
      t.teardown(() => rm(path, { recursive: true, force: true }));
      const first = await start(t, path);
      const initial = await connect(t, path);
      await initial.call(
        'evaluate',
        `(() => {
      globalThis.watchStarted = false;
      globalThis.unsubscribeStarted = false;
      globalThis.inventory = Far('StalledInventory', {
        disconnectEphemeral: () => {},
        subscribe: () => {
          watchStarted = true;
          ${phase === 'subscribe' ? 'return new Promise(() => {});' : "return Far('StalledSubscription', { unsubscribe: () => { unsubscribeStarted = true; return new Promise(() => {}); } });"}
        },
      });
    })()`,
      );
      await initial.call('stop');
      t.is((await first.exited)[0], 0);

      // Restart selects the persisted inventory rather than the old host reference.
      const second = await start(t, path);
      const admin = await connect(t, path);
      const view = await connect(t, path);
      const watching = view.call(
        'watchInventory',
        Far('View', { changed: () => {} }),
      );
      const handledWatch = watching.catch(() => undefined);
      if (phase === 'unsubscribe') await watching;
      let entered = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        if ((await admin.call('evaluate', 'watchStarted')) === 'true') {
          entered = true;
          break;
        }
      }
      t.true(entered, 'the intended stalled operation was reached');
      t.is(await admin.call('stop'), 'Stopping supervisor');
      t.is(
        (await second.exited)[0],
        0,
        'shutdown must not wait forever for guest cancellation',
      );
      await handledWatch;
      t.deepEqual(await readdir(join(path, 'heaps', 'incarnations')), []);

      const third = await start(t, path);
      const restored = await connect(t, path);
      t.is(await restored.call('evaluate', 'watchStarted'), 'true');
      if (phase === 'unsubscribe')
        t.is(await restored.call('evaluate', 'unsubscribeStarted'), 'true');
      await restored.call('stop');
      t.is(
        (await third.exited)[0],
        0,
        'state ownership is reusable after bounded cleanup',
      );
    },
  );
}

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

/**
 * @param {ExecutionContext} t
 * @param {Awaited<ReturnType<typeof connectLocalControl>>} client
 * @param {bigint} expected
 */
const waitForViews = async (t, client, expected) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const counts = await client.call('inventoryStatus');
    if (counts.ephemeral === expected) return counts;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  t.fail(`Expected ${expected} ephemeral subscriptions`);
};

test.serial(
  'observable inventory crosses a persistent guest and ephemeral views without retaining closed subscriptions',
  async t => {
    t.timeout(180_000);
    const path = await mkdtemp('/tmp/thix-inventory-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const first = await start(t, path);
    const admin = await connect(t, path);
    await admin.call(
      'evaluate',
      `(() => {
    globalThis.retainedCounter = Far('Counter', { read: () => 42 });
    inventory.set('counter', retainedCounter);
    globalThis.observedRevisions = [];
    globalThis.durableSubscription = inventory.subscribe(Far('GuestObserver', {
      changed: snapshot => { observedRevisions.push(snapshot.revision); },
    }));
  })()`,
    );
    const view = await connect(t, path);
    const updates = [];
    let nextUpdate;
    const observer = Far('TestView', {
      changed: update => {
        updates.push(update);
        nextUpdate?.();
        nextUpdate = undefined;
      },
    });
    await view.call('watchInventory', observer);
    while (updates.length === 0) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => {
        nextUpdate = resolve;
      });
    }
    t.deepEqual(updates[0].entries, [['counter', '<object / capability>']]);
    t.deepEqual(await admin.call('inventoryStatus'), {
      durable: 1n,
      ephemeral: 1n,
    });
    await admin.call('evaluate', "inventory.set('color', 'blue'); undefined");
    while (
      !updates.some(update => update.entries.some(([key]) => key === 'color'))
    ) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => {
        nextUpdate = resolve;
      });
    }
    view.close();
    t.deepEqual(await waitForViews(t, admin, 0n), {
      durable: 1n,
      ephemeral: 0n,
    });
    const stalled = await connect(t, path);
    await stalled.call(
      'watchInventory',
      Far('StalledView', {
        changed: () => new Promise(() => {}),
      }),
    );
    await admin.call('evaluate', "inventory.set('slow', true); undefined");
    stalled.close();
    await waitForViews(t, admin, 0n);
    const received = updates.length;
    await admin.call('evaluate', "inventory.delete('color'); undefined");
    t.is(updates.length, received);
    // Persist an attached view, then kill the supervisor. Its successor must
    // discard that old UI subscription while retaining the guest's subscriber.
    const abandoned = await connect(t, path);
    await abandoned.call(
      'watchInventory',
      Far('AbandonedView', { changed: () => {} }),
    );
    t.deepEqual(await admin.call('inventoryStatus'), {
      durable: 1n,
      ephemeral: 1n,
    });
    // Let the actual idle policy snapshot both kinds of subscription while
    // the UI remains connected. status is read-only and does not wake the vat.
    // The 30-second idle timer only starts parking. Snapshot completion also
    // closes SQLite, copies and syncs the heap, and relaunches the worker.
    // Allow another engine-watchdog interval (60 seconds) for that work on CI;
    // this is a test allowance, not an upper bound on filesystem latency.
    const sleepDeadline = performance.now() + 90_000;
    let slept = false;
    let lastStatus;
    while (performance.now() < sleepDeadline) {
      // eslint-disable-next-line no-await-in-loop
      const status = await admin.call('status');
      lastStatus = status;
      if (
        !status.workers.find(worker => worker.workerId === status.workspace)
          .awake
      ) {
        slept = true;
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!slept) {
      t.log('Last supervisor status:', lastStatus);
      t.log('Supervisor stderr:', first.diagnostic());
    }
    t.true(slept, 'workspace slept with an attached UI');
    await admin.call('evaluate', "inventory.set('woke', true); undefined");
    t.deepEqual(await admin.call('inventoryStatus'), {
      durable: 1n,
      ephemeral: 1n,
    });
    first.child.kill('SIGKILL');
    await first.exited;
    const second = await start(t, path);
    const restored = await connect(t, path);
    t.deepEqual(await restored.call('inventoryStatus'), {
      durable: 1n,
      ephemeral: 0n,
    });
    t.is(
      await restored.call('evaluate', "E(inventory.get('counter')).read()"),
      '42',
    );
    await restored.call(
      'evaluate',
      "inventory.set('restored', true); undefined",
    );
    t.is(
      await restored.call(
        'evaluate',
        'observedRevisions.includes(inventory.snapshot().revision)',
      ),
      'true',
    );
    await restored.call('stop');
    t.is((await second.exited)[0], 0);
  },
);

test.serial(
  'inventory TUI disconnects on stdin close and removes its guest subscription',
  async t => {
    t.timeout(120_000);
    const path = await mkdtemp('/tmp/thix-tui-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const supervisor = await start(t, path);
    const admin = await connect(t, path);
    await admin.call('evaluate', "inventory.set('example', 123); undefined");
    const ui = spawn(process.execPath, [cli, 'inventory', path], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = once(ui, 'exit');
    t.teardown(async () => {
      ui.kill('SIGKILL');
      await exited;
    });
    let output = '';
    let diagnostic = '';
    ui.stderr.on('data', data => {
      diagnostic += String(data);
    });
    const rendered = new Promise(resolve => {
      ui.stdout.on('data', data => {
        output += String(data);
        if (output.includes('example  123')) resolve(undefined);
      });
    });
    await Promise.race([
      rendered,
      exited.then(() => {
        throw Error(diagnostic);
      }),
    ]);
    t.is((await admin.call('inventoryStatus')).ephemeral, 1n);
    const refreshed = new Promise(resolve =>
      ui.stdout.on('data', () => {
        if (output.includes('changed  true')) resolve(undefined);
      }),
    );
    await admin.call('evaluate', "inventory.set('changed', true); undefined");
    await refreshed;
    ui.stdin.end();
    t.is((await exited)[0], 0);
    await waitForViews(t, admin, 0n);
    t.is(await admin.call('evaluate', "inventory.get('example')"), '123');
    for (const mode of ['q', 'SIGTERM', 'SIGKILL', 'early EOF']) {
      t.log(`closing TUI with ${mode}`);
      const another = spawn(process.execPath, [cli, 'inventory', path], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const ended = once(another, 'exit');
      t.teardown(async () => {
        another.kill('SIGKILL');
        await ended;
      });
      const visible = new Promise(resolve =>
        another.stdout.on('data', () => resolve(undefined)),
      );
      if (mode !== 'early EOF') {
        // eslint-disable-next-line no-await-in-loop
        await Promise.race([
          visible,
          ended.then(() => {
            throw Error('TUI exited before rendering');
          }),
        ]);
      }
      if (mode === 'q') another.stdin.write('q\n');
      else if (mode === 'early EOF') another.stdin.end();
      else if (mode === 'SIGTERM' || mode === 'SIGKILL') another.kill(mode);
      // eslint-disable-next-line no-await-in-loop
      const [code, signal] = await ended;
      if (mode === 'SIGKILL') t.is(signal, 'SIGKILL');
      else t.is(code, 0);
      // eslint-disable-next-line no-await-in-loop
      await waitForViews(t, admin, 0n);
    }

    await admin.call('stop');
    t.is((await supervisor.exited)[0], 0);
  },
);

test.serial(
  'installed modules retain code, powers and their root across supervisor restart',
  async t => {
    t.timeout(120_000);
    const path = await mkdtemp('/tmp/thix-install-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const first = await start(t, path);
    const admin = await connect(t, path);
    const file = join(path, 'application.js');
    await writeFile(
      join(path, 'package.json'),
      JSON.stringify({ name: 'test-application', type: 'module' }),
    );
    await writeFile(
      file,
      `export const make = powers => { let count = 0n; return Far('App', { incr: () => ++count, read: () => count, granted: () => E(powers.counter).read(), powers: () => harden(Object.keys(powers)), confined: () => typeof process + ':' + typeof require }); }; harden(make);`,
    );
    await admin.call(
      'evaluate',
      "inventory.set('counter', Far('GrantedCounter', { read: () => 42n })); undefined",
    );
    const { bundle, digest } = await bundleApplication(nodePowers, file);
    const installed = await admin.call('install', 'counter-app', bundle, [
      ['counter', 'counter'],
    ]);
    t.is(installed.digest, digest);
    t.is(installed.status, 'ready');
    t.is(
      await admin.call('evaluate', "E(E(apps).get('counter-app')).incr()"),
      '1n',
    );
    t.is(
      await admin.call('evaluate', "E(E(apps).get('counter-app')).granted()"),
      '42n',
    );
    t.is(
      await admin.call('evaluate', "E(E(apps).get('counter-app')).confined()"),
      "'undefined:undefined'",
    );
    t.is((await admin.call('status')).workers.length, 2);
    await admin.call('install', 'counter-app', bundle, [
      ['counter', 'counter'],
    ]);
    t.is(
      (await admin.call('status')).workers.length,
      2,
      'repeat installation reuses its vat',
    );
    await t.throwsAsync(
      () =>
        admin.call('install', 'counter-app', `${bundle}\n `, [
          ['counter', 'counter'],
        ]),
      { message: /different installation/ },
    );
    await t.throwsAsync(
      () =>
        admin.call('install', 'missing-grant', bundle, [['counter', 'absent']]),
      { message: /Unknown inventory grant/ },
    );
    t.is((await admin.call('applications')).length, 1);
    await admin.call('stop');
    t.is((await first.exited)[0], 0);
    await rm(file);
    const second = await start(t, path);
    const restored = await connect(t, path);
    t.is(
      await restored.call('evaluate', "E(E(apps).get('counter-app')).incr()"),
      '2n',
    );
    t.is(
      await restored.call(
        'evaluate',
        "E(E(apps).get('counter-app')).granted()",
      ),
      '42n',
    );
    t.is((await restored.call('applications'))[0].digest, digest);
    await restored.call('install', 'counter-app', bundle, [
      ['counter', 'counter'],
    ]);
    t.is((await restored.call('status')).workers.length, 2);
    await restored.call('stop');
    t.is((await second.exited)[0], 0);
  },
);

test.serial(
  'install CLI bundles the counter example and lists its application',
  async t => {
    t.timeout(60_000);
    const path = await mkdtemp('/tmp/thix-install-cli-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const supervisor = await start(t, path);
    const child = spawn(
      process.execPath,
      [cli, 'install', path, 'counter', './examples/counter.js'],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
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
    const code = (await exited)[0];
    const check = await connect(t, path);
    if (code !== 0) t.log(await check.call('status'));
    t.is(code, 0, diagnostic);
    t.is(JSON.parse(output).status, 'ready');
    const listed = await transcript(t, path, '', 'applications');
    t.is(listed.code, 0);
    t.is(JSON.parse(listed.output)[0].name, 'counter');
    const graph = await transcript(t, path, '', 'reachability');
    t.is(graph.code, 0);
    t.is(JSON.parse(graph.output).workers.length, 2);
    const collection = await transcript(t, path, '', 'collect');
    t.is(collection.code, 0);
    t.deepEqual(JSON.parse(collection.output), []);
    const admin = await connect(t, path);
    t.is(
      await admin.call('evaluate', "E(E(apps).get('counter')).incr()"),
      '1n',
    );
    await admin.call('stop');
    t.is((await supervisor.exited)[0], 0);
  },
);

test.serial(
  'pending application factory survives restart through a direct guest answer',
  async t => {
    t.timeout(120_000);
    const path = await mkdtemp('/tmp/thix-install-pending-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const first = await start(t, path);
    const admin = await connect(t, path);
    await admin.call(
      'evaluate',
      "globalThis.gateStarted = false; globalThis.gatePromise = new Promise(resolve => { globalThis.resolveGate = resolve; }); inventory.set('gate', Far('Gate', { wait: () => { gateStarted = true; return gatePromise; } })); undefined",
    );
    const installing = admin.call(
      'install',
      'pending',
      "({ make: async powers => { await E(powers.gate).wait(); return Far('Ready', { read: () => 8n }); } })",
      [['gate', 'gate']],
    );
    const handled = installing.catch(() => undefined);
    let entered = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      if ((await admin.call('evaluate', 'gateStarted')) === 'true') {
        entered = true;
        break;
      }
    }
    t.true(entered);
    t.is((await admin.call('applications'))[0].status, 'pending');
    await admin.call('stop');
    t.is((await first.exited)[0], 0);
    await handled;
    const second = await start(t, path);
    const restored = await connect(t, path);
    await restored.call('evaluate', 'resolveGate(); undefined');
    t.is(
      await restored.call('evaluate', "E(E(apps).get('pending')).read()"),
      '8n',
    );
    t.is((await restored.call('applications'))[0].status, 'ready');
    await t.throwsAsync(
      () => restored.call('install', 'oversized', ' '.repeat(16 * 1024), []),
      { message: /16 KiB/ },
    );
    await restored.call(
      'evaluate',
      "inventory.set('large-copy', 'x'.repeat(250_000)); undefined",
    );
    await t.throwsAsync(
      () =>
        restored.call('install', 'copy-grant', '({make: () => 0})', [
          ['data', 'large-copy'],
        ]),
      { message: /remotable capabilities/ },
    );
    t.is(
      await restored.call('evaluate', '2 + 2'),
      '4',
      'oversized requests never enter the workspace',
    );
    await restored.call('stop');
    t.is((await second.exited)[0], 0);
  },
);
