// @ts-check

import { E } from '@endo/eventual-send';

const ENDOWMENT_FACET_SPECIFIER = new URL(
  './agent-endowment-facet-module.js',
  import.meta.url,
).href;

/**
 * Formulates one agent's responder from inside the agent's own worker, which
 * ends with those formulas anyway, and returns only data, so that the launcher
 * never references them. Each step finds its earlier effect by name.
 *
 * @param {any} powers Root host.
 * @param {any} _context
 * @param {{ env: Record<string, string> }} options
 */
export const make = async (powers, _context, { env }) => {
  const {
    AGENT_FACTORY_NAME: factoryName,
    AGENT_ID: agentId,
    AGENT_RESPONDER_GUEST_NAME: guestName,
    AGENT_RESPONDER_LAUNCHER_NAME: launcherName,
    AGENT_RESPONDER_NAME: name,
    AGENT_RESPONDER_SPECIFIER: specifier,
    AGENT_RESPONDER_INITIAL_BACKOFF_MS: initialBackoffMs,
  } = env;
  const workerPath = ['agent-responder-workers', name];
  const endowmentPowersPath = ['agent-responder-endowment-powers', name];
  const endowmentPath = ['agent-responder-endowments', name];
  const responderPowersPath = ['agent-responder-powers', name];
  const responderPath = ['agent-responders', name];
  const guestPowersName = `${guestName}-agent`;

  /**
   * @param {string[]} path
   * @param {() => Promise<unknown>} formulate
   */
  const ensure = async (path, formulate) => {
    await null;
    if (!(await E(powers).has(...path))) await formulate();
  };

  await ensure(endowmentPowersPath, () =>
    E(powers).makeDirectory(endowmentPowersPath),
  );
  await E(powers).storeIdentifier(
    [...endowmentPowersPath, 'factory'],
    await E(powers).identify(factoryName),
  );
  await ensure(endowmentPath, () =>
    E(powers).makeUnconfined(workerPath, ENDOWMENT_FACET_SPECIFIER, {
      powersName: endowmentPowersPath,
      resultName: endowmentPath,
      env: { AGENT_ID: agentId },
    }),
  );
  await ensure(responderPowersPath, () =>
    E(powers).makeDirectory(responderPowersPath),
  );
  for (const [entry, identifier] of [
    ['guest', await E(powers).identify(guestPowersName)],
    ['endowment', await E(powers).identify(...endowmentPath)],
    ['launcher', await E(powers).identify(launcherName)],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await E(powers).storeIdentifier(
      [...responderPowersPath, entry],
      identifier,
    );
  }
  await ensure(responderPath, () =>
    E(powers).makeUnconfined(workerPath, specifier, {
      powersName: responderPowersPath,
      resultName: responderPath,
      env: {
        ...(initialBackoffMs === undefined
          ? {}
          : { AGENT_RESPONDER_INITIAL_BACKOFF_MS: initialBackoffMs }),
        AGENT_RESPONDER_NAME: name,
        AGENT_RESPONDER_STATE_DIRECTORY: `${name}-state`,
      },
    }),
  );
  const responderIdentifier = await E(powers).identify(...responderPath);
  await E(powers).storeIdentifier(
    [guestPowersName, '@pins', name],
    responderIdentifier,
  );
  // The daemon revives only the root's pins at startup. The guest's pin retains
  // the responder with its guest; this one wakes it.
  await E(powers).storeIdentifier(['@pins', name], responderIdentifier);
  return harden({ provisioned: name });
};
harden(make);
