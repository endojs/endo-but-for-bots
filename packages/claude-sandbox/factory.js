// @ts-check
/* global process */
// endo run --UNCONFINED factory.js --powers @agent  [<factoryName>]
//
// Provision the Claude Sandbox factory caplet under @host. The factory
// presents a "Create Claude Sandbox" form on @host's inbox; each
// submission mounts a Filesystem cap over 9P on the host, mints a
// podman slice with that workspace bound at /workspace, runs Claude
// Code inside it, and stores a ClaudeClient exo back in @host's
// petstore.
//
// Prerequisites (mint them first, or use setup.js which does both):
//   - a sandbox factory on @host named `sandbox-factory`
//     (from `@endo/sandbox`'s agent.js), and
//   - a 9P mounter on @host named `fs-mounter`
//     (from `@endo/9p-server`'s mount-caplet.js).
//
// Caplet env (threaded from this process's environment):
//   SANDBOX_FACTORY_NAME      pet name of the sandbox factory (default
//                             `sandbox-factory`).
//   FS_MOUNTER_NAME           pet name of the 9P mounter (default
//                             `fs-mounter`).
//   CLAUDE_SANDBOX_IMAGE      default OCI image when the form's rootfs
//                             field is blank.
//   CLAUDE_SANDBOX_BACKEND    sandbox backend (default `podman`).
//   CLAUDE_SANDBOX_MOUNT_DIR  base dir for per-session 9P mountpoints
//                             (default the OS temp dir).
//
// Defaults:
//   <factoryName>   claude-sandbox-factory
//
// Idempotent: re-running with the same name is a no-op.

import { E } from '@endo/eventual-send';

const factoryCapletSpecifier = new URL(
  'src/claude-sandbox-factory.js',
  import.meta.url,
).href;

const DEFAULT_FACTORY_NAME = 'claude-sandbox-factory';

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
 * @param {string} [factoryName]
 */
export const main = async (agent, factoryName = DEFAULT_FACTORY_NAME) => {
  const controllerName = `controller-for-${factoryName}`;
  if (await E(agent).has(controllerName)) {
    console.log(`${controllerName} already provisioned — skipping`);
    return;
  }

  const agentName = `profile-for-${factoryName}`;
  if (!(await E(agent).has(factoryName))) {
    await E(agent).provideGuest(factoryName, {
      introducedNames: harden({ '@agent': 'host-agent' }),
      agentName,
    });
  }

  await E(agent).makeUnconfined('@main', factoryCapletSpecifier, {
    powersName: agentName,
    resultName: controllerName,
    env: harden(collectCapletEnv()),
  });

  console.log(`Factory ${factoryName} provisioned`);
};
harden(main);
