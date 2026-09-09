// @ts-check

import { join } from 'node:path';

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeProviderBrokerLeaseIssuer } from '@endo/hosted-agent/provider-lease-issuer.js';
import { makePodmanProviderListenerRuntime } from '@endo/hosted-agent/provider-listener-runtime.js';
import { makeSecretRotator } from '@endo/hosted-agent/secret-rotator.js';
import { make as makeSandbox } from '@endo/sandbox';

import { startAppServerTransport } from './app-server-transport.js';
import { makeCodexBackendFactory } from './backend-factory.js';
import { makeHostVolumeProvider } from './host-volume-provider.js';
import { whenHostStops } from './host-lifecycle.js';
import { makeAttestedCodexResourceProvisioner } from './sandbox-policy.js';
import { makeCodexSubscriptionCredential } from './subscription-auth.js';

/** Compose existing guarded backend and attested resource provisioner. This
 * function runs only with operator powers, never Floot session powers.
 * Durable audit/checkpoint authority is explicitly supplied and not returned.
 * @param {any} options
 */
export const makeHostedCodexSubscription = async options => {
  const {
    ownerId,
    directory,
    imageRef,
    listenerImageRef,
    accountRef,
    secret,
    secretAdmin,
    models,
    makeAuditJournal,
    loadThreadState,
    saveThreadState,
    removeSessionState,
    context,
  } = options;
  const imageDigest = imageRef.slice(imageRef.indexOf('@') + 1);
  const credential = makeCodexSubscriptionCredential({
    secret,
    rotate: makeSecretRotator(secretAdmin),
    accountRef,
    now: Date.now,
    fetch: globalThis.fetch,
  });
  // Refuse a stale, fenced or malformed credential before publishing a backend.
  await credential.current();
  const storage = await makeHostVolumeProvider({
    ...options,
    directory: join(directory, 'volumes'),
  });
  const listener = await makePodmanProviderListenerRuntime({
    imageRef: listenerImageRef,
    ownerId,
    stateDirectory: join(directory, 'listener'),
    maxListeners: options.maxSessions,
  });
  let issuer;
  let provision;
  let shutdown;
  let stopped = false;
  const dispose = async () => {
    stopped = true;
    const failures = [];
    // The backend barrier settles endowed tools and stops clients before any
    // slice, workspace, or listener can be released. Failure retains ownership.
    await shutdown?.();
    try {
      await provision?.retryCleanup();
    } catch (error) {
      failures.push(error);
    }
    try {
      await issuer?.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(failures, 'Codex host cleanup pending');
    await listener.dispose();
  };
  try {
    await options.initializeState?.();
    issuer = makeProviderBrokerLeaseIssuer({
      runtime: listener,
      secret,
      credential,
      fetch: globalThis.fetch,
      imageDigest,
      accountRef,
      leaseDurationMs: 60 * 60 * 1000,
      requestTimeoutMs: 600_000,
      onDiagnostic: options.onDiagnostic,
      audit: options.audit,
      policy: {
        origin: 'https://chatgpt.com',
        authMode: 'subscription',
        routes: [{ method: 'POST', path: '/v1/responses' }],
        models: models.map(model => model.id),
        maxRequests: 64n,
        maxRequestBytes: 8n * 1024n ** 2n,
        maxResponseBytes: 16n * 1024n ** 2n,
        // The broker conservatively reserves a full response per request.
        // Cover all 64 bounded requests, not merely fifteen reservations.
        maxTotalBytes: 64n * (8n + 16n) * 1024n ** 2n,
        // Request-unit budget, not a claim about subscription monetary billing.
        maxCostMicrounits: 64n,
        maxCostMicrounitsPerRequest: 1n,
      },
    });
    const noScratch = makeExo(
      'No host scratch',
      M.interface('NoHostScratch', {
        provideScratchMount: M.call().rest(M.arrayOf(M.any())).returns(M.any()),
        provideHostPath: M.call().rest(M.arrayOf(M.any())).returns(M.any()),
      }),
      {
        provideScratchMount() {
          throw Fail`Host scratch is forbidden`;
        },
        provideHostPath() {
          throw Fail`Host paths are forbidden`;
        },
      },
    );
    const sandbox = await makeSandbox(
      /** @type {any} */ (noScratch),
      undefined,
      {
        ownerId,
        volumeQuota: storage.observer,
      },
    );
    // The listener lock proves that an earlier host process has exited; the
    // driver probe completes exact-owner descendant reaping before recovery.
    const probes = await E(sandbox).listBackends();
    probes.some(probe => probe.name === 'podman' && probe.available) ||
      Fail`Attested Podman backend is unavailable`;
    // An abandoned registry transaction remains fenced: container reaping
    // alone cannot prove that old privileged host operations have stopped.
    const recovered = new Set();
    provision = makeAttestedCodexResourceProvisioner({
      sandbox,
      volumeProvider: storage.provider.volumeProvider,
      makeWorkspace: async spec => {
        if (!recovered.has(spec.sessionId)) {
          await storage.provider.recoverLease(spec);
          recovered.add(spec.sessionId);
        }
        return storage.provider.makeWorkspace(spec);
      },
      mountWorkspace: storage.provider.mountWorkspace,
      issueBrokerLease: issuer,
      imageRef,
      imageDigest,
      providerOrigin: 'https://chatgpt.com',
      accountRef,
      brokerAuthMode: 'subscription',
      volumeLimits: options.volumeLimits,
      makeAuditJournal,
      loadThreadState,
      saveThreadState,
      startTransport: startAppServerTransport,
    });
    const backend = makeCodexBackendFactory({
      registerShutdown: stop => {
        shutdown = stop;
      },
      imageDigest,
      listModels: async () => models,
      provision: async spec => {
        !stopped || Fail`Codex host is stopped`;
        const resources = await provision(spec);
        return resources;
      },
      destroy: async spec => {
        !stopped || Fail`Codex host is stopped`;
        await storage.provider.destroy({ sessionId: spec.sessionId });
        await removeSessionState(spec.sessionId);
      },
    });
    if (context) {
      void whenHostStops(context, dispose).catch(() => {
        // Do not release the lifecycle lock when cleanup failed.
        console.error('Codex host cleanup remains pending');
      });
    }
    return harden({ backend, dispose });
  } catch (error) {
    await dispose();
    throw error;
  }
};
harden(makeHostedCodexSubscription);
