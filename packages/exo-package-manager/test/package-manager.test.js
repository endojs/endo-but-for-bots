// @ts-check
/// <reference types="ses"/>

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';

import {
  getPackageManagerFacetName,
  isPackageManagerReadOnly,
  makePackageManager,
  makePackageManagerKit,
} from '@endo/exo-package-manager';

/** @import { InstallBackendInput, InspectWorkspaceInput } from '../src/types.js' */
/** @import { PackageManagerBackend, RunBackendInput } from '../src/types.js' */
/** @import { WorkspaceSnapshot } from '../src/types.js' */

/**
 * @typedef {PackageManagerBackend & {
 *   inspectCalls: InspectWorkspaceInput[];
 *   installCalls: InstallBackendInput[];
 *   runCalls: RunBackendInput[];
 *   cancelCalls: string[];
 *   ops: Map<string, { cancel: () => void }>;
 * }} FakeBackend
 */

const LINEAGE = harden({});

/**
 * @param {object} facet
 * @returns {Promise<string[]>}
 */
const methodNamesOf = async facet =>
  // eslint-disable-next-line no-underscore-dangle
  E(/** @type {any} */ (facet)).__getMethodNames__();

/**
 * @param {Partial<WorkspaceSnapshot>} [snapshot]
 * @returns {FakeBackend}
 */
const makeFakeBackend = (snapshot = {}) => {
  // Tracking arrays stay mutable and outside harden() so SES cannot freeze them.
  /** @type {object[]} */
  const inspectCalls = [];
  /** @type {object[]} */
  const installCalls = [];
  /** @type {object[]} */
  const runCalls = [];
  /** @type {string[]} */
  const cancelCalls = [];
  /** @type {Map<string, { cancel: () => void }>} */
  const ops = new Map();

  const defaultSnapshot = {
    snapshotDigest: 'fixture-digest',
    packageManagerField: undefined,
    markers: { 'package-lock.json': true },
    scriptNames: ['lint', 'test'],
    packageName: 'fixture-pkg',
    // Default: no monorepo selector (spawn cwd targets the package).
    workspaceSelector: undefined,
    yarnMajorVersion: 2,
    yarnMinorVersion: 4,
    ...snapshot,
  };

  /** @type {FakeBackend} */
  const backend = {
    inspectCalls,
    installCalls,
    runCalls,
    cancelCalls,
    ops,
    async inspectWorkspace(input) {
      inspectCalls.push(input);
      return harden({ ...defaultSnapshot });
    },
    async install(input) {
      installCalls.push(input);
      if (input.operationId) {
        ops.set(input.operationId, { cancel: () => {} });
      }
      return harden({
        ok: true,
        operation: 'install',
        manager: input.manager,
        target: {
          displayPath: input.displayPath,
          ...(input.packageName ? { packageName: input.packageName } : {}),
        },
        command: {
          operation: 'install',
          manager: input.manager,
          args: [input.manager, 'ci'],
          redacted: false,
        },
        exitCode: 0,
        signal: null,
        termination: 'exit',
        durationMs: 1,
        stdout: '',
        stderr: '',
        truncated: { stdout: false, stderr: false },
        changed: {
          packageJson: false,
          lockfile: false,
          dependencyTree: true,
        },
      });
    },
    async run(input) {
      runCalls.push(input);
      if (input.operationId) {
        ops.set(input.operationId, { cancel: () => {} });
      }
      return harden({
        ok: true,
        operation: 'run',
        manager: input.manager,
        target: {
          displayPath: input.displayPath,
          ...(input.packageName ? { packageName: input.packageName } : {}),
        },
        command: {
          operation: 'run',
          manager: input.manager,
          args: [input.manager, 'run', input.script],
          redacted: false,
        },
        exitCode: 0,
        signal: null,
        termination: 'exit',
        durationMs: 1,
        stdout: 'ok',
        stderr: '',
        truncated: { stdout: false, stderr: false },
        changed: {
          packageJson: false,
          lockfile: false,
          dependencyTree: false,
        },
      });
    },
    async cancel(operationId) {
      cancelCalls.push(operationId);
      return ops.has(operationId);
    },
  };
  return backend;
};

const makeMount = () => {
  const mount = Far('EndoMount', {
    entry: async segments =>
      Far('EndoMountEntry', {
        segments: async () => segments,
      }),
  });
  return mount;
};

