// @ts-check

import { Fail, makeError, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import {
  HostedBackendFactoryInterface,
  HostedTurnBackendAdminInterface,
  HostedTurnBackendInterface,
  normalizeHostedModelDescriptor,
} from '@endo/hosted-agent';
import {
  HOSTED_AGENT_POLICY_V1,
  makeHostedAgentPolicyVerifier,
} from '@endo/hosted-agent/hosted-agent-policy.js';
import { makeCleanupScope } from '@endo/hosted-agent/cleanup-scope.js';
import { assertPublicNetworkEvidence } from '@endo/hosted-agent/public-network.js';
import { makeSessionRegistry } from '@endo/hosted-agent/session-registry.js';

import { makeCodexClient } from './codex-client.js';
import { adaptEndoTools, withEndoToolInstructions } from './endo-tools.js';

export { HOSTED_AGENT_POLICY_V1 };

const assertSessionId = sessionId => {
  (typeof sessionId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) ||
    Fail`Codex sessionId must be a bounded portable path component`;
  return sessionId;
};

/**
 * Validate the concrete provider grant before it enters a slice.
 *
 * @param {any} grant
 * @param {{ sessionId: string, imageDigest: string, networkNamespaceId: string, providerOrigin: string, accountRef: string, model?: string, authMode?: 'api-key' | 'oauth' | 'subscription', networkPolicy?: string }} requirements
 */
export const assertProviderGrantV1 = (grant, requirements) => {
  const keys = [
    'accountRef',
    'authMode',
    'endpoint',
    'imageDigest',
    'grantId',
    'modelAllowlist',
    'networkNamespaceId',
    'providerOrigin',
    'sessionId',
    'version',
  ];
  if (requirements.networkPolicy === 'public-internet') keys.push('network');
  keys.sort();
  if (requirements.networkPolicy === 'public-internet') {
    grant?.network !== undefined ||
      Fail`Broker public network evidence missing`;
    assertPublicNetworkEvidence(grant.network);
  }
  if (
    Object.keys(grant || {})
      .sort()
      .join(',') !== keys.join(',')
  ) {
    throw makeError(X`broker grant attestation is not exact`);
  }
  const accountRef = /** @type {unknown} */ (grant.accountRef);
  if (
    grant.version !== 'ProviderGrantV1' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(grant.grantId || '') ||
    grant.sessionId !== requirements.sessionId ||
    grant.imageDigest !== requirements.imageDigest ||
    grant.networkNamespaceId !== requirements.networkNamespaceId ||
    grant.providerOrigin !== requirements.providerOrigin ||
    typeof accountRef !== 'string' ||
    accountRef === '' ||
    accountRef.length > 256 ||
    accountRef !== requirements.accountRef
  ) {
    throw makeError(X`broker grant identity does not match the session`);
  }
  // Authentication mode is a property of the host-held broker, never a token
  // delivered to the slice. Refuse a silent API-billing downgrade.
  if (
    !['api-key', 'oauth', 'subscription'].includes(grant.authMode) ||
    (grant.authMode === 'subscription' &&
      grant.providerOrigin !== 'https://chatgpt.com') ||
    (requirements.authMode && grant.authMode !== requirements.authMode)
  ) {
    throw makeError(X`broker grant authentication mode is not supported`);
  }
  let origin;
  let endpoint;
  try {
    origin = new URL(grant.providerOrigin);
    endpoint = new URL(grant.endpoint);
  } catch {
    throw makeError(X`broker grant contains an invalid endpoint`);
  }
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== grant.providerOrigin ||
    endpoint.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.pathname !== '/' ||
    endpoint.search !== '' ||
    endpoint.hash !== ''
  ) {
    throw makeError(X`broker grant endpoint is not provider-bound loopback`);
  }
  if (
    !Array.isArray(grant.modelAllowlist) ||
    grant.modelAllowlist.length === 0 ||
    grant.modelAllowlist.some(
      model => typeof model !== 'string' || model === '',
    ) ||
    new Set(grant.modelAllowlist).size !== grant.modelAllowlist.length ||
    (requirements.model && !grant.modelAllowlist.includes(requirements.model))
  ) {
    throw makeError(X`broker grant model allowlist is invalid`);
  }
  return harden(grant);
};
harden(assertProviderGrantV1);

