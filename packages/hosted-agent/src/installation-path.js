// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';

const BACKENDS = harden([
  'claude-sandbox',
  'codex-sandbox',
  'opencode-sandbox',
]);

/**
 * Resolve a backend installation's private storage. The semantic adapter ID
 * remains unchanged in account publications, owner labels, and configuration.
 * Other callers of the shared provisioning helpers retain their explicit path.
 * @param {string} owner
 * @param {...string} names
 * @returns {string[]}
 */
export const installationPath = (owner, ...names) =>
  harden(
    BACKENDS.includes(owner)
      ? ['@pins', 'installations', owner, ...names]
      : [owner, ...names],
  );
harden(installationPath);

/**
 * @param {any} host
 * @param {string[]} path
 */
export const hasInstallationPath = async (host, path) => {
  await null;
  for (let length = 1; length <= path.length; length += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await E(host).has(...path.slice(0, length)))) return false;
  }
  return true;
};
harden(hasInstallationPath);

/**
 * @param {any} host
 * @param {string[]} path
 */
const provideParents = async (host, path) => {
  await E(host).provideDirectory(path);
};

/**
 * Move an existing installation as one directory binding, retaining all native
 * owners, account facets and session records. A copied alias left by an
 * interrupted migration is safe to resume; conflicting destinations are not.
 * This does not cancel formulas or recreate any descendants.
 * @param {any} host
 * @param {string} owner
 * @param {{removeLegacy?: boolean}} [options] Keep the old alias while staging a live rollout.
 */
export const migrateBackendInstallation = async (
  host,
  owner,
  { removeLegacy = true } = {},
) => {
  await null;
  BACKENDS.includes(owner) || Fail`Unknown backend installation`;
  if (!(await E(host).has(owner))) return;
  const from = [owner];
  const to = installationPath(owner);
  const identifier = await E(host).identify(...from);
  const formula = await E(E(host).diagnostics()).getFormula(identifier);
  formula.type === 'directory' || Fail`Backend installation is not a directory`;
  await E(host).provideDirectory(to, {
    adoptFrom: from,
    keepSource: !removeLegacy,
  });
  (await E(host).identify(...to)) === identifier ||
    Fail`Backend installation changed during migration`;
};
harden(migrateBackendInstallation);

/**
 * @param {any} host
 * @param {string} owner
 */
export const provideInstallationDirectory = async (host, owner) => {
  await provideParents(host, installationPath(owner));
};
harden(provideInstallationDirectory);
