// @ts-check
import '@endo/init';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import test from 'ava';

import { makeBrokerAppServerArgv } from '../src/broker-launch.js';
import {
  makeAttestedCodexSliceFactory,
  makeAttestedCodexResourceProvisioner,
} from '../src/sandbox-policy.js';

const imageDigest = `sha256:${'a'.repeat(64)}`;
const identity = harden({
  sessionId: 's1',
  imageDigest,
  leaseId: 'lease1',
  networkNamespaceId: 'netns1',
});

// These are controlled evidence authorities, not substitutes for live probes.
const fixture = (changes = {}) => {
  const events = [];
  /** @type {number} */
  let cleanupFailures =
    typeof changes.cleanupFailures === 'number' ? changes.cleanupFailures : 0;
  let outerOverrides = changes.outer;
  let request;
  const slice = Far('slice', {
    policy: () => {
      const { policy } = request;
      return harden({
        version: 'SlicePolicyAttestationV1',
        profile: 'hosted-agent-v1',
        backend: 'rootless-podman',
        imageDigest,
        network: 'broker-only',
        networkNamespaceId: 'netns1',
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
        limits: policy.resources,
        mounts: policy.mounts.map(mount => ({
          role: mount.role,
          source:
            mount.kind === 'volume'
              ? `volume:${mount.source}`
              : mount.kind === 'attach'
                ? `attach:${mount.source}`
                : 'tmpfs',
          destination: mount.destination,
          mode: mount.kind === 'attach' ? mount.mode : 'rw',
          options: ['nodev', 'nosuid'],
        })),
        ...outerOverrides,
      });
    },
    dispose: () => {
      events.push('dispose');
      if (changes.cleanupError || cleanupFailures > 0) {
        cleanupFailures -= 1;
        throw Error('cleanup');
      }
    },
    spawn: () => {
      events.push('spawn');
      return Far('process', {});
    },
  });
  const powers = {
    imageDigest,
    imageRef: `registry.example/codex@${imageDigest}`,
    providerOrigin: 'https://api.example.com',
    accountRef: 'account1',
    sandbox: Far('sandbox', {
      make: options => {
        events.push('make');
        request = options;
        return slice;
      },
    }),
    volumeProvider: Far('volumes', {
      describe: () =>
        harden({
          sessionId: 's1',
          workspaceVolume: 'workspace-s1',
          stateVolume: 'state-s1',
          ...changes.volumes,
        }),
    }),
    runtimeVerifier: Far('verifier', {
      attest: context => {
        events.push('verify');
        if (context.slice !== slice) throw Error('wrong slice');
        if (
          context.launchArgv.join('\n') !==
          makeBrokerAppServerArgv('http://127.0.0.1:1234/').join('\n')
        ) {
          throw Error('wrong launch');
        }
        if (context.launchEnvironment.CODEX_HOME !== '/codex-home')
          throw Error('wrong environment');
        return harden({
          version: 'CodexRuntimeEvidenceV1',
          ...identity,
          toolSandbox: 'codex-workspace-write',
          toolCodexHomeAccess: 'read-only',
          toolBrokerAccess: 'denied',
          environment: 'credential-and-proxy-free',
          ...changes.runtime,
        });
      },
    }),
  };
  const makeSlice = makeAttestedCodexSliceFactory(powers);
  const brokerLease = Far('lease', {
    attestation: () =>
      harden({
        version: 'BrokerLeaseV1',
        ...identity,
        providerOrigin: 'https://api.example.com',
        accountRef: 'account1',
        endpoint: 'http://127.0.0.1:1234/',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        modelAllowlist: ['model1'],
        limits: { requests: 10, bytes: 1024n, costMicrounits: 100n },
      }),
    sandboxEvidence: () =>
      harden({
        version: 'CodexBrokerSandboxEvidenceV1',
        ...identity,
        brokerSidecar: { container: 'broker-s1' },
        credentialInjection: 'broker-only',
        brokerTransport: 'loopback-sidecar',
        ...changes.broker,
      }),
  });
  return {
    events,
    powers,
    brokerLease,
    retryCleanup: makeSlice.retryCleanup,
    setOuter: value => {
      outerOverrides = value;
    },
    request: () => request,
    create: (spec = {}) =>
      makeSlice({
        spec: { sessionId: 's1', model: 'model1', ...spec },
        workspaceMount: Far('workspace', {}),
        brokerLease,
      }),
  };
};

