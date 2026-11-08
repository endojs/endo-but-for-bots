// @ts-check
/* eslint-disable no-await-in-loop */
import { E } from '@endo/eventual-send';
import { stableModuleSpecifier } from './module-specifier.js';

const factorySpecifier = stableModuleSpecifier('../agent.js', import.meta.url);
const driverSpecifier = stableModuleSpecifier('../driver.js', import.meta.url);
// Old setup scripts used absolute file paths; module formulas may also retain a
// pinned release URL. Compare these with the same durable current entrypoint.
const canonicalSpecifier = value => {
  if (typeof value !== 'string') return value;
  if (!value.startsWith('/') && !value.startsWith('file:///')) return value;
  return stableModuleSpecifier(value, 'file:///');
};

/**
 * @param {any} host
 * @param {string[]} path
 */
const identify = async (host, path) => {
  await null;
  for (let i = 1; i <= path.length; i += 1) {
    if (!(await E(host).has(...path.slice(0, i)))) return undefined;
  }
  return E(host).identify(...path);
};

/**
 * All ownership checks precede any driver resolution.
 * @param {any} host
 * @param {any} diagnostics
 * @param {string} pinsId
 * @param {string} recipeId
 * @param {string} expectedDriverSpecifier
 */
const inspectOwnedDrivers = async (
  host,
  diagnostics,
  pinsId,
  recipeId,
  expectedDriverSpecifier,
) => {
  const actualPinsId = await E(host).identify('@pins');
  if (actualPinsId !== pinsId) throw Error('Fae agent pins changed');
  const ownerId = await E(host).identify('@agent');
  if (!ownerId) throw Error('Fae owner identity is missing');
  const names = await E(host).list('@pins');
  const drivers = [];
  for (const driver of names) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*-driver$/u.test(driver))
      throw Error('Unexpected Fae driver pin');
    const name = driver.slice(0, -'-driver'.length);
    const id = await E(host).identify('@pins', driver);
    const powers = await E(host).identify(`profile-for-${driver}-handle`);
    const agent = await E(host).identify(`profile-for-${name}`);
    const powersHandle = await E(host).identify(`${driver}-handle`);
    const agentHandle = await E(host).identify(name);
    if (
      !id ||
      !powers ||
      !agent ||
      !powersHandle ||
      !agentHandle ||
      (await E(host).identify(driver)) !== id
    )
      throw Error('Incomplete Fae driver ownership');
    const formula = await E(diagnostics).getFormula(id);
    const guest = await E(diagnostics).getFormula(powers);
    const agentFormula = await E(diagnostics).getFormula(agent);
    const handle = await E(diagnostics).getFormula(powersHandle);
    const mailHandle = await E(diagnostics).getFormula(agentHandle);
    if (
      formula.type !== 'make-unconfined' ||
      canonicalSpecifier(formula.properties.specifier?.value) !==
        canonicalSpecifier(expectedDriverSpecifier) ||
      formula.properties.powers?.identifier !== powers ||
      guest.type !== 'guest' ||
      agentFormula.type !== 'guest' ||
      guest.properties.hostAgent?.identifier !== ownerId ||
      agentFormula.properties.hostAgent?.identifier !== ownerId ||
      guest.properties.handle?.identifier !== powersHandle ||
      agentFormula.properties.handle?.identifier !== agentHandle ||
      handle.type !== 'handle' ||
      handle.properties.agent?.identifier !== powers ||
      mailHandle.type !== 'handle' ||
      mailHandle.properties.agent?.identifier !== agent
    )
      throw Error('Fae driver dependencies changed');
    const driverPowers = await E(host).lookup(`profile-for-${driver}-handle`);
    if (
      (await E(driverPowers).identify('agent')) !== agent ||
      (await E(driverPowers).identify('llm-provider')) !== recipeId
    )
      throw Error('Fae driver agent or recipe changed');
    drivers.push({ name: driver, id });
  }
  return drivers;
};

/**
 * Restore retained inbox loops after startup, including pending old mail.
 * @param {any} host
 * @param {any} diagnostics
 * @param {string} pinsId
 * @param {string} recipeId
 * @param {string} [expectedDriverSpecifier]
 */
export const restoreOwnedDrivers = async (
  host,
  diagnostics,
  pinsId,
  recipeId,
  expectedDriverSpecifier = driverSpecifier,
) => {
  const drivers = await inspectOwnedDrivers(
    host,
    diagnostics,
    pinsId,
    recipeId,
    expectedDriverSpecifier,
  );
  for (const { name, id } of drivers) {
    if (
      (await E(host).identify('@pins', name)) !== id ||
      (await E(host).identify(name)) !== id
    )
      throw Error('Fae driver changed during restoration');
    await E(host).lookup(['@pins', name]);
  }
  return drivers.length;
};
harden(restoreOwnedDrivers);

/** Inspect an application's dedicated ordinary Fae factory and its private
 * agent pins. The caller checks its own resources before invoking provide.
 * @param {any} root @param {string[]} directory @param {any} connection
 */
