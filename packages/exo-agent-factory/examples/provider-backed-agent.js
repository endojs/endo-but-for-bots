// @ts-check

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';

/** @import { ChildAgentPolicy } from '../src/policy.js' */

/**
 * Host-side issuance for a provider registry such as the one proposed by
 * https://github.com/endojs/endo-but-for-bots/pull/1543. The deploying host
 * already holds the
 * provider's use facet; neither that facet nor the resulting driver maker is
 * handed to the owner guest.
 *
 * `driverMakerFactory` is the seam where a provider consumer composes its
 * durable inference grant with a Lal or Fae harness. Its returned maker must
 * implement `AgentDriverMaker`.
 *
 * @param {object} options
 * @param {any} options.deploymentHost
 * @param {any} options.ownerGuest
 * @param {any} options.providerUse
 * @param {any} options.driverMakerFactory
 * @param {'lal' | 'fae'} options.harness
 * @param {string} options.model
 * @param {Record<string, number>} options.limits
 * @param {ChildAgentPolicy} options.policy
 * @param {string | string[]} [options.factoryPath]
 * @param {string} [options.ownerFactoryName]
 */
export const issueProviderBackedFactory = async ({
  deploymentHost,
  ownerGuest,
  providerUse,
  driverMakerFactory,
  harness,
  model,
  limits,
  policy,
  factoryPath = ['agent-factory', 'root'],
  ownerFactoryName = 'child-agents',
}) => {
  const root = await E(deploymentHost).lookup(factoryPath);
  const maker = await E(driverMakerFactory).makeDriverMaker(
    providerUse,
    harden({ harness, model, limits }),
  );
  const bound = await E(root).bind(maker, policy);
  await E(ownerGuest).storeValue(bound, ownerFactoryName);
  return bound;
};
harden(issueProviderBackedFactory);

/**
 * Owner-side use of the attenuated facet. The owner names only ordinary child
 * endowments; it never receives the provider use facet, the maker, or the root
 * factory.
 *
 * @param {object} options
 * @param {any} options.boundFactory
 * @param {any} options.ownerGuest
 * @param {string} options.name
 * @param {string} options.instructions
 * @param {Record<string, any>} [options.endowments]
 */
export const createProviderBackedAgent = async ({
  boundFactory,
  ownerGuest,
  name,
  instructions,
  endowments = {},
}) => {
  const { summary, handle } = await E(boundFactory).create(name, {
    instructions,
    endowments,
  });
  await E(ownerGuest).storeValue(handle, name);
  return summary;
};
harden(createProviderBackedAgent);