const lineageOf = value => {
  if (value === undefined || value === null) return undefined;
  return LINEAGE;
};

test('detect selects npm from marker via shipped makePackageManager', async t => {
  const backend = makeFakeBackend();
  const pm = makePackageManager({
    mount: makeMount(),
    backend,
    lineageOf,
  });
  const detection = await pm.detect();
  t.is(detection.manager, 'npm');
  t.is(detection.source, 'marker');
  t.true(detection.hasFrozenLockfile);
});

test('scripts lists declared names only', async t => {
  const backend = makeFakeBackend({ scriptNames: ['lint', 'test', 'build'] });
  const pm = makePackageManager({
    mount: makeMount(),
    backend,
    lineageOf,
  });
  const scripts = await pm.scripts();
  t.deepEqual(scripts.scriptNames, ['lint', 'test', 'build']);
  t.is(scripts.manager, 'npm');
});

test('install rejects update without policy and missing lockfile for frozen', async t => {
  const backend = makeFakeBackend({ markers: {} });
  const pm = makePackageManager({
    mount: makeMount(),
    backend,
    policy: harden({ defaultManager: 'npm' }),
    lineageOf,
  });
  await t.throwsAsync(pm.install({ lockfileMode: 'update' }), {
    message: /policy-denied/,
  });
  await t.throwsAsync(pm.install({ lockfileMode: 'frozen' }), {
    message: /lockfile-missing/,
  });
});

test('installer structurally rejects lifecycle controls', async t => {
  const backend = makeFakeBackend();
  const pm = makePackageManager(
    {
      mount: makeMount(),
      backend,
      lineageOf,
    },
    { facet: 'installer' },
  );
  await t.throwsAsync(
    E(/** @type {any} */ (pm)).install({ lifecycleScripts: 'enabled' }),
    { message: /lifecycleScripts|rest/ },
  );
  t.is(backend.inspectCalls.length, 0);
  t.is(backend.installCalls.length, 0);
});

test('package manager kit exposes three cumulative authority facets', async t => {
  await null;
  const backend = makeFakeBackend();
  const { reader, installer, executor } = makePackageManagerKit({
    mount: makeMount(),
    backend,
    lineageOf,
  });

  const publicNames = async facet => {
    await null;
    const names = await methodNamesOf(facet);
    return names.filter(name => !name.startsWith('__')).sort();
  };
  t.deepEqual(await publicNames(reader), [
    'detect',
    'help',
    'readOnly',
    'scope',
    'scripts',
  ]);
  t.deepEqual(await publicNames(installer), [
    'cancel',
    'detect',
    'help',
    'install',
    'readOnly',
    'scope',
    'scripts',
  ]);
  t.deepEqual(await publicNames(executor), [
    'cancel',
    'detect',
    'help',
    'install',
    'readOnly',
    'run',
    'scope',
    'scripts',
  ]);
  t.regex(reader.help(), /reader facet.*metadata/);
  t.notRegex(reader.help(), /installation|execution/);
  t.is(
    reader.help('install'),
    'Method install is not available on the reader facet',
  );
  t.is(reader.help('run'), 'Method run is not available on the reader facet');
  t.is(
    installer.help('run'),
    'Method run is not available on the installer facet',
  );
  t.regex(executor.help(), /named-script execution/);

  await t.throwsAsync(E(/** @type {any} */ (reader)).install({}), {
    message: /has no method "install"/,
  });
  await t.throwsAsync(E(/** @type {any} */ (reader)).run({ script: 'test' }), {
    message: /has no method "run"/,
  });
  await t.throwsAsync(
    E(/** @type {any} */ (installer)).run({ script: 'test' }),
    {
      message: /has no method "run"/,
    },
  );
  await installer.install({});
  await executor.run({ script: 'test' });
  t.is(backend.installCalls[0].lifecycleScripts, 'disabled');

  t.is(reader.readOnly(), reader);
  t.is(installer.readOnly(), reader);
  t.is(executor.readOnly(), reader);
  t.is(reader.scope('reader'), reader);
  t.is(installer.scope('installer'), installer);
  t.is(executor.scope('installer'), installer);
  await t.throwsAsync(E(/** @type {any} */ (reader)).scope('installer'), {
    message: /In "scope" method of \(PackageManagerReader\)/,
  });
  await t.throwsAsync(E(/** @type {any} */ (installer)).scope('executor'), {
    message: /In "scope" method of \(PackageManagerInstaller\)/,
  });
  t.true(isPackageManagerReadOnly(reader));
  t.false(isPackageManagerReadOnly(installer));
  t.false(isPackageManagerReadOnly(executor));
  t.is(getPackageManagerFacetName(reader), 'reader');
  t.is(getPackageManagerFacetName(installer), 'installer');
  t.is(getPackageManagerFacetName(executor), 'executor');
  t.is(getPackageManagerFacetName(Far('ForeignPackageManager', {})), undefined);
  t.throws(
    () =>
      makePackageManager(
        { mount: makeMount(), backend, lineageOf },
        /** @type {any} */ ({ facet: 'unknown' }),
      ),
    { message: /Unknown package manager facet/ },
  );
});

