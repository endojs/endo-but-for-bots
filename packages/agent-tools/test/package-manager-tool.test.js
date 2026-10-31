// @ts-check
/// <reference types="ses"/>

import '@endo/init/debug.js';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { makePackageManagerKit } from '@endo/exo-package-manager';
import { Far } from '@endo/pass-style';

import { makePackageManagerTools } from '../src/json-tools/package-manager.js';

/** @import { PackageManagerBackend, PackageManagerFacet } from '@endo/exo-package-manager' */
/** @import { ToolRecord } from '../src/types.js' */

const LINEAGE = harden({});

const makeFakeBackend = () => {
  /** @type {object[]} */
  const installCalls = [];
  /** @type {object[]} */
  const runCalls = [];
  /** @type {string[]} */
  const cancelCalls = [];

  // Leave the backend unhardened so test doubles can record calls under SES.
  /**
   * @type {PackageManagerBackend & {
   *   installCalls: object[],
   *   runCalls: object[],
   *   cancelCalls: string[],
   * }}
   */
  const backend = {
    installCalls,
    runCalls,
    cancelCalls,
    async inspectWorkspace({ displayPath }) {
      return harden({
        markers: { 'package-lock.json': true },
        scriptNames: ['lint', 'test'],
        packageName: 'fixture',
        displayPath,
      });
    },
    async install(input) {
      installCalls.push(input);
      return harden({
        ok: true,
        operation: 'install',
        manager: input.manager,
        target: { displayPath: input.displayPath },
        command: {
          operation: 'install',
          manager: input.manager,
          args: ['npm', 'ci'],
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
      return harden({
        ok: true,
        operation: 'run',
        manager: input.manager,
        target: { displayPath: input.displayPath },
        command: {
          operation: 'run',
          manager: input.manager,
          args: ['npm', 'run', input.script],
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
      return true;
    },
  };
  return backend;
};

/**
 * @param {ToolRecord[]} tools
 * @param {string} name
 * @returns {ToolRecord}
 */
const findTool = (tools, name) => {
  const tool = tools.find(candidate => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`missing tool ${name}`);
  }
  return tool;
};

const makeMount = () => {
  /** @type {string[][]} */
  const entries = [];
  const mount = Far('EndoMount', {
    entry: async segments => {
      entries.push([...segments]);
      return Far('EndoMountEntry', {
        segments: async () => segments,
      });
    },
  });
  // Tracking lives outside the Far so pass-style stays method-only.
  return { mount, entries };
};

/**
 * @param {PackageManagerBackend} backend
 * @param {ReturnType<typeof makeMount>['mount']} mount
 */
const makeKit = (backend, mount) =>
  makePackageManagerKit({
    mount,
    backend,
    lineageOf: () => LINEAGE,
  });

test('executor exposes install/run plus detect/list tools', t => {
  const backend = makeFakeBackend();
  const { mount } = makeMount();
  const { executor } = makeKit(backend, mount);
  const tools = makePackageManagerTools(executor, { mount });
  const names = tools.map(tool => tool.name);
  t.deepEqual(names, [
    'detectPackageManager',
    'listPackageScripts',
    'installDependencies',
    'runPackageScript',
  ]);
  // Schemas must not advertise host path fields.
  for (const tool of tools) {
    const schema = /** @type {any} */ (tool.parameters);
    t.false(
      JSON.stringify(schema).includes('/home/'),
      `${tool.name} schema must not include host paths`,
    );
  }
});

test('tool catalogs follow the granted facet and fail closed for foreign caps', async t => {
  await null;
  const backend = makeFakeBackend();
  const { mount } = makeMount();
  const { reader, installer, executor } = makeKit(backend, mount);
  /** @param {unknown} facet */
  const namesFor = facet =>
    makePackageManagerTools(/** @type {PackageManagerFacet} */ (facet), {
      mount,
    }).map(tool => tool.name);

  t.deepEqual(namesFor(reader), ['detectPackageManager', 'listPackageScripts']);
  t.deepEqual(namesFor(installer), [
    'detectPackageManager',
    'listPackageScripts',
    'installDependencies',
  ]);
  t.deepEqual(namesFor(executor), [
    'detectPackageManager',
    'listPackageScripts',
    'installDependencies',
    'runPackageScript',
  ]);
  t.deepEqual(namesFor(Far('ForeignPackageManager', {})), [
    'detectPackageManager',
    'listPackageScripts',
  ]);

  // eslint-disable-next-line no-underscore-dangle
  const readerMethods = await E(
    /** @type {any} */ (reader),
  ).__getMethodNames__();
  // eslint-disable-next-line no-underscore-dangle
  const installerMethods = await E(
    /** @type {any} */ (installer),
  ).__getMethodNames__();
  t.false(readerMethods.includes('install'));
  t.false(readerMethods.includes('run'));
  t.true(installerMethods.includes('install'));
  t.false(installerMethods.includes('run'));

  const install = findTool(
    makePackageManagerTools(installer, { mount }),
    'installDependencies',
  );
  const schema = /** @type {any} */ (install.parameters);
  t.false('lifecycleScripts' in schema.properties);
  await install.invoke({});
  t.is(backend.installCalls[0].lifecycleScripts, 'disabled');
});

test('installDependencies resolves cwd through mount issuer', async t => {
  const backend = makeFakeBackend();
  const { mount, entries } = makeMount();
  const { installer } = makeKit(backend, mount);
  const tools = makePackageManagerTools(installer, { mount });
  const install = findTool(tools, 'installDependencies');
  const result = await install.invoke({
    cwd: 'packages/fixture',
    offline: true,
  });
  t.true(/** @type {any} */ (result).ok);
  t.deepEqual(entries, [['packages', 'fixture']]);
  t.is(backend.installCalls[0].displayPath, 'packages/fixture');
  t.true(backend.installCalls[0].offline);
});

test('runPackageScript bridges abort signal to cancel', async t => {
  const backend = makeFakeBackend();
  const inspectWorkspace = backend.inspectWorkspace;
  /** @type {() => void} */
  let signalInspectStarted = () => {};
  /** @type {Promise<void>} */
  const inspectStartedP = new Promise(resolve => {
    signalInspectStarted = resolve;
  });
  /** @type {() => void} */
  let releaseInspect = () => {};
  /** @type {Promise<void>} */
  const inspectGateP = new Promise(resolve => {
    releaseInspect = resolve;
  });
  backend.inspectWorkspace = async input => {
    await null;
    signalInspectStarted();
    await inspectGateP;
    return inspectWorkspace(input);
  };
  const { mount } = makeMount();
  const { executor } = makeKit(backend, mount);
  const tools = makePackageManagerTools(executor, { mount });
  const run = findTool(tools, 'runPackageScript');

  const controller = new AbortController();
  // Hold inspection so the operation is registered but cannot reach run.
  const invokeP = run.invoke({ script: 'lint' }, { signal: controller.signal });
  await inspectStartedP;
  controller.abort();
  await null;
  releaseInspect();
  await t.throwsAsync(invokeP, { message: /operation-cancelled/ });
  t.is(backend.runCalls.length, 0);
});

test('detectPackageManager returns structured detection', async t => {
  const backend = makeFakeBackend();
  const { mount } = makeMount();
  const { reader } = makeKit(backend, mount);
  const tools = makePackageManagerTools(reader, { mount });
  const detect = findTool(tools, 'detectPackageManager');
  const result = await detect.invoke({});
  t.is(/** @type {any} */ (result).manager, 'npm');
});
