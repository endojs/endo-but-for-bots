// @ts-check

/**
 * One execution envelope for every hosted native controller.
 *
 * A controller activates a recorded plan by acquiring a scope from the native
 * sandbox service and an inference grant from the provider broker, checking
 * the grant and the broker's evidence against the recorded image, account and
 * network policy, preparing its durable state, projecting the recorded
 * workspace through the session's own 9P mounter, standing up its tools, and
 * only then asking for a slice over the attested mount table, which it checks
 * twice before trusting: the raw placement it asked for, then the hosted
 * contract's controls. The three runtimes did all of this in the same order
 * with the same checks; what differs is the state they keep, the tools they
 * expose, the binds and environment their CLI needs, and the client they
 * build over the slice. An adapter declares those and copies none of the
 * sequence.
 *
 * Every step is owned or fenced through the supervisor's activation owner, so
 * a failed acquisition is released by the same cleanup as a successful one.
 *
 * @module
 */

import { dirname } from 'node:path';

import { Fail, b } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { SLICE_POLICY_PROFILE } from '@endo/sandbox/policy.js';

import { canonicalJson } from './canonical-json.js';
import { assertCopyData } from './copy-data.js';
import {
  HOSTED_AGENT_POLICY_V1,
  HOSTED_ANCHOR_ARGV,
  HOSTED_SLICE_RESOURCES,
  sliceWritableBytes,
} from './hosted-agent-policy.js';
import { assertProviderGrantV1 } from './provider-grant.js';
import { assertPublicNetworkEvidence } from './public-network.js';
import { readPinnedRootfs } from './session-plan.js';
import {
  makeDefaultMounter,
  makeWorkspaceProjection,
} from './workspace-projection.js';

/** Slice-internal paths; the recorded host paths never reach the guest. */
export const WORKSPACE_PATH = '/workspace';
harden(WORKSPACE_PATH);

/** A container name as the runtime spells one. */
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** The temporary mounts every hosted slice gets, with their ceilings. */
const TEMPORARY_MOUNTS = harden([
  { role: 'tmp', kind: 'tmpfs', destination: '/tmp', sizeBytes: 1024n ** 3n },
  {
    role: 'run',
    kind: 'tmpfs',
    destination: '/run',
    sizeBytes: 256n * 1024n ** 2n,
  },
]);

/**
 * What the broker's evidence must say about the slice it admitted: the
 * session, the image, the grant and the network namespace the grant names,
 * the sidecar it reports, and the transport the hosted contract requires.
 *
 * @param {Record<string, any>} attestation
 * @param {Record<string, any>} evidence
 * @param {string} sessionId
 * @param {string} imageDigest
 * @param {any} network
 */
const expectedEvidence = (
  attestation,
  evidence,
  sessionId,
  imageDigest,
  network,
) =>
  harden({
    version: 'CodexBrokerSandboxEvidenceV1',
    sessionId,
    imageDigest,
    grantId: attestation.grantId,
    networkNamespaceId: attestation.networkNamespaceId,
    brokerSidecar: evidence.brokerSidecar,
    credentialInjection: HOSTED_AGENT_POLICY_V1.credentialInjection,
    brokerTransport: HOSTED_AGENT_POLICY_V1.brokerTransport,
    ...(network ? { network } : {}),
  });

/**
 * What a slice must report about itself, given the placement it was asked
 * for: the hosted contract's controls, the per-cgroup limits, and exactly the
 * mounts it was given in the order it was given them. Hosted normalization
 * deliberately erases host paths, so this is checked first, raw.
 *
 * @param {object} context
 * @param {string} context.imageDigest
 * @param {string} context.networkNamespaceId
 * @param {readonly any[]} context.mounts
 */
