// @ts-check

import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { randomUUID } from 'node:crypto';

import { makeProviderBrokerLease } from './provider-broker.js';
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
 * three inference paths the lease admits, so a refresh that could travel
 * through the lease would mean the lease admitted something else.
 *
 * @param {object} options
 * @param {any} options.runtime Concrete provider listener runtime.
 * @param {any} options.secret SecretBlob read facet.
 * @param {typeof globalThis.fetch} options.fetch Explicit outbound authority.
 * @param {Omit<BrokerPolicy,'expiresAt'>} options.policy
 * @param {number} options.leaseDurationMs
 * @param {number} [options.requestTimeoutMs] Host-only request deadline, at most ten minutes; lease expiry remains authoritative.
 * @param {string} options.imageDigest Target Codex image, not listener image.
 * @param {string} options.accountRef
 * @param {() => number} [options.now]
 * @param {(event: any) => void} [options.audit]
 * @param {Parameters<typeof makeProviderFetchTransport>[0]['onDiagnostic']} [options.onDiagnostic]
 * @param {any} [options.credential] The record's shared refreshing credential,
 * from `makeBrokerOAuthCredential`. One per secret record, shared by every
 * issuer and lease over it.
 * @param {(spec:any)=>{endpoint:any,address:string,dispose:()=>void}} [options.makePublicNetwork]
 * Host-only factory for a separately revocable public-egress capability.
 */
