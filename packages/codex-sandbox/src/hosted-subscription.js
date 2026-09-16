// @ts-check

import { join } from 'node:path';

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { providePrivateDirectory } from '@endo/hosted-agent/hosted-setup.js';
import { makeProviderBrokerGrantIssuer } from '@endo/hosted-agent/provider-grant-issuer.js';
import { makePodmanProviderListenerRuntime } from '@endo/hosted-agent/provider-listener-runtime.js';
import { makePublicEgress } from '@endo/hosted-agent/public-egress.js';
import { makeSecretRotator } from '@endo/hosted-agent/secret-rotator.js';

import { startAppServerTransport } from './app-server-transport.js';
import { makeCodexBackendFactory } from './backend-factory.js';
import { makeHostVolumeProvider } from './host-volume-provider.js';
import { whenHostStops } from './host-lifecycle.js';
import { readPinnedSliceImage } from './hosted-runtime-setup.js';
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
    listenerImageRef,
    accountRef,
    credential: secret,
    sandbox,
    models,
    makeAuditJournal,
    loadThreadState,
    saveThreadState,
    removeSessionState,
    context,
    publicInternet = false,
  } = options;
  // One capability serves both roles the composition below needs of the
  // credential record: the broker grant reads it, and the refreshing credential
  // replaces it under a generation check. `makeSecretRotator` attenuates the
  // second down to that one method, exactly as it did when the admin facet came
  // from the host agent's catalog.
  const secretAdmin = secret;
  sandbox || Fail`Codex host requires a native sandbox runtime`;
  typeof publicInternet === 'boolean' ||
    Fail`Invalid public network configuration`;
  // Refuse a tagged, unpinned or malformed reference here, where the operator
  // can still read the message, rather than one session at a time inside slice
  // admission. The unchecked `imageRef.slice(imageRef.indexOf('@') + 1)` this
  // replaces returned the whole reference when there was no `@`, so the image
  // *name* reached the broker grant and the slice policy as a digest.
  const { imageRef, imageDigest } = readPinnedSliceImage(options.imageRef);
  const credential = makeCodexSubscriptionCredential({
    secret,
    rotate: makeSecretRotator(secretAdmin),
    accountRef,
    now: Date.now,
    fetch: globalThis.fetch,
  });
  // Refuse a stale, fenced or malformed credential before publishing a backend.
  await credential.current();
  // The volume registry and the listener's process lock both live under this
  // root, and both would otherwise `mkdir -p` it blind. Refuse a symlink, a
  // non-directory, or a directory owned by another user once, here, and
  // normalize its mode — the same treatment the other two adapters give their
  // operator-supplied roots.
  await providePrivateDirectory('Codex host directory', directory);
  const storage = await makeHostVolumeProvider({
    ...options,
    directory: join(directory, 'volumes'),
    // Each session's mount point, 9P socket directory, and — when it brings
    // no worktree of its own — its workspace tree.
    sessionsDirectory: join(directory, 'sessions'),
  });
  const listener = await makePodmanProviderListenerRuntime({
    imageRef: listenerImageRef,
    ownerId,
    stateDirectory: join(directory, 'listener'),
    maxListeners: options.maxSessions,
    publicInternet,
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
    issuer = makeProviderBrokerGrantIssuer({
      runtime: listener,
      secret,
      credential,
      fetch: globalThis.fetch,
      imageDigest,
      accountRef,
      requestTimeoutMs: 600_000,
      onDiagnostic: options.onDiagnostic,
      audit: options.audit,
      ...(publicInternet
        ? {
            makePublicNetwork: () =>
              makePublicEgress({ policy: 'public-internet' }),
          }
        : {}),
      policy: {
        origin: 'https://chatgpt.com',
        authMode: 'subscription',
        routes: [{ method: 'POST', path: '/v1/responses' }],
        models: models.map(model => model.id),
        maxConcurrentRequests: 4,
        maxRequestBytes: 8n * 1024n ** 2n,
        maxResponseBytes: 16n * 1024n ** 2n,
      },
    });
    // The sandbox is no longer constructed here. It is the daemon-owned
    // `codex-sandbox/native-sandbox` formula: it claims the exclusive ownership
    // marker of its runtime directory, builds its own kernel-quota observer
    // from configuration, and refuses capability-based construction through a
    // null scratch provider — which is what the `noScratch` exo that used to
    // stand here was for. Separating it is what lets this caplet, which is
    // pinned to a release checkout, be re-minted on every setup run without
    // re-claiming a marker a live runtime already holds.
    //
    // The listener lock proves that an earlier host process has exited; the
    // driver probe completes exact-owner descendant reaping before recovery.
    const probes = await E(sandbox).listBackends();
    probes.some(probe => probe.name === 'podman' && probe.available) ||
      Fail`Attested Podman backend is unavailable`;
    // An abandoned registry transaction remains fenced: container reaping
    // alone cannot prove that old privileged host operations have stopped.
    const recovered = new Set();
    provision = makeAttestedCodexResourceProvisioner({
      publicInternetEnabled: publicInternet,
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
      issueProviderGrant: issuer,
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
      publicInternetEnabled: publicInternet,
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