export const inspectOwnedFactory = async (root, directory, connection) => {
  const installationPath = leaf => [...directory, leaf];
  const diagnostics = await E(root).diagnostics();
  // Validate existing parent directories without creating or adopting anything.
  for (let length = 1; length <= directory.length; length += 1) {
    const id = await identify(root, directory.slice(0, length));
    if (id && (await E(diagnostics).getFormula(id)).type !== 'directory')
      throw Error('Conflicting Fae installation directory');
  }
  const expected = [
    ['agent-pins', 'directory'],
    ['agents', 'host'],
    ['agents-handle', 'handle'],
    ['factory-state', 'guest'],
    ['factory-handle', 'handle'],
    ['factory-worker', 'worker'],
    ['factory', 'make-unconfined'],
    ['recipe', 'marshal'],
  ];
  const ids = new Map();
  const formulas = new Map();
  for (const [leaf, type] of expected) {
    const id = await identify(root, installationPath(leaf));
    if (id) {
      const formula = await E(diagnostics).getFormula(id);
      if (formula.type !== type)
        throw Error('Conflicting Fae installation binding');
      ids.set(leaf, id);
      formulas.set(leaf, formula);
    }
  }
  for (const [agentName, handleName] of [
    ['agents', 'agents-handle'],
    ['factory-state', 'factory-handle'],
  ]) {
    if (Boolean(ids.get(agentName)) !== Boolean(ids.get(handleName)))
      throw Error('Incomplete Fae installation pair');
    if (
      ids.has(agentName) &&
      (formulas.get(agentName).properties.handle?.identifier !==
        ids.get(handleName) ||
        formulas.get(handleName).properties.agent?.identifier !==
          ids.get(agentName))
    )
      throw Error('Conflicting Fae installation pair');
  }
  const ownerId = ids.get('agents');
  const powersId = ids.get('factory-state');
  const recipeId = ids.get('recipe');
  const factoryId = ids.get('factory');
  const pinsId = ids.get('agent-pins');
  const rootId = await E(root).identify('@agent');
  if (
    ownerId &&
    formulas.get('agents').properties.hostHandle?.identifier !==
      (await E(root).identify('@self'))
  )
    throw Error('Fae owner belongs to another host');
  if (
    ownerId &&
    (!pinsId || formulas.get('agents').properties.pins?.identifier !== pinsId)
  )
    throw Error('Fae owner does not use its private pins');
  if (!recipeId && (ownerId || powersId || factoryId))
    throw Error('Fae recipe missing from existing installation');
  if (recipeId) await connection.validateRetained(formulas.get('recipe'));
  let powers;
  if (powersId) {
    if (
      formulas.get('factory-state').properties.hostAgent?.identifier !== rootId
    )
      throw Error('Fae factory powers belong to another host');
    powers = await E(root).lookup(installationPath('factory-state'));
    for (const [name, target] of [
      ['host-agent', ownerId],
      ['llm-provider', recipeId],
    ]) {
      const id = await E(powers).identify(name);
      if (
        (id !== undefined && id !== target) ||
        (factoryId && id === undefined)
      )
        throw Error('Fae factory endowment changed');
    }
  }
  if (factoryId) {
    const { properties } = formulas.get('factory');
    if (
      !powersId ||
      !ids.has('factory-worker') ||
      !ownerId ||
      properties.powers?.identifier !== powersId ||
      properties.worker?.identifier !== ids.get('factory-worker') ||
      canonicalSpecifier(properties.specifier?.value) !==
        canonicalSpecifier(factorySpecifier) ||
      Object.keys(await E(root).getFormulaEnvironment(factoryId)).length !== 0
    )
      throw Error('Fae factory dependencies changed');
  }
  if (ownerId) {
    await inspectOwnedDrivers(
      await E(root).lookup(installationPath('agents')),
      diagnostics,
      pinsId,
      recipeId,
      driverSpecifier,
    );
  } else if (
    pinsId &&
    (await E(root).list(...installationPath('agent-pins'))).length !== 0
  ) {
    throw Error('Fae pins exist without an owner');
  }
  const provide = async ({ model, reasoningEffort }) => {
    const newRecipe = recipeId
      ? undefined
      : await connection.select(model, reasoningEffort);
    await connection.assertCurrent();
    if (!ids.has('agent-pins'))
      await E(root).provideDirectory(installationPath('agent-pins'));
    if (newRecipe)
      await E(root).storeValue(newRecipe, installationPath('recipe'));
    if (!ownerId)
      await E(root).provideHost(installationPath('agents-handle'), {
        agentName: installationPath('agents'),
        pins: await E(root).lookup(installationPath('agent-pins')),
      });
    if (!powersId)
      await E(root).provideGuest(installationPath('factory-handle'), {
        agentName: installationPath('factory-state'),
      });
    powers ??= await E(root).lookup(installationPath('factory-state'));
    for (const [name, target] of [
      ['host-agent', 'agents'],
      ['llm-provider', 'recipe'],
    ]) {
      if (!(await E(powers).has(name)))
        await E(powers).storeLocator(
          name,
          await E(root).locate(...installationPath(target)),
        );
    }
    if (!ids.has('factory-worker'))
      await E(root).provideWorker(installationPath('factory-worker'));
    if (!factoryId)
      await E(root).makeUnconfined(
        installationPath('factory-worker'),
        factorySpecifier,
        {
          powersName: installationPath('factory-state'),
          resultName: installationPath('factory'),
        },
      );
    const restored = await restoreOwnedDrivers(
      await E(root).lookup(installationPath('agents')),
      diagnostics,
      await E(root).identify(...installationPath('agent-pins')),
      await E(root).identify(...installationPath('recipe')),
    );
    return restored;
  };
  return harden({
    factoryId,
    workerId: ids.get('factory-worker'),
    factoryPath: installationPath('factory'),
    workerPath: installationPath('factory-worker'),
    provide,
  });
};
harden(inspectOwnedFactory);