const expectedAttestation = ({ imageDigest, networkNamespaceId, mounts }) =>
  harden({
    version: 'SlicePolicyAttestationV1',
    profile: SLICE_POLICY_PROFILE,
    backend: HOSTED_AGENT_POLICY_V1.backend,
    imageDigest,
    network: HOSTED_AGENT_POLICY_V1.network,
    networkNamespaceId,
    uid: HOSTED_AGENT_POLICY_V1.uid,
    gid: HOSTED_AGENT_POLICY_V1.gid,
    readOnlyRoot: true,
    noNewPrivileges: true,
    dropAllCapabilities: true,
    seccomp: true,
    devices: 'none',
    hostSockets: 'none',
    hostHome: 'none',
    descendantReaping: true,
    namespaces: HOSTED_AGENT_POLICY_V1.namespaces,
    limits: {
      ...HOSTED_SLICE_RESOURCES,
      writableBytes: sliceWritableBytes(mounts),
    },
    mounts: mounts.map(mount => ({
      role: mount.role,
      source:
        mount.kind === 'tmpfs' ? 'tmpfs' : `${mount.kind}:${mount.source}`,
      destination: mount.destination,
      mode:
        mount.kind === 'tmpfs' || mount.kind === 'volume' ? 'rw' : mount.mode,
      options: ['nodev', 'nosuid'],
    })),
  });

/**
 * @typedef {object} EnvelopeAdapter
 * @property {string} label The adapter's name for messages.
 * @property {Record<string, string>} [env] Trusted native runner configuration
 *   for the session's mounter.
 * @property {typeof makeDefaultMounter} [makeMounter]
 * @property {(rootPath: string) => object} [makeFilesystem]
 * @property {(plan: Record<string, any>) => { providerOrigin: string, accountRef: string, networkPolicy: string, model?: string, subscription?: string }} scopeRequest
 *   What the broker scope is asked for; the grant is then held to it.
 * @property {(plan: Record<string, any>) => 'api-key' | 'oauth' | undefined} [authMode]
 *   The authentication mode the grant must report, when the plan fixes one.
 * @property {(context: { plan: Record<string, any>, resolver: any, assertOpen: () => void }) => Promise<any>} [prepare]
 *   The runtime's durable state, prepared before the workspace is projected.
 * @property {(context: { plan: Record<string, any>, resolver: any, own: <T>(role: any, value: T) => T, assertOpen: () => void, prepared: any }) => Promise<any>} [tools]
 *   The runtime's tool access, stood up after the projection and before the
 *   slice is asked for.
 * @property {(context: { plan: Record<string, any>, prepared: any, tools: any }) => readonly any[]} [binds]
 *   The runtime's host binds, in the order its profile fixes them, after the
 *   workspace and before the temporary mounts.
 * @property {(context: { plan: Record<string, any>, prepared: any }) => readonly string[]} [bindRoots]
 *   The deployment-owned roots those binds must sit under.
 * @property {(plan: Record<string, any>) => readonly any[]} [attaches] The
 *   runtime attaches the session declared, after the temporary mounts.
 * @property {(context: { plan: Record<string, any>, attestation: Record<string, any>, publicNetwork: any, tools: any, prepared: any }) => Record<string, string>} [sliceEnv]
 *   The slice's environment; never a credential.
 * @property {{ assertHostedAgentPolicyV1: (policy: any, requirements?: any) => any, hostedPolicyFromSlice: (context: any) => any }} policy
 *   The adapter's binding of the hosted contract to its fixed mount table.
 */

/**
 * Activate a recorded plan's execution envelope.
 *
 * @param {Record<string, any>} plan
 * @param {any} resolver The daemon's resolver of the record's exact
 *   dependencies.
 * @param {{ own: <T>(role: any, value: T) => T, assertOpen: () => void }} owner
 *   The supervisor's activation owner.
 * @param {EnvelopeAdapter} adapter
 */
