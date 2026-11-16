// @ts-check
/* eslint-disable no-await-in-loop */
// Whylip owns ordinary Fae agents and borrows the shared Codex subscription.
// It installs no credential, inference broker, or alternate provider runtime.
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeMarshal } from '@endo/marshal';
import { assertSubscriptionResponsesRecipe } from '@endo/lal/providers/index.js';
import { stableModuleSpecifier } from './src/module-specifier.js';

const OWNER = harden(['@pins', 'installations', 'whylip']);
const SOURCE = harden(['floot', 'controller-profile', 'codex-inference']);
const factorySpecifier = stableModuleSpecifier('agent.js', import.meta.url);
const driverSpecifier = stableModuleSpecifier('driver.js', import.meta.url);
const booksSpecifier = stableModuleSpecifier(
  'whylip-books.js',
  import.meta.url,
);
const subscriptionSpecifier = stableModuleSpecifier(
  '../hosted-agent/src/subscription-module.js',
  import.meta.url,
);
const installationPath = leaf => [...OWNER, leaf];

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

const sameEnvironment = (left, right) => {
  const keys = Object.keys(left).sort();
  return (
    keys.length === Object.keys(right).length &&
    keys.every(key => Object.hasOwn(right, key) && left[key] === right[key])
  );
};

/**
 * Inspect a subscription wrapper without incarnating it or its broker.
 * @param {any} root
 * @param {any} diagnostics
 * @param {string} id
 */
const subscriptionEvidence = async (root, diagnostics, id) => {
  const formula = await E(diagnostics).getFormula(id);
  const { properties } = formula;
  if (
    formula.type !== 'make-unconfined' ||
    canonicalSpecifier(properties.specifier?.value) !==
      canonicalSpecifier(subscriptionSpecifier) ||
    !properties.powers?.identifier ||
    !properties.worker?.identifier
  )
    throw Error('Whylip requires the standard shared subscription wrapper');
  return {
    powers: properties.powers.identifier,
    worker: properties.worker.identifier,
    env: await E(root).getFormulaEnvironment(id),
  };
};

/**
 * Decode only inert metadata. Never resolve a recipe's capability slots.
 * @param {any} formula
 */
const recipeSubscriptionId = formula => {
  try {
    if (formula.type !== 'marshal') throw Error();
    const slots = formula.properties.slots?.entries;
    if (
      !slots ||
      Object.keys(slots).length !== 1 ||
      typeof slots['0'] !== 'string'
    )
      throw Error();
    const marker = Far('Subscription metadata marker', {});
    const decoder = makeMarshal(undefined, () => marker);
    const recipe = decoder.unserialize({
      body: formula.properties.body.value,
      slots: [slots['0']],
    });
    assertSubscriptionResponsesRecipe(recipe);
    if (recipe.subscription !== marker) throw Error();
    return slots['0'];
  } catch {
    throw Error('Invalid retained Whylip subscription recipe');
  }
};

/**
 * All ownership checks precede any driver resolution.
 * @param {any} host
 * @param {any} diagnostics
 * @param {string} pinsId
 * @param {string} recipeId
 * @param {string} expectedDriverSpecifier
 */
const inspectWhylipDrivers = async (
  host,
  diagnostics,
  pinsId,
  recipeId,
  expectedDriverSpecifier,
) => {
  const actualPinsId = await E(host).identify('@pins');
  if (actualPinsId !== pinsId) throw Error('Whylip agent pins changed');
  const ownerId = await E(host).identify('@agent');
  if (!ownerId) throw Error('Whylip owner identity is missing');
  const names = await E(host).list('@pins');
  const drivers = [];
  for (const driver of names) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*-driver$/u.test(driver))
      throw Error('Unexpected Whylip driver pin');
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
      throw Error('Incomplete Whylip driver ownership');
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
      throw Error('Whylip driver dependencies changed');
    const driverPowers = await E(host).lookup(`profile-for-${driver}-handle`);
    if (
      (await E(driverPowers).identify('agent')) !== agent ||
      (await E(driverPowers).identify('llm-provider')) !== recipeId
    )
      throw Error('Whylip driver agent or recipe changed');
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
export const restoreWhylipDrivers = async (
  host,
  diagnostics,
  pinsId,
  recipeId,
  expectedDriverSpecifier = driverSpecifier,
) => {
  const drivers = await inspectWhylipDrivers(
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
      throw Error('Whylip driver changed during restoration');
    await E(host).lookup(['@pins', name]);
  }
  return drivers.length;
};
harden(restoreWhylipDrivers);

