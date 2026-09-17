// @ts-check

import { assertCopyData } from '@endo/daemon/copy-data.js';
import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import {
  HOSTED_SLICE_RESOURCES,
  sliceWritableBytes,
} from '@endo/hosted-agent/hosted-agent-policy.js';
import { assertPublicNetworkEvidence } from '@endo/hosted-agent/public-network.js';
import { reclaimRecordedMount } from '@endo/hosted-agent/recorded-cleanup.js';
import { makeHostedSessionSupervisor } from '@endo/hosted-agent/session-supervisor.js';
import {
  makeDefaultMounter,
  makeWorkspaceProjection,
} from '@endo/hosted-agent/workspace-projection.js';
import { dirname } from 'node:path';

import { startAppServerTransport } from './app-server-transport.js';
import { canonicalAuditJson, makeStoredAuditJournal } from './audit-journal.js';
import { assertProviderGrantV1 } from './codex-provider-grant.js';
import {
  makeBrokerAppServerArgv,
  makeBrokerEnvironment,
} from './broker-launch.js';
import { makeCodexClient } from './codex-client.js';
import {
  assertHostedAgentPolicyV1,
  hostedPolicyFromSlice,
} from './codex-hosted-policy.js';
import { readPinnedSliceImage } from './codex-image-reference.js';
import { readCodexSessionPlan } from './codex-session-plan.js';
import { makeCodexSessionState } from './codex-session-store.js';
import { adaptEndoTools } from './endo-tools.js';
import { makeCodexRuntimeVerifier } from './runtime-verifier.js';

/**
 * One inert native incarnation. The shared supervisor owns every acquired
 * scope and projection; this adapter owns only Codex's protocol and evidence
 * checks. Host checkpoints never share a bind with the writable CLI home.
 *
 * @param {object} [powers]
 * @param {typeof makeDefaultMounter} [powers.makeMounter]
 * @param {(rootPath: string) => object} [powers.makeFilesystem]
 * @param {typeof reclaimRecordedMount} [powers.reclaimMount]
 * @param {typeof makeCodexClient} [powers.makeClient]
 * @param {typeof startAppServerTransport} [powers.startTransport]
 * @param {typeof makeCodexRuntimeVerifier} [powers.makeVerifier]
 * @param {typeof makeCodexSessionState} [powers.openState]
 * @param {Record<string, string>} [powers.env]
 * @param {any} [powers.context]
 * @param {(error: unknown) => void} [powers.reportError]
 */
