// @ts-check
// endo run --UNCONFINED credentials.js --powers @agent
//   [<factoryName>]
//
// Provision the Claude Credentials factory caplet under @host. The
// factory presents a "Create Claude Credentials" form on @host's
// inbox; each submission stores a `ClaudeCredentials` cap (Anthropic
// API key wrapper) back in @host's petstore under the chosen name.
// That cap is what the ClaudeSandbox factory's `credentials` form
// field references when minting a session.
//
// Defaults:
//   <factoryName>   claude-credentials-factory
//
// Idempotent: re-running with the same name is a no-op.

import { E } from '@endo/eventual-send';

const factoryCapletSpecifier = new URL(
  'src/claude-credentials-factory.js',
  import.meta.url,
).href;

const DEFAULT_FACTORY_NAME = 'claude-credentials-factory';

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
  });

  console.log(`Factory ${factoryName} provisioned`);
};
harden(main);
