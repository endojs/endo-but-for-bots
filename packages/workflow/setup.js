// @ts-check
// endo run --UNCONFINED setup.js --powers @agent
//
// Provisions the durable workflow service and pins it so `revivePins()`
// wakes it — and with it every stored run — on daemon start. Intended to be
// listed in the daemon's ENDO_EXTRA so hosted daemons provision it on boot,
// mirroring @endo/space-nixos-admin/setup.js.
//
// The service gets a dedicated guest as its powers: its runs, journals,
// charts, and factory records live in that guest's pet store, and its asks
// fan out from that guest's mailbox. IDEMPOTENT: the service formula's
// identity must stay stable so grants derived from it (the deploy-workflow
// connections @endo/floot's machine-admin-setup.js binds to it) do not
// dangle across restarts, while the current-linked specifier still
// re-imports the newest code on each revival and survives release pruning.

import { E } from '@endo/eventual-send';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SERVICE_NAME = 'workflow-service';
const OWNER = harden(['@pins', 'installations', 'workflow']);
const SERVICE_PATH = harden([...OWNER, 'service']);
const POWERS_HANDLE_PATH = harden([...OWNER, 'state-handle']);
const POWERS_AGENT_PATH = harden([...OWNER, 'state']);

/**
 * Reroute a release-pinned module URL through a hosted deploy's stable
 * `current` symlink so a pinned UNCONFINED formula survives release pruning.
 * No-op outside that layout (dev checkouts, or when the `current` twin does
 * not resolve on disk). A small pure twin of the helper in
 * `@endo/space-nixos-admin/setup.js`; duplicated because this package does
 * not depend on it.
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
 * @param {any} agent
 * @param {string[]} path
 */
const identifyPath = async (agent, path) => {
  for (let n = 1; n <= path.length; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await E(agent).has(...path.slice(0, n)))) return undefined;
  }
  return E(agent).identify(...path);
};

/**
 * Retain the service in private installation storage and its direct boot pin.
 * Adopt legacy root aliases without replacing the service or its state. Unknown/conflicting state fails closed.
 * @param {import('@endo/eventual-send').ERef<any>} agent
 */
export const main = async agent => {
  const diagnostics = await E(agent).diagnostics();
  const parents = [OWNER.slice(0, 2), OWNER];
  for (const path of parents) {
    // eslint-disable-next-line no-await-in-loop
    const id = await identifyPath(agent, path);
    // eslint-disable-next-line no-await-in-loop
    if (id && (await E(diagnostics).getFormula(id)).type !== 'directory')
      throw Error('Workflow installation parent is not a directory');
  }
  const moves = [
    { old: 'workflow-agent', path: POWERS_AGENT_PATH },
    { old: 'workflow-powers', path: POWERS_HANDLE_PATH },
  ];
  const retained = [];
  for (const { old, path } of moves) {
    // eslint-disable-next-line no-await-in-loop
    const legacy = await identifyPath(agent, [old]);
    // eslint-disable-next-line no-await-in-loop
    const current = await identifyPath(agent, path);
    if (legacy && current && legacy !== current)
      throw Error('Conflicting workflow state bindings');
    retained.push({ old, path, id: current || legacy, legacy });
  }
  const legacyService = await identifyPath(agent, [SERVICE_NAME]);
  const service = await identifyPath(agent, SERVICE_PATH);
  const pin = await identifyPath(agent, ['@pins', SERVICE_NAME]);
  const serviceIds = [service, pin, legacyService].filter(Boolean);
  if (new Set(serviceIds).size > 1)
    throw Error('Conflicting workflow service bindings');
  const serviceId = service || pin || legacyService;
  const [state, handle] = retained;
  if (serviceId || state.id || handle.id) {
    if (!serviceId || !state.id || !handle.id)
      throw Error(
        'Incomplete workflow installation; restore existing bindings',
      );
    const stateFormula = await E(diagnostics).getFormula(state.id);
    const handleFormula = await E(diagnostics).getFormula(handle.id);
    const serviceFormula = await E(diagnostics).getFormula(serviceId);
    if (
      stateFormula.type !== 'guest' ||
      handleFormula.type !== 'handle' ||
      stateFormula.properties.handle?.kind !== 'reference' ||
      stateFormula.properties.handle.identifier !== handle.id ||
      serviceFormula.type !== 'make-unconfined' ||
      serviceFormula.properties.powers?.kind !== 'reference' ||
      serviceFormula.properties.powers.identifier !== state.id ||
      serviceFormula.properties.specifier?.kind !== 'literal' ||
      serviceFormula.properties.specifier.value !== serviceSpecifier
    )
      throw Error('Workflow installation dependencies do not match');
  }
  for (const path of parents) {
    // eslint-disable-next-line no-await-in-loop
    await E(agent).provideDirectory(path);
  }
  for (const { old, path, id } of retained.filter(item => item.legacy)) {
    // eslint-disable-next-line no-await-in-loop
    if ((await identifyPath(agent, [old])) !== id)
      throw Error('Workflow source changed');
    // eslint-disable-next-line no-await-in-loop
    const destination = await identifyPath(agent, path);
    if (destination && destination !== id)
      throw Error('Workflow destination changed');
    // eslint-disable-next-line no-await-in-loop
    if (!destination) await E(agent).copy([old], path);
    if (
      // eslint-disable-next-line no-await-in-loop
      (await identifyPath(agent, path)) !== id ||
      // eslint-disable-next-line no-await-in-loop
      (await identifyPath(agent, [old])) !== id
    )
      throw Error('Workflow binding changed during copy');
    // eslint-disable-next-line no-await-in-loop
    await E(agent).remove(old);
  }
  if (serviceId) {
    if (!service) {
      const source = pin ? ['@pins', SERVICE_NAME] : [SERVICE_NAME];
      if ((await identifyPath(agent, source)) !== serviceId)
        throw Error('Workflow service source changed');
      if (await identifyPath(agent, SERVICE_PATH))
        throw Error('Workflow service destination changed');
      await E(agent).copy(source, SERVICE_PATH);
    }
  } else {
    await E(agent).provideGuest(POWERS_HANDLE_PATH, {
      agentName: POWERS_AGENT_PATH,
    });
    await E(agent).makeUnconfined(undefined, serviceSpecifier, {
      powersName: POWERS_AGENT_PATH,
      resultName: SERVICE_PATH,
    });
  }
  const finalService = await identifyPath(agent, SERVICE_PATH);
  const finalPin = await identifyPath(agent, ['@pins', SERVICE_NAME]);
  if (
    (serviceId && finalService !== serviceId) ||
    (finalPin && finalPin !== finalService)
  )
    throw Error('Workflow service changed during setup');
  // Only immediate @pins children revive at boot. Preserve this direct alias.
  await E(agent).copy(SERVICE_PATH, ['@pins', SERVICE_NAME]);
  if (legacyService) {
    if (
      (await identifyPath(agent, [SERVICE_NAME])) !== legacyService ||
      (await identifyPath(agent, SERVICE_PATH)) !== legacyService ||
      (await identifyPath(agent, ['@pins', SERVICE_NAME])) !== legacyService
    )
      throw Error('Workflow service changed before legacy removal');
    await E(agent).remove(SERVICE_NAME);
  }
};
harden(main);
