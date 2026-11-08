// @ts-check
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeMarshal } from '@endo/marshal';
import { normalizeBackendCatalog } from '@endo/hosted-agent/backend-catalog.js';
import { assertSubscriptionResponsesRecipe } from '@endo/lal/providers/index.js';
import { stableModuleSpecifier } from './module-specifier.js';
import {
  pooledSubscriptionModels,
  makeSubscriptionRecipe,
} from './subscription-models.js';

const path = name => ['@pins', 'installations', 'codex-sandbox', name];
const subscriptionSpecifier = stableModuleSpecifier(
  '../../hosted-agent/src/subscription-module.js',
  import.meta.url,
);
const catalogSpecifier = stableModuleSpecifier(
  '../../hosted-agent/src/subscription-model-catalog.js',
  import.meta.url,
);
const canonicalSpecifier = value =>
  typeof value === 'string' &&
  (value.startsWith('/') || value.startsWith('file:///'))
    ? stableModuleSpecifier(value, 'file:///')
    : value;
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
const subscriptionEvidence = async (
  root,
  diagnostics,
  id,
  expected = subscriptionSpecifier,
) => {
  const formula = await E(diagnostics).getFormula(id);
  const { properties } = formula;
  if (
    formula.type !== 'make-unconfined' ||
    canonicalSpecifier(properties.specifier?.value) !==
      canonicalSpecifier(expected) ||
    !properties.powers?.identifier ||
    !properties.worker?.identifier
  )
    throw Error('Expected the standard shared subscription wrapper');
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
    if (
      !recipe ||
      typeof recipe !== 'object' ||
      !('subscription' in recipe) ||
      recipe.subscription !== marker
    )
      throw Error();
    return slots['0'];
  } catch {
    throw Error('Invalid retained subscription recipe');
  }
};

/** Inspect the shared OpenAI subscription without incarnating it.
 * @param {any} root
 */
export const inspectInstalledOpenAI = async root => {
  const diagnostics = await E(root).diagnostics();
  const sourceId = await E(root).identify(...path('subscription'));
  if (!sourceId) throw Error('Missing installed OpenAI subscription');
  const source = await subscriptionEvidence(root, diagnostics, sourceId);
  const assertCurrent = async () => {
    if ((await E(root).identify(...path('subscription'))) !== sourceId)
      throw Error('Shared inference subscription changed during setup');
  };
  return harden({
    assertCurrent,
    async validateRetained(formula) {
      const existing = await subscriptionEvidence(
        root,
        diagnostics,
        recipeSubscriptionId(formula),
      );
      if (
        existing.powers !== source.powers ||
        existing.worker !== source.worker ||
        !sameEnvironment(existing.env, source.env)
      )
        throw Error('Retained subscription differs from shared backend');
    },
    async select(modelId, reasoningEffort) {
      const catalogId = await E(root).identify(...path('model-catalog'));
      const catalog = await subscriptionEvidence(
        root,
        diagnostics,
        catalogId,
        catalogSpecifier,
      );
      if (
        catalog.powers !== source.powers ||
        catalog.worker !== source.worker ||
        Object.keys(catalog.env).length
      )
        throw Error('Model catalog differs from shared subscription');
      const reader = await E(root).lookupById(catalogId);
      const accounts = normalizeBackendCatalog(await E(reader).modelCatalog());
      const selected = pooledSubscriptionModels('fae-codex', accounts).find(
        row => row.model.id === modelId,
      )?.model;
      if (!selected)
        throw Error('Model is not supported by the shared backend');
      await assertCurrent();
      return makeSubscriptionRecipe(
        'fae-codex',
        { ...selected, modelId },
        await E(root).lookupById(sourceId),
        reasoningEffort,
      );
    },
  });
};
harden(inspectInstalledOpenAI);
