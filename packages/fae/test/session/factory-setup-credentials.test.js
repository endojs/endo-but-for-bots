// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { main } from '../../setup-session-factory.js';

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
    const names = new Map([
      ['@self', 'root-handle'],
      ['@main', 'main-worker'],
      ['fae-sessions/controller-profile', 'profile'],
      ['fae-sessions/controller-handle', 'handle'],
      ['fae-sessions/controller', 'controller'],
    ]);
    const formulas = harden({
      profile: {
        type: 'host',
        properties: {
          hostHandle: { identifier: 'root-handle' },
          handle: { identifier: 'handle' },
        },
      },
      handle: {
        type: 'handle',
        properties: { agent: { identifier: 'profile' } },
      },
      controller: {
        type: 'make-unconfined',
        properties: {
          powers: { identifier: 'profile' },
          worker: { identifier: 'main-worker' },
          specifier: {
            value: new URL('../../session-factory.js', import.meta.url).href,
          },
        },
      },
    });
    const host = Far('SetupHost', {
      has: (...parts) => parts[0] === 'fae-sessions',
      identify: (...parts) => names.get(parts.join('/')),
      diagnostics: () => Far('Diagnostics', { getFormula: id => formulas[id] }),
      lookupById: id => {
        if (id !== 'profile') throw Error('Unexpected recipient');
        return profile;
      },
      lookup: path => {
        if (Array.isArray(path) && path[0] === 'fae-sessions') return profile;
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
