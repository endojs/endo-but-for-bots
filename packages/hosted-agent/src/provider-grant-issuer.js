// @ts-check

import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { randomUUID } from 'node:crypto';

import { makeProviderBrokerGrant } from './provider-broker.js';
import { makeProviderFetchTransport } from './provider-transport.js';
import { InferenceEndpointInterface } from './subscription-share.js';

/**
 * How many subscriptions a request may already have passed through when it
 * arrives here. `subscription-share.js` refuses one hop sooner; this is the
 * innermost subscription's own check, for whatever reaches it.
 */
const MAX_ENDPOINT_HOPS = 4;

/** How long a far subscription gets to open an endpoint for one session. */
const WRAPPED_OPEN_DEADLINE_MS = 15_000;

/**
 * A promise that loses to a deadline. What arrives after the deadline is
 * handed to `late`, so that an endpoint opened too late is given back.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {(value: T) => void} [late]
 * @returns {Promise<T>}
 */
export const withDeadline = (promise, ms, late = () => {}) =>
  new Promise((resolve, reject) => {
    let over = false;
    const timer = globalThis.setTimeout(() => {
      over = true;
      reject(Error('Provider subscription unavailable'));
    }, ms);
    /** @type {any} */ (timer).unref?.();
    promise.then(
      value => {
        globalThis.clearTimeout(timer);
        if (over) late(value);
        else resolve(value);
      },
      error => {
        globalThis.clearTimeout(timer);
        if (!over) reject(error);
      },
    );
  });
harden(withDeadline);

/** @import { BrokerPolicy, ProviderRequestAdapter } from './provider-broker.js' */
/** @import { makePoolMemberLifecycle } from './pool-member-lifecycle.js' */
/** @import { BrokerGrantMember } from './provider-broker.js' */

/**
 * @typedef {object} IssuerPoolMember
 * @property {string} id
 * @property {any} [subscription] In place of `secret`: this member is
 *   somebody else's `Subscription` (a share they handed over). Each grant
 *   opens an endpoint of its own on it, and revokes it with the grant.
 * @property {any} [secret] SecretBlob read facet.
 * @property {any} [credential] The member's shared refreshing credential.
 * @property {ReturnType<typeof makePoolMemberLifecycle>} [lifecycle]
 * @property {ProviderRequestAdapter} [adaptRequest]
 * @property {string} [accountRef]
 * @property {(reading: any) => void} [onReading] What this member's responses
 *   say of its account.
 * @property {(model: string) => Promise<boolean> | boolean} admits Whether
 *   this member's account lists the model now, from its catalog owner.
 * @property {() => string} [catalogState] How that catalog stands, for the
 *   grant's audit trail.
 * @property {boolean} [pinnedOnly] Served only to a session pinned to it.
 */

/**
 * @typedef {object} IssuerPool
 * @property {() => Promise<readonly IssuerPoolMember[]> | readonly IssuerPoolMember[]} members
 * @property {(sessionId: string, preference: string) => { select(): string[], served(id: string): void, exhausted(id: string): void }} forSession
 */

