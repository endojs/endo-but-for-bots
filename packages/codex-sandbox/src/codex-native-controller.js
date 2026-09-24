// @ts-check
import { randomUUID } from 'node:crypto';

import { assertCopyData } from '@endo/hosted-agent/copy-data.js';
import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import {
  WORKSPACE_PATH,
  activateExecutionEnvelope,
  bindRootOf,
} from '@endo/hosted-agent/execution-envelope.js';
import { reclaimRecordedMount } from '@endo/hosted-agent/recorded-cleanup.js';
import { makeHostedSessionSupervisor } from '@endo/hosted-agent/session-supervisor.js';
import { makeDefaultMounter } from '@endo/hosted-agent/workspace-projection.js';

import { canonicalAuditJson, makeStoredAuditJournal } from './audit-journal.js';
import {
  makeBrokerAppServerArgv,
  makeBrokerEnvironment,
  startAppServerTransport,
} from './app-server-transport.js';
import { makeCodexClient } from './codex-client.js';
import { makeNativeContextTransport } from './native-context-transport.js';
import {
  assertHostedAgentPolicyV1,
  hostedPolicyFromSlice,
} from './codex-hosted-policy.js';
import { readCodexSessionPlan } from './codex-session-plan.js';
import { makeCodexSessionState } from './codex-session-store.js';
import { adaptEndoTools } from './endo-tools.js';
import { makeCodexRuntimeVerifier } from './runtime-verifier.js';

/** @import { AppServerTransport } from './codex-client.js' */

const CODEX_ORIGIN = 'https://chatgpt.com';
/** Where the CLI's writable home is bound in the slice. */
const CODEX_HOME_PATH = '/codex-home';

/**
 * One inert native incarnation. The shared supervisor owns every acquired
 * scope and projection and the shared execution envelope activates the plan;
 * this adapter owns only Codex's state, protocol and runtime evidence. Host
 * checkpoints never share a bind with the writable CLI home.
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
    start: async (plan, resolver, owner) => {
      const envelope = await activateExecutionEnvelope(plan, resolver, owner, {
        label: 'Codex',
        env,
        makeMounter,
        ...(makeFilesystem ? { makeFilesystem } : {}),
        scopeRequest: approved => ({
          providerOrigin: CODEX_ORIGIN,
          accountRef: approved.accountRef,
          networkPolicy: approved.networkPolicy,
          ...(approved.model ? { model: approved.model } : {}),
          ...(approved.subscription
            ? { subscription: approved.subscription }
            : {}),
        }),
        authMode: () => 'oauth',
        // Host checkpoints and the writable CLI home, on separate binds; the
        // saved thread and the audit journal come from the checkpoints.
        prepare: async ({
          plan: approved,
          resolver: dependencies,
          assertOpen,
        }) => {
          const stateProvider = await E(dependencies).get('stateProvider');
          assertOpen();
          const records = await E(stateProvider).prepareSessionDirectory(
            approved.sandboxSessionId,
          );
          assertOpen();
          const home = await E(stateProvider).prepareCliDirectory(
            approved.sandboxSessionId,
          );
          assertCopyData(harden(records));
          assertCopyData(harden(home));
          assertOpen();
          const state = await openState(records.directory);
          const saved = await state.readThread();
          assertOpen();
          // Required host-private diagnostics remain distinct from Floot's
          // effect journal and the operational thread checkpoint.
          const journal = makeStoredAuditJournal(state.entries, {
            journalId: `codex-${approved.sessionId}`,
            sessionId: approved.sessionId,
          });
          return { home, state, saved, journal };
        },
        // Codex receives Endo's tools as dynamic tools under adapted names.
        tools: async ({ resolver: dependencies, assertOpen }) => {
          const toolSet = await E(dependencies).get('tools');
          assertOpen();
          const tools = adaptEndoTools(await E(toolSet).describe());
          return { toolSet, tools };
        },
        binds: ({ prepared }) => [
          {
            role: 'codex-state',
            kind: 'bind',
            source: prepared.home.directory,
            destination: CODEX_HOME_PATH,
            mode: 'rw',
          },
        ],
        bindRoots: ({ prepared }) => [bindRootOf(prepared.home.directory)],
        attaches: approved => approved.containerMounts,
        policy: { assertHostedAgentPolicyV1, hostedPolicyFromSlice },
      });
      const {
        slice,
        brokerScope,
        grant,
        imageDigest,
        publicNetwork: network,
        prepared: { state, saved, journal },
        tools: { toolSet, tools },
        policy,
      } = envelope;
      // Codex proves the runtime's own envelope too: the launch it will be
      // given reaches only the broker endpoint, and no credential file is in
      // its home.
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
      owner.assertOpen();
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
      owner.assertOpen();
      return makeClient({
        nativeContext: makeNativeContextTransport({
          slice,
          cwd: WORKSPACE_PATH,
        }),
        makeNativeIdentity: () => ({
          sessionId: randomUUID(),
          timestamp: new Date().toISOString(),
        }),
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
        cwd: WORKSPACE_PATH,
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
