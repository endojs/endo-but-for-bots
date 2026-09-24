// @ts-check

import '@endo/init';

import path from 'node:path';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { assertCopyData } from '@endo/daemon/copy-data.js';

import {
  make,
  makeOpencodeNativeController,
} from '../src/opencode-native-controller.js';
import { makeOpencodeClient } from '../src/opencode-client.js';
import { makeSandboxSessionId } from '../src/opencode-session-plan.js';

const SANDBOX_A = makeSandboxSessionId('a');
const SANDBOX_B = makeSandboxSessionId('b');
const SANDBOX_OLD = makeSandboxSessionId('old');

/**
 * What a slice reports about itself, synthesized from the policy it was asked
 * for. The controller restates this as its hosted policy and checks it at the
 * authority handoff, so a stub that echoed the request would prove nothing:
 * the limits are the per-cgroup halves a runtime reports, and each source
 * carries the prefix its kind gets.
 * @param policy
 */
const sliceAttestationFor = policy =>
  harden({
    version: 'SlicePolicyAttestationV1',
    profile: policy.profile,
    backend: 'rootless-podman',
    imageDigest: policy.imageDigest,
    network: 'broker-only',
    networkNamespaceId: policy.brokerSidecar.container,
    uid: policy.uid,
    gid: policy.gid,
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
        mount.kind === 'tmpfs'
          ? 'tmpfs'
          : mount.kind === 'volume'
            ? `volume:${mount.source}`
            : `${mount.kind}:${mount.source}`,
      destination: mount.destination,
      mode: mount.mode ?? 'rw',
      options: ['nodev', 'nosuid'],
    })),
  });

const gate = () => {
  /** @type {(() => void) | undefined} */
  let resolve;
  const promise = new Promise(r => {
    resolve = () => r(undefined);
  });
  if (resolve === undefined) throw Error('Promise executor did not run');
  return { promise, resolve };
};
const planFor = id =>
  harden({
    sessionId: id,
    sandboxSessionId: makeSandboxSessionId(id),
    rootfs: `oci:example@sha256:${'a'.repeat(64)}`,
    accountRef: 'openrouter-main',
    networkPolicy: 'off',
    workspaceDir: `/workspaces/${id}`,
    workspaceMountPoint: `/private/${id}/work-mount`,
    mcpDir: `/private/${id}/mcp`,
    mounterSocketDir: `/private/${id}/9p`,
    model: 'openrouter/anthropic/claude-sonnet-4',
  });