/**
 * Host-side credential assembly. The worker receives only the bounded inference
 * facet over its private pipe. Secrets and outbound fetch stay in this process.
 * The runtime must be operator-owned, with an exclusively held lifecycle lock.
 *
 * `credential` is the OAuth half, required by `authMode: 'oauth'` and unused by
 * an API key. It is supplied rather than built here because exactly one must
 * exist per secret record: an issuer that made its own would give two issuers
 * over one record separate refresh guards, and both would redeem the same
 * refresh token. Its refresh authority is deliberately not the inference
 * transport — a token endpoint is neither the provider origin nor one of the
 * three inference paths the grant admits, so a refresh that could travel
 * through the grant would mean the grant admitted something else.
 *
 * @param {object} options
 * @param {any} options.runtime Concrete provider listener runtime.
 * @param {any} options.secret SecretBlob read facet.
 * @param {typeof globalThis.fetch} options.fetch Explicit outbound authority.
 * @param {BrokerPolicy} options.policy
 * @param {number} [options.requestTimeoutMs] Host-only request deadline, independent of grant lifetime.
 * @param {string} options.imageDigest Target Codex image, not listener image.
 * @param {string} options.accountRef
 * @param {(event: any) => void} [options.audit]
 * @param {Parameters<typeof makeProviderFetchTransport>[0]['onDiagnostic']} [options.onDiagnostic]
 * @param {Parameters<typeof makeProviderFetchTransport>[0]['onReading']} [options.onReading]
 *   Host-only observer of each response's account reading.
 * @param {any} [options.credential] The record's shared refreshing credential,
 * from `makeBrokerOAuthCredential`. One per secret record, shared by every
 * issuer and grant over it.
 * @param {ProviderRequestAdapter} [options.adaptRequest] Trusted provider translation.
 * @param {(model: string) => Promise<boolean> | boolean} [options.admits]
 * Whether the one account lists a model now, from its catalog owner
 * (`model-catalog.js`); required without a pool, whose members each carry
 * their own. A scope that names a model is admitted only if an account it
 * may be served from lists it, and every request is admitted the same way
 * by the grant. There is no operator model allowlist.
 * @param {() => string} [options.catalogState] How that account's catalog
 * stands, for the grant's audit trail.
 * @param {(spec:any)=>{endpoint:any,dispose:()=>void}} [options.makePublicNetwork]
 * Host-only factory for a separately revocable public-egress capability.
 * @param {IssuerPool} [options.pool] Several subscriptions of this provider,
 * in place of `secret`, `credential`, `adaptRequest` and `onReading`, which
 * describe one. Every grant then serves each request from the member the
 * pool selects for that grant's session, and hands a request a drained
 * member refuses to the next (`makeProviderBrokerGrant`). A grant takes the
 * set as it is when the grant is issued; a member added later is seen by the
 * sessions opened after it.
 * @param {number} [options.wrappedOpenDeadlineMs] How long a member that is
 * somebody else's subscription gets to open an endpoint for a session.
 */
