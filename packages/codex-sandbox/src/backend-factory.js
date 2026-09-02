// @ts-check

import { Fail, makeError, q, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import {
  HostedBackendFactoryInterface,
  HostedTurnBackendAdminInterface,
  HostedTurnBackendInterface,
  normalizeHostedModelDescriptor,
} from '@endo/hosted-agent';

import { makeCodexClient } from './codex-client.js';

const assertSessionId = sessionId => {
  (typeof sessionId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) ||
    Fail`Codex sessionId must be a bounded portable path component`;
  return sessionId;
};

export const HOSTED_AGENT_POLICY_V1 = harden({
  version: 'HostedAgentPolicyV1',
  backend: 'rootless-podman',
  network: 'broker-only',
  uid: 1000,
  gid: 1000,
  readOnlyRoot: true,
  noNewPrivileges: true,
  dropAllCapabilities: true,
  seccomp: true,
  devices: 'none',
  hostSockets: 'none',
  hostHome: 'none',
  credentialInjection: 'broker-only',
  brokerTransport: 'loopback-sidecar',
  toolSandbox: 'codex-workspace-write',
  toolCodexHomeAccess: 'read-only',
  toolBrokerAccess: 'denied',
  descendantReaping: true,
  namespaces: harden({
    user: 'private',
    pid: 'private',
    ipc: 'private',
    mount: 'private',
  }),
  limits: harden({
    memoryBytes: 4 * 1024 * 1024 * 1024,
    pids: 512,
    cpuCores: 4,
    openFiles: 4096,
    coreBytes: 0,
    writableBytes: 16 * 1024 * 1024 * 1024,
  }),
});
harden(HOSTED_AGENT_POLICY_V1);

/**
 * Validate the concrete provider lease before it enters a slice.
 *
 * @param {any} lease
 * @param {{ sessionId: string, imageDigest: string, networkNamespaceId: string, providerOrigin: string, accountRef: string, model?: string }} requirements
 */
export const assertBrokerLeaseV1 = (lease, requirements) => {
  const keys = [
    'accountRef',
    'endpoint',
    'expiresAt',
    'imageDigest',
    'leaseId',
    'limits',
    'modelAllowlist',
    'networkNamespaceId',
    'providerOrigin',
    'sessionId',
    'version',
  ];
  if (
    Object.keys(lease || {})
      .sort()
      .join(',') !== keys.join(',')
  ) {
    throw makeError(X`broker lease attestation is not exact`);
  }
  const accountRef = /** @type {unknown} */ (lease.accountRef);
  if (
    lease.version !== 'BrokerLeaseV1' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(lease.leaseId || '') ||
    lease.sessionId !== requirements.sessionId ||
    lease.imageDigest !== requirements.imageDigest ||
    lease.networkNamespaceId !== requirements.networkNamespaceId ||
    lease.providerOrigin !== requirements.providerOrigin ||
    typeof accountRef !== 'string' ||
    accountRef === '' ||
    accountRef.length > 256 ||
    accountRef !== requirements.accountRef
  ) {
    throw makeError(X`broker lease identity does not match the session`);
  }
  let origin;
  let endpoint;
  try {
    origin = new URL(lease.providerOrigin);
    endpoint = new URL(lease.endpoint);
  } catch {
    throw makeError(X`broker lease contains an invalid endpoint`);
  }
  const requests = /** @type {unknown} */ (lease.limits?.requests);
  const bytes = /** @type {unknown} */ (lease.limits?.bytes);
  const costMicrounits = /** @type {unknown} */ (lease.limits?.costMicrounits);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== lease.providerOrigin ||
    endpoint.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.pathname !== '/' ||
    endpoint.search !== '' ||
    endpoint.hash !== ''
  ) {
    throw makeError(X`broker lease endpoint is not provider-bound loopback`);
  }
  const expiry = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    throw makeError(X`broker lease is expired`);
  }
  if (
    !Array.isArray(lease.modelAllowlist) ||
    lease.modelAllowlist.length === 0 ||
    lease.modelAllowlist.some(
      model => typeof model !== 'string' || model === '',
    ) ||
    new Set(lease.modelAllowlist).size !== lease.modelAllowlist.length ||
    (requirements.model && !lease.modelAllowlist.includes(requirements.model))
  ) {
    throw makeError(X`broker lease model allowlist is invalid`);
  }
  if (
    Object.keys(lease.limits || {})
      .sort()
      .join(',') !== 'bytes,costMicrounits,requests' ||
    typeof requests !== 'number' ||
    !Number.isInteger(requests) ||
    requests <= 0 ||
    typeof bytes !== 'bigint' ||
    bytes <= 0n ||
    typeof costMicrounits !== 'bigint' ||
    costMicrounits <= 0n
  ) {
    throw makeError(X`broker lease quotas are invalid`);
  }
  return harden(lease);
};
harden(assertBrokerLeaseV1);