const fixture = (t, { realClient = false } = {}) => {
  const events = [];
  const scopes = new Map();
  const grants = new Map();
  const clients = [];
  const faults = {
    catalogState: 'unavailable',
    catalogContext: 65_536,
    catalogOutput: undefined,
    catalogFail: false,
    catalogMissing: false,
    catalogWait: false,
    catalogNoContext: false,
    catalogModel: 'anthropic/claude-sonnet-4',
    catalogAccount: 'default',
    catalogDuplicate: false,
    /** @type {string | undefined} */
    resolverFail: undefined,
    reclaimFail: false,
    sandboxClose: false,
    mcpClose: false,
    mcpStart: false,
    mountWait: false,
    grantWait: false,
    badEvidence: false,
    missingPublic: false,
    wrongImage: false,
    lateScope: '',
  };
  const mountEntered = gate();
  const mountReleased = gate();
  const grantEntered = gate();
  const grantReleased = gate();
  const sandboxClosed = gate();
  const scopeEntered = gate();
  const scopeReleased = gate();
  const catalogEntered = gate();
  const catalogReleased = gate();
  const foreign = Far('Filesystem', {});
  const tools = Far('JournaledTools', {});
  const sandboxService = Far('SandboxService', {
    async provideScope(id) {
      events.push(`provide sandbox ${id}`);
      if (scopes.has(id)) return scopes.get(id);
      let closed = false;
      /** @param {any} options */
      const makeSlice = options => {
        if (closed) throw Error('scope closed');
        // Captured before `assertCopyData` narrows the value to its copy-data
        // union, which has no named fields to read back.
        const requested = options.policy;
        assertCopyData(options);
        events.push(['slice', id, options]);
        return Far('NativeSlice', {
          async dispose() {
            events.push(`dispose slice ${id}`);
          },
          async policy() {
            return sliceAttestationFor(requested);
          },
        });
      };
      const scope = Far('Scope', {
        /** @param {any} options */
        async make(options) {
          return makeSlice(options);
        },
        async makeResolved(options) {
          return makeSlice(options);
        },
        async close() {
          events.push(`close sandbox ${id}`);
          if (faults.sandboxClose) throw Error('sandbox close failed');
          closed = true;
          if (scopes.get(id) === scope) scopes.delete(id);
          sandboxClosed.resolve();
        },
      });
      scopes.set(id, scope);
      if (faults.lateScope === 'sandbox' && id === `${SANDBOX_A}`) {
        scopeEntered.resolve();
        await scopeReleased.promise;
      }
      return scope;
    },
    lookupScope(id) {
      events.push(`lookup sandbox ${id}`);
      return scopes.get(id);
    },
  });
  const brokerService = Far('BrokerService', {
    async modelCatalog() {
      if (faults.catalogWait) {
        catalogEntered.resolve();
        await catalogReleased.promise;
      }
      if (faults.catalogFail) throw Error('catalog owner retired');
      const result = {
        accounts: [
          {
            subscriptionId: faults.catalogAccount,
            state: faults.catalogState,
            observedAt: 0,
            models: faults.catalogMissing
              ? []
              : [
                  {
                    id: faults.catalogModel,
                    title: 'Model',
                    description: '',
                    default: false,
                    defaultReasoningEffort: null,
                    reasoningEfforts: [],
                    ...(faults.catalogNoContext
                      ? {}
                      : { contextLength: faults.catalogContext }),
                    ...(faults.catalogOutput === undefined
                      ? {}
                      : { maxOutputTokens: faults.catalogOutput }),
                  },
                ],
          },
        ],
      };
      if (faults.catalogDuplicate)
        result.accounts.push({
          ...result.accounts[0],
          subscriptionId: 'other',
        });
      return harden(result);
    },
    async provideScope(id, spec) {
      events.push(['grant', id, spec]);
      let closed = false;
      const network =
        spec.networkPolicy === 'public-internet' && !faults.missingPublic
          ? harden({
              policy: 'public-internet',
              proxyUrl: 'http://127.0.0.1:9001',
              dnsHost: '127.0.0.53',
              resolverConfigPath: '/operator/public-resolv.conf',
            })
          : undefined;
      const scope = Far('Grant', {
        async start() {
          if (faults.grantWait) {
            grantEntered.resolve();
            await grantReleased.promise;
          }
          if (closed) throw Error('grant closed');
        },
        // The grant and the evidence the shared issuer reports, held to the
        // session at activation: exact, so a stub that echoed less would
        // prove nothing.
        async attestation() {
          return harden({
            version: 'ProviderGrantV1',
            sessionId: id,
            grantId: `grant-${id}`,
            imageDigest: `sha256:${'a'.repeat(64)}`,
            accountRef: 'openrouter-main',
            authMode: 'api-key',
            networkNamespaceId: id,
            ...(network ? { network } : {}),
            endpoint: 'http://127.0.0.1:9000',
            providerOrigin: 'https://openrouter.ai',
            model: spec.model ?? null,
            modelAdmission: 'account-catalog',
          });
        },
        async sandboxEvidence() {
          return harden({
            version: 'CodexBrokerSandboxEvidenceV1',
            sessionId: id,
            imageDigest: `sha256:${(faults.wrongImage ? 'b' : 'a').repeat(64)}`,
            grantId: `grant-${id}`,
            networkNamespaceId: id,
            brokerSidecar: { container: id },
            credentialInjection: 'broker-only',
            brokerTransport: 'loopback-sidecar',
            ...(network ? { network } : {}),
            ...(faults.badEvidence ? { unexpected: foreign } : {}),
          });
        },
        async fence() {
          events.push(`fence grant ${id}`);
        },
        async revoke() {
          closed = true;
          grantReleased.resolve();
          events.push(`revoke ${id}`);
          if (grants.get(id) === scope) grants.delete(id);
        },
      });
      grants.set(id, scope);
      if (faults.lateScope === 'broker' && id === `${SANDBOX_A}`) {
        scopeEntered.resolve();
        await scopeReleased.promise;
      }
      return scope;
    },
    lookupScope(id) {
      events.push(`lookup grant ${id}`);
      return grants.get(id);
    },
  });
  const roles = {
    sandboxService,
    brokerService,
    tools,
  };
  const resolver = Far('Resolver', {
    async get(role) {
      events.push(`resolve ${role}`);
      if (role === 'stateProvider')
        throw Error('OpenCode has no native state provider');
      // Stands in for a service formula that refuses to revive.
      if (faults.resolverFail === role) throw Error(`cannot revive ${role}`);
      return roles[role];
    },
  });
  /** @param {any} [context] */
  const makeController = (context = undefined) => {
    const controller = makeOpencodeNativeController({
      context,
      // The real reclaim runs a privileged umount against a recorded path;
      // here it only records that it was asked, and for which mount point.
      async reclaimMount(recorded) {
        // The operator's own mounter settings reach the reclamation, so a host
        // whose mounts go through a privilege helper can unmount with it.
        events.push([
          'reclaim',
          recorded.workspaceMountPoint,
          recorded.mounterEnv?.XDG_RUNTIME_DIR,
        ]);
        if (faults.reclaimFail) throw Error('umount refused');
      },
      reportError: error => events.push(['cleanup error', error]),
      env: { XDG_RUNTIME_DIR: '/wrong-global' },
      makePassword: () => 'fresh-password',
      makeFilesystem(rootPath) {
        events.push(['filesystem', rootPath]);
        return Far('Filesystem', {});
      },
      makeMounter(env) {
        let closed = false;
        events.push(['mounter', env]);
        return harden({
          mounter: Far('Mounter', {
            async mount(fs, destination, options) {
              events.push(['mount', fs, destination, options]);
              if (faults.mountWait) {
                mountEntered.resolve();
                await mountReleased.promise;
              }
              if (closed) throw Error('mounter closed');
              return Far('Mount', {});
            },
            list: () => [],
            help: () => 'Injected mounter',
          }),
          async close() {
            closed = true;
            events.push('close mounter');
            mountReleased.resolve();
          },
        });
      },
      async makeBridge(cap) {
        t.is(cap, tools);
        return harden({
          handleMessage: async () => undefined,
          toolNames: [],
          pendingCalls: () => 0,
        });
      },
      makeMcp(options) {
        events.push(['mcp', options.socketDir]);
        return harden({
          ...options,
          socketPath: `${options.socketDir}/mcp.sock`,
          socketName: 'mcp.sock',
          stdioBridgeName: 'mcp-stdio-bridge.mjs',
          configFileName: 'mcp.json',
          innerDir: '/endo-mcp',
          innerConfigPath: '/endo-mcp/mcp.json',
          async start() {
            events.push('start mcp');
            if (faults.mcpStart) throw Error('mcp startup failed');
          },
          async close() {
            events.push('close mcp');
            if (faults.mcpClose) throw Error('mcp close failed');
          },
        });
      },
      makeClient(options) {
        clients.push(options);
        if (realClient) return makeOpencodeClient(options);
        t.false(Object.hasOwn(options, 'cleanupProvision'));
        const { slice } = options;
        if (slice === undefined) throw Error('Missing slice');
        return Far('Client', {
          async send(prompt) {
            events.push(['send', prompt]);
            return Far('ReplyReader', {});
          },
          async interrupt() {
            events.push('interrupt');
          },
          async status() {
            return harden({
              sessionId: options.sessionId,
              createdAt: options.createdAt,
              workspaceMountPoint: options.workspaceMountPoint,
              statePath: '/opencode-state',
              backend: 'podman',
              rootfs: options.rootfsLabel || '',
              model: options.model || '',
              network: 'join',
              opencodeSessionId: '',
              terminated: false,
              stopped: false,
              bridgeRunning: false,
              bridgeExited: false,
              pendingPrompts: 0,
              turnActive: false,
            });
          },
          async terminate() {
            await E(slice).dispose();
          },
          async destroy() {
            throw Error('Controller must not delete durable state');
          },
          help: () => 'Injected client',
        });
      },
    });
    return controller;
  };
  t.teardown(async () => {
    faults.sandboxClose = false;
    faults.mcpClose = false;
    mountReleased.resolve();
    grantReleased.resolve();
    scopeReleased.resolve();
    catalogReleased.resolve();
  });
  return {
    events,
    scopes,
    grants,
    clients,
    faults,
    resolver,
    makeController,
    mountEntered,
    grantEntered,
    sandboxService,
    sandboxClosed,
    scopeEntered,
    scopeReleased,
    catalogEntered,
    catalogReleased,
    tools,
  };
};