test('install forwards frozen default to backend', async t => {
  const backend = makeFakeBackend();
  const pm = makePackageManager({
    mount: makeMount(),
    backend,
    lineageOf,
  });
  const result = await pm.install({});
  t.true(result.ok);
  t.is(backend.installCalls.length, 1);
  t.is(backend.installCalls[0].lockfileMode, 'frozen');
  t.is(backend.installCalls[0].manager, 'npm');
  t.is(backend.installCalls[0].lifecycleScripts, 'disabled');
  t.true(Object.isFrozen(backend.inspectCalls[0]));
  t.true(Object.isFrozen(backend.inspectCalls[0].segments));
  t.true(Object.isFrozen(backend.installCalls[0].expectedSnapshot));
});

test('run rejects undeclared scripts before backend', async t => {
  const backend = makeFakeBackend({ scriptNames: ['lint'] });
  const pm = makePackageManager({
    mount: makeMount(),
    backend,
    lineageOf,
  });
  await t.throwsAsync(pm.run({ script: 'test' }), {
    message: /script-not-declared/,
  });
  t.is(backend.runCalls.length, 0);
});

test('run accepts declared scripts', async t => {
  const backend = makeFakeBackend();
  const pm = makePackageManager({
    mount: makeMount(),
    backend,
    lineageOf,
  });
  const result = await pm.run({ script: 'lint', args: ['--fix'] });
  t.true(result.ok);
  t.is(backend.runCalls[0].script, 'lint');
  t.deepEqual(backend.runCalls[0].args, ['--fix']);
  t.is(backend.runCalls[0].yarnMajorVersion, 2);
  t.is(backend.runCalls[0].yarnMinorVersion, 4);
  // package.json#name is forwarded as packageName metadata only — never as a
  // monorepo workspaceSelector that would emit --workspace / --filter flags.
  t.is(backend.runCalls[0].packageName, 'fixture-pkg');
  t.is(backend.runCalls[0].workspaceSelector, undefined);
});

test('workspace selectors reach install and run without replacing package identity', async t => {
  const backend = makeFakeBackend({
    packageName: '@scope/identity',
    workspaceSelector: '@scope/selected-workspace',
  });
  const pm = makePackageManager({
    mount: makeMount(),
    backend,
    lineageOf,
  });
  await pm.install({});
  await pm.run({ script: 'test' });
  t.like(backend.installCalls[0], {
    packageName: '@scope/identity',
    workspaceSelector: '@scope/selected-workspace',
  });
  t.like(backend.runCalls[0], {
    packageName: '@scope/identity',
    workspaceSelector: '@scope/selected-workspace',
  });
});

test('run does not treat package.json name as workspace selector', async t => {
  const backend = makeFakeBackend({
    packageName: '@scope/my-package',
    workspaceSelector: undefined,
  });
  const pm = makePackageManager({
    mount: makeMount(),
    backend,
    lineageOf,
  });
  await pm.run({ script: 'test' });
  t.is(backend.runCalls[0].packageName, '@scope/my-package');
  t.is(
    backend.runCalls[0].workspaceSelector,
    undefined,
    'single-package / cwd-targeted runs must not set monorepo selectors',
  );
});

