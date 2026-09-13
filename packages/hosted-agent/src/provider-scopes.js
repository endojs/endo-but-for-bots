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
 */

/**
 * @typedef {object} ScopedProviderIssuer
 * @property {(spec: ProviderScopeSpec & {sessionId: string}) => {value: Promise<any>, revoke(): Promise<void>}} issueKit
 */

const SpecShape = M.splitRecord(
  { providerOrigin: M.string(), accountRef: M.string() },
  { model: M.string(), networkPolicy: M.or('off', 'public-internet') },
  harden({}),
);

const ScopeInterface = M.interface('ProviderScope', {
  start: M.call().returns(M.promise()),
  attestation: M.call().returns(M.promise()),
  sandboxEvidence: M.call().returns(M.promise()),
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
 */
export const makeProviderScopes = ({ openIssuer }) => {
  /** @type {Map<string, {spec: ProviderScopeSpec, facet: any, revoke(): Promise<void>}>} */
  const scopes = new Map();
  /** @type {Promise<ScopedProviderIssuer> | undefined} */
  let opening;
  /** @type {Promise<void> | undefined} */
  let closing;
  let stopped = false;

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
    });
    const prior = scopes.get(sessionId);
    if (prior) {
      (prior.spec.providerOrigin === spec.providerOrigin &&
        prior.spec.accountRef === spec.accountRef &&
        prior.spec.model === spec.model &&
        prior.spec.networkPolicy === spec.networkPolicy) ||
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
      const results = await Promise.allSettled(releases);
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
    }),
    {
      provideScope,
      lookupScope: sessionId => scopes.get(sessionId)?.facet,
    },
  );
  return harden({ service, close });
};
harden(makeProviderScopes);