test('native controller construction is inert; activation uses copy paths and no initial turn', async t => {
  const f = fixture(t);
  const controller = f.makeController();
  t.deepEqual(f.events, []);
  const plan = planFor('a');
  await E(controller).activate(JSON.stringify(plan), f.resolver);
  t.is(f.clients.length, 1);
  t.is(f.clients[0].rootfsLabel, plan.rootfs);
  t.false(Object.hasOwn(f.clients[0], 'initialPrompt'));
  t.false(f.events.some(event => Array.isArray(event) && event[0] === 'send'));
  const [, , options] = f.events.find(
    event => Array.isArray(event) && event[0] === 'slice',
  );
  // The attested table: a projection for the workspace, binds attested as
  // binds for the CLI's own data directory and the MCP socket directory, and
  // declared ceilings for the writable scratch.
  t.deepEqual(
    options.policy.mounts.map(mount => [mount.role, mount.kind, mount.source]),
    [
      ['workspace', 'attach', plan.workspaceMountPoint],
      ['mcp', 'bind', plan.mcpDir],
      ['tmp', 'tmpfs', undefined],
      ['run', 'tmpfs', undefined],
    ],
  );
  // No durable state row. The CLI's own store is a cache of this
  // incarnation — the stack holds the conversation and restores it — so the
  // database runs in memory and its data directory sits on the slice's tmpfs.
  t.is(options.env.OPENCODE_DB, ':memory:');
  t.is(options.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX, '8192');
  t.is(options.env.XDG_DATA_HOME, '/tmp/opencode-home/.local/share');
  t.deepEqual(options.policy.bindRoots, [path.dirname(plan.mcpDir)]);
  t.is(options.network, 'broker-only');
  t.is(options.policy.brokerSidecar.container, `${SANDBOX_A}`);
  t.is(options.env.OPENROUTER_API_KEY, 'opencode-broker-placeholder');
  t.is(
    JSON.parse(options.env.OPENCODE_CONFIG_CONTENT).mcp.endo.command[2],
    '/endo-mcp/mcp.sock',
  );
  const [, mounterEnv] = f.events.find(
    event => Array.isArray(event) && event[0] === 'mounter',
  );
  t.is(mounterEnv.XDG_RUNTIME_DIR, plan.mounterSocketDir);
  // The workspace is projected from the recorded directory in this worker,
  // and its mount point is the mounter's to remove on unmount.
  t.deepEqual(
    f.events.find(event => Array.isArray(event) && event[0] === 'filesystem'),
    ['filesystem', plan.workspaceDir],
  );
  t.false(f.events.includes('resolve filesystem'));
  const [, , mountPoint, mountOptions] = f.events.find(
    event => Array.isArray(event) && event[0] === 'mount',
  );
  t.is(mountPoint, plan.workspaceMountPoint);
  t.deepEqual(mountOptions, { removeMountPointOnUnmount: true });
  await E(controller).send('recorded foreground turn');
  await E(controller).interrupt();
  t.is((await E(controller).status()).sessionId, 'a');
  await E(controller).terminate(JSON.stringify(plan), f.resolver);
  t.true((await E(controller).status()).stopped);
});

