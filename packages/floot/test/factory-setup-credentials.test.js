// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { main } from '../floot-factory-setup.js';

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
