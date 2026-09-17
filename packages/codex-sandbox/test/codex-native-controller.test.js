// @ts-check
import '@endo/init';
import test from 'ava';
import { Far } from '@endo/far';
import { makeSandboxSessionId } from '@endo/hosted-agent/session-plan.js';
import { assertSlicePolicyRequest } from '@endo/sandbox/policy.js';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeCodexNativeController } from '../src/codex-native-controller.js';
import { makeCodexStateProvider } from '../src/codex-state-provider.js';
import { makeCodexSessionState } from '../src/codex-session-store.js';

const imageDigest = `sha256:${'a'.repeat(64)}`;

/**
 * A protocol fixture, not evidence of confinement on a live native host.
 * @param {any} policy
 */
const slicePolicy = policy =>
  harden({
    version: 'SlicePolicyAttestationV1',
    profile: 'hosted-agent-v1',
    backend: 'rootless-podman',
    imageDigest,
    network: 'broker-only',
    networkNamespaceId: 'broker-a',
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
        mount.kind === 'tmpfs' ? 'tmpfs' : `${mount.kind}:${mount.source}`,
      destination: mount.destination,
      mode: mount.mode ?? 'rw',
      options: ['nodev', 'nosuid'],
    })),
  });

const fixture = async (
  t,
  {
    wrongAccount = false,
    probeFails = false,
    mutatePolicy = policy => policy,
  } = {},
) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-native-')));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  const sandboxSessionId = makeSandboxSessionId('session-a', 'codex');
  const plan = harden({
    sessionId: 'session-a',
    sandboxSessionId,
    imageRef: `example@${imageDigest}`,
    accountRef: 'account-a',
    networkPolicy: 'off',
    workspaceDir: join(root, 'workspace'),
    workspaceMountPoint: join(root, 'mount'),
    mounterSocketDir: join(root, '9p'),
    containerMounts: [],
    model: 'model-a',
    nativeProfile: {
      uid: 1000,
      gid: 1000,
      memoryBytes: '536870912',
      cpuQuotaMicros: '200000',
      pids: 128,
      cpuPeriodMicros: 100_000,
      maxConcurrentOperations: 1,
    },
  });
  const text = JSON.stringify(plan);
  const events = [];
  let sliceOptions;
  let clientOptions;
  const stateProvider = makeCodexStateProvider({
    stateRoot: join(root, 'state'),
  });
  const grant = harden({
    version: 'ProviderGrantV1',
    sessionId: sandboxSessionId,
    imageDigest,
    networkNamespaceId: 'broker-a',
    grantId: 'grant-a',
    providerOrigin: 'https://chatgpt.com',
    accountRef: wrongAccount ? 'wrong' : 'account-a',
    authMode: 'oauth',
    endpoint: 'http://127.0.0.1:9000',
    modelAllowlist: ['model-a'],
  });
  const brokerScope = Far('BrokerScope', {
    async start() {
      events.push('broker-start');
    },
    async attestation() {
      return grant;
    },
    async sandboxEvidence() {
      return harden({
        version: 'CodexBrokerSandboxEvidenceV1',
        sessionId: sandboxSessionId,
        imageDigest,
        networkNamespaceId: 'broker-a',
        grantId: 'grant-a',
        brokerSidecar: { container: 'broker-a' },
        credentialInjection: 'broker-only',
        brokerTransport: 'loopback-sidecar',
      });
    },
    async fence() {
      events.push('fence');
    },
    async revoke() {
      events.push('revoke');
    },
  });
  const sandboxScope = Far('SandboxScope', {
    async make(options) {
      assertSlicePolicyRequest(options.policy);
      sliceOptions = options;
      events.push('slice');
      return Far('Slice', {
        async policy() {
          return harden(mutatePolicy(slicePolicy(options.policy)));
        },
      });
    },
    async close() {
      events.push('sandbox-close');
    },
  });
  const dependencies = {
    sandboxService: Far('SandboxService', {
      async provideScope() {
        return sandboxScope;
      },
    }),
    brokerService: Far('BrokerService', {
      async provideScope() {
        return brokerScope;
      },
    }),
    stateProvider,
    tools: Far('Tools', {
      async describe() {
        return harden({ dynamicTools: [], toolSetId: 'tools-a' });
      },
    }),
  };
  const resolver = Far('Resolver', {
    get(name) {
      return dependencies[name];
    },
  });
  // Injectable CLI/verifier boundaries: the assertions below concern native
  // ownership and capability handoff, not the fake client's protocol behavior.
  const powers = {
    makeFilesystem: () => Far('Workspace', {}),
    makeMounter: () => ({
      mounter: Far('Mounter', {
        async mount() {
          events.push('mount');
        },
      }),
      async close() {
        events.push('unmount');
      },
    }),
    makeVerifier: () =>
      Far('Verifier', {
        async attest(context) {
          events.push('probe');
          if (probeFails) throw Error('runtime probe refused');
          return harden({
            version: 'CodexRuntimeEvidenceV1',
            sessionId: sandboxSessionId,
            imageDigest,
            grantId: context.grantId,
            networkNamespaceId: context.networkNamespaceId,
            executionDomain: 'guest',
            environment: 'credential-and-proxy-free',
            codexHomeAuthFile: 'absent',
          });
        },
      }),
    makeClient: options => {
      clientOptions = options;
      events.push('client');
      return Far('Client', {
        async send() {
          return 'reply';
        },
        async interrupt() {
          events.push('interrupt');
        },
        async status() {
          return harden({});
        },
        async models() {
          return harden([]);
        },
        async acknowledge() {
          events.push('acknowledge');
        },
        async terminate() {
          events.push('client-stop');
        },
      });
    },
    reportError: () => {},
  };
  const controller = makeCodexNativeController(/** @type {any} */ (powers));
  return {
    root,
    plan,
    text,
    resolver,
    controller,
    events,
    stateProvider,
    sliceOptions: () => sliceOptions,
    clientOptions: () => clientOptions,
  };
};

