// @ts-check
// The environments provisioning steps (scripts/provision-steps/
// 60-environments.js; m6-interfaces.md seam P-2, D-M6-3, D-M6-12) against
// a fake control client: install once, configure with the options'
// settings, attach the admin to the factory; skipped without
// options.environments; a second run installs nothing again. The admin is
// made with the real EnvironmentsAdmin guard. No supervisor.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import {
  environmentInterfaces as I,
  defaultAllowedCommands,
} from '../../guest/lib/guards/environments.js';
/* eslint-enable import/no-relative-packages */
import { allProvisionSteps, names } from '../../scripts/provision-steps.js';
import {
  environmentsAdminName,
  environmentsDirectory,
  steps,
} from '../../scripts/provision-steps/60-environments.js';

const { Far, makeExo } = /** @type {any} */ (globalThis);

const makeFakeState = () => {
  /** @type {any[]} */
  const calls = [];
  /** @type {any[]} */
  const configured = [];
  /** @type {Map<string, any>} */
  const inventory = new Map();
  const makeAdmin = () =>
    makeExo('EnvironmentsAdmin', I.EnvironmentsAdmin, {
      getSettings: () => undefined,
      makeWorkspaceSeed: () => {
        throw Error('not used');
      },
      configure: async (/** @type {any} */ settings) => {
        configured.push(settings);
        return harden({
          state: 'ready',
          environments: 0,
          pendingStops: 0,
          pendingReleases: 0,
          runtime: settings.runtime,
        });
      },
      status: async () => harden({}),
      provide: () => harden({}),
      bindSession: () => {},
      release: () => {},
      releaseSession: () => {},
    });
  /** @type {any[]} */
  const harnessSettings = [];
  inventory.set(
    names.harness,
    Far('HarnessRoot', {
      configure: (/** @type {any} */ settings) => {
        harnessSettings.push(settings);
        return harden({});
      },
    }),
  );
  const client = harden({
    /**
     * @param {string} op
     * @param {...any} args
     */
    call: async (op, ...args) => {
      calls.push([op, ...args]);
      if (op === 'lookup') return inventory.get(args[0]);
      if (op === 'installNative') {
        inventory.set(args[0], makeAdmin());
        return undefined;
      }
      throw Error(`unexpected ${op}`);
    },
  });
  return { client, calls, configured, harnessSettings, inventory };
};

/**
 * @param {any} client
 * @param {Record<string, unknown>} options
 */
const runAll = async (client, options) => {
  /** @type {[string, boolean, any][]} */
  const results = [];
  for (const step of steps) {
    // eslint-disable-next-line no-await-in-loop -- in order, as provisioning runs them
    const result = await step.run({
      client,
      options: /** @type {any} */ ({ sessionEntry: 'unused', ...options }),
    });
    results.push([step.name, result.skipped, result.detail]);
  }
  return results;
};

test('the steps are registered after the earlier ones, in this order', async t => {
  const all = (await allProvisionSteps()).map(step => step.name);
  const at = all.indexOf('install-native environments');
  t.true(at > all.indexOf('m5 fixtures'));
  t.deepEqual(all.slice(at, at + 3), [
    'install-native environments',
    'configure environments',
    'attach environments',
  ]);
});

test('without options.environments every step is skipped and calls nothing', async t => {
  const state = makeFakeState();
  t.deepEqual(await runAll(state.client, {}), [
    ['install-native environments', true, undefined],
    ['configure environments', true, undefined],
    ['attach environments', true, undefined],
  ]);
  t.deepEqual(state.calls, []);
});

test('install once, configure with the settings, attach the admin; a second run installs nothing', async t => {
  const state = makeFakeState();
  const environments = {
    runtime: 'fake',
    allowedCommands: [...defaultAllowedCommands, 'true'],
    idleStopMs: undefined,
  };
  const first = await runAll(state.client, { environments });
  t.deepEqual(first, [
    ['install-native environments', false, undefined],
    ['configure environments', false, { state: 'ready', runtime: 'fake' }],
    ['attach environments', false, undefined],
  ]);
  t.deepEqual(
    state.calls.find(call => call[0] === 'installNative'),
    ['installNative', environmentsAdminName, environmentsDirectory],
  );
  // Fields left undefined are not sent (the settings guard is closed).
  t.deepEqual(state.configured, [
    { runtime: 'fake', allowedCommands: [...defaultAllowedCommands, 'true'] },
  ]);
  const admin = state.inventory.get(environmentsAdminName);
  t.is(state.harnessSettings.length, 1);
  t.is(state.harnessSettings[0].environments, admin);
  t.deepEqual(Object.keys(state.harnessSettings[0]), ['environments']);

  state.calls.length = 0;
  const second = await runAll(state.client, { environments });
  t.true(second[0][1], 'the install is skipped');
  t.false(state.calls.some(call => call[0] === 'installNative'));
  // The manager decides that equal settings change nothing (its `same`);
  // the admin attached again is the same handle.
  t.is(state.configured.length, 2);
  t.deepEqual(state.configured[1], state.configured[0]);
  t.is(state.harnessSettings[1].environments, admin);
});

test('a refused image is reported in the detail, not thrown', async t => {
  const state = makeFakeState();
  state.inventory.set(
    environmentsAdminName,
    makeExo('EnvironmentsAdmin', I.EnvironmentsAdmin, {
      getSettings: () => undefined,
      makeWorkspaceSeed: () => {
        throw Error('not used');
      },
      configure: async () =>
        harden({
          state: 'refused',
          environments: 0,
          pendingStops: 0,
          pendingReleases: 0,
          runtime: 'podman',
          error: 'The environment image is not available',
        }),
      status: async () => harden({}),
      provide: () => harden({}),
      bindSession: () => {},
      release: () => {},
      releaseSession: () => {},
    }),
  );
  const results = await runAll(state.client, {
    environments: { runtime: 'podman', allowedCommands: ['sh'] },
  });
  t.deepEqual(results[1], [
    'configure environments',
    false,
    {
      state: 'refused',
      runtime: 'podman',
      error: 'The environment image is not available',
    },
  ]);
});
