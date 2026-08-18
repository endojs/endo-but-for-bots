// @ts-check
// endo run --UNCONFINED setup.js --powers @agent
//
// Provisions the durable workflow service and pins it so `revivePins()`
// wakes it — and with it every stored run — on daemon start. Intended to be
// listed in the daemon's ENDO_EXTRA so hosted daemons provision it on boot
// (see the endo-host repo), mirroring @endo/space-nixos-admin/setup.js.
//
// The service gets a dedicated guest as its powers: its runs, journals,
// charts, and factory records live in that guest's pet store, and its asks
// fan out from that guest's mailbox. IDEMPOTENT: the service formula's
// identity must stay stable so factory grants derived from it (see
// @endo/floot's floot-factory-setup.js) do not dangle across restarts,
// while the current-linked specifier still re-imports the newest code on
// each revival and survives release pruning.

import { E } from '@endo/eventual-send';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SERVICE_NAME = 'workflow-service';
const POWERS_HANDLE_NAME = 'workflow-powers';
const POWERS_AGENT_NAME = 'workflow-agent';

/**
 * Reroute a release-pinned module URL through a hosted deploy's stable
 * `current` symlink so a pinned UNCONFINED formula survives release pruning.
 * No-op outside that layout (dev checkouts, or when the `current` twin does
 * not resolve on disk). A small pure twin of the helper in `@endo/daemon`
 * and `@endo/claude-sandbox`; duplicated because this package may not depend
 * on them.
 *
 * @param {string} specifier
 * @returns {string}
 */
const toCurrentSpecifier = specifier => {
  const match = /^(.*)\/releases\/[^/]+\/(.*)$/.exec(specifier);
  if (!match) {
    return specifier;
  }
  const [, stateRoot, rest] = match;
  const currentSpecifier = `${stateRoot}/current/${rest}`;
  try {
    if (existsSync(fileURLToPath(currentSpecifier))) {
      return currentSpecifier;
    }
  } catch {
    // Unparseable URL or unreadable path: keep the concrete release specifier.
  }
  return specifier;
};

const serviceSpecifier = toCurrentSpecifier(
  new URL('src/index.js', import.meta.url).href,
);

/**
 * @param {import('@endo/eventual-send').ERef<any>} agent
 */
export const main = async agent => {
  const alreadyInstalled = await E(agent).has(SERVICE_NAME);
  if (alreadyInstalled) {
    // Re-pin unconditionally: the pin is what revives the service (and
    // recovers every stored run) at boot, so a lost pin must heal rather
    // than silently leaving runs dormant.
    await E(agent).copy([SERVICE_NAME], ['@pins', SERVICE_NAME]);
    console.log('Workflow service already installed; pin refreshed.');
    return;
  }

  // A dedicated agent whose pet store holds the service's runs and whose
  // mailbox carries its asks.
  await E(agent).provideGuest(POWERS_HANDLE_NAME, {
    agentName: POWERS_AGENT_NAME,
  });

  await E(agent).makeUnconfined(undefined, serviceSpecifier, {
    powersName: POWERS_AGENT_NAME,
    resultName: SERVICE_NAME,
  });

  await E(agent).copy([SERVICE_NAME], ['@pins', SERVICE_NAME]);

  console.log('Workflow service provisioned and pinned.');
};
harden(main);
