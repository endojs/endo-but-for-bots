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
 * `refresh` and `rotate` are the OAuth half, required together by
 * `authMode: 'oauth'` and unused by an API key. `refresh` is deliberately not
 * the inference transport: a token endpoint is neither the provider origin nor
 * one of the three inference paths the lease admits, so a refresh that could
 * travel through the lease would mean the lease admitted something else.
 *
 * @param {object} options
 * @param {any} options.runtime Concrete provider listener runtime.
 * @param {any} options.secret SecretBlob read facet.
 * @param {typeof globalThis.fetch} options.fetch Explicit outbound authority.
 * @param {Omit<BrokerPolicy,'expiresAt'>} options.policy
 * @param {number} options.leaseDurationMs
 * @param {string} options.imageDigest Target Codex image, not listener image.
 * @param {string} options.accountRef
 * @param {() => number} [options.now]
 * @param {(event: any) => void} [options.audit]
 * @param {any} [options.refresh] Token exchange on its own outbound authority.
 * @param {any} [options.rotate] Rotate-only secret capability.
 */
export const makeProviderBrokerLeaseIssuer = ({
  runtime,
  secret,
  fetch,
  policy,
  leaseDurationMs,
  imageDigest,
  accountRef,
  now = Date.now,
  audit,
  refresh,
  rotate,
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
  // The issuer's selected account is the binding, so an operator policy may
  // agree with it but never name a different one. The broker then refuses any
  // credential — including a refreshed one — that belongs elsewhere.
  policy.accountRef === undefined ||
    policy.accountRef === accountRef ||
    Fail`Invalid provider lease issuer policy`;
  const authMode = policy.authMode ?? 'api-key';
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
    const expiresAt = now() + leaseDurationMs;
    const leaseId = `lease-${randomUUID()}`;
    const transport = makeProviderFetchTransport({
      fetch,
      timeoutMs: Math.min(leaseDurationMs, 120_000),
      maxRequestBytes: configuredPolicy.maxRequestBytes,
      maxResponseBytes: configuredPolicy.maxResponseBytes,
    });
    const core = makeProviderBrokerLease(
      { ...configuredPolicy, expiresAt },
      {
        secret,
        transport: transport.transport,
        now,
        audit,
        refresh,
        rotate,
      },
    );
    let worker;
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
      worker = await runtime.start({
        endpoint: core.endpoint,
        limits: harden({
          maxConnections: 4,
          maxRequestBytes: configuredPolicy.maxRequestBytes,
          maxResponseBytes: configuredPolicy.maxResponseBytes,
          timeoutMs: Math.min(leaseDurationMs, 120_000),
        }),
      });
      const initial = await worker.observe();
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
            current.listenerImageDigest === initial.listenerImageDigest) ||
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
              // Proved by construction, not declared: the broker core refuses
              // to exist in `oauth` mode without a refresh and a rotate
              // capability, so a lease that reports one has both.
              authMode,
              networkNamespaceId: current.networkNamespaceId,
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