/**
 * The mount table Codex's profile fixes. `codex-state` is the CLI's own
 * home — its `~/.codex` transcript and config — and `workspace` is the tree
 * the session's file tools, the guest's workspace capability, and Floot's
 * publisher all read.
 */
export const CODEX_FIXED_MOUNTS = harden([
  { role: 'workspace', kind: 'session', destination: '/workspace', mode: 'rw' },
  {
    role: 'codex-state',
    kind: 'session',
    destination: '/codex-home',
    mode: 'rw',
  },
  { role: 'tmp', kind: 'tmpfs', destination: '/tmp', mode: 'rw' },
  { role: 'run', kind: 'tmpfs', destination: '/run', mode: 'rw' },
  { role: 'scratch', kind: 'tmpfs', destination: '/scratch', mode: 'rw' },
]);

const codexPolicy = makeHostedAgentPolicyVerifier({
  fixedMounts: CODEX_FIXED_MOUNTS,
});

/**
 * Validate the runtime attaches a Codex session declares, against the fixed
 * table above.
 */
export const assertContainerMounts = codexPolicy.assertContainerMounts;

/**
 * Assert the machine-checkable outer sandbox contract required before Codex
 * may run with its inner approval prompts disabled.
 */
export const assertHostedAgentPolicyV1 = codexPolicy.assertHostedAgentPolicyV1;

/**
 * Compose the concrete, per-session resource lifecycle from narrow platform
 * adapters. Every successfully created ephemeral stage registers its inverse
 * before the next stage begins, so a partial failure unwinds in strict reverse
 * order. The durable workspace is the exception, see `makeWorkspace`.
 *
 * @param {object} powers
 * @param {(spec: any) => Promise<{ writer: any }>} powers.makeAuditJournal
 *   Operator-constructed factory that already closes over independently held
 *   entry-store and anchor capabilities. Session specs cannot select either.
 * @param {(spec: any) => Promise<any>} powers.makeWorkspace
 *   Create or reopen the session's durable workspace, which `mountWorkspace`
 *   attaches to the slice. Rollback and disposal never remove it: a session
 *   revived after a restart reopens the workspace it had, and a broker or
 *   slice failure on the way must not cost the user its contents. Only the
 *   factory's `destroy` removes durable state.
 * @param {(workspace: any, spec: any) => Promise<{ unmount: () => Promise<void> }>} powers.mountWorkspace
 * @param {(spec: any) => Promise<{ revoke: () => Promise<void>, attestation: () => Promise<any> }>} powers.issueProviderGrant
 * @param {(options: any) => Promise<{ policy: () => Promise<any>, dispose: () => Promise<void> }>} powers.makeSlice
 * @param {() => Promise<void>} [powers.retrySliceCleanup]
 *   Reap slices retained by a failed makeSlice before releasing workspace leases.
 * @param {boolean} [powers.publicInternetEnabled] Trusted operator capability availability.
 * @param {(options: any) => Promise<any>} powers.startTransport
 * @param {(sessionId: string) => Promise<{ threadId?: string, toolSetId?: string, recovery?: { baseTurnId: string | null, turnId?: string, status?: string, previousCheckpoint?: string } }>} powers.loadThreadState
 * @param {(sessionId: string, state: { threadId: string, toolSetId?: string, recovery?: { baseTurnId: string | null, turnId?: string, status?: string, previousCheckpoint?: string } }) => Promise<void>} powers.saveThreadState
 * @param {string} powers.imageDigest
 * @param {string} powers.providerOrigin operator-approved HTTPS origin
 * @param {string} powers.accountRef operator-selected provider account
 * @param {'api-key' | 'oauth' | 'subscription'} [powers.brokerAuthMode] required upstream
 * authentication mode; a lease issued in the other mode is refused rather than
 * silently accepted
 */
