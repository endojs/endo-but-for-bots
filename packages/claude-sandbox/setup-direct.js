// @ts-check
/* global process */
import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';
import {
  assertAccountBindings,
  publishAccountBindings,
} from '@endo/hosted-agent/account-bindings.js';
import { installationPath } from '@endo/hosted-agent/installation-path.js';

/** Publish the existing broker's inference capability to Fae/Floot. This path
 * does not construct a native backend, CLI session, listener or sandbox.
 * @param {any} host
 * @param {{env?: Record<string, string | undefined>}} [options]
 */
export const main = async (host, { env = process.env } = {}) => {
  const flootDir = env.ENDO_FLOOT_DIR || env.FLOOT_DIR || 'floot';
  const source = installationPath('claude-sandbox', 'subscription');
  (await E(host).has(...source)) ||
    Fail`Configure the Claude subscription broker before publishing direct inference`;
  (await E(host).has(flootDir, 'controller-profile')) ||
    Fail`Configure Floot before publishing direct inference`;
  const profile = await E(host).lookup([flootDir, 'controller-profile']);
  // Preserve existing account/oracle identities; only add another consumer.
  if (await E(profile).has('account-bindings')) {
    const directory = await E(profile).lookup('account-bindings');
    if (await E(directory).has('claude-sandbox')) {
      const publication = assertAccountBindings(
        await E(directory).lookup('claude-sandbox'),
      );
      if (!publication.unavailable) {
        const accounts = publication.accounts.map(account => ({
          ...account,
          uses: [
            ...account.uses,
            ...account.uses
              .filter(
                use =>
                  use.backendId === 'claude' &&
                  !account.uses.some(
                    other =>
                      other.backendId === 'fae-claude' &&
                      other.subscriptionId === use.subscriptionId,
                  ),
              )
              .map(use => ({ ...use, backendId: 'fae-claude' })),
          ],
        }));
        if (
          accounts.some(
            (account, index) =>
              account.uses.length !== publication.accounts[index].uses.length,
          )
        )
          await publishAccountBindings(profile, {
            source: 'claude-sandbox',
            accounts,
          });
      }
    }
  }
  await E(host).copy(source, [
    flootDir,
    'controller-profile',
    'claude-inference',
  ]);
};
harden(main);
