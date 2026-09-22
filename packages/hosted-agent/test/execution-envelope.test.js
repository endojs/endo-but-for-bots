// @ts-check
import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import {
  WORKSPACE_PATH,
  activateExecutionEnvelope,
} from '../src/execution-envelope.js';
import {
  makeHostedAgentPolicyVerifier,
  sliceWritableBytes,
} from '../src/hosted-agent-policy.js';

const digest = `sha256:${'a'.repeat(64)}`;
const otherDigest = `sha256:${'b'.repeat(64)}`;

/** A runtime's fixed mount table: a workspace, one durable bind, scratch. */
const policy = makeHostedAgentPolicyVerifier({
  fixedMounts: harden([
    {
      role: 'workspace',
      kind: 'session',
      destination: '/workspace',
      mode: 'rw',
    },
    { role: 'state', kind: 'session', destination: '/state', mode: 'rw' },
    { role: 'tmp', kind: 'tmpfs', destination: '/tmp', mode: 'rw' },
    { role: 'run', kind: 'tmpfs', destination: '/run', mode: 'rw' },
  ]),
});

/**
 * What a slice reports about itself, synthesized from the placement it was
 * asked for, the way a runtime reports it: each source carries the prefix its
 * kind gets and the limits are the per-cgroup halves.
 * @param {any} requested
 */
const attestationFor = requested =>
  harden({
    version: 'SlicePolicyAttestationV1',
    profile: requested.profile,
    backend: 'rootless-podman',
    imageDigest: requested.imageDigest,
    network: 'broker-only',
    networkNamespaceId: 'ns-1',
    uid: requested.uid,
    gid: requested.gid,
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
    limits: requested.resources,
    mounts: requested.mounts.map(mount => ({
      role: mount.role,
      source:
        mount.kind === 'tmpfs' ? 'tmpfs' : `${mount.kind}:${mount.source}`,
      destination: mount.destination,
      mode: mount.mode ?? 'rw',
      options: ['nodev', 'nosuid'],
    })),
  });

const planFor = (overrides = {}) =>
  harden({
    sessionId: 'a',
    sandboxSessionId: 'a-sandbox',
    networkPolicy: 'off',
    workspaceDir: '/workspaces/a',
    workspaceMountPoint: '/private/a/workspace',
    mounterSocketDir: '/private/a/9p',
    model: 'model-a',
    ...overrides,
  });

/**
 * @param {object} [faults]
 * @param {boolean} [faults.wrongImage] The evidence names another image.
 * @param {boolean} [faults.missingPublic] No public network evidence.
 * @param {boolean} [faults.wrongGrant] The evidence names another grant.
 * @param {boolean} [faults.wrongAccount] The grant names another account.
 * @param {boolean} [faults.wrongModel] The grant names another model.
 * @param {boolean} [faults.otherProxy] The evidence names another proxy
 *   than the grant.
 * @param {(attestation: any) => any} [faults.mutate] What the slice reports.
 */
