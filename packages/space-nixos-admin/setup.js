// @ts-check
/* global process */
// endo run --UNCONFINED setup.js --powers @agent
//
// Provisions the local NixOS host-admin controller and stores it in the agent's
// inventory as `controller-for-nixos-admin`. Intended to be listed in the
// daemon's ENDO_EXTRA so it auto-provisions on start.
//
// Unlike the deploy controller (which re-binds every boot), this one is
// IDEMPOTENT and pins its module through the deploy's `current` symlink: the
// formula identity must stay stable so the grant that the Floot factory hands
// to sessions (via storeLocator) does not dangle across restarts, while the
// current-linked specifier still re-imports the newest code on each revival and
// survives release pruning.

import { E } from '@endo/far';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reroute a release-pinned module URL through a deployment's stable
 * `current` symlink so a pinned UNCONFINED formula survives release pruning.
 * No-op outside that layout (dev checkouts, or when the `current` twin does not
 * resolve on disk). A small pure twin of the helper in `@endo/daemon` and
 * `@endo/claude-sandbox`; duplicated because this package may not depend on them.
 *
 * @param {string} specifier
 * @returns {string}
 */
const toCurrentSpecifier = specifier => {
  const match = /^(.*)\/releases\/[^/]+\/(.*)$/.exec(specifier);
  if (!match) {
    return specifier;
  }
  const [, stateRoot, rest] = match;
  const currentSpecifier = `${stateRoot}/current/${rest}`;
  try {
    if (existsSync(fileURLToPath(currentSpecifier))) {
      return currentSpecifier;
    }
  } catch {
    // Unparseable URL or unreadable path: keep the concrete release specifier.
  }
  return specifier;
};

const capletSpecifier = toCurrentSpecifier(
  new URL('caplet.js', import.meta.url).href,
);

/**
 * @param {import('@endo/far').ERef<any>} agent
 */
export const main = async agent => {
  const { env } = process;
  const configDir = env.ENDO_NIXOS_CONFIG_DIR || '';
  const nixosDir = env.ENDO_NIXOS_DIR || '';
  const expected = {
    configDir,
    nixosDir,
    stateDir: env.ENDO_NIXOS_STATE_DIR || (nixosDir ? dirname(nixosDir) : ''),
    lockDir: env.ENDO_NIXOS_LOCK_DIR || '/run/lock/endo-nixos-admin',
    host: env.ENDO_NIXOS_HOST || hostname(),
  };
  const alreadyInstalled = await E(agent).has('controller-for-nixos-admin');
  if (alreadyInstalled) {
    const controller = await E(agent).lookup('controller-for-nixos-admin');
    const actual = await E(controller).getConfig();
    const mismatches = Object.entries(expected)
      .filter(([name, value]) => actual?.[name] !== value)
      .map(([name]) => name);
    if (mismatches.length > 0) {
      throw new Error(
        `Existing NixOS admin controller has stale configuration for: ${mismatches.join(', ')}. ` +
          'Remove and reprovision it explicitly.',
      );
    }
    console.error('NixOS admin controller already installed.');
    return;
  }

  await E(agent).makeUnconfined('@main', capletSpecifier, {
    resultName: 'controller-for-nixos-admin',
    env: {
      ENDO_NIXOS_CONFIG_DIR: env.ENDO_NIXOS_CONFIG_DIR || '',
      ENDO_NIXOS_DIR: env.ENDO_NIXOS_DIR || '',
      ENDO_NIXOS_HOST: env.ENDO_NIXOS_HOST || '',
      ENDO_NIXOS_STATE_DIR: env.ENDO_NIXOS_STATE_DIR || '',
      ENDO_NIXOS_LOCK_DIR: env.ENDO_NIXOS_LOCK_DIR || '',
    },
  });

  console.error('NixOS admin controller provisioned.');
};
harden(main);
