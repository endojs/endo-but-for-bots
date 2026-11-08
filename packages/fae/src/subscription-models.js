// @ts-check
import { Fail } from '@endo/errors';
import { codexResponsesEffort } from '@endo/hosted-agent/codex-reasoning.js';
import {
  assertSubscriptionResponsesRecipe,
  assertSubscriptionMessagesRecipe,
} from '@endo/lal/providers/index.js';
/** Combine supported model options across accounts eligible for automatic routing.
 * @param {string} id
 * @param {ReturnType<typeof import('@endo/hosted-agent/backend-catalog.js').normalizeBackendCatalog>} accounts
 */
export const pooledSubscriptionModels = (id, accounts) => {
  /** @type {Map<string, { model: any, subscriptionIds: string[] }>} */
  const byModel = new Map();
  for (const account of accounts.filter(
    item =>
      id !== 'fae-codex' ||
      (!item.pinnedOnly && ['current', 'stale'].includes(item.state)),
  )) {
    for (const raw of account.models) {
      const choices =
        id === 'fae-codex'
          ? [
              ...new Set(
                raw.reasoningEfforts.map(codexResponsesEffort).filter(Boolean),
              ),
            ]
          : raw.reasoningEfforts;
      const preferred =
        id === 'fae-codex'
          ? codexResponsesEffort(raw.defaultReasoningEffort)
          : raw.defaultReasoningEffort;
      const model = {
        ...raw,
        reasoningEfforts: choices,
        defaultReasoningEffort:
          preferred && choices.includes(preferred) ? preferred : null,
      };
      const entry = byModel.get(model.id);
      if (entry === undefined) {
        byModel.set(model.id, {
          model,
          subscriptionIds: [account.subscriptionId],
        });
      } else {
        entry.subscriptionIds.push(account.subscriptionId);
        // A pooled request can use any listed account. Unknown capacity
        // on one route must not become another account's window claim.
        const previous = entry.model;
        const reasoningEfforts = previous.reasoningEfforts.filter(effort =>
          choices.includes(effort),
        );
        entry.model = {
          ...previous,
          reasoningEfforts,
          defaultReasoningEffort:
            reasoningEfforts.includes(previous.defaultReasoningEffort) &&
            previous.defaultReasoningEffort === model.defaultReasoningEffort
              ? previous.defaultReasoningEffort
              : null,
          contextLength:
            previous.contextLength && model.contextLength
              ? Math.min(previous.contextLength, model.contextLength)
              : undefined,
          maxOutputTokens:
            previous.maxOutputTokens && model.maxOutputTokens
              ? Math.min(previous.maxOutputTokens, model.maxOutputTokens)
              : undefined,
        };
      }
    }
  }
  return harden([...byModel.values()]);
};
harden(pooledSubscriptionModels);

/** Bind an admitted model to the selected inference capability.
 * @param {string} backendId
 * @param {{modelId: string, reasoningEfforts: readonly string[], contextLength?: number}} model
 * @param {any} subscription
 * @param {string} [reasoningEffort]
 */
export const makeSubscriptionRecipe = (
  backendId,
  model,
  subscription,
  reasoningEffort,
) => {
  ['fae-codex', 'fae-claude'].includes(backendId) ||
    Fail`Unknown Fae subscription`;
  !reasoningEffort ||
    model.reasoningEfforts.includes(reasoningEffort) ||
    Fail`Unsupported reasoning effort for Fae subscription`;
  const recipe = harden({
    kind:
      backendId === 'fae-codex'
        ? 'subscription-responses'
        : 'subscription-messages',
    model: model.modelId,
    subscription,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(model.contextLength === undefined
      ? {}
      : { contextLength: model.contextLength }),
  });
  (backendId === 'fae-codex'
    ? assertSubscriptionResponsesRecipe
    : assertSubscriptionMessagesRecipe)(recipe);
  return recipe;
};
harden(makeSubscriptionRecipe);
