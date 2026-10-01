// @ts-nocheck
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { parseLocator } from '@endo/daemon/locator.js';

import { spawnWorkerLoop } from './agent.js';
import { resolveAuthToken } from './src/credentials.js';

/**
 * Fae agent driver caplet.
 *
 * A lightweight caplet whose sole job is to run the inbox/LLM loop for
 * a single fae agent.  Its namespace holds two capability references
 * written by the factory at creation time:
 *
 *   - `llm-provider`  – token-free HTTP config or a subscription-capability recipe
 *   - `agent`          – the agent's EndoGuest (inbox, mail, petstore, tools)
 *
 * and optionally a third:
 *
 *   - `subagent-spawner` – authority to create, list, and release agents named
 *     beneath this one.  Absent for an agent at the delegation bound, which is
 *     what withholds the subagent tools from it.
 *
 * When this formula is pinned (`PINS`), `revivePins()` re-provides it on
 * daemon restart, which re-imports this module and calls `make()` again,
 * restarting the inbox loop automatically.
 *
 * IMPORTANT: This make() must return immediately without awaiting any
 * remote references.  During reincarnation, awaiting lookups on the
 * powers guest can deadlock with the provision chain that is creating
 * this very formula.  Instead, we fire off the async work and return
 * the Far object synchronously.
 *
 * @param {import('@endo/eventual-send').ERef<object>} powers
 * @param {Promise<object> | object | undefined} context
 * @param {{ env?: Record<string, string> }} [options]
 * @returns {Promise<object>}
 */
export const make = async (powers, context, { env } = {}) => {
  const systemPrompt = env?.FAE_SYSTEM_PROMPT || undefined;
  // Written by this agent's parent, not by the operator, so the loop appends it
  // to the standing prompt rather than letting it take its place.
  const delegatedPrompt = env?.FAE_SUBAGENT_PROMPT || undefined;

  const startLoop = async () => {
    const providerIdentity = await E(powers).locate('llm-provider');
    const storedConfig =
      /** @type {{ host?: string, model: string, kind?: string, subscription?: object }} */ (
        await E(powers).lookupByLocator(providerIdentity)
      );
    const agentPowers = await E(powers).lookup('agent');
    const spawner = (await E(powers).has('subagent-spawner'))
      ? await E(powers).lookup('subagent-spawner')
      : undefined;
    // The agent, not the driver incarnation or a mutable pet name, identifies
    // the inference session. Preserve both fixed-width components without a
    // delimiter to fit the subscription endpoint's 128-character identity.
    let sessionId;
    if (storedConfig.kind === 'subscription-responses') {
      const { number, node } = parseLocator(await E(powers).locate('agent'));
      sessionId = `${number}${node}`;
    }
    // The token comes from the `SecretBlob` when one was delegated, so the
    // stored config carries no credential. Handing the loop a thunk rather
    // than a token is what makes rotation and revocation reach an agent that
    // is already running: it reads the secret again for every turn.
    await spawnWorkerLoop(
      agentPowers,
      context,
      storedConfig,
      systemPrompt,
      harden({
        forceCompaction: env?.FAE_FORCE_COMPACTION === 'true',
        providerIdentity,
        ...(spawner ? { spawner } : {}),
        ...(delegatedPrompt ? { delegatedPrompt } : {}),
        ...(sessionId === undefined
          ? {
              provideAuthToken: () =>
                resolveAuthToken({ powers, config: storedConfig }),
            }
          : { sessionId }),
      }),
    );
  };

  startLoop().catch(error => {
    console.error(
      '[fae-driver] inbox loop error:',
      error instanceof Error ? error.message : String(error),
    );
  });

  return Far('FaeDriver', {
    /** @returns {string} */
    help() {
      return 'Fae agent driver: runs the inbox/LLM loop for a single agent. Pin to PINS for auto-restart on daemon reboot.';
    },
  });
};
harden(make);