export const makeProviderBrokerLeaseIssuer = ({
  runtime,
  secret,
  fetch,
  policy,
  leaseDurationMs,
  requestTimeoutMs = 120_000,
  imageDigest,
  accountRef,
  now = Date.now,
  audit,
  onDiagnostic,
  credential,
  makePublicNetwork,
}) => {
  (Number.isInteger(leaseDurationMs) &&
    leaseDurationMs > 0 &&
    leaseDurationMs <= 0x7fff_ffff &&
    /^sha256:[a-f0-9]{64}$/.test(imageDigest) &&
    typeof accountRef === 'string' &&
    accountRef.length > 0 &&
    accountRef.length <= 256 &&
    policy.maxRequests > 0n &&
    policy.maxRequests <= 0xffff_ffffn) ||
    Fail`Invalid provider lease issuer policy`;
  (Number.isInteger(requestTimeoutMs) &&
    requestTimeoutMs > 0 &&
    requestTimeoutMs <= 600_000) ||
    Fail`Invalid provider request deadline`;
  // The issuer's selected account is the binding, so an operator policy may
  // agree with it but never name a different one. The broker then refuses any
  // credential — including a refreshed one — that belongs elsewhere.
  policy.accountRef === undefined ||
    policy.accountRef === accountRef ||
    Fail`Invalid provider lease issuer policy`;
  const authMode = policy.authMode ?? 'api-key';
  // The credential arrives already built and already bound to an account, so
  // this checks that it is one this issuer's leases can actually use: bound to
  // the selected account, and able to refresh. Without the second half an
  // object that cannot refresh is admitted here, reports `authMode: 'oauth'`
  // in its attestation, and only fails on the first turn.
  if (authMode === 'oauth' || authMode === 'subscription') {
    credential !== undefined || Fail`Invalid provider lease issuer policy`;
    credential.accountRef === accountRef ||
      Fail`Invalid provider lease issuer policy`;
    typeof credential.current === 'function' ||
      Fail`Unprovisioned broker OAuth mode`;
  }
  // BrokerLeaseV1 carries the bounded request count as a number; its profile
  // explicitly caps it at 32 bits. Byte and cost counters retain bigint.
  const configuredPolicy = harden({
    ...policy,
    accountRef,
    routes: policy.routes.map(route => ({ ...route })),
    models: [...policy.models],
  });
  const leases = new Set();
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
  /** @param {any} spec */
  const issue = async spec => {
    (!disposed &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(spec.sessionId) &&
      spec.providerOrigin === configuredPolicy.origin &&
      spec.accountRef === accountRef &&
      (!spec.model || configuredPolicy.models.includes(spec.model))) ||
      Fail`Provider lease request denied`;
    spec.networkPolicy === 'off' ||
      (spec.networkPolicy === 'public-internet' && makePublicNetwork) ||
      Fail`Unsupported provider lease network policy`;
    const expiresAt = now() + leaseDurationMs;
    const leaseId = `lease-${randomUUID()}`;
    // Both sides of the private pipe use the same host-selected ceiling.
    // The lease's independent expiry timer also revokes requests started late.
    const timeoutMs = Math.min(requestTimeoutMs, expiresAt - now());
    (Number.isInteger(timeoutMs) && timeoutMs > 0) ||
      Fail`Provider lease expired before admission`;
    const transport = makeProviderFetchTransport({
      fetch,
      timeoutMs,
      maxRequestBytes: configuredPolicy.maxRequestBytes,
      maxResponseBytes: configuredPolicy.maxResponseBytes,
      onDiagnostic,
    });
    const core = makeProviderBrokerLease(
      { ...configuredPolicy, expiresAt },
      {
        secret,
        transport: transport.transport,
        now,
        audit,
        credential,
      },
    );
    let worker;
    let network;
    let inactive = false;
    let cleaned = false;
    let cleanup;
    let timer;
    const checkLive = () => {
      (!inactive && !disposed && now() < expiresAt) ||
        Fail`Provider lease inactive`;
    };
    const revoke = () => {
      if (cleaned) return Promise.resolve();
      inactive = true;
      pending.add(revoke);
      globalThis.clearTimeout(timer);
      transport.dispose();
      network?.dispose();
      const revoking = E(core.admin).revoke();
      if (!cleanup) {
        cleanup = (async () => {
          await revoking;
          if (worker) await worker.stop();
          leases.delete(revoke);
          pending.delete(revoke);
          cleaned = true;
        })().catch(error => {
          cleanup = undefined;
          throw error;
        });
      }
      return cleanup;
    };
    leases.add(revoke);
    try {
      if (spec.networkPolicy === 'public-internet') {
        if (!makePublicNetwork) throw Fail`Public network factory unavailable`;
        network = makePublicNetwork(spec);
      }
      worker = await runtime.start({
        endpoint: core.endpoint,
        ...(network
          ? {
              network: { endpoint: network.endpoint, address: network.address },
            }
          : {}),
        limits: harden({
          diagnostics: Boolean(onDiagnostic),
          maxConnections: 4,
          maxRequestBytes: configuredPolicy.maxRequestBytes,
          maxResponseBytes: configuredPolicy.maxResponseBytes,
          timeoutMs,
          allowedPaths: [
            ...new Set(configuredPolicy.routes.map(route => route.path)),
          ],
          clientAuthorization: configuredPolicy.clientAuthorization ?? 'reject',
        }),
      });
      const initial = await worker.observe();
      (!!initial.network === !!network &&
        (!network || initial.network.policy === 'public-internet')) ||
        Fail`Provider listener network policy mismatch`;
      checkLive();
      timer = globalThis.setTimeout(
        () => {
          void revoke().catch(() => {});
        },
        Math.max(1, expiresAt - now()),
      );
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
      const lease = makeExo(
        'ProviderLease',
        M.interface('ProviderLease', {
          attestation: M.call().returns(M.promise()),
          sandboxEvidence: M.call().returns(M.promise()),
          revoke: M.call().returns(M.promise()),
        }),
        {
          async attestation() {
            const current = await observe();
            return harden({
              version: 'BrokerLeaseV1',
              sessionId: spec.sessionId,
              leaseId,
              imageDigest,
              accountRef,
              // What this reports is how the lease was configured, checked
              // against a credential that was present and account-bound at
              // admission. It is not evidence about the stored secret, which
              // is first read on the first request, nor about how many other
              // holders share that record.
              authMode,
              networkNamespaceId: current.networkNamespaceId,
              ...(current.network ? { network: current.network } : {}),
              endpoint: current.endpoint,
              providerOrigin: configuredPolicy.origin,
              expiresAt: new Date(expiresAt).toISOString(),
              modelAllowlist: [...configuredPolicy.models],
              limits: {
                requests: Number(configuredPolicy.maxRequests),
                bytes: configuredPolicy.maxTotalBytes,
                costMicrounits: configuredPolicy.maxCostMicrounits,
              },
            });
          },
          async sandboxEvidence() {
            const current = await observe();
            return harden({
              version: 'CodexBrokerSandboxEvidenceV1',
              sessionId: spec.sessionId,
              imageDigest,
              leaseId,
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
      return lease;
    } catch (error) {
      await revoke().catch(cleanupError => {
        throw AggregateError(
          [error, cleanupError],
          'Provider lease admission and cleanup failed',
        );
      });
      throw AggregateError([error], 'Provider lease admission failed');
    }
  };
  const clean = async callbacks => {
    const results = await Promise.allSettled(
      [...callbacks].map(revoke => revoke()),
    );
    const errors = results.flatMap(result =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length)
      throw AggregateError(errors, 'Provider lease cleanup failed');
  };
  return harden(
    Object.assign(
      spec => {
        const request = harden({
          sessionId: spec.sessionId,
          providerOrigin: spec.providerOrigin,
          accountRef: spec.accountRef,
          model: spec.model,
          networkPolicy:
            spec.networkPolicy === undefined ? 'off' : spec.networkPolicy,
        });
        return serialize(() => issue(request));
      },
      {
        retryCleanup: () => serialize(() => clean(pending)),
        dispose: () => {
          disposed = true;
          return serialize(() => clean(leases));
        },
      },
    ),
  );
};
harden(makeProviderBrokerLeaseIssuer);