test('composes independently verified evidence with exact aggregate budgets', async t => {
  const f = fixture();
  const slice = await f.create();
  t.teardown(() => E(slice).dispose());
  const policy = await E(slice).policy();
  t.is(policy.version, 'HostedAgentPolicyV1');
  t.is(policy.mounts[0].source, 'workspace:s1');
  t.deepEqual(f.events, ['make', 'verify']);
  const request = f.request();
  t.deepEqual(request.env, {});
  t.is(request.network, 'broker-only');
  t.is(
    request.policy.resources.memoryBytes * 2n,
    BigInt(policy.limits.memoryBytes),
  );
  const storage = request.policy.mounts.reduce(
    (sum, mount) => sum + mount.sizeBytes * (mount.kind === 'tmpfs' ? 2n : 1n),
    2n * request.policy.resources.shmBytes,
  );
  t.is(storage, 16n * 1024n ** 3n);
});

for (const [name, changes] of [
  ['missing runtime proof', { runtime: { toolBrokerAccess: undefined } }],
  ['mismatched runtime identity', { runtime: { sessionId: 'other' } }],
  ['unattested environment', { runtime: { environment: undefined } }],
  ['unknown runtime assertion', { runtime: { extra: true } }],
  ['wrong broker namespace', { outer: { networkNamespaceId: 'other' } }],
  ['missing outer control', { outer: { seccomp: undefined } }],
  ['extra outer control', { outer: { ignored: true } }],
  ['undeclared mount', { outer: { mounts: [] } }],
]) {
  test(`rejects ${name} and disposes the slice`, async t => {
    const f = fixture(changes);
    await t.throwsAsync(f.create, { message: /not proved|unknown or missing/ });
    t.is(f.events.at(-1), 'dispose');
    t.false(f.events.includes('spawn'));
  });
}

test('bad broker or volume evidence prevents slice creation', async t => {
  await null;
  for (const changes of [
    { broker: { credentialInjection: 'environment' } },
    { volumes: { sessionId: 'other' } },
    { volumes: { stateVolume: 'workspace-s1' } },
  ]) {
    const f = fixture(changes);
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(f.create);
    t.deepEqual(f.events, []);
  }
});

test('default runtime verifier executes probes and refuses unavailable evidence', async t => {
  t.timeout(5000);
  const f = fixture();
  const create = makeAttestedCodexSliceFactory({
    ...f.powers,
    runtimeVerifier: undefined,
  });
  await t.throwsAsync(
    () =>
      create({
        spec: { sessionId: 's1', model: 'model1' },
        workspaceMount: Far('workspace', {}),
        brokerLease: f.brokerLease,
      }),
    { message: /Codex runtime verification failed/ },
  );
  t.true(f.events.includes('spawn'));
  t.is(f.events.at(-1), 'dispose');
});

test('rollback failure retains both errors', async t => {
  const f = fixture({
    runtime: { toolBrokerAccess: 'allowed' },
    cleanupError: true,
  });
  const error = await t.throwsAsync(f.create, { instanceOf: AggregateError });
  t.is(error.errors.length, 2);
  t.is(error.errors[1].message, 'cleanup');
});

test('failed admission retains cleanup authority and blocks new admission until reaped', async t => {
  t.timeout(2000);
  const f = fixture({
    runtime: { toolBrokerAccess: 'allowed' },
    cleanupFailures: 2,
  });
  await t.throwsAsync(f.create, { instanceOf: AggregateError });
  await t.throwsAsync(f.create, { message: 'cleanup' });
  t.is(f.events.filter(event => event === 'make').length, 1);
  await f.retryCleanup();
  t.is(f.events.filter(event => event === 'dispose').length, 3);
  await f.retryCleanup();
  t.is(f.events.filter(event => event === 'dispose').length, 3);
});

test('policy rejects drift and cannot attest a closing slice', async t => {
  const f = fixture({ cleanupFailures: 1 });
  const slice = await f.create();
  t.teardown(f.retryCleanup);
  f.setOuter({ seccomp: false });
  await t.throwsAsync(() => E(slice).policy(), { message: /not proved/ });
  await t.throwsAsync(() => E(slice).dispose(), { message: 'cleanup' });
  await t.throwsAsync(() => E(slice).policy(), {
    message: /disposal has started/,
  });
  await f.retryCleanup();
  await t.throwsAsync(() => E(slice).policy(), {
    message: /disposal has started/,
  });
});