test('activation observes exact provider context while retaining a separate output budget', async t => {
  for (const state of ['current', 'stale', 'unavailable', 'unsupported']) {
    const f = fixture(t);
    f.faults.catalogState = state;
    f.faults.catalogOutput = 4096;
    const controller = f.makeController();
    // eslint-disable-next-line no-await-in-loop
    await E(controller).activate(JSON.stringify(planFor('a')), f.resolver);
    const [, , options] = f.events.find(
      event => Array.isArray(event) && event[0] === 'slice',
    );
    const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
    t.deepEqual(
      config.provider.openrouter.models['anthropic/claude-sonnet-4'].limit,
      ['current', 'stale'].includes(state)
        ? { context: 65_536, output: 4096 }
        : undefined,
    );
    t.is(options.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX, '8192');
  }
});

test('missing model metadata remains unknown and retired catalog owners abort activation', async t => {
  const f = fixture(t);
  f.faults.catalogState = 'current';
  f.faults.catalogMissing = true;
  await E(f.makeController()).activate(
    JSON.stringify(planFor('a')),
    f.resolver,
  );
  const [, , options] = f.events.find(
    event => Array.isArray(event) && event[0] === 'slice',
  );
  t.false(
    Object.hasOwn(
      JSON.parse(options.env.OPENCODE_CONFIG_CONTENT).provider.openrouter
        .models['anthropic/claude-sonnet-4'],
      'limit',
    ),
  );
  const g = fixture(t);
  g.faults.catalogFail = true;
  await t.throwsAsync(
    E(g.makeController()).activate(JSON.stringify(planFor('a')), g.resolver),
    { message: /catalog owner retired/ },
  );
  t.false(g.events.some(event => Array.isArray(event) && event[0] === 'slice'));
});

