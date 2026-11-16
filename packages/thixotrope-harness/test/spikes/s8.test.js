// @ts-check
/**
 * Spike S8 (milestones.md M0, W0.7): a state template. Provision once
 * (supervisor, workspace, an application vat, a native resource with a
 * built adapter), stop cleanly, then copy the directory per test under a new
 * short path and serve the copy.
 *
 * Checks path independence: no file of the template names the path it was
 * provisioned under, a copy serves from its new path while the template is
 * moved away (control socket, runtime/ copies, a pre-existing vat, the
 * native adapter), survives kill -9 and restart, and two copies serve side
 * by side. Measures copy + start to serving (`template.start`, budget
 * <= 20 s) against the cold provision.
 *
 *   THIX_HARNESS_SPIKES=1 node scripts/run-lock.mjs -- \
 *     corepack yarn test test/spikes/s8.test.js
 */
import { readdir, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import test from 'ava';

import { limits } from '../../config/defaults.js';
import { du, stats as perfStats } from '../../perf/_harness.mjs';
import {
  ensureTemplate,
  processesUnder,
  removeTemplates,
  startFromTemplate,
} from '../template/index.js';
import { ATTACH_FIXTURE, SPIKE_PROGRAM } from './_crash.js';
import {
  E,
  PROBE_PROGRAM,
  emit,
  round1,
  spikesEnabled,
  takeRunLock,
} from './_spike.js';

const crankBudget = BigInt(process.env.S8_BUDGET ?? limits.crankBudget);
const STARTS = Number(process.env.S8_STARTS ?? 5);

/** @type {Awaited<ReturnType<typeof takeRunLock>> | undefined} */
let lock;
test.before(async () => {
  if (spikesEnabled) lock = await takeRunLock('spike s8');
});
test.after.always(async () => {
  await lock?.release();
});

/**
 * Every file under `root` whose bytes contain `needle`, with counts.
 * @param {string} root
 * @param {string} needle
 */
const filesNaming = async (root, needle) => {
  const target = Buffer.from(needle);
  /** @type {{ file: string, count: number, bytes: number }[]} */
  const found = [];
  /** @param {string} dir */
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // eslint-disable-next-line no-await-in-loop
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        // eslint-disable-next-line no-await-in-loop
        const bytes = await readFile(full);
        let count = 0;
        for (
          let at = bytes.indexOf(target);
          at !== -1;
          at = bytes.indexOf(target, at + 1)
        )
          count += 1;
        if (count)
          found.push({
            file: path.relative(root, full),
            count,
            bytes: bytes.length,
          });
      }
    }
  };
  await walk(root);
  return found;
};

/**
 * Provisioning of the S8 template: a probe application vat, the attach
 * fixture native resource, and a vat that opened an adapter endpoint.
 * @param {import('../template/index.js').ProvisionContext} context
 */
const provisionS8 = async ({ client }) => {
  await client.call('install', 'probe', PROBE_PROGRAM, []);
  await client.call('installNative', 'spk', ATTACH_FIXTURE);
  await client.call('install', 'v', SPIKE_PROGRAM, [['spk', 'spk']]);
  const v = await client.call('lookup', 'v');
  await E(v).open();
  await E(v).callAdapter(2);
};

/**
 * Calls into a served copy: the probe vat from the template, the workspace,
 * the native adapter (through the spike vat), and a new install.
 * @param {any} client
 * @param {string} label
 */
const exercise = async (client, label) => {
  const t0 = performance.now();
  const probe = await client.call('lookup', 'probe');
  const ping = await E(probe).ping();
  const firstCallMs = round1(performance.now() - t0);
  const evaluated = await client.call('evaluate', '6 * 7');
  const v = await client.call('lookup', 'v');
  const t1 = performance.now();
  const incarnation = await E(v).open();
  const adapterCalls = await E(v).callAdapter(3);
  const adapterMs = round1(performance.now() - t1);
  const name = `n${label}`;
  const t2 = performance.now();
  await client.call('install', name, PROBE_PROGRAM, []);
  const fresh = await client.call('lookup', name);
  const freshPing = await E(fresh).ping();
  const installMs = round1(performance.now() - t2);
  return {
    ok:
      ping === 1 &&
      String(evaluated) === '42' &&
      adapterCalls === 3 &&
      freshPing === 1,
    ping,
    evaluated,
    incarnation,
    adapterCalls,
    freshPing,
    firstCallMs,
    adapterMs,
    installMs,
  };
};

const run = spikesEnabled ? test.serial : test.skip;

