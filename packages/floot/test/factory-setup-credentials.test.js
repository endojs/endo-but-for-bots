// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { main } from '../floot-factory-setup.js';

test.serial(
  'unsupported provider setup refuses before any host resource calls',
  async t => {
    const names = ['FLOOT_PROVIDER', 'ENDO_FLOOT_PROVIDER'];
    const previous = new Map(names.map(name => [name, process.env[name]]));
    t.teardown(() => {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    const calls = [];
    const touched = method => {
      calls.push(method);
      throw Error('Unexpected host access');
    };
    const host = Far('UncalledSetupHost', {
      has: () => touched('has'),
      lookup: () => touched('lookup'),
      storeValue: () => touched('storeValue'),
      remove: () => touched('remove'),
      provideGuest: () => touched('provideGuest'),
      makeUnconfined: () => touched('makeUnconfined'),
    });
    for (const name of names) {
      delete process.env.FLOOT_PROVIDER;
      delete process.env.ENDO_FLOOT_PROVIDER;
      process.env[name] = 'lal';
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(main(host), { message: /provider/i });
      t.deepEqual(calls, []);
    }
  },
);

test.serial(
  'Secrets failure aborts before replacing the provider config',
  async t => {
    const vars = {
      FLOOT_PROVIDER: 'anthropic',
      FLOOT_AUTH_TOKEN: 'test-import-only',
      ENDO_FLOOT_PROVIDER: 'anthropic',
      ENDO_FLOOT_AUTH_TOKEN: 'test-import-only',
    };
    const previous = new Map(
      Object.keys(vars).map(name => [name, process.env[name]]),
    );
    Object.assign(process.env, vars);
    t.teardown(() => {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    const profile = Far('ExistingProfile', {});
    const mutations = [];
    const host = Far('SetupHost', {
      has: (...parts) => parts[0] === 'floot',
      lookup: path => {
        if (Array.isArray(path) && path[0] === 'floot') return profile;
        throw Error('Secrets unavailable');
      },
      storeValue: (...args) => {
        mutations.push(args);
      },
      remove: (...args) => {
        mutations.push(args);
      },
    });
    await t.throwsAsync(main(host), { message: /Secrets unavailable/ });
    t.deepEqual(mutations, []);
  },
);
