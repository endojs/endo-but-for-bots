// @ts-check
/// <reference types="ses"/>

import test from '@endo/ses-ava/prepare-endo.js';

import { makePackageManagerBackendCoordinator } from '../src/index.js';

/** @import {
 *   InstallBackendInput,
 *   PackageManagerConfiguration,
 *   PackageManagerEffectState,
 *   PackageManagerRunner,
 *   PackageManagerRunnerInput,
 *   PackageManagerWorkspace,
 *   PackageManagerWorkspaceInspection,
 *   WorkspaceSnapshot,
 * } from '../src/types.js' */

const manifestState = harden({
  manifestDigest: 'manifest-1',
  lockfiles: harden({ 'package-lock.json': 'lock-1' }),
});

/**
 * @param {Partial<WorkspaceSnapshot>} [overrides]
 * @returns {WorkspaceSnapshot}
 */
const makeSnapshot = (overrides = {}) =>
  harden({
    snapshotDigest: 'snapshot-1',
    markers: harden({ 'package-lock.json': true }),
    scriptNames: harden(['test']),
    displayPath: '.',
    packageName: 'fixture',
    ...overrides,
  });

/**
 * @param {object} [options]
 * @param {WorkspaceSnapshot} [options.snapshot]
 * @param {PackageManagerEffectState} [options.effectState]
 * @param {PackageManagerWorkspaceInspection<object>} [options.revalidatedInspection]
 * @param {Promise<void>} [options.revalidationGate]
 * @param {() => void} [options.onRevalidation]
 * @returns {{
 *   workspace: PackageManagerWorkspace<object>;
 *   inspectionCalls: unknown[];
 *   revalidationCalls: unknown[];
 * }}
 */
const makeWorkspace = ({
  snapshot = makeSnapshot(),
  effectState = manifestState,
  revalidatedInspection,
  revalidationGate,
  onRevalidation,
} = {}) => {
  const inspectionCalls = [];
  const revalidationCalls = [];
  const target = harden({ target: 'opaque' });
  /** @type {PackageManagerWorkspaceInspection<object>} */
  const inspection = harden({
    snapshot,
    target,
    effectState,
  });
  /** @type {PackageManagerWorkspace<object>} */
  const workspace = {
    async inspectWorkspace(input) {
      inspectionCalls.push(input);
      return inspection;
    },
    async revalidateWorkspace(input) {
      revalidationCalls.push(input);
      onRevalidation?.();
      if (revalidationGate !== undefined) {
        await revalidationGate;
      }
      return revalidatedInspection || inspection;
    },
    async readEffectState() {
      return effectState;
    },
  };
  return { workspace, inspectionCalls, revalidationCalls };
};

/**
 * @param {object} [options]
 * @param {(input: PackageManagerRunnerInput<object>) => Promise<import('../src/types.js').PackageManagerRunnerResult>} [options.run]
 * @returns {{ runner: PackageManagerRunner<object>; runs: PackageManagerRunnerInput<object>[]; cancellations: string[] }}
 */
const makeRunner = ({
  run = async input => {
    return harden({
      managerVersion: input.versionRequest,
      exitCode: 0,
      signal: null,
      termination: 'exit',
      stdout: 'ok',
      stderr: '',
      truncated: harden({ stdout: false, stderr: false }),
      cleanup: 'complete',
    });
  },
} = {}) => {
  const runs = [];
  const cancellations = [];
  /** @type {PackageManagerRunner<object>} */
  const runner = {
    async run(input) {
      runs.push(input);
      return run(input);
    },
    async cancel(operationId) {
      cancellations.push(operationId);
      return true;
    },
  };
  return { runner, runs, cancellations };
};

/** @param {WorkspaceSnapshot} snapshot */
const installInput = snapshot =>
  /** @type {InstallBackendInput} */ ({
    manager: 'npm',
    segments: [],
    displayPath: '.',
    expectedSnapshot: snapshot,
    packageName: snapshot.packageName,
    workspaceSelector: snapshot.workspaceSelector,
    lockfileMode: 'frozen',
    offline: false,
    lifecycleScripts: 'disabled',
    production: false,
    timeoutMs: 10,
    maxOutputBytes: 100,
  });