/**
 * Assert the machine-checkable outer sandbox contract required before Codex
 * may run with its inner approval prompts disabled.
 *
 * @param {any} policy
 * @param {{ imageDigest?: string, sessionId?: string }} [requirements]
 */
export const assertHostedAgentPolicyV1 = (policy, requirements = {}) => {
  const expected = HOSTED_AGENT_POLICY_V1;
  const imageDigest = policy?.imageDigest;
  if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest || '')) {
    throw makeError(X`hosted agent image must be pinned by SHA-256 digest`);
  }
  if (requirements.imageDigest && imageDigest !== requirements.imageDigest) {
    throw makeError(X`hosted agent image digest is not operator-approved`);
  }
  if (
    typeof policy?.sessionId !== 'string' ||
    policy.sessionId === '' ||
    (requirements.sessionId && policy.sessionId !== requirements.sessionId)
  ) {
    throw makeError(X`sandbox attestation has the wrong session identity`);
  }
  for (const key of [
    'version',
    'backend',
    'network',
    'uid',
    'gid',
    'readOnlyRoot',
    'noNewPrivileges',
    'dropAllCapabilities',
    'seccomp',
    'devices',
    'hostSockets',
    'hostHome',
    'credentialInjection',
    'brokerTransport',
    'toolSandbox',
    'toolCodexHomeAccess',
    'toolBrokerAccess',
    'descendantReaping',
  ]) {
    if (policy?.[key] !== expected[key]) {
      throw makeError(X`sandbox policy field ${q(key)} is not enforced`);
    }
  }
  for (const [key, value] of Object.entries(expected.namespaces)) {
    if (policy?.namespaces?.[key] !== value) {
      throw makeError(X`sandbox namespace ${q(key)} is not private`);
    }
  }
  for (const [key, value] of Object.entries(expected.limits)) {
    if (policy?.limits?.[key] !== value) {
      throw makeError(X`sandbox limit ${q(key)} is not enforced`);
    }
  }
  const expectedTopLevelKeys = [
    ...Object.keys(expected),
    'imageDigest',
    'mounts',
    'networkNamespaceId',
    'sessionId',
  ].sort();
  if (
    Object.keys(policy || {})
      .sort()
      .join(',') !== expectedTopLevelKeys.join(',')
  ) {
    throw makeError(X`sandbox attestation has unknown or missing fields`);
  }
  if (
    Object.keys(policy.namespaces).sort().join(',') !==
    Object.keys(expected.namespaces).sort().join(',')
  ) {
    throw makeError(X`sandbox namespace attestation is not exact`);
  }
  if (
    Object.keys(policy.limits).sort().join(',') !==
    Object.keys(expected.limits).sort().join(',')
  ) {
    throw makeError(X`sandbox limit attestation is not exact`);
  }
  if (
    typeof policy.networkNamespaceId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(policy.networkNamespaceId)
  ) {
    throw makeError(X`sandbox network namespace identity is invalid`);
  }
  const mounts = policy?.mounts;
  if (!Array.isArray(mounts)) {
    throw makeError(X`sandbox policy omitted its effective mount table`);
  }
  if (mounts.length !== 5) {
    throw makeError(X`sandbox attestation contains an undeclared mount`);
  }
  const expectedMounts = harden({
    workspace: harden({
      source: `workspace:${policy.sessionId}`,
      destination: '/workspace',
      mode: 'rw',
    }),
    'codex-state': harden({
      source: `codex-state:${policy.sessionId}`,
      destination: '/codex-home',
      mode: 'rw',
    }),
    tmp: harden({ source: 'tmpfs', destination: '/tmp', mode: 'rw' }),
    run: harden({ source: 'tmpfs', destination: '/run', mode: 'rw' }),
    scratch: harden({ source: 'tmpfs', destination: '/scratch', mode: 'rw' }),
  });
  const seenRoles = new Set();
  for (const mount of mounts) {
    if (
      typeof mount?.role !== 'string' ||
      !Object.hasOwn(expectedMounts, mount.role)
    ) {
      throw makeError(X`sandbox mount table is not the exact session table`);
    }
    const expectedMount = expectedMounts[mount?.role];
    if (
      !expectedMount ||
      seenRoles.has(mount.role) ||
      Object.keys(mount || {})
        .sort()
        .join(',') !== 'destination,mode,options,role,source' ||
      mount.source !== expectedMount.source ||
      mount.destination !== expectedMount.destination ||
      mount.mode !== expectedMount.mode ||
      !Array.isArray(mount.options) ||
      [...mount.options].sort().join(',') !== 'nodev,nosuid'
    ) {
      throw makeError(X`sandbox mount table is not the exact session table`);
    }
    seenRoles.add(mount.role);
  }
  if (seenRoles.size !== Object.keys(expectedMounts).length) {
    throw makeError(X`sandbox mount table omitted a required role`);
  }
  return harden({ ...policy, mounts: harden([...mounts]) });
};
harden(assertHostedAgentPolicyV1);

