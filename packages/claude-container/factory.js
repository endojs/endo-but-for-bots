// @ts-check
// endo run --UNCONFINED factory.js --powers @agent
//   [<factoryName>] [<orchestratorSocket>]
//
// Provision the Claude Container factory caplet under @host. The factory
// presents a "Create Claude Container" form on @host's inbox; each
// submission resolves the named filesystem capability, spawns a microVM
// through the host orchestrator (see DESIGN.md), and stores a
// ClaudeClient exo back in @host's petstore.
//
// Defaults:
//   <factoryName>          claude-container-factory
//   <orchestratorSocket>   /run/claude-orch/api.sock
//
// Idempotent: re-running with the same name is a no-op.

import { E } from '@endo/eventual-send';

const factoryCapletSpecifier = new URL(
  'src/claude-container-factory.js',
  import.meta.url,
).href;

const DEFAULT_FACTORY_NAME = 'claude-container-factory';
const DEFAULT_ORCHESTRATOR_SOCKET = '/run/claude-orch/api.sock';

/**
 * @param {import('@endo/eventual-send').ERef<object>} agent
 * @param {string} [factoryName]
 * @param {string} [orchestratorSocket]
 */
export const main = async (
  agent,
  factoryName = DEFAULT_FACTORY_NAME,
  orchestratorSocket = DEFAULT_ORCHESTRATOR_SOCKET,
) => {
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
    env: harden({ ORCHESTRATOR_SOCKET: orchestratorSocket }),
  });

  console.log(
    `Factory ${factoryName} provisioned (orchestrator=${orchestratorSocket})`,
  );
};
harden(main);
