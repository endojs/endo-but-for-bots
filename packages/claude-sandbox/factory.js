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

import os from 'node:os';
import nodePath from 'node:path';

import { E } from '@endo/eventual-send';

const factoryCapletSpecifier = new URL(
  'src/claude-sandbox-factory.js',
  import.meta.url,
).href;

// Well-known host pet name of the attenuated powers cap the per-session
// `claude-client` formulas run as instead of `@agent`. It exposes only
// `lookup(name)` and a mount-dir-bounded `provideMount(path, name)` — the
// two host methods the client actually needs — so a client worker cannot
// reach the rest of the host surface (`makeUnconfined`, `remove`,
// `provideHostPath`, `provideGuest`, …). It is a single shared cap (minted
// once here), not per-session, so it adds no per-session host-petstore
// footprint. Keep in sync with `SANDBOX_POWERS_NAME` in
// `src/claude-sandbox-factory.js`.
const CLIENT_POWERS_NAME = 'sandbox-powers';

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
 * Mint the shared, attenuated `sandbox-powers` cap the per-session
 * `claude-client` formulas run as instead of `@agent`.
 *
 * It is an `evaluate` formula that closes over `@agent` and re-exports
 * exactly two methods: `lookup(name)` (delegated straight to the host) and
 * `provideMount(path, name)` **bounded to paths under the sandbox mount
 * dir** so a client cannot `provideMount('/etc', …)` and recover arbitrary
 * host paths through a slice. `makeUnconfined` is Host-only and resolves
 * `powersName` against the host petstore, so this cap must be host-named;
 * it is a single shared cap (not per-session), minted once and idempotent.
 *
 * The bound must match the factory caplet's mountpoints
 * (`<CLAUDE_SANDBOX_MOUNT_DIR>/claude-sandbox-<sessionId>`); both resolve
 * the base dir from `CLAUDE_SANDBOX_MOUNT_DIR` (default the OS temp dir).
 *
 * @param {import('@endo/eventual-send').ERef<object>} agent
 */
const provisionClientPowers = async agent => {
  if (await E(agent).has(CLIENT_POWERS_NAME)) {
    return;
  }
  const mountBaseDir = process.env.CLAUDE_SANDBOX_MOUNT_DIR || os.tmpdir();
  const mountPrefix = nodePath.join(mountBaseDir, 'claude-sandbox-');
  const helpText = `Attenuated host powers for @endo/claude-sandbox client sessions: lookup(name) + provideMount(path, name) bounded to paths under ${mountPrefix}. Holds @agent internally; exposes only these two methods.`;
  // Evaluated in a worker whose compartment endows E / makeExo / M (see
  // packages/daemon/src/worker.js); `agent` is the host @agent.
  const source = `makeExo(
    'SandboxClientPowers',
    M.interface('SandboxClientPowers', {
      lookup: M.call(M.string()).returns(M.promise()),
      provideMount: M.call(M.string(), M.string()).returns(M.promise()),
      help: M.call().returns(M.string()),
    }),
    {
      lookup: name => E(agent).lookup(name),
      provideMount: (path, name) => {
        if (typeof path !== 'string' || !path.startsWith(${JSON.stringify(
          mountPrefix,
        )})) {
          throw Error('claude-sandbox powers: provideMount restricted to the sandbox mount dir');
        }
        return E(agent).provideMount(path, name);
      },
      help: () => ${JSON.stringify(helpText)},
    },
  )`;
  await E(agent).evaluate(
    '@main',
    source,
    harden(['agent']),
    harden(['@agent']),
    CLIENT_POWERS_NAME,
  );
  console.log(`Minted ${CLIENT_POWERS_NAME} (attenuated client powers)`);
};
harden(provisionClientPowers);

/**
 * @param {import('@endo/eventual-send').ERef<object>} agent
 * @param {string} [factoryName]
 */
export const main = async (agent, factoryName = DEFAULT_FACTORY_NAME) => {
  // Mint the attenuated client powers first, and unconditionally (before
  // the controller short-circuit below), so re-running an already-
  // provisioned factory still backfills the powers cap.
  await provisionClientPowers(agent);

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