test('catalog metadata is exact, optional, and reobserved for each incarnation', async t => {
  const f = fixture(t);
  f.faults.catalogState = 'current';
  const text = JSON.stringify(planFor('a'));
  for (const context of [65_536, 131_072]) {
    f.faults.catalogContext = context;
    f.faults.catalogOutput = context / 16;
    const controller = f.makeController();
    // eslint-disable-next-line no-await-in-loop
    await E(controller).activate(text, f.resolver);
    const [, , options] = f.events
      .filter(event => Array.isArray(event) && event[0] === 'slice')
      .at(-1);
    t.is(
      JSON.parse(options.env.OPENCODE_CONFIG_CONTENT).provider.openrouter
        .models['anthropic/claude-sonnet-4'].limit.context,
      context,
    );
    t.is(
      JSON.parse(options.env.OPENCODE_CONFIG_CONTENT).provider.openrouter
        .models['anthropic/claude-sonnet-4'].limit.output,
      context / 16,
    );
    // eslint-disable-next-line no-await-in-loop
    await E(controller).terminate(text, f.resolver);
  }
  for (const kind of ['wrong-model', 'no-context']) {
    const g = fixture(t);
    g.faults.catalogState = 'current';
    if (kind === 'wrong-model') g.faults.catalogModel = 'vendor/another-model';
    else g.faults.catalogNoContext = true;
    // eslint-disable-next-line no-await-in-loop
    await E(g.makeController()).activate(text, g.resolver);
    const [, , options] = g.events.find(
      event => Array.isArray(event) && event[0] === 'slice',
    );
    t.false(
      Object.hasOwn(
        JSON.parse(options.env.OPENCODE_CONFIG_CONTENT).provider.openrouter
          .models['anthropic/claude-sonnet-4'],
        'limit',
      ),
    );
  }
});

test('malformed catalog facts and unexpected accounts cannot start a slice', async t => {
  for (const change of [
    { catalogContext: 0 },
    { catalogContext: -1 },
    { catalogContext: 0x1_0000_0000 },
    { catalogOutput: 0 },
    { catalogOutput: -1 },
    { catalogOutput: 0x1_0000_0000 },
    { catalogAccount: 'other' },
    { catalogDuplicate: true },
  ]) {
    const f = fixture(t);
    Object.assign(f.faults, change, { catalogState: 'current' });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      E(f.makeController()).activate(JSON.stringify(planFor('a')), f.resolver),
    );
    t.false(
      f.events.some(event => Array.isArray(event) && event[0] === 'slice'),
    );
  }
});

test('output-only observation configures only the exact selected route and retains execution budget', async t => {
  const f = fixture(t);
  f.faults.catalogState = 'current';
  f.faults.catalogNoContext = true;
  f.faults.catalogOutput = 16_384;
  await E(f.makeController()).activate(
    JSON.stringify(planFor('a')),
    f.resolver,
  );
  const [, , options] = f.events.find(
    event => Array.isArray(event) && event[0] === 'slice',
  );
  const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
  t.deepEqual(
    config.provider.openrouter.models['anthropic/claude-sonnet-4'].limit,
    { output: 16_384 },
  );
  t.is(options.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX, '8192');
});

test('null output and absent context leave model limits unspecified', async t => {
  const f = fixture(t);
  f.faults.catalogState = 'current';
  f.faults.catalogNoContext = true;
  f.faults.catalogOutput = null;
  await E(f.makeController()).activate(
    JSON.stringify(planFor('a')),
    f.resolver,
  );
  const [, , options] = f.events.find(
    event => Array.isArray(event) && event[0] === 'slice',
  );
  const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
  t.false(
    Object.hasOwn(
      config.provider.openrouter.models['anthropic/claude-sonnet-4'],
      'limit',
    ),
  );
  t.is(options.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX, '8192');
});

test('late catalog completion after termination cannot create native effects', async t => {
  t.timeout(3000);
  const f = fixture(t);
  f.faults.catalogWait = true;
  f.faults.catalogState = 'current';
  const controller = f.makeController();
  const text = JSON.stringify(planFor('a'));
  const failed = t.throwsAsync(E(controller).activate(text, f.resolver), {
    message: /stopping/,
  });
  await f.catalogEntered.promise;
  const stopping = E(controller).terminate(text, f.resolver);
  await f.sandboxClosed.promise;
  f.catalogReleased.resolve();
  await Promise.all([failed, stopping]);
  t.is(f.clients.length, 0);
  t.is(f.scopes.size, 0);
  t.is(f.grants.size, 0);
  t.false(
    f.events.some(
      event =>
        Array.isArray(event) && ['slice', 'mounter', 'mcp'].includes(event[0]),
    ),
  );
});

