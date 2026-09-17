// @ts-check

import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { randomUUID } from 'node:crypto';

import { makeProviderBrokerGrant } from './provider-broker.js';
import { makeProviderFetchTransport } from './provider-transport.js';

/** @import { BrokerPolicy } from './provider-broker.js' */

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
 * @param {any} [options.credential] The record's shared refreshing credential,
 * from `makeBrokerOAuthCredential`. One per secret record, shared by every
 * issuer and grant over it.
 * @param {(spec:any)=>{endpoint:any,dispose:()=>void}} [options.makePublicNetwork]
 * Host-only factory for a separately revocable public-egress capability.
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
  credential,
  makePublicNetwork,
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
  if (authMode === 'oauth' || authMode === 'subscription') {
    credential !== undefined || Fail`Invalid provider grant issuer policy`;
    credential.accountRef === accountRef ||
      Fail`Invalid provider grant issuer policy`;
    typeof credential.current === 'function' ||
      Fail`Unprovisioned broker OAuth mode`;
  }
  const configuredPolicy = harden({
    ...policy,
    accountRef,
    routes: policy.routes.map(route => ({ ...route })),
    models: [...policy.models],
  });
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
    });
    const grantId = `grant-${randomUUID()}`;
    let transport;
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
        (!spec.model || configuredPolicy.models.includes(spec.model))) ||
        Fail`Provider grant request denied`;
      spec.networkPolicy === 'off' ||
        (spec.networkPolicy === 'public-internet' && makePublicNetwork) ||
        Fail`Unsupported provider grant network policy`;
      admitted = true;
      grants.add(revoke);
      fences.add(fence);
      const timeoutMs = requestTimeoutMs;
      transport = makeProviderFetchTransport({
        fetch,
        timeoutMs,
        maxRequestBytes: configuredPolicy.maxRequestBytes,
        maxResponseBytes: configuredPolicy.maxResponseBytes,
        onDiagnostic,
      });
      core = makeProviderBrokerGrant(configuredPolicy, {
        secret,
        transport: transport.transport,
        audit,
        credential,
      });
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
              modelAllowlist: [...configuredPolicy.models],
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