export const makeProviderBrokerGrantIssuer = ({
  runtime,
  secret,
  fetch,
  policy,
  requestTimeoutMs = 120_000,
  imageDigest,
  accountRef,
  audit,
  onDiagnostic,
  onReading,
  credential,
  adaptRequest,
  admits,
  catalogState,
  makePublicNetwork,
  pool,
  wrappedOpenDeadlineMs = WRAPPED_OPEN_DEADLINE_MS,
}) => {
  (/^sha256:[a-f0-9]{64}$/.test(imageDigest) &&
    typeof accountRef === 'string' &&
    accountRef.length > 0 &&
    accountRef.length <= 256) ||
    Fail`Invalid provider grant issuer policy`;
  (Number.isInteger(requestTimeoutMs) &&
    requestTimeoutMs > 0 &&
    requestTimeoutMs <= 600_000) ||
    Fail`Invalid provider request deadline`;
  // The issuer's selected account is the binding, so an operator policy may
  // agree with it but never name a different one. The broker then refuses any
  // credential — including a refreshed one — that belongs elsewhere.
  policy.accountRef === undefined ||
    policy.accountRef === accountRef ||
    Fail`Invalid provider grant issuer policy`;
  const authMode = policy.authMode ?? 'api-key';
  // The credential arrives already built and already bound to an account, so
  // this checks that it is one this issuer's grants can actually use: bound to
  // the selected account, and able to refresh. Without the second half an
  // object that cannot refresh is admitted here, reports `authMode: 'oauth'`
  // in its attestation, and only fails on the first turn.
  // A pool's members are checked one by one when a grant is made over them.
  if (authMode === 'oauth' && pool === undefined) {
    credential !== undefined || Fail`Invalid provider grant issuer policy`;
    credential.accountRef === accountRef ||
      Fail`Invalid provider grant issuer policy`;
    typeof credential.current === 'function' ||
      Fail`Unprovisioned broker OAuth mode`;
  }
  pool !== undefined ||
    typeof admits === 'function' ||
    Fail`Invalid provider grant issuer policy`;
  /** @type {any} */ (policy).models === undefined ||
    Fail`Invalid provider grant issuer policy`;
  const configuredPolicy = harden({
    ...policy,
    accountRef,
    routes: policy.routes.map(route => ({ ...route })),
  });
  /**
   * Whether a session pinned to a model may be issued a scope: some account
   * it may be served from lists the model now. `auto` asks the accounts not
   * set aside; an id asks that one and no other.
   *
   * @param {string} model
   * @param {string} subscription
   */
  const admitsModel = async (model, subscription) => {
    if (pool === undefined) {
      return (
        (await /** @type {NonNullable<typeof admits>} */ (admits)(model)) ===
        true
      );
    }
    const declared = [...(await pool.members())];
    const eligible = declared.filter(member =>
      subscription === 'auto'
        ? member.pinnedOnly !== true
        : member.id === subscription,
    );
    // Asked of all at once: this runs inside the issuer's queue, and a
    // provider's catalog endpoint timing out must cost one wait, not one
    // per account.
    const answers = await Promise.all(
      eligible.map(async member => {
        try {
          return (await member.admits(model)) === true;
        } catch (_error) {
          // An account that cannot answer does not admit.
          return false;
        }
      }),
    );
    return answers.some(Boolean);
  };
  const grants = new Set();
  const fences = new Set();
  const pending = new Set();
  let queue = Promise.resolve();
  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const serialize = operation => {
    const result = queue.then(operation);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  let disposed = false;
  /**
   * The credential-bearing core of one grant or endpoint: the broker grant
   * over this issuer's one credential, or over a transport per member of its
   * pool. No listener: who serves it to a harness is the caller's business.
   *
   * @param {{ sessionId: string, subscription: string }} spec
   * @param {boolean} revealExhaustion
   */
  const makeCore = (spec, revealExhaustion) => {
    const timeoutMs = requestTimeoutMs;
    if (pool === undefined) {
      // Synchronously: a grant over one credential starts its listener in
      // the turn it was admitted in, as it always has.
      const transport = makeProviderFetchTransport({
        fetch,
        timeoutMs,
        maxRequestBytes: configuredPolicy.maxRequestBytes,
        maxResponseBytes: configuredPolicy.maxResponseBytes,
        onDiagnostic,
        onReading,
      });
      const core = makeProviderBrokerGrant(configuredPolicy, {
        secret,
        transport: transport.transport,
        audit,
        credential,
        adaptRequest,
        admits,
        ...(catalogState === undefined ? {} : { catalogState }),
        revealExhaustion,
      });
      return { core, transport, memberTransports: [] };
    }
    return makePoolCore(pool, spec, revealExhaustion);
  };
  /**
   * @param {IssuerPool} memberPool
   * @param {{ sessionId: string, subscription: string, hops?: number }} spec
   * @param {boolean} revealExhaustion
   */
  const makePoolCore = async (memberPool, spec, revealExhaustion) => {
    const timeoutMs = requestTimeoutMs;
    // A transport per member, so that what a response says of the account is
    // read as that member's, whichever of them served a request while
    // another is mid-stream.
    /** @type {Array<{ dispose(): void }>} */
    const memberTransports = [];
    const declared = [...(await memberPool.members())];
    /** @param {IssuerPoolMember} member
     * @returns {BrokerGrantMember[]} */
    const makeMember = member => {
      const { lifecycle } = member;
      lifecycle?.check();
      if (
        member.subscription !== undefined &&
        (spec.hops ?? 0) + 2 > MAX_ENDPOINT_HOPS
      ) {
        // The far side would refuse to open one hop further. That is about
        // how far this request has come, which its caller chose, and not
        // about the member: it is left out of this core, and the pool is not
        // told it cannot serve.
        return [];
      }
      if (member.subscription !== undefined) {
        // Somebody else's subscription. Its endpoint for this session is
        // opened on first use, one hop further from the provider, and never
        // while this issuer's queue is held: what is beneath it may be a
        // pool that holds a share of this one, whose issuer would then wait
        // for the very queue that is waiting for it. Opening has a deadline,
        // so a far daemon that hangs costs a request a pause and not the
        // session its grant.
        /** @type {Promise<any> | undefined} */
        let opening;
        /** @type {any} */
        let current;
        // Endpoints that stopped working, kept until the grant ends: another
        // request of this session may still be streaming from one. Bounded;
        // past that the oldest is given back.
        /** @type {any[]} */
        const retired = [];
        const held = new Set();
        const rawOpenings = new Set();
        let gone = false;
        /** @param {any} endpoint */
        const giveBack = endpoint => {
          held.add(endpoint);
          void E(endpoint)
            .revoke()
            .then(() => held.delete(endpoint))
            .catch(() => {});
        };
        const provide = () => {
          lifecycle?.check();
          !gone || Fail`Provider grant inactive`;
          if (opening === undefined) {
            const open = () => {
              const acquisition = E(member.subscription)
                .openEndpoint(
                  harden({
                    sessionId: spec.sessionId,
                    subscription: 'auto',
                    hops: (spec.hops ?? 0) + 1,
                  }),
                )
                .then(raw => {
                  const endpoint =
                    lifecycle === undefined
                      ? raw
                      : makeExo(
                          'PoolMemberEndpoint',
                          InferenceEndpointInterface,
                          {
                            request: message =>
                              lifecycle.run(
                                () => E(raw).request(message),
                                true,
                              ),
                            requestByteStream: message =>
                              lifecycle.run(
                                () => E(raw).requestByteStream(message),
                                true,
                              ),
                            attestation: () =>
                              lifecycle.run(() => E(raw).attestation()),
                            revoke: () => E(raw).revoke(),
                          },
                        );
                  held.add(endpoint);
                  return endpoint;
                });
              rawOpenings.add(acquisition);
              return acquisition.finally(() => rawOpenings.delete(acquisition));
            };
            const attempt = withDeadline(
              lifecycle === undefined ? open() : lifecycle.run(open, true),
              wrappedOpenDeadlineMs,
              giveBack,
            ).then(endpoint => {
              if (gone) {
                giveBack(endpoint);
                throw Fail`Provider grant inactive`;
              }
              current = endpoint;
              return endpoint;
            });
            opening = attempt;
            // One that could not be opened is tried again by the next
            // request, not remembered.
            attempt.catch(() => {
              if (opening === attempt) opening = undefined;
            });
          }
          return opening;
        };
        /** @param {any} endpoint */
        const reset = endpoint => {
          // Only the one named: two requests that both found it dead must
          // not each forget the endpoint the other has just opened.
          if (current !== endpoint) return;
          current = undefined;
          opening = undefined;
          retired.push(endpoint);
          while (retired.length > 8) giveBack(retired.shift());
        };
        const dependent = {
          dispose: () => {
            gone = true;
            const last = opening;
            opening = undefined;
            current = undefined;
            if (last !== undefined) void last.then(giveBack, () => {});
            for (const endpoint of retired.splice(0)) giveBack(endpoint);
          },
        };
        const cleanup = async () => {
          dependent.dispose();
          // The owner also drains admitted late openings before acknowledgement.
          // A late result is returned by giveBack, retained here on failure.
          await Promise.allSettled([...rawOpenings]);
          for (const endpoint of held) {
            // eslint-disable-next-line no-await-in-loop
            await E(endpoint).revoke();
            held.delete(endpoint);
          }
        };
        const release = lifecycle?.retain(cleanup);
        memberTransports.push({
          dispose: () => {
            dependent.dispose();
            void cleanup().then(
              () => {
                release?.();
              },
              () => {},
            );
          },
        });
        return [
          harden({
            id: member.id,
            admits: member.admits,
            ...(member.catalogState === undefined
              ? {}
              : { catalogState: member.catalogState }),
            wrapped: { provide, reset },
          }),
        ];
      }
      const memberTransport = makeProviderFetchTransport({
        fetch:
          lifecycle === undefined
            ? fetch
            : (input, init) => lifecycle.run(() => fetch(input, init), true),
        timeoutMs,
        maxRequestBytes: configuredPolicy.maxRequestBytes,
        maxResponseBytes: configuredPolicy.maxResponseBytes,
        onDiagnostic,
        onReading: member.onReading,
      });
      const release = lifecycle?.retain(() => memberTransport.close());
      const dispose = () => {
        memberTransport.dispose();
        void memberTransport.close().then(
          () => {
            release?.();
          },
          () => {},
        );
      };
      memberTransports.push({ dispose });
      return [
        harden({
          id: member.id,
          admits: member.admits,
          ...(member.catalogState === undefined
            ? {}
            : { catalogState: member.catalogState }),
          secret: member.secret,
          transport: memberTransport.transport,
          ...(member.credential === undefined
            ? {}
            : { credential: member.credential }),
          ...(member.adaptRequest === undefined
            ? {}
            : { adaptRequest: member.adaptRequest }),
          ...(member.accountRef === undefined
            ? {}
            : { accountRef: member.accountRef }),
        }),
      ];
    };
    const members = declared.flatMap(makeMember);
    try {
      const core = makeProviderBrokerGrant(configuredPolicy, {
        audit,
        revealExhaustion,
        pool: harden({
          members,
          ...memberPool.forSession(spec.sessionId, spec.subscription),
        }),
      });
      return { core, transport: undefined, memberTransports };
    } catch (error) {
      for (const memberTransport of memberTransports) memberTransport.dispose();
      throw error;
    }
  };

  /**
   * An inference endpoint for one session, with no listener and no sandbox:
   * what a `Subscription` hands out (`subscription-share.js`). The caller
   * serves it to a harness, or wraps it. It is the same credential-bearing
   * core a grant has, so the route allowlist, the model allowlist, the byte
   * bounds, the echo screen and the pool's selection all apply.
   *
   * @param {any} requested `{ sessionId, subscription?, hops? }`
   */
  const openEndpoint = requested =>
    serialize(async () => {
      const spec = harden({
        sessionId: requested?.sessionId,
        subscription:
          requested?.subscription === undefined
            ? 'auto'
            : requested.subscription,
        hops: requested?.hops === undefined ? 0 : requested.hops,
      });
      (!disposed &&
        typeof spec.sessionId === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(spec.sessionId) &&
        typeof spec.subscription === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(spec.subscription) &&
        (pool !== undefined || spec.subscription === 'auto') &&
        Number.isSafeInteger(spec.hops) &&
        Number(spec.hops) >= 0 &&
        Number(spec.hops) <= MAX_ENDPOINT_HOPS) ||
        Fail`Provider endpoint request denied`;
      const made = await makeCore(spec, true);
      let revoked = false;
      const fence = async () => {
        revoked = true;
        made.transport?.dispose();
        for (const memberTransport of made.memberTransports) {
          memberTransport.dispose();
        }
        await E(made.core.admin).revoke();
      };
      const revoke = async () => {
        if (!revoked) await fence();
        grants.delete(revoke);
        fences.delete(fence);
      };
      if (disposed) {
        await fence();
        throw Fail`Provider endpoint request denied`;
      }
      grants.add(revoke);
      fences.add(fence);
      const live = () => {
        (!revoked && !disposed) || Fail`Inference endpoint revoked`;
      };
      return makeExo('InferenceEndpoint', InferenceEndpointInterface, {
        /** @param {any} message */
        async request(message) {
          live();
          return made.core.endpoint.request(message);
        },
        /** @param {any} message */
        async requestByteStream(message) {
          live();
          return made.core.endpoint.requestByteStream(message);
        },
        async attestation() {
          live();
          // No operator allowlist to attest: each request is admitted by
          // the serving account's own catalog.
          return harden({
            version: 'InferenceEndpointV1',
            sessionId: spec.sessionId,
            providerOrigin: configuredPolicy.origin,
            models: null,
            modelAdmission: 'account-catalog',
            subscription: spec.subscription,
            hops: spec.hops,
          });
        },
        revoke,
      });
    });

  /**
   * Retain one grant's cleanup before queued issuance. This is the same issuer,
   * account policy, runtime and admission queue as callable promise issuance.
   * A rejected value does not release its listener; revoke() remains scoped to
   * this grant and retries its original listener acquisition owner.
   * @param {any} requested
   */
  const issueKit = requested => {
    const spec = harden({
      sessionId: requested.sessionId,
      providerOrigin: requested.providerOrigin,
      accountRef: requested.accountRef,
      model: requested.model,
      networkPolicy:
        requested.networkPolicy === undefined ? 'off' : requested.networkPolicy,
      // Which subscription this session uses: `auto`, or one by id.
      subscription:
        requested.subscription === undefined ? 'auto' : requested.subscription,
    });
    const grantId = `grant-${randomUUID()}`;
    let transport;
    /** @type {Array<{ dispose(): void }>} */
    const memberTransports = [];
    let core;
    let worker;
    let workerKit;
    let network;
    let admitted = false;
    let inactive = false;
    let cleaned = false;
    /** @type {Promise<void> | undefined} */
    let cleanup;
    const checkLive = () => {
      (!inactive && !disposed) || Fail`Provider grant inactive`;
    };
    const fence = () => {
      inactive = true;
      transport?.dispose();
      for (const memberTransport of memberTransports) memberTransport.dispose();
      network?.dispose();
      return core ? E(core.admin).revoke() : Promise.resolve();
    };
    /** @returns {Promise<void>} */
    const revoke = () => {
      inactive = true;
      if (cleaned) return Promise.resolve();
      if (cleanup) return cleanup;
      if (admitted) pending.add(revoke);
      // Fence authority and reach a pending listener handshake immediately.
      // Both acknowledgements are retained even if the other stage fails.
      const revoking = (async () => {
        await fence();
      })();
      const stopping = (async () => {
        await workerKit?.stop();
      })();
      cleanup = (async () => {
        const results = await Promise.allSettled([
          revoking,
          stopping,
          acquisition.catch(() => {}),
        ]);
        const errors = results.flatMap(result =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (errors.length === 1) throw errors[0];
        if (errors.length)
          throw AggregateError(errors, 'Provider grant cleanup failed');
        grants.delete(revoke);
        fences.delete(fence);
        pending.delete(revoke);
        cleaned = true;
      })().catch(error => {
        cleanup = undefined;
        throw error;
      });
      return cleanup;
    };
    const acquisition = serialize(async () => {
      (!disposed &&
        !inactive &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(spec.sessionId) &&
        spec.providerOrigin === configuredPolicy.origin &&
        spec.accountRef === accountRef &&
        typeof spec.subscription === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(spec.subscription) &&
        (pool !== undefined || spec.subscription === 'auto') &&
        (spec.model === undefined ||
          (typeof spec.model === 'string' &&
            spec.model !== '' &&
            spec.model.length <= 256))) ||
        Fail`Provider grant request denied`;
      // The session's pinned model must be one an account it may be served
      // from lists now. Missing discovery is a refusal, not permission.
      spec.model === undefined ||
        (await admitsModel(spec.model, spec.subscription)) ||
        Fail`Provider grant request denied`;
      (!disposed && !inactive) || Fail`Provider grant request denied`;
      spec.networkPolicy === 'off' ||
        (spec.networkPolicy === 'public-internet' && makePublicNetwork) ||
        Fail`Unsupported provider grant network policy`;
      admitted = true;
      grants.add(revoke);
      fences.add(fence);
      const timeoutMs = requestTimeoutMs;
      const making = makeCore(spec, false);
      const made = making instanceof Promise ? await making : making;
      transport = made.transport;
      memberTransports.push(...made.memberTransports);
      core = made.core;
      if (inactive || disposed) {
        // Fenced while the core was being made: the fence saw none of this.
        made.transport?.dispose();
        for (const memberTransport of made.memberTransports) {
          memberTransport.dispose();
        }
      }
      checkLive();
      if (spec.networkPolicy === 'public-internet') {
        if (!makePublicNetwork) throw Fail`Public network factory unavailable`;
        network = makePublicNetwork(spec);
      }
      checkLive();
      workerKit = runtime.startKit({
        endpoint: core.endpoint,
        ...(network
          ? {
              network: { endpoint: network.endpoint },
            }
          : {}),
        limits: harden({
          diagnostics: Boolean(onDiagnostic),
          maxConnections: configuredPolicy.maxConcurrentRequests,
          maxRequestBytes: configuredPolicy.maxRequestBytes,
          maxResponseBytes: configuredPolicy.maxResponseBytes,
          timeoutMs,
          allowedPaths: [
            ...new Set(configuredPolicy.routes.map(route => route.path)),
          ],
          clientAuthorization: configuredPolicy.clientAuthorization ?? 'reject',
        }),
      });
      worker = await workerKit.value;
      checkLive();
      const initial = await worker.observe();
      (!!initial.network === !!network &&
        (!network || initial.network.policy === 'public-internet')) ||
        Fail`Provider listener network policy mismatch`;
      checkLive();
      void worker.closed.then(() => revoke()).catch(() => {});
      const observe = async () => {
        checkLive();
        try {
          const current = await worker.observe();
          (current.containerName === initial.containerName &&
            current.networkNamespaceId === initial.networkNamespaceId &&
            current.endpoint === initial.endpoint &&
            current.listenerImageDigest === initial.listenerImageDigest &&
            JSON.stringify(current.network) ===
              JSON.stringify(initial.network)) ||
            Fail`Provider listener identity changed`;
          checkLive();
          return current;
        } catch (error) {
          await revoke();
          throw error;
        }
      };
      const grant = makeExo(
        'ProviderGrant',
        M.interface('ProviderGrant', {
          attestation: M.call().returns(M.promise()),
          sandboxEvidence: M.call().returns(M.promise()),
          revoke: M.call().returns(M.promise()),
        }),
        {
          async attestation() {
            const current = await observe();
            return harden({
              version: 'ProviderGrantV1',
              sessionId: spec.sessionId,
              grantId,
              imageDigest,
              accountRef,
              // What this reports is how the grant was configured, checked
              // against a credential that was present and account-bound at
              // admission. It is not evidence about the stored secret, which
              // is first read on the first request, nor about how many other
              // holders share that record.
              authMode,
              networkNamespaceId: current.networkNamespaceId,
              ...(current.network ? { network: current.network } : {}),
              endpoint: current.endpoint,
              providerOrigin: configuredPolicy.origin,
              // The model this grant was issued for, admitted at issuance
              // against the accounts the session may be served from; null
              // for a session that pins none. Not what every request is
              // held to: each is admitted the same way by the serving
              // account's catalog, so a runtime's side requests on other
              // models the account lists (Claude Code's Haiku calls beside
              // a session on Opus) are served too.
              model: spec.model ?? null,
              modelAdmission: 'account-catalog',
            });
          },
          async sandboxEvidence() {
            const current = await observe();
            return harden({
              version: 'CodexBrokerSandboxEvidenceV1',
              sessionId: spec.sessionId,
              imageDigest,
              grantId,
              networkNamespaceId: current.networkNamespaceId,
              ...(current.network ? { network: current.network } : {}),
              brokerSidecar: { container: current.containerName },
              credentialInjection: 'broker-only',
              brokerTransport: 'loopback-sidecar',
            });
          },
          revoke,
        },
      );
      return grant;
    });
    const value = acquisition.catch(async error => {
      if (!admitted) throw error;
      await revoke().catch(cleanupError => {
        throw AggregateError(
          [error, cleanupError],
          'Provider grant admission and cleanup failed',
        );
      });
      throw AggregateError([error], 'Provider grant admission failed');
    });
    void value.catch(() => {});
    return harden({ value, fence, revoke });
  };
  const clean = async callbacks => {
    const results = await Promise.allSettled(
      [...callbacks].map(revoke => revoke()),
    );
    const errors = results.flatMap(result =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length)
      throw AggregateError(errors, 'Provider grant cleanup failed');
  };
  return harden(
    Object.assign(spec => issueKit(spec).value, {
      issueKit,
      openEndpoint,
      retryCleanup: () => serialize(() => clean(pending)),
      dispose: () => {
        disposed = true;
        // Withdrawal must not wait behind a listener still being acquired.
        // Cleanup stays serialized so it also reaps that late acquisition.
        for (const fence of fences) void fence().catch(() => {});
        return serialize(() => clean(grants));
      },
    }),
  );
};
harden(makeProviderBrokerGrantIssuer);