test('Codex supervisor binds only CLI state and hands host checkpoint recovery to its client', async t => {
  const f = await fixture(t);
  const records = await f.stateProvider.prepareSessionDirectory(
    f.plan.sandboxSessionId,
  );
  const state = await makeCodexSessionState(records.directory);
  await state.writeThread(
    harden({
      threadId: 'prior-thread',
      toolSetId: 'prior-tools',
      recovery: { baseTurnId: null },
    }),
  );
  await f.controller.activate(f.text, f.resolver);
  const options = f.sliceOptions();
  const home = options.policy.mounts.find(
    mount => mount.role === 'codex-state',
  );
  t.is(home.kind, 'bind');
  t.is(
    home.source,
    join(f.root, 'state', 'cli_homes', f.plan.sandboxSessionId),
  );
  t.false(
    options.policy.mounts.some(mount => mount.source === records.directory),
  );
  t.is(f.clientOptions().threadId, 'prior-thread');
  t.deepEqual(f.clientOptions().savedRecovery, { baseTurnId: null });
  t.true(f.events.indexOf('probe') < f.events.indexOf('client'));
  await f.controller.terminate(f.text, f.resolver);
  t.true(f.events.indexOf('sandbox-close') < f.events.indexOf('unmount'));
  t.true(f.events.indexOf('sandbox-close') < f.events.indexOf('revoke'));
  t.is(f.events.filter(event => event === 'fence').length, 1);
});

test('wrong subscription evidence is refused before workspace or CLI acquisition', async t => {
  const f = await fixture(t, { wrongAccount: true });
  await t.throwsAsync(f.controller.activate(f.text, f.resolver), {
    message: /identity does not match/,
  });
  await f.controller.terminate(f.text, f.resolver);
  t.false(f.events.includes('mount'));
  t.false(f.events.includes('client'));
  t.true(f.events.includes('fence'));
  t.true(f.events.includes('sandbox-close'));
});

test('runtime probe failure releases acquired scopes and projection without starting Codex', async t => {
  const f = await fixture(t, { probeFails: true });
  await t.throwsAsync(f.controller.activate(f.text, f.resolver), {
    message: /runtime probe refused/,
  });
  await f.controller.terminate(f.text, f.resolver);
  t.false(f.events.includes('client'));
  t.true(f.events.includes('unmount'));
  t.true(f.events.indexOf('sandbox-close') < f.events.indexOf('unmount'));
});

for (const role of ['codex-state', 'workspace']) {
  test(`raw attestation refuses a substituted ${role} source before normalization`, async t => {
    const f = await fixture(t, {
      mutatePolicy: policy => ({
        ...policy,
        mounts: policy.mounts.map(mount =>
          mount.role === role
            ? {
                ...mount,
                source: `${role === 'workspace' ? 'attach' : 'bind'}:/host/records`,
              }
            : mount,
        ),
      }),
    });
    await t.throwsAsync(f.controller.activate(f.text, f.resolver), {
      message: /raw slice attestation/,
    });
    await f.controller.terminate(f.text, f.resolver);
    t.false(f.events.includes('probe'));
    t.false(f.events.includes('client'));
    t.true(f.events.includes('unmount'));
  });
}

for (const field of ['version', 'profile']) {
  test(`raw attestation refuses an unknown ${field}`, async t => {
    const f = await fixture(t, {
      mutatePolicy: policy => ({ ...policy, [field]: 'unknown' }),
    });
    await t.throwsAsync(f.controller.activate(f.text, f.resolver), {
      message: /raw slice attestation/,
    });
    await f.controller.terminate(f.text, f.resolver);
    t.false(f.events.includes('client'));
  });
}

test('raw attestation refuses omitted resource controls', async t => {
  const f = await fixture(t, {
    mutatePolicy: policy => ({
      ...policy,
      limits: {
        memoryBytes: policy.limits.memoryBytes,
        pids: policy.limits.pids,
        cpuCores: policy.limits.cpuCores,
        openFiles: policy.limits.openFiles,
        coreBytes: policy.limits.coreBytes,
        writableBytes: policy.limits.writableBytes,
      },
    }),
  });
  await t.throwsAsync(f.controller.activate(f.text, f.resolver), {
    message: /raw slice attestation/,
  });
  await f.controller.terminate(f.text, f.resolver);
  t.false(f.events.includes('probe'));
});
