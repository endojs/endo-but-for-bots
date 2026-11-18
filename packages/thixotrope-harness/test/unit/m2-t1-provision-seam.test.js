// @ts-check
// The provisioning seam for later milestones (M2-T1; m3-interfaces.md H5,
// m4-interfaces.md H-8, m5-interfaces.md H-10): `makeProvision` forwards
// every option it does not use itself, untouched, to the M1 table's steps
// and then to the steps registered by file, in file-name order. A fake
// control client on which every M1 step is already done, so only the seam
// runs; registered step files are written to a temporary directory.
import './_m1a-prelude.js';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import test from '@endo/ses-ava/test.js';

import { Far } from '@endo/far';

import { bundleGuest } from '../../scripts/bundle-guest.mjs';
import {
  guestRoot,
  makeProvision,
  names,
  provisionSteps,
  registeredSteps,
  standinSessionEntry,
  stepFiles,
} from '../../scripts/provision-steps.js';

/**
 * A control client of a provisioned workspace: every M1 step answers
 * `{ skipped: true }` (the inventory holds its names, the factory holds the
 * stand-in program, no pool, no exec program).
 */
const makeDoneClient = async () => {
  const { digest } = await bundleGuest(standinSessionEntry, { guestRoot });
  const harness = Far('HarnessRoot', {
    status: () => harden({ program: { digest } }),
  });
  const inventory = new Map([
    [names.agentHost, Far('AgentHostAdmin', {})],
    [names.vats, Far('ThixotropeWorkerController', {})],
    [names.harness, harness],
  ]);
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    client: {
      /**
       * @param {string} method
       * @param {...any} args
       */
      call: async (method, ...args) => {
        calls.push(method);
        if (method === 'lookup') return inventory.get(args[0]);
        throw Error(`unexpected call ${method}`);
      },
    },
  };
};

/**
 * A step file whose steps answer the options they were given as detail.
 * @param {string[]} stepNames
 */
const stepSource = stepNames =>
  `export const steps = [${stepNames
    .map(
      name =>
        `{ name: ${JSON.stringify(name)}, run: async ({ options }) => ({ skipped: false, detail: { options } }) }`,
    )
    .join(', ')}];\n`;

/**
 * A temporary registry directory with these files.
 * @param {import('ava').ExecutionContext} t
 * @param {Record<string, string>} files
 */
const registry = async (t, files) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'm2t1-steps-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    // eslint-disable-next-line no-await-in-loop
    await writeFile(path.join(directory, name), text);
  }
  return directory;
};

const M1_STEPS = provisionSteps.map(step => step.name);

test('later milestones get their options untouched, in file order, after the table', async t => {
  const directory = await registry(t, {
    '50-m5-fixtures.js': stepSource(['m5 fixtures']),
    '30-gateway.js': stepSource(['gateway']),
    '40-subscriptions.js': stepSource(['subscriptions']),
    'notes.md': 'not a step file',
    'helper.js': 'export const steps = [{ name: "not registered" }];\n',
  });
  const { client } = await makeDoneClient();
  const gateway = { port: 0 };
  const subscriptions = [{ kind: 'claude-pool', label: 'p', members: [] }];
  const m5Fixtures = { name: 'fixtures', source: '() => ({})' };
  /** @type {any[]} */
  const reports = [];
  const run = makeProvision({
    sessionEntry: standinSessionEntry,
    execEntry: path.join(directory, 'no-exec-program.js'),
    stepDirectory: directory,
    onStep: report => reports.push(report),
    gateway,
    subscriptions,
    m5Fixtures,
  });
  const done = await run({ client });
  t.deepEqual(
    done.map(r => [r.name, r.skipped]),
    [
      ...M1_STEPS.map(name => [name, true]),
      ['gateway', false],
      ['subscriptions', false],
      ['m5 fixtures', false],
    ],
  );
  t.deepEqual(reports, done);
  for (const report of done.slice(M1_STEPS.length)) {
    const { options } = /** @type {any} */ (report.detail);
    // The same objects, not copies.
    t.is(options.gateway, gateway);
    t.is(options.subscriptions, subscriptions);
    t.is(options.m5Fixtures, m5Fixtures);
    t.is(options.sessionEntry, standinSessionEntry);
    t.false('onStep' in options, 'onStep stays with makeProvision');
    t.false(
      'stepDirectory' in options,
      'stepDirectory stays with makeProvision',
    );
  }
});

test('a step not asked for still runs and sees no option of another lane', async t => {
  const directory = await registry(t, {
    '30-gateway.js': stepSource(['gateway']),
  });
  const { client } = await makeDoneClient();
  const done = await makeProvision({
    sessionEntry: standinSessionEntry,
    execEntry: path.join(directory, 'no-exec-program.js'),
    stepDirectory: directory,
  })({ client });
  const { options } = /** @type {any} */ (done[done.length - 1].detail);
  t.deepEqual(Object.keys(options).sort(), [
    'execEntry',
    'pool',
    'sessionEntry',
  ]);
});

test('the registry: file names ordered, a missing directory is empty, a taken name is refused', async t => {
  const directory = await registry(t, {
    '40-b.js': stepSource(['b']),
    '30-a.js': stepSource(['a1', 'a2']),
    '3-short.js': stepSource(['short']),
    '30-a.mjs': stepSource(['other extension']),
  });
  t.deepEqual(
    (await stepFiles(directory)).map(file => path.basename(file)),
    ['30-a.js', '40-b.js'],
  );
  t.deepEqual(
    (await registeredSteps(directory)).map(step => step.name),
    ['a1', 'a2', 'b'],
  );
  t.true(Object.isFrozen(await registeredSteps(directory)));
  t.deepEqual(await registeredSteps(path.join(directory, 'absent')), []);

  const clash = await registry(t, { '30-pool.js': stepSource(['pool']) });
  await t.throwsAsync(() => registeredSteps(clash), {
    message: /30-pool\.js: step pool exists already/,
  });
  const twice = await registry(t, {
    '30-x.js': stepSource(['x']),
    '40-x.js': stepSource(['x']),
  });
  await t.throwsAsync(() => registeredSteps(twice), {
    message: /40-x\.js: step x exists already/,
  });
  const bad = await registry(t, { '30-bad.js': 'export const step = {};\n' });
  await t.throwsAsync(() => registeredSteps(bad), {
    message: /must export steps/,
  });
});