test('readOnly exposes exactly the metadata facet and memoizes it', async t => {
  const backend = makeFakeBackend();
  const pm = makePackageManager({
    mount: makeMount(),
    backend,
    lineageOf,
  });
  const ro = pm.readOnly();
  t.regex(ro.help(), /EndoPackageManager/);
  const detection = await ro.detect();
  const scripts = await ro.scripts();
  t.is(detection.manager, 'npm');
  t.deepEqual(scripts.scriptNames, ['lint', 'test']);
  t.is(ro.readOnly(), ro);
  t.is(pm.readOnly(), ro);
  const names = await methodNamesOf(ro);
  t.deepEqual(names.filter(name => !name.startsWith('__')).sort(), [
    'detect',
    'help',
    'readOnly',
    'scope',
    'scripts',
  ]);
  await t.throwsAsync(E(/** @type {any} */ (ro)).install({}), {
    message: /has no method "install"/,
  });
  await t.throwsAsync(E(/** @type {any} */ (ro)).cancel('operation'), {
    message: /has no method "cancel"/,
  });
  t.is(backend.installCalls.length, 0);
  t.is(backend.runCalls.length, 0);
});

test('same-lineage cwd forwards validated segments and display path', async t => {
  const backend = makeFakeBackend();
  const mount = makeMount();
  const cwd = await E(mount).entry(['packages', 'fixture']);
  const pm = makePackageManager({ mount, backend, lineageOf });
  await pm.install({ cwd });
  t.deepEqual(backend.installCalls[0].segments, ['packages', 'fixture']);
  t.is(backend.installCalls[0].displayPath, 'packages/fixture');
});

test('same-lineage cwd rejects malformed and traversal segments', async t => {
  await null;
  const backend = makeFakeBackend();
  const mount = makeMount();
  const pm = makePackageManager({ mount, backend, lineageOf });
  /** @type {Array<[string, unknown[]]>} */
  const malformed = [
    ['non-string', ['packages', 42, 'fixture']],
    ['empty', ['packages', '']],
    ['current-directory', ['packages', '.']],
    ['parent-directory', ['packages', '..']],
    ['forward-slash', ['packages/fixture']],
    ['backslash', ['packages\\fixture']],
    ['nul', ['packages\0fixture']],
  ];

  for (const [label, segments] of malformed) {
    const cwd = Far(`MalformedEntry-${label}`, {
      segments: async () => harden([...segments]),
    });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(pm.detect({ cwd: /** @type {any} */ (cwd) }), {
      message: /workspace-invalid.*cwd segment/,
    });
  }
  t.is(backend.inspectCalls.length, 0);
});

test('foreign cwd fails workspace-invalid before backend install', async t => {
  const backend = makeFakeBackend();
  const otherLineage = harden({});
  const mount = makeMount();
  const foreign = Far('ForeignEntry', {
    segments: async () => ['pkg'],
  });
  // The foreign entry must fail before the backend is called.
  const pm2 = makePackageManager({
    mount,
    backend,
    lineageOf: value => {
      if (value === foreign) return otherLineage;
      return LINEAGE;
    },
  });
  await t.throwsAsync(pm2.install({ cwd: foreign }), {
    message: /workspace-invalid/,
  });
  t.is(backend.installCalls.length, 0);
});

test('cancel is limited to this capability active operations', async t => {
  const backend = makeFakeBackend();
  const pm = makePackageManager({
    mount: makeMount(),
    backend,
    lineageOf,
  });
  const other = makePackageManager({
    mount: makeMount(),
    backend,
    lineageOf,
  });

  const immediateRun = backend.run;
  /** @type {((value?: void | PromiseLike<void>) => void) | undefined} */
  let finish;
  /** @type {((value?: void | PromiseLike<void>) => void) | undefined} */
  let bothStarted;
  const gate = new Promise(resolve => {
    finish = resolve;
  });
  const started = new Promise(resolve => {
    bothStarted = resolve;
  });
  backend.run = async input => {
    const result = await immediateRun(input);
    if (backend.runCalls.length === 2) {
      bothStarted?.();
    }
    await gate;
    return result;
  };

  const running = pm.run({ script: 'test', operationId: 'op-9' });
  const sibling = other.run({ script: 'test', operationId: 'op-9' });
  await started;
  t.is(backend.runCalls.length, 2);
  t.not(
    backend.runCalls[0].operationId,
    backend.runCalls[1].operationId,
    'sibling capabilities translate the same local id to distinct backend ids',
  );
  t.false(await other.cancel('unknown'));
  t.true(await pm.cancel('op-9'));
  t.true(await other.cancel('op-9'));
  t.deepEqual(backend.cancelCalls, [
    backend.runCalls[0].operationId,
    backend.runCalls[1].operationId,
  ]);
  finish?.();
  await Promise.all([running, sibling]);
  t.false(await pm.cancel('op-9'));
  t.false(await other.cancel('op-9'));
});

