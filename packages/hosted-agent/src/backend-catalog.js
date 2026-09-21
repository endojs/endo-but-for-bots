// @ts-check

import { Fail, q } from '@endo/errors';

import { normalizeHostedModelDescriptor } from './hosted-backend.js';
import { CATALOG_STATES } from './model-catalog.js';

/** @import { CatalogState, HostedModelDescriptor } from './model-catalog.js' */

/**
 * What a backend says of one account's catalog, as a picker shows it: the
 * broker's per-account reading (`provider-scopes.js` `modelCatalog`), with
 * the operator's label and lane marking for that account, and each model
 * projected through the runtime's own rules.
 *
 * @typedef {object} BackendCatalogAccount
 * @property {string} subscriptionId `default` where the broker holds one
 *   credential.
 * @property {string} [label]
 * @property {boolean} [pinnedOnly] A lane set aside: listed, not offered to
 *   an `auto` session.
 * @property {CatalogState} state
 * @property {number | null} observedAt
 * @property {HostedModelDescriptor[]} models
 */

const SUBSCRIPTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_ACCOUNTS = 16;

/**
 * Validate what a broker's `modelCatalog()` answered before it crosses into
 * a backend: bounded accounts, honest states, normalized descriptors.
 *
 * @param {unknown} candidate
 * @returns {Array<{ subscriptionId: string, pinnedOnly?: boolean, state: CatalogState, observedAt: number | null, models: HostedModelDescriptor[] }>}
 */
export const normalizeBrokerCatalog = candidate => {
  const accounts = /** @type {any} */ (candidate)?.accounts;
  (Array.isArray(accounts) && accounts.length <= MAX_ACCOUNTS) ||
    Fail`Invalid broker model catalog`;
  const projected = accounts.map((/** @type {any} */ account) => {
    (account && typeof account === 'object') ||
      Fail`Invalid broker model catalog account`;
    const subscriptionId = /** @type {unknown} */ (account.subscriptionId);
    const pinnedOnly = /** @type {unknown} */ (account.pinnedOnly);
    const state = /** @type {unknown} */ (account.state);
    const observedAt = /** @type {unknown} */ (account.observedAt);
    const rawModels = /** @type {unknown} */ (account.models);
    (typeof subscriptionId === 'string' &&
      SUBSCRIPTION_ID.test(subscriptionId) &&
      (pinnedOnly === undefined || typeof pinnedOnly === 'boolean') &&
      typeof state === 'string' &&
      CATALOG_STATES.includes(state) &&
      (observedAt === null ||
        (typeof observedAt === 'number' &&
          Number.isFinite(observedAt) &&
          observedAt >= 0)) &&
      Array.isArray(rawModels) &&
      rawModels.length <= 4096) ||
      Fail`Invalid broker model catalog account`;
    const models = /** @type {any[]} */ (rawModels).map(
      normalizeHostedModelDescriptor,
    );
    new Set(models.map(model => model.id)).size === models.length ||
      Fail`Duplicate model in broker catalog account`;
    return harden({
      subscriptionId: /** @type {string} */ (account.subscriptionId),
      ...(pinnedOnly === true ? { pinnedOnly: true } : {}),
      state: /** @type {CatalogState} */ (account.state),
      observedAt: /** @type {number | null} */ (account.observedAt),
      models,
    });
  });
  new Set(projected.map(account => account.subscriptionId)).size ===
    projected.length || Fail`Duplicate account in broker model catalog`;
  return harden(projected);
};
harden(normalizeBrokerCatalog);

/**
 * Validate what a backend factory's `modelCatalog()` answered before Floot
 * believes it: the broker shape above, with the operator's label and lane
 * marking allowed on each account.
 *
 * @param {unknown} candidate
 * @returns {BackendCatalogAccount[]}
 */
export const normalizeBackendCatalog = candidate => {
  const raw = /** @type {any} */ (candidate)?.accounts;
  Array.isArray(raw) || Fail`Invalid backend model catalog`;
  const accounts = normalizeBrokerCatalog({
    accounts: raw.map((/** @type {any} */ account) => {
      (account && typeof account === 'object') ||
        Fail`Invalid backend model catalog account`;
      const { label, pinnedOnly, ...rest } = account;
      label === undefined ||
        (typeof label === 'string' && label !== '' && label.length <= 128) ||
        Fail`Invalid backend model catalog label`;
      pinnedOnly === undefined ||
        typeof pinnedOnly === 'boolean' ||
        Fail`Invalid backend model catalog lane marking`;
      return { ...rest, ...(pinnedOnly === true ? { pinnedOnly: true } : {}) };
    }),
  });
  return harden(
    accounts.map((account, index) => {
      const { label, pinnedOnly } = raw[index];
      return harden({
        ...account,
        ...(label === undefined ? {} : { label }),
        ...(pinnedOnly === true ? { pinnedOnly: true } : {}),
      });
    }),
  );
};
harden(normalizeBackendCatalog);

