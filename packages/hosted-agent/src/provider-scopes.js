// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

/**
 * @typedef {object} ProviderScopeSpec
 * @property {string} providerOrigin
 * @property {string} accountRef
 * @property {string} [model]
 * @property {'off' | 'public-internet'} [networkPolicy]
 * @property {string} [subscription] `auto` (the default) or a subscription id.
 */

/**
 * @typedef {object} ScopedProviderIssuer
 * @property {(spec: ProviderScopeSpec & {sessionId: string}) => {value: Promise<any>, fence(): Promise<void>, revoke(): Promise<void>}} issueKit
 */

const SpecShape = M.splitRecord(
  { providerOrigin: M.string(), accountRef: M.string() },
  {
    model: M.string(),
    networkPolicy: M.or('off', 'public-internet'),
    // Which of the provider's subscriptions this session uses: `auto`, or
    // one by id. Absent means `auto`.
    subscription: M.string(),
  },
  harden({}),
);

const ScopeInterface = M.interface('ProviderScope', {
  start: M.call().returns(M.promise()),
  attestation: M.call().returns(M.promise()),
  sandboxEvidence: M.call().returns(M.promise()),
  fence: M.call().returns(M.promise()),
  revoke: M.call().returns(M.promise()),
});

/**
 * Host-private remote scopes over one retained operator issuer/runtime.
 * provideScope() is inert: receive and retain the scope before calling start(),
 * without pipelining startup through its unresolved acquisition promise.
 * The caller must retain the operator kit behind openIssuer before effects.
 * close() fences and drains scopes; only then may that caller close the shared
 * issuer/runtime. A session's revoke never closes those operator resources.
 *
 * Scopes remain retrievable through failed cleanup. Successful revoke permits a
 * new scope for the same logical session, while old handles stay closed. The
 * session supervisor must serialize replacement and drain pending scope calls.
 * lookupScope() does not create ownership, and absence is not proof that native
 * resources from an earlier service process have been released. Recovery across
 * service loss requires the operator's independent reconciliation contract.
 * No disposable session capabilities are accepted by this shared service.
 * The trusted issuer supplies the existing copy-data attestation and sandbox
 * evidence records; this facade forwards their contract without redefining it.
 *
 * @param {object} powers
 * @param {() => Promise<ScopedProviderIssuer>} powers.openIssuer
 * @param {any} [powers.accountSource] The broker's read-only account source
 *   (`account-source.js`), offered beside the scopes.
 * @param {(subscriptionId?: string) => any} [powers.accountSourceOf] For a
 *   broker over several subscriptions: each one's account source, by id.
 * @param {() => Promise<Array<{ id: string, label: string, weight: number }>>} [powers.listSubscriptions]
 * @param {(subscriptionId?: string) => Promise<any>} [powers.readModelCatalog]
 *   Host-only provider metadata discovery, without opening an issuer or scope.
 * @param {any} [powers.resetRedeemer] The broker's facet for spending a
 *   banked rate-limit reset (`reset-redeemer.js`), where the adapter has one.
 * @param {(subscriptionId?: string) => any} [powers.resetRedeemerOf] The same,
 *   per subscription.
 * @param {any} [powers.subscription] The broker as a `Subscription`
 *   (`broker-subscription.js`): endpoints without a listener, for shares.
 */