export const makeCodexResourceProvisioner = powers => {
  /^sha256:[0-9a-f]{64}$/.test(powers.imageDigest) ||
    Fail`Codex resource provisioner requires an operator-approved image digest`;
  let configuredOrigin;
  try {
    configuredOrigin = new URL(powers.providerOrigin);
  } catch {
    throw makeError(X`Codex resource provisioner requires a provider origin`);
  }
  (configuredOrigin.protocol === 'https:' &&
    configuredOrigin.origin === powers.providerOrigin) ||
    Fail`Codex resource provisioner requires an exact HTTPS provider origin`;
  (typeof powers.accountRef === 'string' &&
    powers.accountRef !== '' &&
    powers.accountRef.length <= 256) ||
    Fail`Codex resource provisioner requires an operator account reference`;
  /** @type {Set<() => Promise<void>>} */
  const pendingCleanup = new Set();
  const retryPending = async () => {
    await null;
    const failures = [];
    try {
      await powers.retrySliceCleanup?.();
    } catch (error) {
      failures.push(error);
    }
    for (const cleanup of [...pendingCleanup]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await cleanup();
        pendingCleanup.delete(cleanup);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Provisioning cleanup remains pending',
      );
    }
  };
  let admission = Promise.resolve();
  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const enqueue = operation => {
    const result = admission.then(operation);
    admission = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const provision = async spec => {
    assertSessionId(spec?.sessionId);
    spec.accountRef === undefined ||
      spec.accountRef === powers.accountRef ||
      Fail`Codex session cannot override the operator account reference`;
    spec.cwd === undefined ||
      spec.cwd === '/workspace' ||
      Fail`Codex session cwd must be /workspace`;
    const containerMounts = assertContainerMounts(spec.containerMounts);
    // The broker lease is about provider access, not the mount table: the
    // attaches stay out of its request so they neither ride into its audit
    // record nor become something a lease issuer is asked to reason about.
    const leaseSpec = Object.fromEntries(
      Object.entries(spec).filter(([key]) => key !== 'containerMounts'),
    );
    const cleanupScope = makeCleanupScope();
    const cleanupStages = cleanupScope.run;
    let auditJournal;
    let sliceReleased = true;
    const unwind = async primaryError => {
      await null;
      const failures = [primaryError];
      pendingCleanup.add(cleanupStages);
      try {
        await cleanupStages();
        pendingCleanup.delete(cleanupStages);
      } catch (cleanupError) {
        failures.push(
          ...(cleanupError instanceof AggregateError
            ? cleanupError.errors
            : [cleanupError]),
        );
      }
      if (failures.length > 1 && auditJournal) {
        try {
          await E(auditJournal.writer).append(
            'session-provisioning-cleanup-failed',
            {
              sessionId: spec.sessionId,
              failures: failures
                .slice(1)
                .map(error =>
                  (error instanceof Error
                    ? error.message
                    : String(error)
                  ).slice(0, 4096),
                ),
            },
          );
        } catch (auditError) {
          failures.push(auditError);
        }
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          'Codex session provisioning and rollback failed',
        );
      }
      throw primaryError;
    };
    await null;
    try {
      auditJournal = await powers.makeAuditJournal(spec);
      await E(auditJournal.writer).append('session-provisioning-started', {
        sessionId: spec.sessionId,
        imageDigest: powers.imageDigest,
      });
      // Durable, so deliberately not registered for rollback: see the
      // `makeWorkspace` contract above.
      const workspace = await powers.makeWorkspace(spec);
      const workspaceMount = await powers.mountWorkspace(workspace, spec);
      cleanupScope.add(async () => {
        await powers.retrySliceCleanup?.();
        sliceReleased || Fail`Workspace remains leased until slice is reaped`;
        await E(workspaceMount).unmount();
      });
      const brokerLease = await powers.issueProviderGrant(
        harden({
          ...leaseSpec,
          providerOrigin: powers.providerOrigin,
          accountRef: powers.accountRef,
        }),
      );
      cleanupScope.add(() => E(brokerLease).revoke());
      const brokerAttestation = await E(brokerLease).attestation();
      const slice = await powers.makeSlice({
        spec,
        workspaceMount,
        brokerLease,
      });
      sliceReleased = false;
      cleanupScope.add(async () => {
        await E(slice).dispose();
        sliceReleased = true;
      });
      const policy = await E(slice).policy();
      // Validate here, before app-server can start, and again in the backend
      // factory at the authority handoff.
      assertHostedAgentPolicyV1(policy, {
        imageDigest: powers.imageDigest,
        sessionId: spec.sessionId,
        containerMounts,
        networkPolicy: spec.networkPolicy,
      });
      assertProviderGrantV1(brokerAttestation, {
        sessionId: spec.sessionId,
        imageDigest: powers.imageDigest,
        networkNamespaceId: policy.networkNamespaceId,
        providerOrigin: powers.providerOrigin,
        accountRef: powers.accountRef,
        networkPolicy: spec.networkPolicy,
        ...(spec.model ? { model: spec.model } : {}),
        ...(powers.brokerAuthMode ? { authMode: powers.brokerAuthMode } : {}),
      });
      await E(auditJournal.writer).append('session-resources-provisioned', {
        sessionId: spec.sessionId,
        imageDigest: policy.imageDigest,
        brokerLeaseId: brokerAttestation.grantId,
        providerOrigin: brokerAttestation.providerOrigin,
        accountRef: brokerAttestation.accountRef,
      });
      const threadState = await powers.loadThreadState(spec.sessionId);
      let disposed = false;
      return harden({
        policy,
        auditWriter: auditJournal.writer,
        threadId: threadState.threadId,
        savedToolSetId: threadState.toolSetId,
        savedRecovery: threadState.recovery,
        saveThreadState: state => powers.saveThreadState(spec.sessionId, state),
        start: () =>
          powers.startTransport({
            slice,
            cwd: spec.cwd || '/workspace',
            brokerLease,
          }),
        async dispose() {
          await null;
          if (disposed) return;
          pendingCleanup.add(cleanupStages);
          try {
            await cleanupStages();
            pendingCleanup.delete(cleanupStages);
          } catch (error) {
            throw new AggregateError(
              [error],
              'Codex provisioned resources did not fully dispose',
              { cause: error },
            );
          }
          disposed = true;
        },
      });
    } catch (error) {
      let failure = error;
      if (auditJournal) {
        try {
          await E(auditJournal.writer).append('session-provisioning-failed', {
            sessionId: spec.sessionId,
            reason: (error instanceof Error
              ? error.message
              : String(error)
            ).slice(0, 4096),
          });
        } catch (auditError) {
          failure = new AggregateError(
            [error, auditError],
            'Codex provisioning and failure audit both failed',
            { cause: auditError },
          );
        }
      }
      return unwind(failure);
    }
  };
  return harden(
    Object.assign(
      async spec => {
        spec?.networkPolicy === undefined ||
          spec.networkPolicy === 'off' ||
          (powers.publicInternetEnabled === true &&
            spec.networkPolicy === 'public-internet') ||
          Fail`Codex supports only the off network policy`;
        return enqueue(async () => {
          await retryPending();
          return provision(
            harden({ ...spec, networkPolicy: spec.networkPolicy ?? 'off' }),
          );
        });
      },
      { retryCleanup: () => enqueue(retryPending) },
    ),
  );
};
harden(makeCodexResourceProvisioner);

