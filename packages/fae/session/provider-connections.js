// @ts-check
/* eslint-disable no-await-in-loop */
import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import {
  makeSubscriptionResponsesProvider,
  assertSubscriptionResponsesRecipe,
  makeSubscriptionMessagesProvider,
  assertSubscriptionMessagesRecipe,
  claudeMessagesEfforts,
} from '@endo/lal/providers/index.js';
import { makeAnthropicModelRead } from '@endo/hosted-agent/anthropic-model-read.js';
import { normalizeBackendCatalog } from '@endo/hosted-agent/backend-catalog.js';
import { makeModelCatalogOwner } from '@endo/hosted-agent/model-catalog.js';
import {
  makeOpenRouterModelRead,
  modelsFromOpenRouterCatalog,
} from '@endo/hosted-agent/openrouter-model-read.js';
import { resolveAuthToken } from '../src/credentials.js';
import {
  pooledSubscriptionModels,
  makeSubscriptionRecipe,
} from '../src/subscription-models.js';
import { createStreamingProvider } from '../providers/index.js';
import { providerModelId } from './session-identity.js';

/** Installed inference connections own discovery, admission, and reopening saved model selections. */
export const makeProviderConnections = ({
  powers,
  ownership,
  fetchAuthority,
  workload,
}) => {
  // The provider config (backend kind, default model, auth token) lives behind
  // the `llm-provider` capability handle. Resolve it once and cache it; every
  // per-model provider is built from it.
  const providerConfigs = new Map();
  let providerEpoch = harden({});
  const apiProvider = id => id === 'provider' || id === 'openrouter';
  const getProviderConfig = (id = 'provider') => {
    if (!providerConfigs.has(id)) {
      const pending = E(powers)
        .lookup(id === 'openrouter' ? 'openrouter-provider' : 'llm-provider')
        .then(cfg => {
          if (id === 'openrouter' && cfg?.provider !== 'openrouter')
            throw Error('Invalid OpenRouter provider configuration');
          return cfg;
        })
        .catch(error => {
          if (providerConfigs.get(id) === pending) providerConfigs.delete(id);
          throw error;
        });
      providerConfigs.set(id, pending);
    }
    return providerConfigs.get(id);
  };
  const readProviderToken = (id, cfg) =>
    resolveAuthToken({
      powers,
      config: cfg,
      ...(id === 'openrouter' ? { petName: 'openrouter-auth' } : {}),
    });

  // The direct provider's own model discovery: what the configured account
  // may be served, read from the provider under Floot's credential and held
  // for a while (`@endo/hosted-agent/model-catalog.js`). The same readers a
  // hosted OpenRouter or Anthropic broker uses; no list of models lives here.
  // A provider kind with no discovery reports itself unsupported and offers
  // nothing, rather than a list somebody typed.
  /** @type {Map<string, Promise<ReturnType<typeof makeModelCatalogOwner>>>} */
  const catalogsByProvider = new Map();
  /** Catalog construction/retirement remains owned until close settles. */
  const providerCatalogs = new Set();
  const closeProviderCatalog = async pending => {
    try {
      const owner = await pending;
      await owner.close();
    } finally {
      providerCatalogs.delete(pending);
    }
  };
  const getProviderCatalog = (id = 'provider') => {
    ownership.assertOpen();
    const existing = catalogsByProvider.get(id);
    if (existing) return existing;
    const pending = (async () => {
      const cfg = await getProviderConfig(id);
      ownership.assertOpen();
      if (!cfg) throw Error('API provider is not configured');
      const kind = cfg.provider || 'anthropic';
      const readKey = () => readProviderToken(id, cfg);
      /** @type {(() => Promise<any>) | undefined} */
      let read;
      if (kind === 'openrouter') {
        const readCatalog = makeOpenRouterModelRead({
          readKey,
          fetch: fetchAuthority,
        });
        read = async () => {
          const result = await readCatalog();
          return harden({
            observedAt: result.observedAt,
            models: modelsFromOpenRouterCatalog(result.models),
          });
        };
      } else if (kind === 'anthropic') {
        read = makeAnthropicModelRead({
          readAuthorization: async () =>
            harden({ header: 'x-api-key', token: await readKey() }),
          fetch: fetchAuthority,
        });
      }
      return makeModelCatalogOwner({ read });
    })().catch(error => {
      if (catalogsByProvider.get(id) === pending) catalogsByProvider.delete(id);
      providerCatalogs.delete(pending);
      throw error;
    });
    catalogsByProvider.set(id, pending);
    providerCatalogs.add(pending);
    return pending;
  };

  const configuredProvider = cfg => {
    const kind = cfg?.provider || 'anthropic';
    if (kind === 'anthropic')
      return { providerId: 'anthropic-api', providerTitle: 'Anthropic API' };
    if (kind === 'openrouter')
      return { providerId: 'openrouter', providerTitle: 'OpenRouter' };
    return { providerId: kind, providerTitle: kind };
  };
  const subscriptionProvider = id =>
    id === 'fae-codex'
      ? { providerId: 'openai', providerTitle: 'OpenAI' }
      : { providerId: 'anthropic', providerTitle: 'Anthropic' };

  const catalogTrouble = new Map();
  /**
   * What the inference pool offers through its installed catalog reader.
   * A backend that cannot be asked is every account unavailable: nothing is
   * offered from it, and nothing is admitted. Why is logged once per change
   * of what went wrong, so an operator seeing "unavailable" in the picker
   * has something to go on; the readers' messages name no credential and
   * no provider body.
   *
   * @param {string} id
   * @param {{ factory: any, descriptor: any }} backend
   */
  /** Reads in flight, by backend id (`''` for all): a second ask joins one. */
  const catalogReads = new Map();
  /**
   * `listModels()` and `listModelCatalogs()` are read together by the
   * picker; one read of the backends serves both rather than each asking
   * every backend again.
   *
   * @param {string} [backendId]
   */
  const readCatalogs = backendId => {
    // `undefined` (every backend) and `''` (no backend of that name) are
    // different asks and get different answers.
    const key = backendId;
    let pending = catalogReads.get(key);
    if (pending === undefined) {
      pending = readCatalogsNow(backendId).finally(() => {
        if (catalogReads.get(key) === pending) catalogReads.delete(key);
      });
      catalogReads.set(key, pending);
    }
    return pending;
  };

  const readSubscriptionCatalog = async (id, backend) => {
    try {
      const accounts = normalizeBackendCatalog(
        await E(backend.factory).modelCatalog(),
      );
      if (catalogTrouble.delete(id)) {
        console.error(
          `[floot-factory] Model catalog for backend "${id}" is readable again.`,
        );
      }
      return accounts;
    } catch (error) {
      const message = `${error instanceof Error ? error.message : error}`.slice(
        0,
        200,
      );
      if (catalogTrouble.get(id) !== message) {
        catalogTrouble.set(id, message);
        console.error(
          `[floot-factory] Model catalog unavailable for backend "${id}": ${message}`,
        );
      }
      const declared = backend.descriptor.subscriptions || [];
      return harden(
        (declared.length ? declared : [{ id: 'default' }]).map(entry =>
          harden({
            subscriptionId: entry.id,
            ...(entry.label === undefined ? {} : { label: entry.label }),
            ...(entry.pinnedOnly === true ? { pinnedOnly: true } : {}),
            state: 'unavailable',
            observedAt: null,
            models: [],
          }),
        ),
      );
    }
  };

  /**
   * A backend's rows in the order a picker shows them: the model the
   * provider marks first (whether or not the row says `default`, which the
   * flattened listing reserves for the direct provider), then by title, then
   * by id. A provider lists hundreds of models in an order of its own; nobody
   * scrolls that.
   *
   * @template {{ title: string, modelId: string }} Row
   * @param {Array<{ marked: boolean, row: Row }>} entries
   */
  const orderModelRows = entries => {
    // Case-insensitive by title, then exact title, then id: `localeCompare`
    // is tamed to code-point order under SES, so the key is lowered here.
    /** @type {(a: string, b: string) => number} */
    const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    return [...entries]
      .sort(
        (a, b) =>
          Number(b.marked) - Number(a.marked) ||
          compare(a.row.title.toLowerCase(), b.row.title.toLowerCase()) ||
          compare(a.row.title, b.row.title) ||
          compare(a.row.modelId, b.row.modelId),
      )
      .map(entry => entry.row);
  };

  /**
   * The rows a picker and the acceptance drivers read: one per model a
   * backend offers, with the accounts that list it, and the accounts'
   * discovery states beside them; each backend's rows in the picker's order.
   *
   * @param {string} [backendId]
   */
  const readCatalogsNow = async backendId => {
    /** @type {any[]} */
    const models = [];
    /** @type {any[]} */
    const catalogs = [];
    const slots =
      backendId === undefined
        ? [
            'provider',
            ...((await E(powers).has('openrouter-provider'))
              ? ['openrouter']
              : []),
          ]
        : apiProvider(backendId)
          ? [backendId]
          : [];
    for (const slot of slots) {
      let cfg;
      try {
        cfg = await getProviderConfig(slot);
      } catch (_error) {
        cfg = undefined;
      }
      const defaultModel = `${cfg?.model || ''}`;
      let snapshot;
      try {
        snapshot = await (await getProviderCatalog(slot)).snapshot();
      } catch (_error) {
        snapshot = harden({
          state: 'unavailable',
          observedAt: null,
          models: [],
        });
      }
      if (cfg)
        catalogs.push(
          harden({
            backendId: slot,
            ...configuredProvider(cfg),
            accounts: [
              {
                subscriptionId: 'default',
                state: snapshot.state,
                observedAt: snapshot.observedAt,
                modelCount: snapshot.models.length,
              },
            ],
          }),
        );
      /** @type {Array<{ marked: boolean, row: any }>} */
      const providerRows = [];
      for (const model of snapshot.models) {
        providerRows.push({
          marked: model.id === defaultModel,
          row: harden({
            id:
              slot === 'provider' ? model.id : providerModelId(slot, model.id),
            selectionId:
              slot === 'provider' ? model.id : providerModelId(slot, model.id),
            backendId: slot,
            ...configuredProvider(cfg),
            modelId: model.id,
            title: model.title,
            description: model.description,
            // What an unpinned session runs, when the account lists it.
            default: model.id === defaultModel,
            defaultReasoningEffort: null,
            reasoningEfforts: [],
            ...(model.contextLength === undefined
              ? {}
              : { contextLength: model.contextLength }),
            ...(model.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: model.maxOutputTokens }),
            subscriptionIds: ['default'],
          }),
        });
      }
      models.push(...orderModelRows(providerRows));
    }
    if (backendId === undefined || !apiProvider(backendId)) {
      const subscriptions = new Map();
      if (
        (backendId === undefined || backendId === 'fae-codex') &&
        (await E(powers).has('codex-inference'))
      ) {
        subscriptions.set('fae-codex', {
          descriptor: {},
          factory: await E(powers)
            .lookup('codex-model-catalog')
            .catch(() => undefined),
        });
      }
      if (
        (backendId === undefined || backendId === 'fae-claude') &&
        (await E(powers).has('claude-inference'))
      ) {
        const subscription = await E(powers).lookup('claude-inference');
        // Read the inference capability itself: no Claude Code factory needed.
        subscriptions.set('fae-claude', {
          descriptor: { subscriptions: [] },
          factory: Far('ClaudeInferenceCatalog', {
            async modelCatalog() {
              const { models: admittedModels } =
                await E(subscription).describe();
              return harden({
                accounts: [
                  {
                    subscriptionId: 'auto',
                    state: admittedModels.length ? 'current' : 'unavailable',
                    observedAt: admittedModels.length ? Date.now() : null,
                    models: admittedModels.map(id => ({
                      id,
                      title: id,
                      description: '',
                      default: false,
                      defaultReasoningEffort: null,
                      reasoningEfforts: claudeMessagesEfforts(id),
                    })),
                  },
                ],
              });
            },
          }),
        });
      }
      if (backendId !== undefined && !subscriptions.has(backendId)) {
        throw Error(`Unknown inference backend "${backendId}"`);
      }
      const selected = [...subscriptions.entries()].filter(
        ([id]) => backendId === undefined || id === backendId,
      );
      // Every backend is asked at once: one slow provider does not hold the
      // others' listings back, and the rows keep the backends' order.
      const read = await Promise.all(
        selected.map(
          async ([id, backend]) =>
            /** @type {const} */ ([
              id,
              await readSubscriptionCatalog(id, backend),
            ]),
        ),
      );
      for (const [id, listedAccounts] of read) {
        const accounts =
          id === 'fae-codex'
            ? listedAccounts.filter(account => !account.pinnedOnly)
            : listedAccounts;
        catalogs.push(
          harden({
            backendId: id,
            ...subscriptionProvider(id),
            accounts: accounts.map(account =>
              harden({
                subscriptionId: account.subscriptionId,
                ...(account.label === undefined
                  ? {}
                  : { label: account.label }),
                ...(account.pinnedOnly === true ? { pinnedOnly: true } : {}),
                state: account.state,
                observedAt: account.observedAt,
                modelCount: account.models.length,
              }),
            ),
          }),
        );
        /** @type {Array<{ marked: boolean, row: any }>} */
        const rows = [];
        for (const { model, subscriptionIds } of pooledSubscriptionModels(
          id,
          accounts,
        )) {
          rows.push({
            marked: model.default,
            row: harden({
              id: providerModelId(id, model.id),
              selectionId: providerModelId(id, model.id),
              backendId: id,
              ...subscriptionProvider(id),
              modelId: model.id,
              title: model.title,
              description: model.description,
              // A backend-scoped listing keeps the provider's default; the
              // flattened one marks only the direct provider's configured
              // model, which is what an unpinned session runs.
              default: backendId === undefined ? false : model.default,
              defaultReasoningEffort: model.defaultReasoningEffort,
              reasoningEfforts: model.reasoningEfforts,
              ...(model.contextLength === undefined
                ? {}
                : { contextLength: model.contextLength }),
              ...(model.maxOutputTokens === undefined
                ? {}
                : { maxOutputTokens: model.maxOutputTokens }),
              subscriptionIds,
            }),
          });
        }
        models.push(...orderModelRows(rows));
      }
    }
    return harden({ models, catalogs });
  };

  // One streaming provider per model. Sessions that don't pin a model share the
  // entry under the empty-string key (the factory's configured default model).
  //
  // The auth token is read from the `SecretBlob`, never held in the config
  // value, and re-read for every turn: a provider pins the token it was built
  // with, so a cache keyed on the model alone would go on presenting a revoked
  // credential until somebody thought to call `refreshCredentials()`. Keyed on
  // the bytes as well, a rotation or revocation takes effect by itself on the
  // next turn, and an unrotated deployment still reuses the provider it built.
  /** @type {Map<string, { token: string, providerP: Promise<any> }>} */
  const providersByModel = new Map();
  const getProvider = async (model, id = 'provider') => {
    const epoch = providerEpoch;
    const key = JSON.stringify([id, model || '']);
    const cfg = await getProviderConfig(id);
    // A revoked secret rejects here, which fails the turn rather than letting
    // a cached provider answer it.
    const token = await readProviderToken(id, cfg);
    const cached = providersByModel.get(key);
    if (epoch === providerEpoch && cached && cached.token === token)
      return cached.providerP;
    const providerP = (async () =>
      createStreamingProvider({
        provider: cfg.provider,
        model: model || cfg.model,
        apiKey: token,
        requestTimeoutMs: workload.requestTimeoutMs,
      }))().catch(error => {
      if (providersByModel.get(key)?.providerP === providerP) {
        providersByModel.delete(key);
      }
      throw error;
    });
    if (epoch === providerEpoch)
      providersByModel.set(key, { token, providerP });
    return providerP;
  };

  const list = async () => {
    const descriptors = [];
    const cfg = await getProviderConfig().catch(() => undefined);
    if (cfg) descriptors.push({ id: 'provider', ...configuredProvider(cfg) });
    if (await E(powers).has('openrouter-provider')) {
      const config = await getProviderConfig('openrouter').catch(
        () => undefined,
      );
      if (config)
        descriptors.push({ id: 'openrouter', ...configuredProvider(config) });
    }
    for (const [id, name] of [
      ['fae-codex', 'codex-inference'],
      ['fae-claude', 'claude-inference'],
    ]) {
      if (await E(powers).has(name))
        descriptors.push({ id, ...subscriptionProvider(id) });
    }
    return harden(
      descriptors.map(provider => ({
        ...provider,
        title: provider.providerTitle,
        kind: 'api',
        continuity: 'explicit',
        toolOwnership: 'endo',
      })),
    );
  };
  const select = async (options, inheritedInferenceRecipe) => {
    const selectedModel = options.modelId || '';
    const backendId = options.backendId || 'provider';
    const modelId = selectedModel;
    let inferenceRecipe;
    let contextLength;
    const providerConfig = apiProvider(backendId)
      ? await getProviderConfig(backendId).catch(() => undefined)
      : undefined;
    if (apiProvider(backendId) && !providerConfig)
      throw Error(
        'No API provider is configured for this session; choose a configured provider and model',
      );
    if (backendId === 'openrouter' && !modelId)
      throw Error('Choose an available OpenRouter model');
    const openRouter = providerConfig?.provider === 'openrouter';
    if (apiProvider(backendId)) {
      const effectiveModel = modelId;
      // Auto routes name a router, not the model that will serve the request.
      if (effectiveModel && !effectiveModel.startsWith('openrouter/')) {
        const snapshot = await (await getProviderCatalog(backendId)).snapshot();
        contextLength = snapshot.models.find(
          model => model.id === effectiveModel,
        )?.contextLength;
      }
    }
    if (
      apiProvider(backendId) &&
      openRouter &&
      selectedModel &&
      (typeof selectedModel !== 'string' || !selectedModel.includes('/'))
    ) {
      throw Error('OpenRouter model must include its organization prefix');
    }
    if (['fae-codex', 'fae-claude'].includes(backendId)) {
      const assertRecipe =
        backendId === 'fae-claude'
          ? assertSubscriptionMessagesRecipe
          : assertSubscriptionResponsesRecipe;
      !options.subscription ||
        options.subscription === 'auto' ||
        Fail`Fae subscription backends use automatic subscription routing only`;
      if (inheritedInferenceRecipe) {
        assertRecipe(inheritedInferenceRecipe);
        (inheritedInferenceRecipe.model === modelId &&
          (inheritedInferenceRecipe.reasoningEffort || '') ===
            (options.reasoningEffort || '')) ||
          Fail`Delegated inference identity differs from its parent`;
        inferenceRecipe = inheritedInferenceRecipe;
      } else {
        const rows = (await readCatalogs(backendId)).models;
        const model = rows.find(row => row.modelId === modelId);
        model || Fail`Unknown model for Fae subscription`;
        inferenceRecipe = makeSubscriptionRecipe(
          backendId,
          model,
          await E(powers).lookup(
            backendId === 'fae-claude' ? 'claude-inference' : 'codex-inference',
          ),
          options.reasoningEffort,
        );
      }
    } else if (!apiProvider(backendId)) {
      throw Error(`Unknown inference backend "${backendId}"`);
    } else if (options.subscription && options.subscription !== 'auto') {
      throw Error('Fae providers use automatic account selection');
    } else if (selectedModel) {
      // Validate a pinned model against the provider account's current catalog.
      let snapshot;
      try {
        snapshot = await (await getProviderCatalog(backendId)).snapshot();
      } catch (_error) {
        snapshot = undefined;
      }
      if (snapshot === undefined || snapshot.state === 'unavailable') {
        throw Error(
          'Model catalog unavailable for the provider backend; no model can be admitted now',
        );
      }
      if (snapshot.state === 'unsupported') {
        throw Error(
          'No model discovery for this provider kind; a session runs its configured model, unpinned',
        );
      }
      if (!snapshot.models.some(candidate => candidate.id === selectedModel)) {
        throw Error(
          `Unknown model "${selectedModel}" for the provider backend`,
        );
      }
    }
    return { backendId, modelId, inferenceRecipe, contextLength };
  };
  const open = (entry, id) => {
    if (['fae-codex', 'fae-claude'].includes(entry.backendId)) {
      const messagesProtocol = entry.backendId === 'fae-claude';
      const recipe = entry.inferenceRecipe;
      (messagesProtocol
        ? assertSubscriptionMessagesRecipe
        : assertSubscriptionResponsesRecipe)(recipe);
      (recipe?.kind ===
        (messagesProtocol
          ? 'subscription-messages'
          : 'subscription-responses') &&
        recipe.model === entry.modelId &&
        (recipe.reasoningEffort || '') === (entry.reasoningEffort || '')) ||
        Fail`Invalid retained Floot inference recipe`;
      const provider = (
        messagesProtocol
          ? makeSubscriptionMessagesProvider
          : makeSubscriptionResponsesProvider
      )({
        ...recipe,
        sessionId: `floot-${id}`,
        log: line => console.error(line),
      });
      return {
        kind: 'provider',
        providerFormat: messagesProtocol
          ? 'messages-output-v1'
          : 'responses-output-v1',
        provideProvider: () => provider,
        disposeProvider: () => provider.dispose(),
      };
    } else {
      // A thunk, not a resolved provider: `refreshCredentials()` clears
      // the factory's cache, and a session that had captured its provider
      // would keep using the token that provider was built with — the
      // rotation or revocation would reach only sessions opened after it.
      return {
        kind: 'provider',
        provideProvider: () => getProvider(entry.modelId, entry.backendId),
      };
    }
  };
  const refresh = () => {
    providerEpoch = harden({});
    providersByModel.clear();
    providerConfigs.clear();
    // The direct provider's catalog was read under that config too: let
    // the owner go and read again under the next.
    for (const catalog of catalogsByProvider.values())
      void closeProviderCatalog(catalog).catch(() => {});
    catalogsByProvider.clear();
    catalogReads.clear();
  };
  const close = async attempt => {
    await Promise.all(
      [...providerCatalogs].map(pending =>
        attempt(() => closeProviderCatalog(pending)),
      ),
    );
    catalogsByProvider.clear();
    catalogReads.clear();
  };
  return harden({
    select,
    open,
    list,
    refresh,
    close,
    getProviderConfig,
    apiProvider,
    readCatalogs,
  });
};
harden(makeProviderConnections);
