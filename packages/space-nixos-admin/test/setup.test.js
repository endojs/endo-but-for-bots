// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { main } from '../setup.js';

test.serial('setup forwards the configured NixOS state directory', async t => {
  const previous = process.env.ENDO_NIXOS_STATE_DIR;
  process.env.ENDO_NIXOS_STATE_DIR = '/var/lib/local-nixos-admin';
  const previousLockDir = process.env.ENDO_NIXOS_LOCK_DIR;
  process.env.ENDO_NIXOS_LOCK_DIR = '/run/lock/local-nixos-admin';
  t.teardown(() => {
    if (previous === undefined) {
      delete process.env.ENDO_NIXOS_STATE_DIR;
    } else {
      process.env.ENDO_NIXOS_STATE_DIR = previous;
    }
    if (previousLockDir === undefined) {
      delete process.env.ENDO_NIXOS_LOCK_DIR;
    } else {
      process.env.ENDO_NIXOS_LOCK_DIR = previousLockDir;
    }
  });

  /** @type {any} */
  let invocation;
  const agent = {
    async has() {
      return false;
    },
    async makeUnconfined(name, specifier, options) {
      invocation = { name, specifier, options };
    },
  };

  await main(agent);

  t.is(
    invocation.options.env.ENDO_NIXOS_STATE_DIR,
    '/var/lib/local-nixos-admin',
  );
  t.is(
    invocation.options.env.ENDO_NIXOS_LOCK_DIR,
    '/run/lock/local-nixos-admin',
  );
});

test.serial(
  'setup refuses to preserve a controller with stale paths',
  async t => {
    const names = [
      'ENDO_NIXOS_CONFIG_DIR',
      'ENDO_NIXOS_DIR',
      'ENDO_NIXOS_HOST',
      'ENDO_NIXOS_STATE_DIR',
      'ENDO_NIXOS_LOCK_DIR',
    ];
    const previous = Object.fromEntries(
      names.map(name => [name, process.env[name]]),
    );
    Object.assign(process.env, {
      ENDO_NIXOS_CONFIG_DIR: '/etc/nixos',
      ENDO_NIXOS_DIR: '/var/lib/nixos-admin/apply',
      ENDO_NIXOS_HOST: 'new-host',
      ENDO_NIXOS_STATE_DIR: '/var/lib/nixos-admin',
      ENDO_NIXOS_LOCK_DIR: '/run/lock/nixos-admin',
    });
    t.teardown(() => {
      for (const name of names) {
        if (previous[name] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = previous[name];
        }
      }
    });

    const controller = {
      async getConfig() {
        return {
          configDir: '/old/config',
          nixosDir: '/old/spool',
          stateDir: '/old',
          lockDir: '/old/lock',
          host: 'old-host',
        };
      },
    };
    const agent = {
      async has() {
        return true;
      },
      async lookup() {
        return controller;
      },
    };

    await t.throwsAsync(() => main(agent), {
      message:
        /stale configuration.*configDir.*nixosDir.*stateDir.*lockDir.*host/,
    });
  },
);