/**
 * Translate the pinned Codex app-server 0.152.0 model schema at the provider
 * boundary. No Codex-native field names cross into Floot or hosted-agent.
 *
 * @param {any} candidate
 */
export const normalizeCodexModelDescriptor = candidate => {
  (candidate && typeof candidate === 'object') ||
    Fail`Codex model descriptor must be a record`;
  Array.isArray(candidate.supportedReasoningEfforts) ||
    Fail`Codex model descriptor has invalid supported reasoning efforts`;
  const reasoningEfforts = candidate.supportedReasoningEfforts.map(entry => {
    (entry &&
      typeof entry === 'object' &&
      typeof entry.reasoningEffort === 'string') ||
      Fail`Codex model descriptor has invalid supported reasoning efforts`;
    return entry.reasoningEffort;
  });
  typeof candidate.isDefault === 'boolean' ||
    Fail`Codex model descriptor has invalid isDefault`;
  return normalizeHostedModelDescriptor({
    id: candidate.id,
    title: candidate.displayName,
    description: candidate.description || '',
    default: candidate.isDefault,
    defaultReasoningEffort: candidate.defaultReasoningEffort,
    reasoningEfforts,
  });
};
harden(normalizeCodexModelDescriptor);

/**
 * Build the trusted lifecycle owner for Codex backend sessions.
 *
 * The provision callback must create one disposable resource set per call and
 * return an effective policy attestation. The run facet is safe to hand to a
 * Floot session; only the factory retains the admin facet.
 *
 * @param {object} options
 * @param {(spec: Record<string, any>) => Promise<{
 *   start: () => Promise<any>,
 *   dispose: () => Promise<void>,
 *   policy: Record<string, any>,
 *   auditWriter: any,
 *   threadId?: string,
 *   savedToolSetId?: string,
 *   savedRecovery?: { baseTurnId: string | null, turnId?: string, status?: string, previousCheckpoint?: string },
 *   saveThreadState?: (state: { threadId: string, toolSetId?: string, recovery?: { baseTurnId: string | null, turnId?: string, status?: string, previousCheckpoint?: string } }) => Promise<void>,
 * }>} options.provision
 * @param {() => Promise<readonly any[]>} options.listModels
 * @param {string} options.imageDigest
 * @param {boolean} [options.publicInternetEnabled] Trusted operator capability availability.
 * @param {(shutdown: () => Promise<void>) => void} [options.registerShutdown]
 *   Host-only shutdown authority; stops live clients without deleting sessions.
 * @param {(spec: Record<string, any>) => Promise<void>} options.destroy
 *   Idempotently destroys a session's durable resources: its workspace, Codex
 *   state, thread state, and journal. The factory stops any instance of the
 *   session it still runs before calling it, so it never runs underneath a
 *   live app-server; it must tolerate lifecycle replay after a process crash
 *   or a lost successful response.
 */
