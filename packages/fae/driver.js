// @ts-nocheck
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';

import { spawnWorkerLoop } from './agent.js';
import { resolveAuthToken } from './src/credentials.js';

/**
 * Fae agent driver caplet.
 *
 * A lightweight caplet whose sole job is to run the inbox/LLM loop for
 * a single fae agent.  Its namespace holds two capability references
 * written by the factory at creation time:
 *
 *   - `llm-provider`  – the provider config `{ host, model, authToken }`
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

  const startLoop = async () => {
    const storedConfig =
      /** @type {{ host: string, model: string, authToken?: string }} */ (
        await E(powers).lookup('llm-provider')
      );
    // The token comes from the SecretBlob when one was delegated, so the
    // stored config need carry no credential. Read once per loop start: a
    // rotation takes effect when the driver next starts.
    const providerConfig = harden({
      ...storedConfig,
      authToken: await resolveAuthToken({ powers, config: storedConfig }),
    });
    const agentPowers = await E(powers).lookup('agent');
    const spawner = (await E(powers).has('subagent-spawner'))
      ? await E(powers).lookup('subagent-spawner')
      : undefined;
    await spawnWorkerLoop(
      agentPowers,
      context,
      providerConfig,
      systemPrompt,
      harden({ ...(spawner ? { spawner } : {}) }),
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
