// @ts-check
/**
 * Tests of the state-template helper (test/template/index.js).
 *
 * The unit tests always run. The lifecycle test needs the release Ironhorse
 * worker and runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs -- \
 *     corepack yarn test test/template/template.test.js
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import test from 'ava';

import { scratch } from '../_helpers.js';
import {
  copyState,
  ensureTemplate,
  integrationEnabled,
  integrationEnabledIn,
  processesUnder,
  shortName,
  startFromTemplate,
  supervisorEnv,
  takeIntegrationLock,
  templateInputs,
  templateKey,
} from './index.js';

takeIntegrationLock(test, 'template helper test');

test('shortName is one letter and five base-36 characters', t => {
  for (let i = 0; i < 50; i += 1) t.regex(shortName(), /^s[0-9a-z]{5}$/);
  t.regex(shortName('q'), /^q[0-9a-z]{5}$/);
});

test('templateKey depends on the provisioning id and the crank budget', async t => {
  const a = await templateKey({ crankBudget: 50_000_000n, id: 'base' });
  t.regex(a, /^[0-9a-f]{10}$/);
  t.is(await templateKey({ crankBudget: 50_000_000n, id: 'base' }), a);
  t.not(await templateKey({ crankBudget: 50_000_000n, id: 'other' }), a);
  t.not(await templateKey({ crankBudget: 10_000_000n, id: 'base' }), a);
});

test.serial(
  'templateKey depends on a set collection schedule or hub store, not on unset ones',
  async t => {
    const names = ['THIXOTROPE_GC_POLICY', 'THIXOTROPE_HUB_STORE'];
    const saved = names.map(name => process.env[name]);
    t.teardown(() =>
      names.forEach((name, i) => {
        if (saved[i] === undefined) delete process.env[name];
        else process.env[name] = saved[i];
      }),
    );
    for (const name of names) delete process.env[name];
    const a = await templateKey({ crankBudget: 50_000_000n, id: 'base' });
    process.env.THIXOTROPE_GC_POLICY = 'every-crank';
    const b = await templateKey({ crankBudget: 50_000_000n, id: 'base' });
    t.not(b, a);
    delete process.env.THIXOTROPE_GC_POLICY;
    process.env.THIXOTROPE_HUB_STORE = 'file';
    const c = await templateKey({ crankBudget: 50_000_000n, id: 'base' });
    t.not(c, a);
    t.not(c, b);
    delete process.env.THIXOTROPE_HUB_STORE;
    t.is(await templateKey({ crankBudget: 50_000_000n, id: 'base' }), a);
  },
);

test('integration files run only under THIX_HARNESS_INTEGRATION, never under THIX_HARNESS_SPIKES', t => {
  t.true(integrationEnabledIn({ THIX_HARNESS_INTEGRATION: '1' }));
  t.false(integrationEnabledIn({ THIX_HARNESS_SPIKES: '1' }));
  t.false(integrationEnabledIn({}));
});

test('a Secrets key file reaches one supervisor, not the test process', t => {
  const before = process.env.THIX_HARNESS_SECRETS_KEY;
  const base = { PATH: '/bin', THIX_HARNESS_SECRETS_KEY: '/elsewhere/old.key' };
  t.deepEqual(supervisorEnv({ secretsKeyFile: '/k/secrets.key' }, base), {
    PATH: '/bin',
    THIX_HARNESS_SECRETS_KEY: '/k/secrets.key',
  });
  t.is(supervisorEnv({}, base), base);
  t.is(base.THIX_HARNESS_SECRETS_KEY, '/elsewhere/old.key');
  t.is(process.env.THIX_HARNESS_SECRETS_KEY, before);
  t.throws(() => supervisorEnv({ secretsKeyFile: 'relative.key' }, base), {
    message: /absolute/,
  });
});

test('a provisioned template is keyed by the guest bundles, the manager part, provisioning and the core', async t => {
  const plain = await templateInputs({ provisioned: false });
  const provisioned = await templateInputs({ provisioned: true });
  const harness = 'packages/thixotrope-harness';
  for (const file of [
    'packages/thixotrope/src/control/supervisor.js',
    'packages/thixotrope/dist-ironhorse/boot.js',
    'packages/thixotrope/dist-ironhorse/worker-peer.js',
  ]) {
    t.true(plain.files.includes(file), file);
    t.true(provisioned.files.includes(file), file);
  }
  t.true(plain.files.includes('<worker>'));
  t.deepEqual(plain.programs, []);
  t.deepEqual(provisioned.programs, ['exec', 'factory', 'session']);
  for (const file of [
    `${harness}/guest/session/main.js`,
    `${harness}/guest/factory/standin-session.js`,
    `${harness}/guest/lib/limits.js`,
    `${harness}/resources/agent-host/durable.js`,
    `${harness}/resources/agent-host/durable-subscriptions.js`,
    `${harness}/resources/agent-host/ephemeral.js`,
    `${harness}/scripts/provision-steps.js`,
    `${harness}/scripts/bundle-guest.mjs`,
    `${harness}/config/defaults.js`,
  ]) {
    t.false(plain.files.includes(file), file);
    t.true(provisioned.files.includes(file), file);
  }
  // Paths only, relative to the repository: keys agree across worktrees.
  for (const file of provisioned.files) t.false(path.isAbsolute(file), file);
  t.not(
    await templateKey({ crankBudget: 50_000_000n, id: 'x', provisioned: true }),
    await templateKey({ crankBudget: 50_000_000n, id: 'x' }),
  );
});

test('a template key follows the files its provisioning names, and a missing one throws', async t => {
  const dir = await scratch(t, 'k');
  const file = path.join(dir, 'provisioning.js');
  await writeFile(file, 'one');
  const key = () =>
    templateKey({ crankBudget: 50_000_000n, id: 'src', sources: [file] });
  const a = await key();
  t.is(await key(), a);
  await writeFile(file, 'two');
  const b = await key();
  t.not(b, a);
  await mkdir(path.join(dir, 'sub'));
  await writeFile(path.join(dir, 'sub', 'more.js'), 'x');
  const c = await templateKey({
    crankBudget: 50_000_000n,
    id: 'src',
    sources: [dir],
  });
  await writeFile(path.join(dir, 'sub', 'more.js'), 'y');
  t.not(
    await templateKey({ crankBudget: 50_000_000n, id: 'src', sources: [dir] }),
    c,
  );
  t.not(
    await templateKey({
      crankBudget: 50_000_000n,
      id: 'src',
      sources: [file],
      extra: { turns: 300 },
    }),
    b,
  );
  await t.throwsAsync(
    () =>
      templateKey({
        crankBudget: 50_000_000n,
        id: 'src',
        sources: [path.join(dir, 'missing.js')],
      }),
    { message: /missing\.js/ },
  );
});

test('ensureTemplate refuses an id that is not a short slug', async t => {
  await t.throwsAsync(() => ensureTemplate({ id: '../x' }), {
    message: /template id/,
  });
});

test('copyState clones files, skips sockets and makes the root private', async t => {
  const dir = await scratch(t, 'c');
  const from = path.join(dir, 'a');
  await mkdir(path.join(from, 'heaps'), { recursive: true, mode: 0o755 });
  await writeFile(path.join(from, 'heaps', 'x'), 'payload');
  const server = net.createServer();
  await new Promise(resolve =>
    server.listen(path.join(from, 'control.sock'), () => resolve(undefined)),
  );
  try {
    const to = path.join(dir, 'b');
    await copyState(from, to);
    t.is((await stat(path.join(to, 'heaps', 'x'))).size, 7);
    await t.throwsAsync(() => stat(path.join(to, 'control.sock')));
    t.is(((await stat(to)).mode % 0o1000).toString(8), '700');
  } finally {
    server.close();
  }
});

const run = integrationEnabled ? test.serial : test.skip;

run(
  'a fresh state from the template serves, survives kill -9 and is cleaned up',
  async t => {
    t.timeout(15 * 60_000);
    const template = await ensureTemplate();
    const state = await startFromTemplate(template, { t });
    t.not(state.root, template.dir);
    t.true(
      Buffer.byteLength(`${state.root}/control.sock`) < 104,
      'socket path within sun_path',
    );
    t.log(JSON.stringify({ built: template.built, ...state.timings }));

    // The workspace answers from the copy, and keeps a value durably.
    t.is(
      await state.client.call(
        'evaluate',
        '(globalThis.helperProbe = 41 + 1, globalThis.helperProbe)',
      ),
      '42',
    );
    // Its supervisor's processes name the copy, never the template.
    t.deepEqual(processesUnder(template.dir), []);
    t.true(processesUnder(state.root).length > 0);

    const pid = state.pid();
    await state.kill();
    t.throws(() => process.kill(/** @type {number} */ (pid), 0));
    await state.restart();
    t.not(state.pid(), pid);
    t.is(await state.client.call('evaluate', 'globalThis.helperProbe'), '42');

    await state.cleanup();
    await t.throwsAsync(() => stat(state.root));
    t.deepEqual(processesUnder(state.root), []);
    // The template itself is untouched and still cleanly stopped.
    t.true((await stat(template.dir)).isDirectory());
  },
);