export const makeCodexNativeController = ({
  makeMounter = makeDefaultMounter,
  makeFilesystem,
  reclaimMount = reclaimRecordedMount,
  makeClient = makeCodexClient,
  startTransport = startAppServerTransport,
  makeVerifier = makeCodexRuntimeVerifier,
  openState = makeCodexSessionState,
  env = {},
  context,
  reportError,
} = {}) =>
  makeHostedSessionSupervisor({
    name: 'Codex',
    readPlan: readCodexSessionPlan,
    env,
    context,
    reclaimMount,
    ...(reportError ? { reportError } : {}),
    start: async (plan, resolver, { own, assertOpen }) => {
      const sandbox = await E(resolver).get('sandboxService');
      assertOpen();
      const sandboxScope = own(
        'sandbox',
        await E(sandbox).provideScope(plan.sandboxSessionId),
      );
      assertOpen();
      const broker = await E(resolver).get('brokerService');
      assertOpen();
      const brokerScope = own(
        'broker',
        await E(broker).provideScope(
          plan.sandboxSessionId,
          harden({
            providerOrigin: 'https://chatgpt.com',
            accountRef: plan.accountRef,
            networkPolicy: plan.networkPolicy,
            ...(plan.model ? { model: plan.model } : {}),
          }),
        ),
      );
      assertOpen();
      await E(brokerScope).start();
      assertOpen();
      const [grant, evidence] = await Promise.all([
        E(brokerScope).attestation(),
        E(brokerScope).sandboxEvidence(),
      ]);
      assertCopyData(harden(grant));
      assertCopyData(harden(evidence));
      const { imageRef, imageDigest } = readPinnedSliceImage(plan.imageRef);
      assertProviderGrantV1(grant, {
        sessionId: plan.sandboxSessionId,
        imageDigest,
        networkNamespaceId: evidence.networkNamespaceId,
        providerOrigin: 'https://chatgpt.com',
        accountRef: plan.accountRef,
        authMode: 'subscription',
        networkPolicy: plan.networkPolicy,
        ...(plan.model ? { model: plan.model } : {}),
      });
      const network = assertPublicNetworkEvidence(grant.network);
      const expectedEvidence = harden({
        version: 'CodexBrokerSandboxEvidenceV1',
        sessionId: plan.sandboxSessionId,
        imageDigest,
        grantId: grant.grantId,
        networkNamespaceId: grant.networkNamespaceId,
        brokerSidecar: evidence.brokerSidecar,
        credentialInjection: 'broker-only',
        brokerTransport: 'loopback-sidecar',
        ...(network ? { network } : {}),
      });
      canonicalAuditJson(evidence) === canonicalAuditJson(expectedEvidence) ||
        Fail`Codex broker evidence differs from the recorded session grant`;
      assertOpen();
      const stateProvider = await E(resolver).get('stateProvider');
      assertOpen();
      const records = await E(stateProvider).prepareSessionDirectory(
        plan.sandboxSessionId,
      );
      assertOpen();
      const home = await E(stateProvider).prepareCliDirectory(
        plan.sandboxSessionId,
      );
      assertCopyData(harden(records));
      assertCopyData(harden(home));
      assertOpen();
      const state = await openState(records.directory);
      const saved = await state.readThread();
      assertOpen();
      const journal = makeStoredAuditJournal(state.entries, {
        journalId: `codex-${plan.sessionId}`,
        sessionId: plan.sessionId,
        anchorPowers: state.anchors,
        maxEntryBytes: 1024 * 1024,
        maxTotalBytes: 16 * 1024 * 1024,
        maxAnchorBytes: 16 * 1024 * 1024,
      });
      const mounter = own(
        'mounter',
        makeWorkspaceProjection(
          {
            workspaceRootPath:
              plan.workspaceHostPath ??
              /** @type {string} */ (plan.workspaceDir),
            workspaceMountPoint: plan.workspaceMountPoint,
            mounterSocketDir: plan.mounterSocketDir,
            ...(plan.mounterEnv ? { mounterEnv: plan.mounterEnv } : {}),
          },
          { env, makeMounter, ...(makeFilesystem ? { makeFilesystem } : {}) },
        ),
      );
      await mounter.mount();
      assertOpen();
      const toolSet = await E(resolver).get('tools');
      assertOpen();
      const tools = adaptEndoTools(await E(toolSet).describe());
      assertOpen();
      /** @type {import('@endo/sandbox/types.js').SlicePolicyMount[]} */
      const mounts = [
        {
          role: 'workspace',
          kind: 'attach',
          source: plan.workspaceMountPoint,
          destination: '/workspace',
          mode: 'rw',
        },
        {
          role: 'codex-state',
          kind: 'bind',
          source: home.directory,
          destination: '/codex-home',
          mode: 'rw',
        },
        {
          role: 'tmp',
          kind: 'tmpfs',
          destination: '/tmp',
          sizeBytes: 1024n ** 3n,
        },
        {
          role: 'run',
          kind: 'tmpfs',
          destination: '/run',
          sizeBytes: 256n * 1024n ** 2n,
        },
        {
          role: 'scratch',
          kind: 'tmpfs',
          destination: '/scratch',
          sizeBytes: 704n * 1024n ** 2n,
        },
        ...plan.containerMounts.map(attach => ({
          role: `attach-${attach.key}`,
          kind: /** @type {const} */ ('attach'),
          source: attach.source,
          destination: attach.destination,
          mode: attach.mode,
        })),
      ];
      if (network)
        mounts.unshift({
          role: 'resolver',
          kind: 'resolver',
          source: network.resolverConfigPath,
          destination: '/etc/resolv.conf',
          mode: 'ro',
        });
      const slice = await E(sandboxScope).make(
        harden({
          rootfs: { kind: 'oci', ref: imageRef },
          network: 'broker-only',
          cwd: '/workspace',
          env: {},
          policy: {
            profile: 'hosted-agent-v1',
            imageDigest,
            uid: 1000,
            gid: 1000,
            brokerSidecar: evidence.brokerSidecar,
            resources: {
              ...HOSTED_SLICE_RESOURCES,
              writableBytes: sliceWritableBytes(mounts),
            },
            mounts,
            bindRoots: [dirname(home.directory)],
            attestationArgv: ['/bin/sleep', 'infinity'],
          },
        }),
      );
      assertOpen();
      const outer = await E(slice).policy();
      assertCopyData(harden(outer));
      // Hosted normalization deliberately erases host paths. Verify the exact
      // raw placement and resource controls first, not merely their role names.
      canonicalAuditJson(outer) ===
        canonicalAuditJson({
          version: 'SlicePolicyAttestationV1',
          profile: 'hosted-agent-v1',
          backend: 'rootless-podman',
          imageDigest,
          network: 'broker-only',
          networkNamespaceId: grant.networkNamespaceId,
          uid: 1000,
          gid: 1000,
          readOnlyRoot: true,
          noNewPrivileges: true,
          dropAllCapabilities: true,
          seccomp: true,
          devices: 'none',
          hostSockets: 'none',
          hostHome: 'none',
          descendantReaping: true,
          namespaces: {
            user: 'private',
            pid: 'private',
            ipc: 'private',
            mount: 'private',
          },
          limits: {
            ...HOSTED_SLICE_RESOURCES,
            writableBytes: sliceWritableBytes(mounts),
          },
          mounts: mounts.map(mount => ({
            role: mount.role,
            source:
              mount.kind === 'tmpfs'
                ? 'tmpfs'
                : `${mount.kind}:${mount.source}`,
            destination: mount.destination,
            mode:
              mount.kind === 'tmpfs' || mount.kind === 'volume'
                ? 'rw'
                : mount.mode,
            options: ['nodev', 'nosuid'],
          })),
        }) ||
        Fail`Codex raw slice attestation differs from the approved placement`;
      const policy = assertHostedAgentPolicyV1(
        hostedPolicyFromSlice({
          attestation: outer,
          sessionId: plan.sandboxSessionId,
          credentialInjection: 'broker-only',
          brokerTransport: 'loopback-sidecar',
          executionDomain: 'guest',
          ...(network ? { networkPolicy: 'public-internet' } : {}),
        }),
        {
          sessionId: plan.sandboxSessionId,
          imageDigest,
          containerMounts: plan.containerMounts,
          networkPolicy: plan.networkPolicy,
        },
      );
      assertOpen();
      const runtime = await E(makeVerifier()).attest(
        harden({
          slice,
          sessionId: plan.sandboxSessionId,
          imageDigest,
          grantId: grant.grantId,
          networkNamespaceId: grant.networkNamespaceId,
          launchArgv: makeBrokerAppServerArgv(grant.endpoint, 'codex', network),
          launchEnvironment: makeBrokerEnvironment(network),
          brokerEndpoint: grant.endpoint,
          ...(network ? { network } : {}),
        }),
      );
      canonicalAuditJson(runtime) ===
        canonicalAuditJson({
          version: 'CodexRuntimeEvidenceV1',
          sessionId: plan.sandboxSessionId,
          imageDigest,
          grantId: grant.grantId,
          networkNamespaceId: grant.networkNamespaceId,
          executionDomain: 'guest',
          environment: network
            ? 'credential-free-proxy'
            : 'credential-and-proxy-free',
          ...(network ? { network } : {}),
          codexHomeAuthFile: 'absent',
        }) || Fail`Codex runtime evidence does not prove the session envelope`;
      assertOpen();
      const auditEvent = async (kind, payload) => {
        await E(journal.writer).append(kind, payload);
      };
      await auditEvent('sandbox-attested', {
        imageDigest,
        policyVersion: policy.version,
        containerMounts: plan.containerMounts.map(
          ({ key, destination, mode }) => ({ key, destination, mode }),
        ),
      });
      assertOpen();
      return makeClient({
        start: () => startTransport({ slice, brokerLease: brokerScope }),
        sessionId: plan.sessionId,
        ...(typeof saved.threadId === 'string'
          ? { threadId: saved.threadId }
          : {}),
        ...(typeof saved.toolSetId === 'string'
          ? { savedToolSetId: saved.toolSetId }
          : {}),
        savedRecovery:
          /** @type {Parameters<typeof makeCodexClient>[0]['savedRecovery']} */ (
            saved.recovery
          ),
        saveThreadState: state.writeThread,
        cwd: '/workspace',
        model: plan.model,
        reasoningEffort: plan.reasoningEffort,
        developerInstructions: plan.systemPrompt,
        dynamicTools: tools.dynamicTools,
        toolSetId: tools.toolSetId,
        callTool: (name, args) =>
          E(toolSet).execute(tools.originalName(name), args),
        auditEvent,
      });
    },
  });
harden(makeCodexNativeController);

/**
 * @param {null | Promise<null>} powersP
 * @param {any} context
 * @param {{env?: Record<string,string>}} [options]
 */
export const make = async (powersP, context, { env = {} } = {}) => {
  const controller = makeCodexNativeController({ env, context });
  const powers = await powersP;
  powers === null || Fail`Codex native controller requires null powers`;
  return controller;
};
harden(make);