test('spawn denies injected environment and changed cwd before reaching slice', async t => {
  const f = fixture();
  const slice = await f.create();
  t.teardown(() => E(slice).dispose());
  await t.throwsAsync(
    () =>
      E(slice).spawn(
        harden(['codex']),
        harden({
          cwd: '/workspace',
          env: { OPENAI_API_KEY: 'secret' },
        }),
      ),
    { message: /spawn environment/ },
  );
  await t.throwsAsync(
    () =>
      E(slice).spawn(
        harden(['codex']),
        harden({
          cwd: '/elsewhere',
          env: {
            CODEX_HOME: '/codex-home',
            HOME: '/home/node',
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
            TEMP: '/tmp',
            TMP: '/tmp',
            TMPDIR: '/tmp',
            TZ: 'UTC',
          },
        }),
      ),
    { message: /cwd must be/ },
  );
  t.false(f.events.includes('spawn'));
});

test('attested slice accepts only the broker launch and gives verifier the same launch', async t => {
  const f = fixture();
  const slice = await f.create();
  t.teardown(() => E(slice).dispose());
  const options = harden({
    cwd: '/workspace',
    env: {
      CODEX_HOME: '/codex-home',
      HOME: '/home/node',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TEMP: '/tmp',
      TMP: '/tmp',
      TMPDIR: '/tmp',
      TZ: 'UTC',
    },
  });
  await t.throwsAsync(
    () => E(slice).spawn(harden(['sh', '-c', 'codex app-server']), options),
    {
      message: /spawn argv/,
    },
  );
  t.false(f.events.includes('spawn'));
  const lease = await E(f.brokerLease).attestation();
  await E(slice).spawn(makeBrokerAppServerArgv(lease.endpoint), options);
  t.true(f.events.includes('spawn'));
});

test('attested resource provisioner wires verification into lifecycle and teardown', async t => {
  const f = fixture();
  const provision = makeAttestedCodexResourceProvisioner({
    ...f.powers,
    makeAuditJournal: async () => ({
      writer: Far('audit', { append: () => undefined }),
    }),
    makeWorkspace: async () => Far('workspace', {}),
    mountWorkspace: async () =>
      Far('mount', {
        unmount: async () => {
          f.events.push('unmount');
        },
      }),
    issueBrokerLease: async () =>
      Far('owned lease', {
        attestation: () => E(f.brokerLease).attestation(),
        sandboxEvidence: () => E(f.brokerLease).sandboxEvidence(),
        revoke: async () => {
          f.events.push('revoke');
        },
      }),
    startTransport: async () => undefined,
    loadThreadState: async () => ({}),
    saveThreadState: async () => undefined,
  });
  const resource = await provision({ sessionId: 's1', model: 'model1' });
  t.teardown(() => resource.dispose());
  t.is(resource.policy.version, 'HostedAgentPolicyV1');
  await resource.dispose();
  t.deepEqual(f.events, ['make', 'verify', 'dispose', 'revoke', 'unmount']);
  await provision.retryCleanup();
});

test('a declared attach is bound as a policy mount and attested by key', async t => {
  const f = fixture();
  const slice = await f.create({
    containerMounts: [
      {
        key: 'a1',
        source: '/host/mounts/claude-attach-a1',
        destination: '/mnt/project',
        mode: 'ro',
      },
    ],
  });
  t.teardown(() => E(slice).dispose());
  // The slice request carries the attach as the sandbox's own mount kind,
  // in the declared mode, with no storage ceiling of its own.
  const attach = f.request().policy.mounts.at(-1);
  t.deepEqual(attach, {
    role: 'attach-a1',
    kind: 'attach',
    source: '/host/mounts/claude-attach-a1',
    destination: '/mnt/project',
    mode: 'ro',
  });
  // The hosted policy names it by key, not by host path.
  const policy = await E(slice).policy();
  t.is(policy.mounts.length, 6);
  t.deepEqual(policy.mounts.at(-1), {
    role: 'attach-a1',
    source: 'attach:a1',
    destination: '/mnt/project',
    mode: 'ro',
    options: ['nodev', 'nosuid'],
  });
});

test('an attach the outer attestation does not carry fails slice creation', async t => {
  // The sandbox attested the fixed five but not the declared attach — the
  // driver refused the bind, or the kernel saw host data under it.
  const f = fixture({
    outer: {
      mounts: undefined,
    },
  });
  // `outer.mounts: undefined` deletes the field; rebuild it as the five.
  const five = fixture();
  await t.throwsAsync(
    () =>
      f.create({
        containerMounts: [
          {
            key: 'a1',
            source: '/host/mounts/claude-attach-a1',
            destination: '/mnt/project',
            mode: 'rw',
          },
        ],
      }),
    { message: /not proved|unknown or missing/ },
  );
  t.is(f.events.at(-1), 'dispose');
  void five;
});