export const activateExecutionEnvelope = async (
  plan,
  resolver,
  { own, assertOpen },
  {
    label,
    env = {},
    makeMounter = makeDefaultMounter,
    makeFilesystem,
    scopeRequest,
    authMode = () => undefined,
    prepare = async () => undefined,
    tools: prepareTools = async () => undefined,
    binds = () => [],
    bindRoots = () => [],
    attaches = () => [],
    sliceEnv = () => ({}),
    policy: { assertHostedAgentPolicyV1, hostedPolicyFromSlice },
  },
) => {
  const sandbox = await E(resolver).get('sandboxService');
  assertOpen();
  const sandboxScope = own(
    'sandbox',
    await E(sandbox).provideScope(plan.sandboxSessionId),
  );
  assertOpen();
  const broker = await E(resolver).get('brokerService');
  assertOpen();
  const request = harden(scopeRequest(plan));
  const brokerScope = own(
    'broker',
    await E(broker).provideScope(plan.sandboxSessionId, request),
  );
  assertOpen();
  await E(brokerScope).start();
  assertOpen();
  const [attestation, evidence] = await Promise.all([
    E(brokerScope).attestation(),
    E(brokerScope).sandboxEvidence(),
  ]);
  assertCopyData(harden(attestation));
  assertCopyData(harden(evidence));
  // The slice runs the exact image the broker pinned: the recorded reference
  // names the digest the broker's evidence and grant both carry.
  const pinned = readPinnedRootfs(plan.rootfs, label);
  const rootfs = harden({
    kind: /** @type {const} */ ('oci'),
    ref: pinned.imageRef,
  });
  (typeof evidence.imageDigest === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(evidence.imageDigest) &&
    pinned.imageDigest === evidence.imageDigest) ||
    Fail`${b(label)} rootfs must match the broker's pinned image`;
  const { imageDigest } = evidence;
  const mode = authMode(plan);
  const grant = assertProviderGrantV1(attestation, {
    sessionId: plan.sandboxSessionId,
    imageDigest,
    networkNamespaceId: evidence.networkNamespaceId,
    providerOrigin: request.providerOrigin,
    accountRef: request.accountRef,
    ...(request.model ? { model: request.model } : {}),
    ...(mode ? { authMode: mode } : {}),
    networkPolicy: plan.networkPolicy,
  });
  // The network the grant was issued with; the evidence must report the
  // same one, which the exact comparison below establishes.
  const publicNetwork = assertPublicNetworkEvidence(grant.network);
  (plan.networkPolicy === 'public-internet') ===
    (publicNetwork !== undefined) ||
    Fail`Broker network evidence does not match the recorded policy`;
  // The sidecar the slice joins, named as the runtime names a container.
  const sidecar = evidence.brokerSidecar;
  (typeof sidecar === 'object' &&
    sidecar !== null &&
    Object.keys(sidecar).join(',') === 'container' &&
    typeof sidecar.container === 'string' &&
    CONTAINER_NAME.test(sidecar.container)) ||
    Fail`${b(label)} broker evidence names no sidecar container`;
  canonicalJson(evidence) ===
    canonicalJson(
      expectedEvidence(
        grant,
        evidence,
        plan.sandboxSessionId,
        imageDigest,
        publicNetwork,
      ),
    ) ||
    Fail`${b(label)} broker evidence differs from the recorded session grant`;
  assertOpen();
  const prepared = await prepare({ plan, resolver, assertOpen });
  assertOpen();
  // Exactly one of the two workspaces is recorded; the parser enforces it.
  // Retained before it is established, so a failed mount is still closed by
  // this owner's ordinary cleanup.
  const mounter = own(
    'mounter',
    makeWorkspaceProjection(
      {
        workspaceRootPath:
          plan.workspaceHostPath ?? /** @type {string} */ (plan.workspaceDir),
        workspaceMountPoint: plan.workspaceMountPoint,
        mounterSocketDir: plan.mounterSocketDir,
        ...(plan.mounterEnv ? { mounterEnv: plan.mounterEnv } : {}),
      },
      { env, makeMounter, ...(makeFilesystem ? { makeFilesystem } : {}) },
    ),
  );
  assertOpen();
  await mounter.mount();
  assertOpen();
  const tools = await prepareTools({
    plan,
    resolver,
    own,
    assertOpen,
    prepared,
  });
  assertOpen();
  // The attested mount table. The workspace is the 9P projection this
  // controller just established, so the sandbox can prove the slice sees a
  // projection rather than host data; the runtime's own binds follow, each
  // held to the deployment-owned root its session directory sits under;
  // `/tmp` and `/run` are declared with ceilings rather than left to whatever
  // `--read-only-tmpfs` gives; the session's declared attaches come last. A
  // public-network session gets the operator's generated nameserver file as
  // a declared mount first, the row the hosted contract expects whenever the
  // policy is public-internet.
  const mounts = harden([
    ...(publicNetwork
      ? [
          {
            role: 'resolver',
            kind: 'resolver',
            source: publicNetwork.resolverConfigPath,
            destination: '/etc/resolv.conf',
            mode: 'ro',
          },
        ]
      : []),
    {
      role: 'workspace',
      kind: 'attach',
      source: plan.workspaceMountPoint,
      destination: WORKSPACE_PATH,
      mode: 'rw',
    },
    ...binds({ plan, prepared, tools }),
    ...TEMPORARY_MOUNTS,
    ...attaches(plan).map(attach => ({
      role: `attach-${attach.key}`,
      kind: 'attach',
      source: attach.source,
      destination: attach.destination,
      mode: attach.mode,
    })),
  ]);
  const options = harden({
    rootfs,
    // The policy path derives the namespace from the attested sidecar rather
    // than being handed a container to join.
    network: HOSTED_AGENT_POLICY_V1.network,
    cwd: WORKSPACE_PATH,
    policy: {
      profile: SLICE_POLICY_PROFILE,
      imageDigest,
      uid: HOSTED_AGENT_POLICY_V1.uid,
      gid: HOSTED_AGENT_POLICY_V1.gid,
      brokerSidecar: { container: evidence.brokerSidecar.container },
      resources: {
        ...HOSTED_SLICE_RESOURCES,
        writableBytes: sliceWritableBytes(mounts),
      },
      mounts,
      // The parents of this session's own directories: the roots this
      // deployment owns and allocates under. A bind outside them is refused,
      // which is what makes the row worth attesting.
      bindRoots: bindRoots({ plan, prepared }),
      attestationArgv: HOSTED_ANCHOR_ARGV,
    },
    env: sliceEnv({ plan, attestation: grant, publicNetwork, tools, prepared }),
  });
  assertCopyData(options);
  // `make`, not `makeResolved`: the runtime returns a slice only once its
  // mount table verifies against the anchor's own.
  const slice = await E(sandboxScope).make(options);
  assertOpen();
  // Checked twice. The runtime proved the slice's confinement to itself; this
  // proves the slice it returned is the one this session was promised: first
  // the exact raw placement and resource controls, then the hosted contract's
  // controls, this profile's roles, and no mount the table did not declare.
  const outer = await E(slice).policy();
  assertCopyData(harden(outer));
  canonicalJson(outer) ===
    canonicalJson(
      expectedAttestation({
        imageDigest,
        networkNamespaceId: grant.networkNamespaceId,
        mounts,
      }),
    ) ||
    Fail`${b(label)} raw slice attestation differs from the approved placement`;
  const policy = assertHostedAgentPolicyV1(
    hostedPolicyFromSlice({
      attestation: outer,
      sessionId: plan.sandboxSessionId,
      credentialInjection: HOSTED_AGENT_POLICY_V1.credentialInjection,
      brokerTransport: HOSTED_AGENT_POLICY_V1.brokerTransport,
      executionDomain: HOSTED_AGENT_POLICY_V1.executionDomain,
      ...(publicNetwork ? { networkPolicy: 'public-internet' } : {}),
    }),
    {
      sessionId: plan.sandboxSessionId,
      imageDigest,
      networkPolicy: plan.networkPolicy,
      ...(plan.containerMounts === undefined
        ? {}
        : { containerMounts: plan.containerMounts }),
    },
  );
  assertOpen();
  return {
    sandboxScope,
    brokerScope,
    grant,
    evidence,
    rootfs,
    imageDigest,
    publicNetwork,
    prepared,
    tools,
    mounts,
    slice,
    policy,
  };
};
harden(activateExecutionEnvelope);

/**
 * The parent of a session's own directory: the deployment-owned root a bind
 * is held to.
 * @param {string} directory
 */
export const bindRootOf = directory => dirname(directory);
harden(bindRootOf);