export const makeProviderScopes = ({
  openIssuer,
  accountSource,
  accountSourceOf,
  listSubscriptions,
  readModelCatalog,
  resetRedeemer,
  resetRedeemerOf,
  subscription,
}) => {
  /** @type {Map<string, {spec: ProviderScopeSpec, facet: any, revoke(): Promise<void>}>} */
  const scopes = new Map();
  /** @type {Promise<ScopedProviderIssuer> | undefined} */
  let opening;
  /** @type {Promise<void> | undefined} */
  let closing;
  let stopped = false;
  /** @type {Set<Promise<any>>} */
  const modelReads = new Set();

  /**
   * @param {string} sessionId
   * @param {ProviderScopeSpec} requested
   */
  const provideScope = (sessionId, requested) => {
    !stopped || Fail`Provider scope service is closed`;
    const spec = harden({
      providerOrigin: requested.providerOrigin,
      accountRef: requested.accountRef,
      model: requested.model,
      networkPolicy: requested.networkPolicy ?? 'off',
      subscription: requested.subscription ?? 'auto',
    });
    const prior = scopes.get(sessionId);
    if (prior) {
      (prior.spec.providerOrigin === spec.providerOrigin &&
        prior.spec.accountRef === spec.accountRef &&
        prior.spec.model === spec.model &&
        prior.spec.networkPolicy === spec.networkPolicy &&
        prior.spec.subscription === spec.subscription) ||
        Fail`Provider scope specification differs from its retained owner`;
      return prior.facet;
    }

    /** @type {ReturnType<ScopedProviderIssuer['issueKit']> | undefined} */
    let issue;
    /** @type {Promise<void> | undefined} */
    let starting;
    /** @type {Promise<void> | undefined} */
    let revoking;
    let grant;
    let inactive = false;
    let released = false;
    /** @type {Set<Promise<any>>} */
    const observations = new Set();
    const assertOpen = () => {
      (!stopped && !inactive) || Fail`Provider scope is closed`;
    };
    const start = () => {
      assertOpen();
      starting ??= Promise.resolve().then(async () => {
        assertOpen();
        opening ??= Promise.resolve().then(openIssuer);
        const issuer = await opening;
        assertOpen();
        // Retain the local owner before awaiting an issuance that may fail
        // after acquiring its listener or while rolling that listener back.
        issue = issuer.issueKit(harden({ ...spec, sessionId }));
        grant = await issue.value;
        assertOpen();
      });
      void starting.catch(() => {});
      return starting;
    };
    // Withdraw inference and public egress without removing the namespace
    // anchor. The session owner must reap guest dependents before revoke().
    const fence = async () => {
      inactive = true;
      await issue?.fence();
    };
    const revoke = () => {
      inactive = true;
      if (released) return Promise.resolve();
      if (revoking) return revoking;
      // Invoke the retained grant fence immediately, including while its value
      // is pending. Admission after shared opening checks inactive above.
      const releasing = (async () => {
        await issue?.revoke();
      })();
      revoking = (async () => {
        const results = await Promise.allSettled([
          releasing,
          starting?.catch(() => {}),
          Promise.allSettled([...observations]),
        ]);
        const failures = results.flatMap(result =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (failures.length)
          throw AggregateError(failures, 'Provider scope cleanup pending');
        released = true;
        if (scopes.get(sessionId) === owner) scopes.delete(sessionId);
      })().finally(() => {
        revoking = undefined;
      });
      return revoking;
    };
    /** @param {(grant: any) => Promise<any>} read */
    const observe = read => {
      assertOpen();
      starting !== undefined || Fail`Provider scope has not started`;
      const operation = (async () => {
        await starting;
        assertOpen();
        const evidence = await read(grant);
        assertOpen();
        return evidence;
      })();
      observations.add(operation);
      return operation.finally(() => observations.delete(operation));
    };
    const facet = makeExo('ProviderScope', ScopeInterface, {
      start,
      attestation: () => observe(value => E(value).attestation()),
      sandboxEvidence: () => observe(value => E(value).sandboxEvidence()),
      fence,
      revoke,
    });
    const owner = { spec, facet, revoke };
    scopes.set(sessionId, owner);
    return facet;
  };

  const close = () => {
    stopped = true;
    if (closing) return closing;
    // Every revoke fences before yielding, so a pending A cannot delay B's
    // revocation. Retain every failed owner for the next close attempt.
    const releases = [...scopes.values()].map(scope => scope.revoke());
    closing = (async () => {
      // Metadata may enter the shared renewing credential. Do not acknowledge
      // owner retirement while an admitted read can still use that owner.
      const results = await Promise.allSettled([
        ...releases,
        ...[...modelReads].map(read =>
          read.then(
            () => undefined,
            () => undefined,
          ),
        ),
      ]);
      const failures = results.flatMap(result =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length)
        throw AggregateError(failures, 'Provider service cleanup pending');
    })().finally(() => {
      closing = undefined;
    });
    return closing;
  };
  const service = makeExo(
    'ProviderScopes',
    M.interface('ProviderScopes', {
      provideScope: M.call(M.string(), SpecShape).returns(M.remotable()),
      lookupScope: M.call(M.string()).returns(
        M.or(M.remotable(), M.undefined()),
      ),
      accountSource: M.call()
        .optional(M.string())
        .returns(M.or(M.remotable(), M.undefined(), M.promise())),
      subscriptions: M.call().returns(M.promise()),
      modelCatalog: M.call().optional(M.string()).returns(M.promise()),
      resetRedeemer: M.call()
        .optional(M.string())
        .returns(M.or(M.remotable(), M.undefined(), M.promise())),
      subscription: M.call().returns(M.or(M.remotable(), M.undefined())),
    }),
    {
      provideScope,
      lookupScope: sessionId => scopes.get(sessionId)?.facet,
      // Read-only, and no path to a scope, the secret or the issuer: what the
      // account behind this broker's credential has left.
      /** @param {string} [subscriptionId] */
      accountSource: subscriptionId => {
        if (accountSourceOf !== undefined) {
          return accountSourceOf(subscriptionId);
        }
        return subscriptionId === undefined ? accountSource : undefined;
      },
      // The provider's declared subscriptions, `[{ id, label, weight }]`, for
      // a picker and for status. Empty when this broker holds one credential
      // and has no set. Labels are the operator's; no credential, account
      // number or secret name is in it.
      subscriptions: async () =>
        listSubscriptions === undefined ? harden([]) : listSubscriptions(),
      /** @param {string} [subscriptionId] */
      modelCatalog: subscriptionId => {
        !stopped || Fail`Provider scope service is closed`;
        if (readModelCatalog === undefined) {
          throw Fail`Provider model discovery unavailable`;
        }
        const read = readModelCatalog;
        const operation = (async () => {
          await null;
          !stopped || Fail`Provider scope service is closed`;
          const catalog = await read(subscriptionId);
          !stopped || Fail`Provider scope service is closed`;
          return catalog;
        })();
        modelReads.add(operation);
        return operation.finally(() => modelReads.delete(operation));
      },
      // An operator's: the one call that spends a banked rate-limit reset of
      // the account behind this broker, or of one of its subscriptions.
      // Undefined where the provider has no such thing. A session scope does
      // not offer it, and neither does a grant.
      /** @param {string} [subscriptionId] */
      resetRedeemer: subscriptionId => {
        if (resetRedeemerOf !== undefined) {
          return resetRedeemerOf(subscriptionId);
        }
        return subscriptionId === undefined ? resetRedeemer : undefined;
      },
      // An operator's too, and the widest thing here: inference against the
      // broker's credential with no sandbox, no listener and no meter. Setup
      // holds it as a formula of its own, and only a share's namespace is
      // given that; what is handed to anybody else is the share.
      subscription: () => subscription,
    },
  );
  return harden({ service, close });
};
harden(makeProviderScopes);