test('cancel before workspace inspection completes prevents execution', async t => {
  const backend = makeFakeBackend();
  const immediateInspect = backend.inspectWorkspace;
  /** @type {((value?: void | PromiseLike<void>) => void) | undefined} */
  let finishInspect;
  const inspectionGate = new Promise(resolve => {
    finishInspect = resolve;
  });
  backend.inspectWorkspace = async input => {
    await inspectionGate;
    return immediateInspect(input);
  };
  const pm = makePackageManager({
    mount: makeMount(),
    backend,
    lineageOf,
  });
  const running = pm.run({ script: 'test', operationId: 'early' });
  await Promise.resolve();
  await Promise.resolve();
  t.true(await pm.cancel('early'));
  finishInspect?.();
  await t.throwsAsync(running, { message: /operation-cancelled/ });
  t.is(backend.runCalls.length, 0);
});

test('execution validates operation ids, timeouts, and Corepack policy', async t => {
  const versionedBackend = makeFakeBackend({
    packageManagerField: 'npm@10.9.2',
  });
  const denied = makePackageManager({
    mount: makeMount(),
    backend: versionedBackend,
    lineageOf,
  });
  await t.throwsAsync(denied.install({}), { message: /allowCorepack/ });

  const allowed = makePackageManager({
    mount: makeMount(),
    backend: versionedBackend,
    policy: harden({
      allowCorepack: true,
      defaultTimeoutMs: 100,
      maxTimeoutMs: 250,
    }),
    lineageOf,
  });
  await allowed.install({});
  await allowed.install({ timeoutMs: 1 });
  await allowed.run({ script: 'test', timeoutMs: 1000 });
  t.is(versionedBackend.installCalls[0].versionRequest, '10.9.2');
  t.is(versionedBackend.installCalls[0].timeoutMs, 100);
  t.is(versionedBackend.installCalls[1].timeoutMs, 1);
  t.is(versionedBackend.runCalls[0].timeoutMs, 250);

  await Promise.all(
    [0, NaN, Infinity].map(timeoutMs =>
      t.throwsAsync(allowed.install({ timeoutMs }), {
        message: /positive finite number/,
      }),
    ),
  );
  await t.throwsAsync(allowed.run({ script: 'test', operationId: '' }), {
    message: /non-empty string/,
  });
  await t.throwsAsync(allowed.run({ script: '--version' }), {
    message: /beginning/,
  });
});

test('policy limits must be positive, finite, and integral where required', t => {
  for (const defaultTimeoutMs of [0, -1, NaN, Infinity]) {
    t.throws(
      () =>
        makePackageManager({
          mount: makeMount(),
          backend: makeFakeBackend(),
          policy: harden({ defaultTimeoutMs }),
          lineageOf,
        }),
      { message: /defaultTimeoutMs must be positive and finite/ },
    );
  }
  for (const maxTimeoutMs of [0, -1, NaN, Infinity]) {
    t.throws(
      () =>
        makePackageManager({
          mount: makeMount(),
          backend: makeFakeBackend(),
          policy: harden({ maxTimeoutMs }),
          lineageOf,
        }),
      { message: /maxTimeoutMs must be positive and finite/ },
    );
  }
  t.throws(
    () =>
      makePackageManager({
        mount: makeMount(),
        backend: makeFakeBackend(),
        policy: harden({ defaultTimeoutMs: 11, maxTimeoutMs: 10 }),
        lineageOf,
      }),
    { message: /defaultTimeoutMs must not exceed policy.maxTimeoutMs/ },
  );
  for (const maxOutputBytes of [0, -1, 1.5, NaN, Infinity]) {
    t.throws(
      () =>
        makePackageManager({
          mount: makeMount(),
          backend: makeFakeBackend(),
          policy: harden({ maxOutputBytes }),
          lineageOf,
        }),
      { message: /maxOutputBytes must be a positive integer/ },
    );
  }
});

test('help ignores inherited property names', t => {
  const pm = makePackageManager({
    mount: makeMount(),
    backend: makeFakeBackend(),
    lineageOf,
  });
  t.is(pm.help('toString'), 'Unknown method toString');
  t.is(pm.help('constructor'), 'Unknown method constructor');
  t.is(pm.help('__proto__'), 'Unknown method __proto__');
});
