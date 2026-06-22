// @ts-check
/* global process */
// endo run --UNCONFINED factory.js --powers @agent  [<dirName>]
//
// Provision the Claude Sandbox factory caplet under @host. The factory
// presents a "Create Claude Sandbox" form on @host's inbox; each
// submission mounts a Filesystem cap over 9P on the host, mints a
// podman slice with that workspace bound at /workspace, runs Claude
// Code inside it, and stores a ClaudeClient exo back in @host's
// petstore.
//
// Everything lands under a host directory (`<dirName>/`) so the host root
// stays clean: `<dirName>/{controller, profile, handle}` plus the infra
// caplets `<dirName>/{sandbox-factory, fs-mounter}`.
//
// Prerequisites (mint them first, or use setup.js which does everything):
//   - a sandbox factory at `<dirName>/sandbox-factory`
//     (from `@endo/sandbox`'s agent.js), and
//   - a 9P mounter at `<dirName>/fs-mounter`
//     (from `@endo/9p-server`'s mount-caplet.js).
//
// Caplet env (threaded from this process's environment):
//   SANDBOX_FACTORY_NAME      name of the sandbox factory within the
//                             directory (default `sandbox-factory`).
//   FS_MOUNTER_NAME           name of the 9P mounter within the directory
//                             (default `fs-mounter`).
//   CLAUDE_SANDBOX_IMAGE      default OCI image when the form's rootfs
//                             field is blank.
//   CLAUDE_SANDBOX_BACKEND    sandbox backend (default `podman`).
//   CLAUDE_SANDBOX_MOUNT_DIR  base dir for per-session 9P mountpoints
//                             (default the OS temp dir).
//   (SANDBOX_NAMESPACE is set automatically to <dirName>.)
//
// Defaults:
//   <dirName>   claude-sandbox
//
// Idempotent: re-running is a no-op once `<dirName>/controller` exists.

import { E } from '@endo/eventual-send';

const factoryCapletSpecifier = new URL(
  'src/claude-sandbox-factory.js',
  import.meta.url,
).href;

// The host-side directory this factory's objects live under, so they don't
// pollute the host root: `<dir>/controller` (the form/exo), `<dir>/profile`
// (the factory guest's agent), `<dir>/handle` (the guest), plus the infra
// caplets `<dir>/sandbox-factory` and `<dir>/fs-mounter` (minted by setup.js).
const DEFAULT_FACTORY_NAME = 'claude-sandbox';

const CAPLET_ENV_KEYS = [
  'SANDBOX_FACTORY_NAME',
  'FS_MOUNTER_NAME',
  'CLAUDE_SANDBOX_IMAGE',
  'CLAUDE_SANDBOX_BACKEND',
  'CLAUDE_SANDBOX_MOUNT_DIR',
];

/**
 * Collect the caplet env vars present in this process's environment so
 * the formula reincarnates with the same configuration.
 *
 * @returns {Record<string, string>}
 */
const collectCapletEnv = () => {
  /** @type {Record<string, string>} */
  const capletEnv = {};
  for (const key of CAPLET_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      capletEnv[key] = value;
    }
  }
  return capletEnv;
};

/**
 * @param {import('@endo/eventual-send').ERef<object>} agent
 * @param {string} [dirName]
 */
export const main = async (agent, dirName = DEFAULT_FACTORY_NAME) => {
  // Fully provisioned already? `<dir>/controller` is the last thing created.
  // Guard the directory's existence first — `has(dir, 'controller')` throws
  // ("Unknown pet name") when the directory itself is absent.
  if (
    (await E(agent).has(dirName)) &&
    (await E(agent).has(dirName, 'controller'))
  ) {
    console.log(`${dirName}/controller already provisioned — skipping`);
    return;
  }

  // The factory's directory. `provideGuest` and `powersName` only accept a
  // single (non-path) name, so the guest is born under temporary top-level
  // names and `move`d into the directory after `makeUnconfined` (the caplet
  // holds its powers by formula id, so the rename is transparent).
  if (!(await E(agent).has(dirName))) {
    await E(agent).makeDirectory([dirName]);
  }

  const guestTmp = `${dirName}-guest`;
  const agentTmp = `${dirName}-agent`;
  if (
    !(await E(agent).has(guestTmp)) &&
    !(await E(agent).has(dirName, 'handle'))
  ) {
    await E(agent).provideGuest(guestTmp, {
      introducedNames: harden({ '@agent': 'host-agent' }),
      agentName: agentTmp,
    });
  }

  await E(agent).makeUnconfined('@main', factoryCapletSpecifier, {
    powersName: agentTmp,
    resultName: [dirName, 'controller'],
    // Tell the caplet where its infra caplets live so the per-session powers
    // endows `<dir>/sandbox-factory` and `<dir>/fs-mounter` by path.
    env: harden({ ...collectCapletEnv(), SANDBOX_NAMESPACE: dirName }),
  });

  await E(agent).move([guestTmp], [dirName, 'handle']);
  await E(agent).move([agentTmp], [dirName, 'profile']);

  console.log(`Factory provisioned under ${dirName}/`);
};
harden(main);