/**
 * Whether a recorded plan already answers a request, so that reopening a
 * session needs no catalog: the request names the recorded model, or none,
 * and the recorded effort, or none. A different model or effort is a new pin,
 * and a new pin is admitted by the catalog like a new session's.
 *
 * @param {{ model?: string, reasoningEffort?: string }} recorded
 * @param {{ model?: string, reasoningEffort?: string }} requested
 */
export const recordedPinAnswers = (recorded, requested) =>
  (!requested.model || requested.model === recorded.model) &&
  (!requested.reasoningEffort ||
    requested.reasoningEffort === recorded.reasoningEffort);
harden(recordedPinAnswers);

/**
 * What the catalog is asked for when a reopen changes a pin: the model the
 * request names, or the recorded one when it names none, so that an effort
 * changed on its own keeps the session's model. A recorded model is never
 * replaced by a request that did not name another.
 *
 * @param {{ model?: string } | undefined} recorded
 * @param {{ model?: string, reasoningEffort?: string, subscription?: string }} requested
 */
export const revisedPin = (recorded, requested) =>
  harden({
    ...requested,
    ...(requested.model || recorded?.model === undefined
      ? {}
      : { model: recorded.model }),
  });
harden(revisedPin);

/**
 * A backend's view of its broker's per-account catalogs.
 *
 * `catalog(subscriptionId?)` is what a picker is shown: every account (or
 * the one named), labelled, with its state and its models as the runtime
 * offers them. A broker that cannot be asked at all is reported as every
 * declared account unavailable, never as an empty success.
 *
 * `resolve({ model, reasoningEffort, subscription })` admits a new session's
 * pin: the model must be listed by an account the session may be served
 * from (`auto`: the accounts not set aside; an id: that one), and the effort
 * must be one that model offers, or the model's default when none is named.
 * A request that names no model gets the one the provider marks as its
 * default, and is refused when it marks none: nobody picks "the first
 * listed" for a session. Missing discovery is a refusal that says so, not
 * permission and not a substitute model. It is not for reopening a recorded
 * session: see `recordedPinAnswers` and `revisedPin`.
 *
 * @param {object} powers
 * @param {string} powers.label The adapter's name for messages.
 * @param {(subscriptionId?: string) => Promise<any>} powers.readCatalog The
 *   broker service's `modelCatalog`.
 * @param {() => Promise<Array<{ id: string, label: string, pinnedOnly?: boolean }>>} [powers.listSubscriptions]
 *   The broker's declared subscriptions, for labels and lanes.
 * @param {(model: HostedModelDescriptor) => HostedModelDescriptor | undefined} [powers.project]
 *   The runtime's projection of a provider-native descriptor: its route
 *   spelling, the efforts it can drive, or nothing to leave the model out.
 */