const setup = async (
  root,
  { model = 'gpt-5.6-sol', reasoningEffort = 'low' } = {},
) => {
  const diagnostics = await E(root).diagnostics();
  const sourceId = await identify(root, SOURCE);
  if (!sourceId)
    throw Error('Whylip requires the shared Fae/Codex inference backend');
  const source = await subscriptionEvidence(root, diagnostics, sourceId);
  // Validate existing parent directories without creating or adopting anything.
  for (let length = 1; length <= OWNER.length; length += 1) {
    const id = await identify(root, OWNER.slice(0, length));
    if (id && (await E(diagnostics).getFormula(id)).type !== 'directory')
      throw Error('Conflicting Whylip installation directory');
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
    ['books-state', 'guest'],
    ['books-handle', 'handle'],
    ['books-service', 'make-unconfined'],
  ];
  const ids = new Map();
  const formulas = new Map();
  for (const [leaf, type] of expected) {
    const id = await identify(root, installationPath(leaf));
    if (id) {
      const formula = await E(diagnostics).getFormula(id);
      if (formula.type !== type)
        throw Error('Conflicting Whylip installation binding');
      ids.set(leaf, id);
      formulas.set(leaf, formula);
    }
  }
  for (const [agentName, handleName] of [
    ['agents', 'agents-handle'],
    ['factory-state', 'factory-handle'],
    ['books-state', 'books-handle'],
  ]) {
    if (Boolean(ids.get(agentName)) !== Boolean(ids.get(handleName)))
      throw Error('Incomplete Whylip installation pair');
    if (
      ids.has(agentName) &&
      (formulas.get(agentName).properties.handle?.identifier !==
        ids.get(handleName) ||
        formulas.get(handleName).properties.agent?.identifier !==
          ids.get(agentName))
    )
      throw Error('Conflicting Whylip installation pair');
  }
  const ownerId = ids.get('agents');
  const powersId = ids.get('factory-state');
  const recipeId = ids.get('recipe');
  const factoryId = ids.get('factory');
  const pinsId = ids.get('agent-pins');
  const booksPowersId = ids.get('books-state');
  const booksId = ids.get('books-service');
  const rootId = await E(root).identify('@agent');
  if (
    ownerId &&
    formulas.get('agents').properties.hostHandle?.identifier !==
      (await E(root).identify('@self'))
  )
    throw Error('Whylip owner belongs to another host');
  if ((booksPowersId || booksId) && !factoryId)
    throw Error('Whylip books service has no retained factory');
  if (
    ownerId &&
    (!pinsId || formulas.get('agents').properties.pins?.identifier !== pinsId)
  )
    throw Error('Whylip owner does not use its private pins');
  if (!recipeId && (ownerId || powersId || factoryId))
    throw Error('Whylip recipe missing from existing installation');
  let newRecipe;
  if (recipeId) {
    const retainedId = recipeSubscriptionId(formulas.get('recipe'));
    const retained = await subscriptionEvidence(root, diagnostics, retainedId);
    if (
      retained.powers !== source.powers ||
      retained.worker !== source.worker ||
      !sameEnvironment(retained.env, source.env)
    )
      throw Error('Whylip retained subscription differs from shared backend');
  } else {
    const controller = await E(root).lookup(['floot', 'controller']);
    const catalog = await E(controller).listModels('fae-codex');
    const selected = catalog.find(
      row => row.backendId === 'fae-codex' && row.modelId === model,
    );
    if (!selected || !selected.reasoningEfforts?.includes(reasoningEffort))
      throw Error(
        'Whylip model or reasoning effort is not supported by the shared backend',
      );
    newRecipe = harden({
      kind: 'subscription-responses',
      // A marker validates fields without incarnating the real subscription.
      subscription: Far('Validated subscription placeholder', {}),
      model,
      reasoningEffort,
      ...(selected.contextLength === undefined
        ? {}
        : { contextLength: selected.contextLength }),
    });
    assertSubscriptionResponsesRecipe(newRecipe);
  }
  let powers;
  if (powersId) {
    if (
      formulas.get('factory-state').properties.hostAgent?.identifier !== rootId
    )
      throw Error('Whylip factory powers belong to another host');
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
        throw Error('Whylip factory endowment changed');
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
      throw Error('Whylip factory dependencies changed');
  }
  let booksPowers;
  if (booksPowersId) {
    if (formulas.get('books-state').properties.hostAgent?.identifier !== rootId)
      throw Error('Whylip books powers belong to another host');
    booksPowers = await E(root).lookup(installationPath('books-state'));
    for (const [name, target] of [
      ['root-host', rootId],
      ['factory', factoryId],
    ]) {
      const id = await E(booksPowers).identify(name);
      if ((id !== undefined && id !== target) || (booksId && id === undefined))
        throw Error('Whylip books endowment changed');
    }
  }
  if (booksId) {
    const { properties } = formulas.get('books-service');
    if (
      !booksPowersId ||
      !ids.has('factory-worker') ||
      properties.powers?.identifier !== booksPowersId ||
      properties.worker?.identifier !== ids.get('factory-worker') ||
      canonicalSpecifier(properties.specifier?.value) !==
        canonicalSpecifier(booksSpecifier) ||
      Object.keys(await E(root).getFormulaEnvironment(booksId)).length !== 0
    )
      throw Error('Whylip books service dependencies changed');
  }
  if (ownerId) {
    await inspectWhylipDrivers(
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
    throw Error('Whylip pins exist without an owner');
  }
  // Conflict preflight is complete. Recheck the shared alias before resolving it.
  if ((await identify(root, SOURCE)) !== sourceId)
    throw Error('Shared Whylip backend changed during setup');
  if (!ids.has('agent-pins'))
    await E(root).provideDirectory(installationPath('agent-pins'));
  if (newRecipe)
    await E(root).storeValue(
      harden({
        ...newRecipe,
        subscription: await E(root).lookup(SOURCE),
      }),
      installationPath('recipe'),
    );
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
  if (!booksPowersId)
    await E(root).provideGuest(installationPath('books-handle'), {
      agentName: installationPath('books-state'),
    });
  booksPowers ??= await E(root).lookup(installationPath('books-state'));
  for (const [name, targetPath] of [
    ['root-host', ['@agent']],
    ['factory', installationPath('factory')],
  ]) {
    if (!(await E(booksPowers).has(name)))
      await E(booksPowers).storeLocator(
        name,
        await E(root).locate(...targetPath),
      );
  }
  if (!booksId)
    await E(root).makeUnconfined(
      installationPath('factory-worker'),
      booksSpecifier,
      {
        powersName: installationPath('books-state'),
        resultName: installationPath('books-service'),
      },
    );
  const restored = await restoreWhylipDrivers(
    await E(root).lookup(installationPath('agents')),
    diagnostics,
    await E(root).identify(...installationPath('agent-pins')),
    await E(root).identify(...installationPath('recipe')),
  );
  return harden({ ready: true, restored });
};

// Serialize setup calls within an incarnation. Deployment also holds its normal
// operational lock; this prevents callers of this module racing one another.
const setups = new WeakMap();
/**
 * Install after the shared Floot/Codex backend is ready. Existing recipes keep
 * their identity and model; changing defaults only affects a fresh installation.
 * @param {any} root
 * @param {{ model?: string, reasoningEffort?: string }} [options]
 */
export const setupWhylip = (root, options) => {
  const job = (setups.get(root) || Promise.resolve())
    .catch(() => {})
    .then(() => setup(root, options));
  setups.set(root, job);
  return job;
};
harden(setupWhylip);

/** @param {any} root */
export const main = root => setupWhylip(root);
harden(main);