test('coordinator forwards workspace install selectors and generated configuration', async t => {
  const { workspace, revalidationCalls } = makeWorkspace({
    snapshot: makeSnapshot({ workspaceSelector: '@scope/selected' }),
  });
  const { runner, runs } = makeRunner();
  /** @type {PackageManagerConfiguration | undefined} */
  let supplied;
  const configurationProvider = async input => {
    t.deepEqual(input, { manager: 'npm', operation: 'install' });
    supplied = {
      manager: 'npm',
      format: 'npmrc',
      contents: new Uint8Array([1, 2, 3]),
    };
    return supplied;
  };
  const backend = makePackageManagerBackendCoordinator({
    workspace,
    runner,
    configurationProvider,
  });
  const snapshot = await backend.inspectWorkspace({
    segments: [],
    displayPath: '.',
  });
  const result = await backend.install(installInput(snapshot));

  t.true(result.ok);
  t.deepEqual(runs[0].command, {
    operation: 'install',
    manager: 'npm',
    args: ['ci', '--ignore-scripts', '--workspace=@scope/selected'],
  });
  t.is(runs[0].target.target, 'opaque');
  t.is(runs[0].configuration, supplied);
  t.deepEqual(revalidationCalls, [{ segments: [], displayPath: '.' }]);
});

test('coordinator claims an operation before its first yield', async t => {
  const { workspace } = makeWorkspace();
  const { runner, runs } = makeRunner();
  const backend = makePackageManagerBackendCoordinator({ workspace, runner });
  const snapshot = await backend.inspectWorkspace({
    segments: [],
    displayPath: '.',
  });
  const input = installInput(snapshot);
  input.operationId = 'immediate';

  const running = backend.install(input);
  t.true(await backend.cancel('immediate'));
  await t.throwsAsync(running, { message: /operation-cancelled/ });
  t.is(runs.length, 0);
  t.false(await backend.cancel('immediate'));
});

test('coordinator reports no dependency-tree change for pre-run cancellation', async t => {
  t.timeout(1000);
  /** @type {((value?: void | PromiseLike<void>) => void) | undefined} */
  let releaseRevalidationStarted;
  const revalidationStarted = new Promise(resolve => {
    releaseRevalidationStarted = resolve;
  });
  /** @type {((value?: void | PromiseLike<void>) => void) | undefined} */
  let releaseRevalidationGate;
  const revalidationGate = new Promise(resolve => {
    releaseRevalidationGate = resolve;
  });
  const { workspace } = makeWorkspace({
    revalidationGate,
    onRevalidation: () => releaseRevalidationStarted?.(),
  });
  const { runner, runs } = makeRunner();
  const backend = makePackageManagerBackendCoordinator({ workspace, runner });
  const snapshot = await backend.inspectWorkspace({
    segments: [],
    displayPath: '.',
  });
  const input = installInput(snapshot);
  input.operationId = 'cancel-before-run';

  const running = backend.install(input);
  await revalidationStarted;
  t.true(await backend.cancel('cancel-before-run'));
  releaseRevalidationGate?.();
  const result = await running;

  t.false(result.ok);
  t.is(result.termination, 'cancelled');
  t.deepEqual(result.changed, {
    packageJson: false,
    lockfile: false,
    dependencyTree: false,
  });
  t.is(runs.length, 0);
});

test('coordinator rejects a changed snapshot before runner execution', async t => {
  const changed = harden({
    snapshot: makeSnapshot({ snapshotDigest: 'snapshot-2' }),
    target: harden({ target: 'changed' }),
    effectState: manifestState,
  });
  const initial = makeWorkspace({ revalidatedInspection: changed });
  const { runner, runs } = makeRunner();
  const backend = makePackageManagerBackendCoordinator({
    workspace: initial.workspace,
    runner,
  });
  const snapshot = await backend.inspectWorkspace({
    segments: [],
    displayPath: '.',
  });

  await t.throwsAsync(backend.install(installInput(snapshot)), {
    message: /workspace-invalid.*snapshot changed/,
  });
  t.is(runs.length, 0);
});

test('coordinator does not claim an exact version without runner evidence', async t => {
  const { workspace } = makeWorkspace({
    snapshot: makeSnapshot({ packageManagerField: 'npm@10.9.2' }),
  });
  const { runner, runs } = makeRunner({
    run: async () =>
      harden({
        exitCode: 0,
        signal: null,
        termination: 'exit',
        stdout: '',
        stderr: '',
        truncated: harden({ stdout: false, stderr: false }),
        cleanup: 'complete',
      }),
  });
  const backend = makePackageManagerBackendCoordinator({ workspace, runner });
  const snapshot = await backend.inspectWorkspace({
    segments: [],
    displayPath: '.',
  });
  const input = installInput(snapshot);
  input.versionRequest = '10.9.2';

  await t.throwsAsync(backend.install(input), {
    message: /manager-unavailable.*requested.*version/,
  });
  t.is(runs.length, 1);
});