test('recorded mounter settings reach the session mounter beneath its own socket directory', async t => {
  const f = fixture(t);
  const controller = f.makeController();
  const plan = harden({
    ...planFor('a'),
    mounterEnv: { NINEP_SUDO: '1', NINEP_MOUNT_PROGRAM: 'sudo -n mount' },
  });
  await E(controller).activate(JSON.stringify(plan), f.resolver);
  const [, mounterEnv] = f.events.find(
    event => Array.isArray(event) && event[0] === 'mounter',
  );
  t.deepEqual(mounterEnv, {
    NINEP_SUDO: '1',
    NINEP_MOUNT_PROGRAM: 'sudo -n mount',
    XDG_RUNTIME_DIR: plan.mounterSocketDir,
    NINEP_SOCKET_DIR: plan.mounterSocketDir,
  });
});

test('scope cleanup failure retains mounts and permits sibling progress before retry', async t => {
  const f = fixture(t);
  const a = f.makeController();
  const b = f.makeController();
  await E(a).activate(JSON.stringify(planFor('a')), f.resolver);
  await E(b).activate(JSON.stringify(planFor('b')), f.resolver);
  f.faults.sandboxClose = true;
  await t.throwsAsync(
    E(a).terminate(JSON.stringify(planFor('a')), f.resolver),
    { message: /cleanup pending/ },
  );
  t.false(f.events.includes('close mounter'));
  t.true(f.grants.has(`${SANDBOX_B}`));
  await E(b).send('sibling still works');
  f.faults.sandboxClose = false;
  await E(a).terminate(JSON.stringify(planFor('a')), f.resolver);
  t.true(f.scopes.has(`${SANDBOX_B}`));
  await t.throwsAsync(E(a).send('stale'), { message: /stopping/ });
  await E(b).terminate(JSON.stringify(planFor('b')), f.resolver);
});

for (const kind of ['mount', 'grant']) {
  test(`termination reaches ${kind} acquisition that waits for cancellation`, async t => {
    t.timeout(3000);
    const f = fixture(t);
    f.faults[`${kind}Wait`] = true;
    const controller = f.makeController();
    const text = JSON.stringify(planFor('a'));
    const failed = t.throwsAsync(E(controller).activate(text, f.resolver), {
      message: /closed|stopping/,
    });
    await f[`${kind}Entered`].promise;
    await E(controller).terminate(text, f.resolver);
    await failed;
    t.true((await E(controller).status()).stopped);
    t.is(f.clients.length, 0);
  });
}

for (const kind of ['sandbox', 'broker']) {
  test(`termination retains the original late ${kind} scope before acknowledging release`, async t => {
    t.timeout(3000);
    const f = fixture(t);
    f.faults.lateScope = kind;
    const a = f.makeController();
    const b = f.makeController();
    const text = JSON.stringify(planFor('a'));
    const failed = t.throwsAsync(E(a).activate(text, f.resolver), {
      message: /stopping/,
    });
    await f.scopeEntered.promise;
    let closed = false;
    const stopping = E(a)
      .terminate(text, f.resolver)
      .then(() => {
        closed = true;
      });
    await E(b).activate(JSON.stringify(planFor('b')), f.resolver);
    t.false(closed);
    t.true(
      kind === 'sandbox'
        ? f.scopes.has(`${SANDBOX_A}`)
        : f.grants.has(`${SANDBOX_A}`),
    );
    f.scopeReleased.resolve();
    await Promise.all([failed, stopping]);
    t.false(f.scopes.has(`${SANDBOX_A}`));
    t.false(f.grants.has(`${SANDBOX_A}`));
    t.true(f.scopes.has(`${SANDBOX_B}`));
    t.true(f.grants.has(`${SANDBOX_B}`));
    await E(b).terminate(JSON.stringify(planFor('b')), f.resolver);
  });
}

test('reconstruction uses lookup, reclaims the recorded mount, and invents nothing', async t => {
  const f = fixture(t);
  const controller = f.makeController();
  await E(controller).terminate(JSON.stringify(planFor('old')), f.resolver);
  t.true(f.events.includes(`lookup sandbox ${SANDBOX_OLD}`));
  t.true(f.events.includes(`lookup grant ${SANDBOX_OLD}`));
  // The only structured event is the reclamation of the recorded mount: no
  // mounter, bridge or MCP socket was made to stand in for the lost ones.
  t.deepEqual(
    f.events.filter(event => Array.isArray(event)),
    [['reclaim', '/private/old/work-mount', '/wrong-global']],
  );
  t.true((await E(controller).status()).stopped);
});