export const makeBackendCatalog = ({
  label,
  readCatalog,
  listSubscriptions = async () => [],
  project = model => model,
}) => {
  /**
   * @param {string} [subscriptionId]
   * @returns {Promise<{ accounts: BackendCatalogAccount[] }>}
   */
  const catalog = async subscriptionId => {
    subscriptionId === undefined ||
      (typeof subscriptionId === 'string' &&
        SUBSCRIPTION_ID.test(subscriptionId)) ||
      Fail`Invalid ${q(label)} subscription`;
    const [known, read] = await Promise.all([
      // The broker's declared accounts, or nothing known when it cannot say.
      listSubscriptions().then(
        entries => (Array.isArray(entries) ? entries : undefined),
        () => undefined,
      ),
      // A broker that cannot be asked, or that answers badly, is not known.
      Promise.resolve()
        .then(() => readCatalog(subscriptionId))
        .then(normalizeBrokerCatalog)
        .catch(() => undefined),
    ]);
    // An account the broker declares nothing of is not "unavailable": it is
    // not there, and a pin to it is refused as such rather than as an outage.
    // Over one credential the only account is `default`.
    if (subscriptionId !== undefined && known !== undefined) {
      (known.length
        ? known.some(entry => entry?.id === subscriptionId)
        : subscriptionId === 'default') ||
        Fail`Unknown ${q(label)} subscription`;
    }
    const declared = known ?? [];
    const labels = new Map(
      declared
        .filter(entry => entry && typeof entry.id === 'string')
        .map(entry => [entry.id, entry]),
    );
    /** @type {BackendCatalogAccount[]} */
    let accounts;
    if (read === undefined) {
      // The broker could not be asked, or answered badly: what it holds is
      // unknown, and unknown admits nothing.
      const ids =
        subscriptionId !== undefined
          ? [subscriptionId]
          : declared.length
            ? declared.map(entry => entry.id)
            : ['default'];
      accounts = ids.map(id =>
        harden({
          subscriptionId: id,
          state: /** @type {const} */ ('unavailable'),
          observedAt: null,
          models: [],
        }),
      );
    } else {
      accounts = read.map(account =>
        harden({
          subscriptionId: account.subscriptionId,
          // The read says which accounts are lanes; the declared set, when
          // it could be listed, adds the label and agrees.
          ...(account.pinnedOnly === true ? { pinnedOnly: true } : {}),
          state: account.state,
          observedAt: account.observedAt,
          models: account.models.flatMap(model => {
            // A provider id the runtime cannot spell or route is left out;
            // it is not a reason to lose the rest of the account's list.
            try {
              const projected = project(model);
              return projected === undefined
                ? []
                : [normalizeHostedModelDescriptor(projected)];
            } catch (_error) {
              return [];
            }
          }),
        }),
      );
    }
    return harden({
      accounts: accounts.map(account => {
        const entry = labels.get(account.subscriptionId);
        return harden({
          ...account,
          ...(entry?.label === undefined ? {} : { label: entry.label }),
          ...(entry?.pinnedOnly === true || account.pinnedOnly === true
            ? { pinnedOnly: true }
            : {}),
        });
      }),
    });
  };

  /**
   * @param {{ model?: string, reasoningEffort?: string, subscription?: string }} request
   * @returns {Promise<{ model: string, reasoningEffort?: string }>}
   */
  const resolve = async ({ model, reasoningEffort, subscription }) => {
    const pinned =
      subscription === undefined || subscription === 'auto'
        ? undefined
        : subscription;
    model === undefined ||
      model === '' ||
      (typeof model === 'string' && model.length <= 256) ||
      Fail`${q(label)} model id must be a bounded string`;
    const { accounts } = await catalog(pinned);
    const eligible = accounts.filter(account =>
      pinned === undefined
        ? account.pinnedOnly !== true
        : account.subscriptionId === pinned,
    );
    eligible.length > 0 ||
      (pinned === undefined
        ? Fail`No ${q(label)} account serves an automatic session; every account is set aside`
        : Fail`Unknown ${q(label)} subscription`);
    const usable = eligible.filter(
      account => account.state === 'current' || account.state === 'stale',
    );
    usable.length > 0 ||
      Fail`${q(label)} model catalog is unavailable; no model can be admitted now`;
    /** @type {Map<string, HostedModelDescriptor>} */
    const listed = new Map();
    for (const account of usable) {
      for (const entry of account.models) {
        if (!listed.has(entry.id)) listed.set(entry.id, entry);
      }
    }
    const unnamed = model === undefined || model === '';
    const found = unnamed
      ? [...listed.values()].find(entry => entry.default)
      : listed.get(/** @type {string} */ (model));
    const chosen =
      found ??
      (unnamed
        ? Fail`No ${q(label)} model named, and the account marks no default`
        : Fail`Unknown ${q(label)} model ${q(`${model}`.slice(0, 64))}`);
    const effort =
      reasoningEffort === undefined || reasoningEffort === ''
        ? (chosen.defaultReasoningEffort ?? undefined)
        : reasoningEffort;
    effort === undefined ||
      chosen.reasoningEfforts.includes(effort) ||
      Fail`Unsupported ${q(label)} reasoning effort ${q(`${effort}`.slice(0, 64))} for ${q(chosen.id)}`;
    return harden({
      model: chosen.id,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    });
  };

  /**
   * What a session may be offered, for its own `models()`: pinned to an
   * account, what that account lists; `auto`, the union of what the accounts
   * not set aside list. From those that could be read.
   *
   * @param {string} [subscription]
   * @returns {Promise<HostedModelDescriptor[]>}
   */
  const offered = async subscription => {
    const pinned =
      subscription === undefined || subscription === 'auto'
        ? undefined
        : subscription;
    const { accounts } = await catalog(pinned);
    /** @type {Map<string, HostedModelDescriptor>} */
    const listed = new Map();
    for (const account of accounts) {
      if (
        (pinned === undefined
          ? account.pinnedOnly !== true
          : account.subscriptionId === pinned) &&
        (account.state === 'current' || account.state === 'stale')
      ) {
        for (const entry of account.models) {
          if (!listed.has(entry.id)) listed.set(entry.id, entry);
        }
      }
    }
    return harden([...listed.values()]);
  };

  return harden({ catalog, resolve, offered });
};
harden(makeBackendCatalog);
