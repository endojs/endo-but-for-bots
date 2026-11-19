// @ts-check
// Provisioning steps (W1a.6) against a fake control client: the steps run
// in order, load the bundled stand-in session program into a real factory
// root (made in Node with fakes), and a second run does nothing.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { Far } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { make } from '../../guest/factory/main.js';
import { programPieceBytes as guestPieceBytes } from '../../guest/factory/root.js';
/* eslint-enable import/no-relative-packages */
import { bundleGuest } from '../../scripts/bundle-guest.mjs';
import {
  agentHostDirectory,
  allProvisionSteps,
  factoryEntry,
  guestRoot,
  makeProvision,
  names,
  programPieceBytes,
  provisionSteps,
  sessionProgramBytes,
  standinExecEntry,
  standinSessionEntry,
  templateIdFor,
} from '../../scripts/provision-steps.js';

const makeFakeClient = () => {
  /** @type {Map<string, any>} */
  const inventory = new Map();
  /** @type {any[][]} */
  const calls = [];
  const vats = Far('ThixotropeWorkerController', {});
  const admin = Far('AgentHostAdmin', {
    onStart: () => Far('Registration', { cancel: () => undefined }),
  });
  const client = {
    /**
     * @param {string} method
     * @param {...any} args
     */
    call: async (method, ...args) => {
      calls.push([
        method,
        ...args.map(a =>
          typeof a === 'string' && a.length > 200 ? `<${a.length} chars>` : a,
        ),
      ]);
      switch (method) {
        case 'lookup':
          return inventory.get(args[0]);
        case 'installNative':
          inventory.set(args[0], admin);
          return { name: args[0] };
        case 'evaluate':
          if (args[0] !== '(inventory.set("vats", vats), true)')
            throw Error(`unexpected source ${args[0]}`);
          inventory.set('vats', vats);
          return true;
        case 'install': {
          const [name, bundle, grants] = args;
          if (typeof bundle !== 'string' || bundle.length < 1000)
            throw Error('expected a bundle');
          const powers = Object.fromEntries(
            grants.map(([as, from]) => [as, inventory.get(from)]),
          );
          inventory.set(
            name,
            make(/** @type {{ host: any, vats: any }} */ (harden(powers))),
          );
          return { name };
        }
        default:
          throw Error(`unexpected call ${method}`);
      }
    },
  };
  return { client, calls, inventory };
};

test('the provisioning steps install, load the program, and re-run as a no-op', async t => {
  const { client, calls, inventory } = makeFakeClient();
  /** @type {any[]} */
  const reports = [];
  const run = makeProvision({
    sessionEntry: standinSessionEntry,
    // M1b W1b.5: the exec step is appended; the stand-in keeps this test
    // independent of guest/exec/main.js.
    execEntry: standinExecEntry,
    onStep: report => reports.push(report),
  });
  const first = await run({ client });
  t.deepEqual(
    first.map(r => [r.name, r.skipped]),
    [
      ['install-native agentHost', false],
      ['inventory vats', false],
      ['install harness', false],
      ['load session program', false],
      ['load exec program', false],
      ['pool', false],
      // M3's registered step (scripts/provision-steps/30-gateway.js),
      // skipped without options.gateway.
      ['gateway', true],
      // M4's registered step (scripts/provision-steps/40-subscriptions.js),
      // skipped without options.subscriptions.
      ['subscriptions', true],
      // M5's registered step (scripts/provision-steps/50-m5-fixtures.js),
      // a no-op without options.m5Fixtures.
      ['m5 fixtures', true],
      // The environments steps (scripts/provision-steps/60-environments.js),
      // skipped without options.environments.
      ['install-native environments', true],
      ['configure environments', true],
      ['attach environments', true],
      // Reserved (WX.1), added with its file and skipped without its
      // option: 70-voice.js.
    ],
  );
  t.deepEqual(reports, first);
  const installNative = calls.find(c => c[0] === 'installNative');
  t.deepEqual(installNative, [
    'installNative',
    names.agentHost,
    agentHostDirectory,
  ]);
  const install = calls.find(c => c[0] === 'install');
  t.deepEqual(install?.[3], [
    ['host', 'agentHostAdmin'],
    ['vats', 'vats'],
  ]);
  const standin = await bundleGuest(standinSessionEntry, { guestRoot });
  const status = await inventory.get('harness').status();
  t.is(status.program.digest, standin.digest);
  t.is(status.program.bytes, standin.bytes);
  t.is(first[3].detail?.pieces, Math.ceil(standin.bytes / programPieceBytes));

  calls.length = 0;
  const second = await run({ client });
  t.true(second.every(r => r.skipped));
  t.deepEqual(
    calls.map(c => c[0]),
    ['lookup', 'lookup', 'lookup', 'lookup', 'lookup', 'lookup'],
  );
});

test('piece size and the bundle budgets', async t => {
  t.is(programPieceBytes, guestPieceBytes);
  const factory = await bundleGuest(factoryEntry, { guestRoot });
  const standin = await bundleGuest(standinSessionEntry, { guestRoot });
  t.log(
    JSON.stringify({
      factoryBytes: factory.bytes,
      standinBytes: standin.bytes,
    }),
  );
  // The factory install budget (install.factory <= 15 s) was measured for
  // programs up to 300 k (J-0193); the stand-in must fit the session budget.
  t.true(factory.bytes <= 300_000, `${factory.bytes}`);
  t.true(standin.bytes <= sessionProgramBytes, `${standin.bytes}`);
  t.false(factory.modules.includes('factory/standin-session.js'));
});

test('the template id follows the provisioned code', async t => {
  const a = await templateIdFor({ sessionEntry: standinSessionEntry });
  t.regex(a, /^m1a-[0-9a-f]{10}$/);
  t.is(await templateIdFor({ sessionEntry: standinSessionEntry }), a);
  t.regex(
    await templateIdFor({ sessionEntry: standinSessionEntry, prefix: 'm1as' }),
    /^m1as-[0-9a-f]{10}$/,
  );
  t.not(
    await templateIdFor({ sessionEntry: factoryEntry }),
    a,
    'another session program, another id',
  );
});

test('the steps table is the M1a list, then M1b W1b.5 appends', async t => {
  t.deepEqual(
    provisionSteps.map(s => s.name),
    [
      'install-native agentHost',
      'inventory vats',
      'install harness',
      'load session program',
      'load exec program',
      'pool',
    ],
  );
  t.true(Object.isFrozen(provisionSteps));
  // Later milestones register files (M2-T1): M3's gateway, M4's
  // subscriptions, then M5's fixtures, after the table.
  const all = await allProvisionSteps();
  t.deepEqual(
    all.map(s => s.name),
    [
      ...provisionSteps.map(s => s.name),
      'gateway',
      'subscriptions',
      'm5 fixtures',
      // 60-environments.js
      'install-native environments',
      'configure environments',
      'attach environments',
    ],
  );
});

test('provision refuses a missing session program', async t => {
  const { client } = makeFakeClient();
  await t.throwsAsync(
    () => makeProvision({ sessionEntry: '/nonexistent/main.js' })({ client }),
    { message: /No session program/ },
  );
});