test('a mount that cannot be reclaimed keeps the session stoppable, not stopped', async t => {
  const f = fixture(t);
  const text = JSON.stringify(planFor('old'));
  f.faults.reclaimFail = true;
  const controller = f.makeController();
  await t.throwsAsync(E(controller).terminate(text, f.resolver), {
    message: /Original local 9P\/MCP cleanup ownership is unavailable/,
  });
  t.false((await E(controller).status()).stopped);
  f.faults.reclaimFail = false;
  await E(controller).terminate(text, f.resolver);
  t.true((await E(controller).status()).stopped);
});

test('a shared service that cannot be revived no longer blocks cleanup', async t => {
  const f = fixture(t);
  f.faults.resolverFail = 'sandboxService';
  const controller = f.makeController();
  await E(controller).terminate(JSON.stringify(planFor('old')), f.resolver);
  t.true((await E(controller).status()).stopped);
  t.true(
    f.events.some(
      event => Array.isArray(event) && event[0] === 'cleanup error',
    ),
  );
});

test('MCP drain failure remains retryable after the sandbox has closed', async t => {
  const f = fixture(t);
  const controller = f.makeController();
  const text = JSON.stringify(planFor('a'));
  await E(controller).activate(text, f.resolver);
  f.faults.mcpClose = true;
  await t.throwsAsync(E(controller).terminate(text, f.resolver), {
    message: /cleanup pending/,
  });
  t.false((await E(controller).status()).stopped);
  f.faults.mcpClose = false;
  await E(controller).terminate(text, f.resolver);
  t.true((await E(controller).status()).stopped);
});

test('native entrypoint validates the promised powers supplied by the daemon', async t => {
  await t.throwsAsync(
    Reflect.apply(make, undefined, [
      Promise.resolve(Far('Host', {})),
      undefined,
    ]),
    {
      message: /null powers/,
    },
  );
  const controller = await make(Promise.resolve(null), undefined);
  t.deepEqual(await E(controller).status(), {
    stopping: false,
    stopped: false,
  });
});

test('rejected initial plan is an observed activation, not lost cleanup ownership', async t => {
  const f = fixture(t);
  const controller = f.makeController();
  for (const text of ['null', '"plan"', '[]']) {
    // Copy data, but not a record: refused structurally, not by a stray
    // property read. Each controller admits one plan text, so use a fresh one.
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(E(f.makeController()).activate(text, f.resolver), {
      message: /plan must be a record/,
    });
  }
  const invalid = JSON.stringify({ sessionId: 'a' });
  await t.throwsAsync(E(controller).activate(invalid, f.resolver), {
    message: /Missing session plan field/,
  });
  await E(controller).terminate(invalid, f.resolver);
  t.deepEqual(f.events, []);
  t.true((await E(controller).status()).stopped);
});

test('real eager client disposes its slice and never starts the discarded initial prompt', async t => {
  const f = fixture(t, { realClient: true });
  const controller = f.makeController();
  const text = JSON.stringify(planFor('a'));
  await E(controller).activate(text, f.resolver);
  t.is((await E(controller).status()).opencodeSessionId, '');
  await E(controller).terminate(text, f.resolver);
  t.like(await E(controller).status(), { terminated: true, stopped: true });
  t.is(f.scopes.size, 0);
});

test('retired native session resume plan acquires no resources', async t => {
  const f = fixture(t);
  const controller = f.makeController();
  const text = JSON.stringify({
    ...planFor('a'),
    opencodeSessionId: 'ses_old',
  });
  await t.throwsAsync(E(controller).activate(text, f.resolver), {
    message: /Unknown session plan field "opencodeSessionId"/,
  });
  t.deepEqual(f.events, []);
});

test('terminating a session that has a live client revokes its grant', async t => {
  // The grant is the only thing between a session and the operator's
  // credential, and it no longer carries an expiry, so an unrevoked one is
  // indefinite access. Terminate must revoke it on the ordinary path — a
  // session that activated successfully and still holds its client.
  //
  // Both adapters now delegate lifecycle ownership to the shared supervisor.
  // The client disposes its slice, and cannot withhold the supervisor's grant
  // revocation by failing or hanging during its own shutdown.
  const f = fixture(t, { realClient: true });
  const controller = f.makeController();
  const text = JSON.stringify(planFor('a'));
  await E(controller).activate(text, f.resolver);
  t.true(f.grants.size > 0, 'an activated session holds a broker grant');
  await E(controller).terminate(text, f.resolver);
  t.is(f.grants.size, 0, 'the grant is revoked, not merely abandoned');
  t.is(f.scopes.size, 0);
  t.is(
    f.events.filter(event => event === `revoke ${SANDBOX_A}`).length,
    1,
    'revoked exactly once',
  );
});