export const makeCodexBackendFactory = ({
  provision,
  listModels,
  imageDigest,
  destroy,
  registerShutdown,
  publicInternetEnabled = false,
}) => {
  /^sha256:[0-9a-f]{64}$/.test(imageDigest) ||
    Fail`Codex backend factory requires an operator-approved image digest`;
  const listHostedModels = async () => {
    const models = await listModels();
    Array.isArray(models) || Fail`Codex model catalog must be an array`;
    return harden(models.map(normalizeCodexModelDescriptor));
  };

  const sessions = makeSessionRegistry();

  /**
   * @param {Record<string, any>} spec
   * @param {any} toolSet
   */
  const createSession = async (spec, toolSet) => {
    spec.cwd === undefined ||
      spec.cwd === '/workspace' ||
      Fail`Codex session cwd must be /workspace`;
    const tools = adaptEndoTools(await E(toolSet).describe());
    const containerMounts = assertContainerMounts(spec.containerMounts);
    // A predecessor that cannot stop — an unsettled Endo tool call — refuses
    // the successor rather than running beside it.
    await sessions.stop(spec.sessionId);
    const resources = await provision(spec);
    let client;
    let terminated = false;
    let clientStopped = false;
    let cleanupInFlight;
    let lastTeardownFailure;
    const auditEvent = (kind, payload) =>
      E(resources.auditWriter).append(kind, payload);
    try {
      const policy = assertHostedAgentPolicyV1(resources.policy, {
        imageDigest,
        networkPolicy: spec.networkPolicy,
        sessionId: spec.sessionId,
        containerMounts,
      });
      await auditEvent('sandbox-attested', {
        imageDigest: policy.imageDigest,
        policyVersion: policy.version,
        // The attaches are part of what was attested: the audit trail says
        // which capabilities' trees the slice could see, by key and mode.
        containerMounts: containerMounts.map(attach => ({
          key: attach.key,
          destination: attach.destination,
          mode: attach.mode,
        })),
      });
      client = makeCodexClient({
        start: resources.start,
        sessionId: spec.sessionId,
        threadId: resources.threadId,
        savedToolSetId: resources.savedToolSetId,
        savedRecovery: resources.savedRecovery,
        saveThreadState: resources.saveThreadState,
        cwd: spec.cwd || '/workspace',
        model: spec.model,
        reasoningEffort: spec.reasoningEffort,
        developerInstructions: spec.systemPrompt,
        dynamicTools: tools.dynamicTools,
        toolSetId: tools.toolSetId,
        callTool: (name, args) =>
          E(toolSet).execute(tools.originalName(name), args),
        auditEvent,
      });
    } catch (error) {
      try {
        await resources.dispose();
      } catch (disposeError) {
        throw new AggregateError(
          [error, disposeError],
          'Codex provisioning and rollback both failed',
          { cause: disposeError },
        );
      }
      throw error;
    }

    const terminate = () => {
      if (terminated) return Promise.resolve();
      if (cleanupInFlight) return cleanupInFlight;
      cleanupInFlight = (async () => {
        await null;
        const failures = [];
        const clientCleanup = clientStopped
          ? Promise.resolve()
          : (async () => {
              const status = await E(client).status();
              if (status.pendingToolCalls > 0) {
                throw Error(
                  `Codex session has ${status.pendingToolCalls} unsettled Endo tool call(s)`,
                );
              }
              try {
                await E(client).terminate();
                clientStopped = true;
              } catch (error) {
                // terminate() can reject either before its admission barrier
                // (a tool call raced the status check) or after the client has
                // irreversibly stopped (transport reap failed). Only the latter
                // may be skipped on retry; the outer slice remains the
                // authoritative process-reap barrier.
                const after = await E(client).status();
                if (after.terminated && after.pendingToolCalls === 0) {
                  clientStopped = true;
                }
                throw error;
              }
            })();
        try {
          await clientCleanup;
        } catch (error) {
          failures.push(error);
        }
        // Destroying the slice, the workspace mount, and the broker lease is
        // only safe once the client has actually stopped. Building an
        // `allSettled` array invoked `dispose()` eagerly, so it ran
        // concurrently with — and regardless of — the admission barrier above:
        // a session with an unsettled Endo tool call had its container killed
        // mid-call, its credential revoked, and its durable workspace deleted,
        // while `terminate()` rejected and told the caller the session had been
        // left intact for a later lifecycle retry. `clientStopped` is exactly
        // the condition that makes disposal safe, including the case where
        // `terminate()` rejected after the client had irreversibly stopped.
        if (clientStopped) {
          try {
            await resources.dispose();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0) {
          const failureMessages = failures.map(error =>
            (error instanceof Error ? error.message : String(error)).slice(
              0,
              4096,
            ),
          );
          const failureKey = JSON.stringify(failureMessages);
          if (failureKey !== lastTeardownFailure) {
            try {
              await auditEvent('session-teardown-failed', {
                failures: failureMessages,
              });
              lastTeardownFailure = failureKey;
            } catch (auditError) {
              failures.push(auditError);
            }
          }
          throw new AggregateError(failures, 'Codex session teardown failed');
        }
        await auditEvent('session-closed', { sessionId: spec.sessionId });
        terminated = true;
        sessions.release(spec.sessionId, terminate);
      })().finally(() => {
        if (!terminated) cleanupInFlight = undefined;
      });
      return cleanupInFlight;
    };

    const run = makeExo('HostedTurnBackend', HostedTurnBackendInterface, {
      send: (prompt, options) =>
        E(client).send(
          prompt,
          withEndoToolInstructions(options, spec.systemPrompt),
        ),
      models: async () => {
        const models = await E(client).models();
        return harden(models.map(normalizeCodexModelDescriptor));
      },
      interrupt: () => E(client).interrupt(),
      acknowledge: checkpoint => E(client).acknowledge(checkpoint),
      status: () => E(client).status(),
      help: method =>
        method
          ? `Hosted Codex backend run method: ${method}`
          : 'Hosted Codex backend: send, models, interrupt, acknowledge, and status.',
    });
    const admin = makeExo(
      'HostedTurnBackendAdmin',
      HostedTurnBackendAdminInterface,
      {
        terminate,
        help: () => 'Factory-only Codex lifecycle administration: terminate.',
      },
    );
    sessions.retain(spec.sessionId, terminate);
    return harden({ run, admin });
  };

  /**
   * @param {Record<string, any>} spec
   * @param {any} toolSet
   */
  const create = async (spec, toolSet) => {
    assertSessionId(spec?.sessionId);
    spec.networkPolicy === undefined ||
      spec.networkPolicy === 'off' ||
      (publicInternetEnabled === true &&
        spec.networkPolicy === 'public-internet') ||
      Fail`Codex supports only the off network policy`;
    return sessions.inOrder(spec.sessionId, () =>
      createSession(
        harden({ ...spec, networkPolicy: spec.networkPolicy ?? 'off' }),
        toolSet,
      ),
    );
  };

  const destroySession = async spec => {
    assertSessionId(spec?.sessionId);
    return sessions.inOrder(spec.sessionId, async () => {
      // Never underneath a running app-server.
      await sessions.stop(spec.sessionId);
      await destroy(spec);
    });
  };

  registerShutdown?.(sessions.shutdown);
  return makeExo('CodexBackendFactory', HostedBackendFactoryInterface, {
    async describe() {
      return harden({
        id: 'codex',
        title: 'Codex',
        kind: 'hosted',
        continuity: 'opaque-reconciled',
        toolOwnership: 'endo',
        supportedNetworkPolicies:
          publicInternetEnabled === true ? ['off', 'public-internet'] : ['off'],
      });
    },
    listModels: listHostedModels,
    create,
    destroy: destroySession,
    help() {
      return 'Codex backend factory: describe, listModels, create, and idempotent destroy.';
    },
  });
};
harden(makeCodexBackendFactory);