/**
 * Compose the concrete, per-session resource lifecycle from narrow platform
 * adapters. Every successfully created stage registers its inverse before the
 * next stage begins, so a partial failure unwinds in strict reverse order.
 *
 * @param {object} powers
 * @param {(spec: any) => Promise<{ writer: any }>} powers.makeAuditJournal
 *   Operator-constructed factory that already closes over independently held
 *   entry-store and anchor capabilities. Session specs cannot select either.
 * @param {(spec: any) => Promise<{ remove: () => Promise<void> }>} powers.makeWorkspace
 * @param {(workspace: any, spec: any) => Promise<{ unmount: () => Promise<void> }>} powers.mountWorkspace
 * @param {(spec: any) => Promise<{ revoke: () => Promise<void>, attestation: () => Promise<any> }>} powers.issueBrokerLease
 * @param {(options: any) => Promise<{ policy: () => Promise<any>, dispose: () => Promise<void> }>} powers.makeSlice
 * @param {(options: any) => Promise<any>} powers.startTransport
 * @param {(sessionId: string) => Promise<{ threadId?: string, toolSetId?: string, recovery?: { baseTurnId: string | null, turnId?: string, status?: string } }>} powers.loadThreadState
 * @param {(sessionId: string, state: { threadId: string, toolSetId?: string, recovery?: { baseTurnId: string | null, turnId?: string, status?: string } }) => Promise<void>} powers.saveThreadState
 * @param {string} powers.imageDigest
 * @param {string} powers.providerOrigin operator-approved HTTPS origin
 * @param {string} powers.accountRef operator-selected provider account
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
  const provision = async spec => {
    assertSessionId(spec?.sessionId);
    spec.accountRef === undefined ||
      spec.accountRef === powers.accountRef ||
      Fail`Codex session cannot override the operator account reference`;
    spec.cwd === undefined ||
      spec.cwd === '/workspace' ||
      Fail`Codex session cwd must be /workspace`;
    /** @type {Array<{ run: () => Promise<void>, done: boolean }>} */
    const undo = [];
    let auditJournal;
    const unwind = async primaryError => {
      await null;
      const failures = [primaryError];
      for (const cleanup of [...undo].reverse()) {
        if (!cleanup.done) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await cleanup.run();
            cleanup.done = true;
          } catch (error) {
            failures.push(error);
          }
        }
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
      const workspace = await powers.makeWorkspace(spec);
      undo.push({ run: () => E(workspace).remove(), done: false });
      const workspaceMount = await powers.mountWorkspace(workspace, spec);
      undo.push({ run: () => E(workspaceMount).unmount(), done: false });
      const brokerLease = await powers.issueBrokerLease(
        harden({
          ...spec,
          providerOrigin: powers.providerOrigin,
          accountRef: powers.accountRef,
        }),
      );
      undo.push({ run: () => E(brokerLease).revoke(), done: false });
      const brokerAttestation = await E(brokerLease).attestation();
      const slice = await powers.makeSlice({
        spec,
        workspaceMount,
        brokerLease,
      });
      undo.push({ run: () => E(slice).dispose(), done: false });
      const policy = await E(slice).policy();
      // Validate here, before app-server can start, and again in the backend
      // factory at the authority handoff.
      assertHostedAgentPolicyV1(policy, {
        imageDigest: powers.imageDigest,
        sessionId: spec.sessionId,
      });
      assertBrokerLeaseV1(brokerAttestation, {
        sessionId: spec.sessionId,
        imageDigest: powers.imageDigest,
        networkNamespaceId: policy.networkNamespaceId,
        providerOrigin: powers.providerOrigin,
        accountRef: powers.accountRef,
        ...(spec.model ? { model: spec.model } : {}),
      });
      await E(auditJournal.writer).append('session-resources-provisioned', {
        sessionId: spec.sessionId,
        imageDigest: policy.imageDigest,
        brokerLeaseId: brokerAttestation.leaseId,
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
          const failures = [];
          for (const cleanup of [...undo].reverse()) {
            if (!cleanup.done) {
              try {
                // eslint-disable-next-line no-await-in-loop
                await cleanup.run();
                cleanup.done = true;
              } catch (error) {
                failures.push(error);
              }
            }
          }
          if (failures.length > 0) {
            throw new AggregateError(
              failures,
              'Codex provisioned resources did not fully dispose',
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
  return harden(provision);
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
 *   savedRecovery?: { baseTurnId: string | null, turnId?: string, status?: string },
 *   saveThreadState?: (state: { threadId: string, toolSetId?: string, recovery?: { baseTurnId: string | null, turnId?: string, status?: string } }) => Promise<void>,
 * }>} options.provision
 * @param {() => Promise<readonly any[]>} options.listModels
 * @param {string} options.imageDigest
 * @param {(spec: Record<string, any>) => Promise<void>} options.destroy
 *   Idempotently destroys any durable resources for a session that is not
 *   represented by a live admin facet. It must tolerate lifecycle replay after
 *   a process crash or a lost successful response.
 */
export const makeCodexBackendFactory = ({
  provision,
  listModels,
  imageDigest,
  destroy,
}) => {
  /^sha256:[0-9a-f]{64}$/.test(imageDigest) ||
    Fail`Codex backend factory requires an operator-approved image digest`;
  const listHostedModels = async () => {
    const models = await listModels();
    Array.isArray(models) || Fail`Codex model catalog must be an array`;
    return harden(models.map(normalizeCodexModelDescriptor));
  };
  /**
   * @param {Record<string, any>} spec
   * @param {any} toolSet
   */
  const create = async (spec, toolSet) => {
    assertSessionId(spec?.sessionId);
    spec.cwd === undefined ||
      spec.cwd === '/workspace' ||
      Fail`Codex session cwd must be /workspace`;
    const tools = await E(toolSet).describe();
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
        sessionId: spec.sessionId,
      });
      await auditEvent('sandbox-attested', {
        imageDigest: policy.imageDigest,
        policyVersion: policy.version,
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
        callTool: (name, args) => E(toolSet).execute(name, args),
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
        const cleanup = await Promise.allSettled([
          clientCleanup,
          resources.dispose(),
        ]);
        for (const result of cleanup) {
          if (result.status === 'rejected') failures.push(result.reason);
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
      })().finally(() => {
        if (!terminated) cleanupInFlight = undefined;
      });
      return cleanupInFlight;
    };

    const run = makeExo('HostedTurnBackend', HostedTurnBackendInterface, {
      send: (prompt, options) => E(client).send(prompt, options),
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
    return harden({ run, admin });
  };

  const destroySession = async spec => {
    assertSessionId(spec?.sessionId);
    return destroy(spec);
  };

  return makeExo('CodexBackendFactory', HostedBackendFactoryInterface, {
    async describe() {
      return harden({
        id: 'codex',
        title: 'Codex',
        kind: 'hosted',
        continuity: 'opaque-reconciled',
        toolOwnership: 'endo',
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