test('failed MCP startup retains cleanup before its rejection', async t => {
  const f = fixture(t);
  f.faults.mcpStart = true;
  const controller = f.makeController();
  const text = JSON.stringify(planFor('a'));
  await t.throwsAsync(E(controller).activate(text, f.resolver), {
    message: /mcp startup failed/,
  });
  await E(controller).terminate(text, f.resolver);
  t.true(f.events.includes('close mcp'));
  t.true(f.events.includes('close mounter'));
  t.is(f.scopes.size, 0);
  t.is(f.grants.size, 0);
});

test('noncopy service evidence cannot enter shared native acquisition', async t => {
  const f = fixture(t);
  f.faults.badEvidence = true;
  const controller = f.makeController();
  const text = JSON.stringify(planFor('a'));
  await t.throwsAsync(E(controller).activate(text, f.resolver), {
    message: /copy data/,
  });
  t.false(f.events.some(event => Array.isArray(event) && event[0] === 'slice'));
  await E(controller).terminate(text, f.resolver);
  t.is(f.scopes.size, 0);
});

test('public network uses approved proxy environment and literal resolver contents', async t => {
  const f = fixture(t);
  const controller = f.makeController();
  const text = JSON.stringify({
    ...planFor('a'),
    networkPolicy: 'public-internet',
  });
  await E(controller).activate(text, f.resolver);
  const [, , options] = f.events.find(
    event => Array.isArray(event) && event[0] === 'slice',
  );
  t.is(options.env.HTTP_PROXY, 'http://127.0.0.1:9001');
  t.is(options.env.NO_PROXY, '127.0.0.1');
  // The operator's generated nameserver file is a declared mount, the way
  // Codex has always had it, not a `generatedFiles` entry the attested table
  // would have no row for.
  t.false('generatedFiles' in options);
  t.deepEqual(options.policy.mounts[0], {
    role: 'resolver',
    kind: 'resolver',
    source: '/operator/public-resolv.conf',
    destination: '/etc/resolv.conf',
    mode: 'ro',
  });
  // The operator's per-adapter native profile no longer selects the slice's
  // limits: every hosted adapter runs the one shared resource profile, which
  // is what makes the attested contract comparable across the three.
  t.false('nativeProfile' in options);
  t.false('limits' in options);
  t.is(options.policy.profile, 'hosted-agent-v1');
  await E(controller).terminate(text, f.resolver);
});

for (const [fault, message] of /** @type {const} */ ([
  ['missingPublic', /network evidence/],
  ['wrongImage', /pinned image/],
])) {
  test(`controller refuses ${fault} before native filesystem effects`, async t => {
    const f = fixture(t);
    f.faults[fault] = true;
    const controller = f.makeController();
    const text = JSON.stringify({
      ...planFor('a'),
      networkPolicy: 'public-internet',
    });
    await t.throwsAsync(E(controller).activate(text, f.resolver), { message });
    t.false(
      f.events.some(event => Array.isArray(event) && event[0] === 'mount'),
    );
    await E(controller).terminate(text, f.resolver);
    t.is(f.scopes.size, 0);
    t.is(f.grants.size, 0);
  });
}

test('context loss fences the active client and starts retained cleanup', async t => {
  t.timeout(3000);
  const f = fixture(t);
  const cancelled = gate();
  const context = Far('Context', { whenCancelled: () => cancelled.promise });
  const controller = f.makeController(context);
  const text = JSON.stringify(planFor('a'));
  await E(controller).activate(text, f.resolver);
  cancelled.resolve();
  await f.sandboxClosed.promise;
  await t.throwsAsync(E(controller).send('after cancellation'), {
    message: /stopping/,
  });
  await E(controller).terminate(text, f.resolver);
  t.is(f.scopes.size, 0);
  t.is(f.grants.size, 0);
});

test('reconstructed cleanup releases known shared scopes and never touches the live owner\u2019s locals', async t => {
  const f = fixture(t);
  const old = f.makeController();
  const text = JSON.stringify(planFor('a'));
  await E(old).activate(text, f.resolver);
  const reconstructed = f.makeController();
  const boundary = f.events.length;
  await E(reconstructed).terminate(text, f.resolver);
  t.is(f.scopes.size, 0);
  t.is(f.grants.size, 0);
  // The reconstruction has no mounter or MCP socket of its own and must not
  // reach for the still-live owner's. (On a live host the reclamation would
  // refuse here too: that owner's 9P bridge is still serving its socket.)
  t.false(f.events.slice(boundary).includes('close mounter'));
  t.false(f.events.slice(boundary).includes('close mcp'));
  await E(old).terminate(text, f.resolver);
});