const fixture = ({
  wrongImage = false,
  missingPublic = false,
  wrongGrant = false,
  wrongAccount = false,
  wrongModel = false,
  otherProxy = false,
  mutate = attestation => attestation,
} = {}) => {
  /** @type {any[]} */
  const events = [];
  /** @type {any} */
  let sliceOptions;
  const sandboxService = Far('SandboxService', {
    async provideScope(id) {
      events.push(`sandbox ${id}`);
      return Far('Scope', {
        async make(options) {
          events.push('make');
          sliceOptions = options;
          return Far('Slice', {
            async policy() {
              return harden(mutate(attestationFor(options.policy)));
            },
          });
        },
        async close() {
          await null;
        },
      });
    },
  });
  const brokerService = Far('BrokerService', {
    async provideScope(id, spec) {
      events.push(['grant', id, spec]);
      const network =
        spec.networkPolicy === 'public-internet' && !missingPublic
          ? harden({
              policy: 'public-internet',
              proxyUrl: 'http://127.0.0.1:9001',
              dnsHost: '127.0.0.53',
              resolverConfigPath: '/operator/public-resolv.conf',
            })
          : undefined;
      return Far('Grant', {
        async start() {
          events.push('start grant');
        },
        async attestation() {
          return harden({
            version: 'ProviderGrantV1',
            sessionId: id,
            grantId: 'grant-1',
            imageDigest: digest,
            accountRef: wrongAccount ? 'other' : 'account-a',
            authMode: 'api-key',
            networkNamespaceId: 'ns-1',
            ...(network ? { network } : {}),
            endpoint: 'http://127.0.0.1:9000',
            providerOrigin: 'https://provider.example',
            model: wrongModel ? 'model-z' : (spec.model ?? null),
            modelAdmission: 'account-catalog',
          });
        },
        async sandboxEvidence() {
          return harden({
            version: 'CodexBrokerSandboxEvidenceV1',
            sessionId: id,
            imageDigest: wrongImage ? otherDigest : digest,
            grantId: wrongGrant ? 'grant-2' : 'grant-1',
            networkNamespaceId: 'ns-1',
            brokerSidecar: { container: 'sidecar-1' },
            credentialInjection: 'broker-only',
            brokerTransport: 'loopback-sidecar',
            ...(network
              ? {
                  network: otherProxy
                    ? { ...network, proxyUrl: 'http://127.0.0.1:9002' }
                    : network,
                }
              : {}),
          });
        },
        async fence() {
          await null;
        },
        async revoke() {
          await null;
        },
      });
    },
  });
  const dependencies = { sandboxService, brokerService };
  const resolver = Far('Resolver', {
    get(name) {
      return dependencies[name];
    },
  });
  /** @type {Map<string, any>} */
  const owned = new Map();
  const owner = {
    own: (role, value) => {
      owned.set(role, value);
      return value;
    },
    assertOpen: () => {},
  };
  const adapter = harden({
    label: 'Test',
    makeMounter: () => ({
      mounter: Far('Mounter', {
        async mount() {
          events.push('mount');
        },
      }),
      async close() {
        await null;
      },
    }),
    makeFilesystem: () => Far('Workspace', {}),
    scopeRequest: plan => ({
      providerOrigin: 'https://provider.example',
      accountRef: 'account-a',
      networkPolicy: plan.networkPolicy,
      ...(plan.model ? { model: plan.model } : {}),
    }),
    image: () => ({ kind: 'oci', ref: `example@${digest}` }),
    authMode: () => 'api-key',
    prepare: async () => {
      events.push('prepare');
      return harden({ directory: '/state/a' });
    },
    tools: async ({ own }) => {
      events.push('tools');
      return own('mcp', harden({ innerDir: '/endo-mcp' }));
    },
    binds: ({ prepared }) => [
      {
        role: 'state',
        kind: 'bind',
        source: prepared.directory,
        destination: '/state',
        mode: 'rw',
      },
    ],
    bindRoots: () => ['/state'],
    sliceEnv: ({ attestation }) => ({
      BASE_URL: attestation.endpoint,
      TOKEN: 'placeholder',
    }),
    policy,
  });
  const activate = (plan = planFor(), overrides = {}) =>
    activateExecutionEnvelope(plan, resolver, owner, {
      ...adapter,
      ...overrides,
    });
  return { events, owned, activate, sliceOptions: () => sliceOptions };
};