run('S8 state template: path independence and copy + start cost', async t => {
  t.timeout(60 * 60_000);
  const base = { spike: 'S8', crankBudget: String(crankBudget) };
  /** @type {Record<string, boolean>} */
  const found = {};
  try {
    // 1. Cold provision (always rebuilt here, so it is measured).
    const template = await ensureTemplate({
      id: 's8',
      provision: provisionS8,
      crankBudget,
      rebuild: true,
    });
    const builtAt = /** @type {string} */ (template.builtAt);
    await emit({
      ...base,
      metric: 's8.template.build',
      buildMs: template.buildMs,
      steps: template.buildSteps,
      templateKiB: du(template.dir),
      builtAt: path.basename(builtAt),
      storedAt: path.basename(template.dir),
    });

    // 2. Which files name the path the template was provisioned under?
    const namingBuild = await filesNaming(template.dir, builtAt);
    const namingBase = await filesNaming(
      template.dir,
      path.basename(builtAt) + path.sep,
    );
    const namingRepo = await filesNaming(
      template.dir,
      path.dirname(path.dirname(path.dirname(builtAt))),
    );
    await emit({
      ...base,
      metric: 's8.scan.template',
      filesNamingBuildPath: namingBuild,
      filesNamingBuildDirName: namingBase,
      filesNamingRepoPath: namingRepo.map(({ file, count }) => ({
        file,
        count,
      })),
    });
    // Recorded, not asserted: one vat heap names the build path (below).
    found.buildPathStoredOnlyInSnapshots = namingBuild.every(({ file }) =>
      file.startsWith(`heaps${path.sep}snapshots${path.sep}`),
    );

    // 3. Serve a copy while the template itself is moved away.
    const away = `${template.dir}x`;
    await rename(template.dir, away);
    /** @type {import('../template/index.js').TemplateState | undefined} */
    let a;
    try {
      a = await startFromTemplate(
        { ...template, dir: away },
        { idleSleepMs: 2000 },
      );
      const runtimeEntries = await readdir(path.join(a.root, 'runtime'));
      const socketInfo = await stat(path.join(a.root, 'control.sock'));
      const first = await exercise(a.client, 'a1');
      const processes = processesUnder(a.root);
      const strayOld = [
        ...processesUnder(builtAt),
        ...processesUnder(away),
        ...processesUnder(template.dir),
      ];
      await emit({
        ...base,
        metric: 's8.copy.serve',
        timings: a.timings,
        copyRoot: path.basename(a.root),
        rootLength: a.root.length,
        socketIsSocket: socketInfo.isSocket(),
        runtimeProfiles: runtimeEntries,
        processes: processes.length,
        processesNamingOldPaths: strayOld.length,
        ...first,
      });
      found.copyServes = first.ok && socketInfo.isSocket();
      found.noOldPathProcesses = strayOld.length === 0;

      // 4. kill -9 and restart the copy.
      await a.kill();
      const restarted = await a.restart();
      const second = await exercise(a.client, 'a2');
      await emit({
        ...base,
        metric: 's8.copy.afterKill',
        ...restarted,
        ...second,
      });
      found.copyRestarts = second.ok;

      // 5. A second copy serving side by side.
      const b = await startFromTemplate(
        { ...template, dir: away },
        { idleSleepMs: 2000 },
      );
      try {
        const third = await exercise(b.client, 'b1');
        const overlap = processesUnder(b.root).filter(p =>
          p.command.includes(`${a?.root}/`),
        );
        await emit({
          ...base,
          metric: 's8.copy.sideBySide',
          timings: b.timings,
          overlap: overlap.length,
          ...third,
        });
        found.sideBySide = third.ok && overlap.length === 0;
      } finally {
        await b.cleanup();
      }

      // 6. Does the running copy write its own path into state (it may; a
      // later copy of a copy would then need the same check)?
      await a.stop();
      const namingCopy = await filesNaming(a.root, a.root);
      const stillNamingBuild = await filesNaming(a.root, builtAt);
      await emit({
        ...base,
        metric: 's8.scan.copyAfterRun',
        filesNamingCopyPath: namingCopy,
        filesNamingBuildPath: stillNamingBuild,
        copyKiB: du(a.root),
      });
      // The control-socket manager vat keeps its registration's path in its
      // heap (pkg/resources/control/durable.js `serve`): the template names
      // the build path, and each start replaces it with the copy's path.
      found.buildPathReplaced = stillNamingBuild.length === 0;
    } finally {
      await a?.cleanup();
      await rename(away, template.dir);
    }

    // 7. template.start: copy + start to serving + connected, n runs.
    /** @type {number[]} */
    const totals = [];
    const parts = [];
    for (let i = 0; i < STARTS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const s = await startFromTemplate(template, { idleSleepMs: 2000 });
      try {
        const t0 = performance.now();
        // eslint-disable-next-line no-await-in-loop
        const probe = await s.client.call('lookup', 'probe');
        // eslint-disable-next-line no-await-in-loop
        await E(probe).ping();
        const firstCallMs = round1(performance.now() - t0);
        totals.push(s.timings.totalMs);
        parts.push({ ...s.timings, firstCallMs });
      } finally {
        // eslint-disable-next-line no-await-in-loop
        await s.cleanup();
      }
    }
    const row = await perfStats('template.start', totals, {
      budget: { median: 20_000 },
      extra: {
        parts,
        coldServeMs: template.buildSteps?.serveMs,
        coldCreateWorkspaceMs: template.buildSteps?.createWorkspaceMs,
        coldProvisionMs: template.buildSteps?.provisionMs,
        templateKiB: du(template.dir),
      },
    });
    found.startBudget = row.pass === true;
  } catch (error) {
    await emit({
      ...base,
      metric: 's8.error',
      error: String(/** @type {Error} */ (error)?.stack ?? error).slice(
        0,
        3000,
      ),
    });
    throw error;
  } finally {
    if (!process.env.KEEP_STATE) await removeTemplates();
  }
  t.true(
    found.buildPathStoredOnlyInSnapshots,
    'only vat heaps name the provisioning path',
  );
  t.true(found.buildPathReplaced, 'a start replaces the stored path');
  t.true(found.copyServes, 'a copy serves from its new path');
  t.true(found.noOldPathProcesses, 'no process runs from an old path');
  t.true(found.copyRestarts, 'the copy survives kill -9 and restart');
  t.true(found.sideBySide, 'two copies serve side by side');
  t.true(found.startBudget, 'template.start within budget');
});

if (!spikesEnabled) {
  test('S8 runs only with THIX_HARNESS_SPIKES=1', t => t.pass());
}