test('activation acquires the scopes, checks the grant, prepares state, projects the workspace, stands up tools, then asks for the slice', async t => {
  const f = fixture();
  const envelope = await f.activate();
  t.deepEqual(
    f.events.map(event => (Array.isArray(event) ? event[0] : event)),
    [
      'sandbox a-sandbox',
      'grant',
      'start grant',
      'prepare',
      'mount',
      'tools',
      'make',
    ],
  );
  t.deepEqual(f.events[1], [
    'grant',
    'a-sandbox',
    {
      providerOrigin: 'https://provider.example',
      accountRef: 'account-a',
      networkPolicy: 'off',
      model: 'model-a',
    },
  ]);
  t.is(envelope.grant.grantId, 'grant-1');
  t.is(envelope.imageDigest, digest);
  t.is(envelope.publicNetwork, undefined);
  t.deepEqual(envelope.prepared, { directory: '/state/a' });
  t.deepEqual(envelope.tools, { innerDir: '/endo-mcp' });
  t.deepEqual(
    envelope.mounts.map(mount => mount.role),
    ['workspace', 'state', 'tmp', 'run'],
  );
  t.deepEqual([...f.owned.keys()], ['sandbox', 'broker', 'mounter', 'mcp']);
  const options = f.sliceOptions();
  t.like(options, {
    rootfs: { kind: 'oci', ref: `example@${digest}` },
    network: 'broker-only',
    cwd: WORKSPACE_PATH,
    env: { BASE_URL: 'http://127.0.0.1:9000', TOKEN: 'placeholder' },
    policy: {
      profile: 'hosted-agent-v1',
      imageDigest: digest,
      uid: 1000,
      gid: 1000,
      brokerSidecar: { container: 'sidecar-1' },
      bindRoots: ['/state'],
    },
  });
  t.is(
    options.policy.resources.writableBytes,
    sliceWritableBytes(envelope.mounts),
  );
  t.deepEqual(await E(envelope.slice).policy(), attestationFor(options.policy));
  t.is(envelope.policy.version, 'HostedAgentPolicyV1');
});

test('a public-internet plan gets the resolver row first and the attested proxy evidence', async t => {
  const f = fixture();
  const envelope = await f.activate(
    planFor({ networkPolicy: 'public-internet' }),
  );
  t.deepEqual(
    envelope.mounts.map(mount => mount.role),
    ['resolver', 'workspace', 'state', 'tmp', 'run'],
  );
  t.like(envelope.mounts[0], {
    kind: 'resolver',
    source: '/operator/public-resolv.conf',
    destination: '/etc/resolv.conf',
    mode: 'ro',
  });
  t.is(envelope.publicNetwork?.proxyUrl, 'http://127.0.0.1:9001');
});

for (const [name, faults, message] of /** @type {[string, any, RegExp][]} */ ([
  ['another image', { wrongImage: true }, /pinned image/],
  ['no public network evidence', { missingPublic: true }, /network evidence/],
  [
    'evidence naming another grant',
    { wrongGrant: true },
    /broker evidence differs/,
  ],
  ['a grant for another account', { wrongAccount: true }, /grant identity/],
  ['a grant for another model', { wrongModel: true }, /model binding/],
  [
    'evidence naming another proxy than the grant',
    { otherProxy: true },
    /broker evidence differs/,
  ],
])) {
  test(`the envelope refuses ${name} before any local effect`, async t => {
    const f = fixture(faults);
    const plan = planFor(
      faults.missingPublic || faults.otherProxy
        ? { networkPolicy: 'public-internet' }
        : {},
    );
    await t.throwsAsync(f.activate(plan), { message });
    t.false(f.events.includes('prepare'));
    t.false(f.events.includes('mount'));
    t.false(f.events.includes('make'));
  });
}

test('a slice whose raw attestation differs from the approved placement is refused after the handoff', async t => {
  for (const mutate of [
    attestation => ({ ...attestation, mounts: attestation.mounts.slice(1) }),
    attestation => ({
      ...attestation,
      limits: { ...attestation.limits, pids: attestation.limits.pids + 1 },
    }),
    attestation => ({ ...attestation, networkNamespaceId: 'ns-2' }),
    attestation => ({ ...attestation, readOnlyRoot: false }),
  ]) {
    const f = fixture({ mutate });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(f.activate(), {
      message: /raw slice attestation differs from the approved placement/,
    });
    t.true(f.events.includes('make'));
  }
});

test('the plan without a pinned model is granted unpinned', async t => {
  const f = fixture();
  const { model: _pinned, ...unpinned } = planFor();
  const envelope = await f.activate(harden(unpinned));
  t.is(envelope.grant.model, null);
  t.false('model' in f.events[1][2]);
});
