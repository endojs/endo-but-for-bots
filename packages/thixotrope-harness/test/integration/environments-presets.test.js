// @ts-check
/**
 * Presets with and without the environments runner, reachability and host
 * paths (`designs/m6-interfaces.md` section 9: 14, 17), in real daemons:
 *
 * - 14 (without the setting, the m1a slice template): `development` and
 *   `new-project` are unavailable with `runnerRequired`; `chat-only` and
 *   the built-in `general` (which selects no object until a preset made
 *   from it does; the selection rule is `factory-environments.test.js`'s)
 *   are available;
 * - 14 (with it, the `environments` template): both are available;
 *   a `development` session holds `workspace` and `shell` and is offered
 *   `runCommand`; a `new-project` session holds `workspace` only and is not
 *   offered the shell tools; a `chat-only` session holds neither;
 * - 17 (interface closure, in Node): from what a session and its exec vat
 *   are handed (`Git`, `GitReader`, `Shell`, `EnvironmentControl`, the
 *   `ShellPort` and `ImageSource` they answer), following every method's
 *   return guard, no `EnvironmentsAdmin`, `EnvironmentsSink` or
 *   `EnvironmentsOps` is reachable;
 * - 17 (in the daemon): `reachability()` shows no session vat or exec vat
 *   holding a reference into another session's vats, the environments
 *   manager being the one new origin a shell session's vats hold; and the
 *   environments state directory's absolute path (`<state>/environments`,
 *   which every workspace and home path starts with) is in no vat heap,
 *   journal or snapshot
 *   after a session used its workspace and shell (commands that print no
 *   host path: the fake runtime runs on the host, so a command printing its
 *   working directory would put the path in the transcript, which a
 *   container's `/workspace` does not).
 *
 * `thix reachability` reports holdings by origin vat, and every environment
 * object of every session lives in the one manager vat, so "no other
 * session's environment objects" needs object granularity (core request
 * CC-060, as M4's and M5's acceptance noted); the per-object half is the
 * manager's amplification test (`test/adapter/environments-manager.test.js`).
 *
 *   THIX_AGENT=W6.7 corepack yarn test:integration test/integration/environments-presets.test.js
 */
import '../unit/_m1a-prelude.js';

import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import {
  environmentInterfaces,
  environmentMethodNames,
} from '../../guest/lib/guards/environments.js';
import { texts } from '../../guest/lib/guards/factory.js';
/* eslint-enable import/no-relative-packages */
import { emit, loadAvg, runIdentity } from '../../perf/_harness.mjs';
import {
  integrationEnabled,
  shortName,
  startFromTemplate,
  takeIntegrationLock,
  tmpRoot,
} from '../template/index.js';
import { exportState, importState } from '../../scripts/export.mjs';
import { makeSlice, round1, sliceTemplate } from './_m1a-slice.js';
import { runTurn, turnRecords } from './_m1b.js';
import {
  commandCall,
  commandTurn,
  environmentsTemplate,
  execCall,
  presetOfTemplate,
  startEnvironmentSession,
  stateHasPath,
  toolResultsOf,
} from './_environments.js';

takeIntegrationLock(test, 'environments presets test');

const run = integrationEnabled ? test.serial : test.skip;

const SHELL_PRESETS = harden(['development', 'new-project']);

const holdsCode =
  "const w = await E(powers).lookup('workspace'); const s = await E(powers).lookup('shell'); return JSON.stringify({ workspace: w !== undefined, shell: s !== undefined });";

const script = harden({
  turns: [
    commandTurn('holds', [
      [execCall(holdsCode)],
      [commandCall('printf', ['x'])],
    ]),
    commandTurn('use', [
      [
        commandCall('git', ['status', '--porcelain']),
        execCall(
          "const w = await E(powers).lookup('workspace'); return (await E(w).status()).truncated;",
        ),
      ],
    ]),
  ],
});

/**
 * Remotable labels a pattern names (an `M.remotable` matcher carries its
 * label in its payload; walk every nested pattern).
 * @param {any} pattern
 * @returns {string[]}
 */
const remotableLabels = pattern => {
  if (pattern === null || typeof pattern !== 'object') return [];
  if (pattern[Symbol.toStringTag] === 'match:remotable')
    return [pattern.payload?.label].filter(l => typeof l === 'string');
  return Object.values(
    'payload' in pattern ? { payload: pattern.payload } : pattern,
  ).flatMap(remotableLabels);
};

test('17: the closure of a session environment reaches no admin facet', t => {
  const interfaceNames = Object.keys(environmentMethodNames);
  const reached = new Set(['Git', 'GitReader', 'Shell', 'EnvironmentControl']);
  // A Set iterates the labels added while it runs: the closure.
  for (const name of reached) {
    const guard = interfaceNames.includes(name)
      ? /** @type {any} */ (environmentInterfaces)[name]
      : undefined;
    for (const method of Object.values(guard?.payload.methodGuards ?? {}))
      for (const label of remotableLabels(
        /** @type {any} */ (method).payload.returnGuard,
      ))
        reached.add(label);
  }
  t.true(reached.has('ShellPort') && reached.has('ImageSource'));
  for (const forbidden of [
    'EnvironmentsAdmin',
    'EnvironmentsSink',
    'EnvironmentsOps',
  ])
    t.false(reached.has(forbidden), `${forbidden} is not reachable`);
});

run('14: shell presets need the runner setting', async t => {
  t.timeout(5 * 60_000);
  const state = await startFromTemplate(await sliceTemplate(), { t });
  const slice = await makeSlice(state);
  for (const template of SHELL_PRESETS) {
    // eslint-disable-next-line no-await-in-loop
    const view = await E(
      // eslint-disable-next-line no-await-in-loop
      await presetOfTemplate(slice.factory, template),
    ).describe();
    t.is(view.available, false, `${template} is unavailable`);
    t.is(view.unavailableReason, texts.runnerRequired, `${template}: reason`);
  }
  const chat = await E(
    await presetOfTemplate(slice.factory, 'chat-only'),
  ).describe();
  t.true(chat.available, 'chat-only is available');
  const general = await E(
    await presetOfTemplate(slice.factory, 'general'),
  ).describe();
  t.true(general.available, 'the built-in general (no object selected)');
});

run('14 and 17: objects by preset, reachability and paths', async t => {
  t.timeout(5 * 60_000);
  const t0 = performance.now();
  const state = await startFromTemplate(await environmentsTemplate(), { t });
  const slice = await makeSlice(state);
  const identity = { ...(await runIdentity()), loadAvg: loadAvg() };
  for (const template of SHELL_PRESETS) {
    // eslint-disable-next-line no-await-in-loop
    const view = await E(
      // eslint-disable-next-line no-await-in-loop
      await presetOfTemplate(slice.factory, template),
    ).describe();
    t.true(view.available, `${template} is available with the runner`);
  }
  // The scripted backend's log lives outside the state, so the path grep
  // below does not find the log path the agent host keeps.
  const logPath = path.join(tmpRoot, `${shortName('l')}.log`);
  t.teardown(() => rm(logPath, { force: true }));
  const backend = await E(slice.admin).makeBackend(
    harden({ kind: 'scripted', label: 'Scripted', script, logPath }),
  );
  /** @type {Record<string, any>} */
  const held = {};
  /** @type {Record<string, string[]>} */
  const keys = {};
  for (const template of ['development', 'new-project', 'chat-only']) {
    // eslint-disable-next-line no-await-in-loop
    const session = await startEnvironmentSession(slice, backend, template);
    // eslint-disable-next-line no-await-in-loop
    keys[template] = [(await E(session).getInfo()).key];
    // eslint-disable-next-line no-await-in-loop
    const live = await slice.subscribe(session);
    // eslint-disable-next-line no-await-in-loop
    const ran = await runTurn(slice, session, live, 'holds');
    // eslint-disable-next-line no-await-in-loop
    const results = toolResultsOf(await turnRecords(ran.turn));
    // eslint-disable-next-line no-await-in-loop
    if (template === 'development') await runTurn(slice, session, live, 'use');
    // eslint-disable-next-line no-await-in-loop
    await live.stop();
    t.log(template, JSON.stringify(results));
    held[template] = {
      holds: JSON.parse(JSON.parse(results[0].result)),
      runCommand: results[1],
    };
  }
  t.deepEqual(held.development.holds, { workspace: true, shell: true });
  t.false(held.development.runCommand.failed, 'development runs a command');
  t.deepEqual(held['new-project'].holds, { workspace: true, shell: false });
  t.true(
    held['new-project'].runCommand.failed,
    'new-project is not offered runCommand',
  );
  t.deepEqual(held['chat-only'].holds, { workspace: false, shell: false });
  t.true(held['chat-only'].runCommand.failed, 'chat-only is not offered it');

  // 17: vat-level reachability.
  const report = await state.client.call('reachability');
  /** @type {Map<string, string>} */
  const labelOf = new Map(
    report.workers.map((/** @type {any} */ w) => [
      w.workerId,
      w.debugLabel ?? w.workerId,
    ]),
  );
  const holders = new Map();
  for (const { holder, target } of report.references)
    holders.set(holder, new Set([...(holders.get(holder) ?? []), target]));
  const sessionVats = [...labelOf]
    .filter(([, label]) => /(^| )session( |$)/.test(label))
    .map(([id]) => id);
  for (const id of sessionVats) {
    const others = [...(holders.get(id) ?? [])].filter(
      target => target !== id && sessionVats.includes(target),
    );
    t.deepEqual(others, [], `${labelOf.get(id)} holds no other session vat`);
  }
  const lines = [...holders].map(
    ([holder, targets]) =>
      `${labelOf.get(holder)} -> ${[...targets].map(x => labelOf.get(x)).join(', ')}`,
  );
  t.log(lines.join('\n'));

  // 17: the state path in no vat heap, journal or snapshot.
  const hits = await stateHasPath(state.root);
  for (const { file } of hits.filter(h => h.encoding === 'utf8')) {
    const data = readFileSync(file);
    const at = data.indexOf(Buffer.from(path.join(state.root, 'environments')));
    // Kept: on a failure the log shows what holds the path.
    t.log(
      `${path.basename(file)}: ${data
        .subarray(Math.max(0, at - 300), at + state.root.length + 200)
        .toString('latin1')
        .replace(/[^\x20-\x7e]/g, '.')}`,
    );
  }
  t.deepEqual(
    hits.map(({ file, encoding }) => `${file} (${encoding})`),
    [],
    'the state directory path is in no vat heap, journal or snapshot',
  );
  emit({
    metric: 'environments.presets.acceptance',
    grepFiles: /** @type {any} */ (hits).files,
    grepBytes: /** @type {any} */ (hits).bytes,
    wallMs: round1(performance.now() - t0),
    ...identity,
  });
});

run(
  'a legacy project marker becomes a pinned modern preset and session on export/restore',
  async t => {
    t.timeout(4 * 60_000);
    const template = await environmentsTemplate();
    const source = await startFromTemplate(template, { t });
    const slice = await makeSlice(source);
    const { backend } = await slice.makeBackend(script);
    const operator = await E(slice.harness).getOperator();
    const catalog = await E(operator).getPresets();
    const development = await presetOfTemplate(slice.factory, 'development');
    const { objects } = await E(development).describe();
    const admin = await source.client.call('lookup', 'environmentsAdmin');
    const workspaceSeed = harden({
      project: 'thixotrope',
      commit: 'ab'.repeat(20),
    });
    const marker = await E(admin).makeWorkspaceSeed(workspaceSeed);
    const { revision } = await E(catalog).configuration();
    const { preset } = await E(catalog).create(
      harden({
        label: 'Legacy project',
        template: 'development',
        objects,
        endowments: [{ label: 'thixotrope-project-source', value: marker }],
      }),
      revision,
    );
    const session = await E(slice.factory).createSession(
      harden({ preset, backend, at: 1 }),
    );
    const inventory = await E(session).getInventoryPage();
    t.deepEqual(
      inventory.rows.map((/** @type {any} */ row) => row.label),
      ['shell', 'workspace'],
    );
    const file = path.join(tmpRoot, `${shortName('project')}.jsonl`);
    t.teardown(() => rm(file, { force: true }));
    await exportState({ client: source.client, file });
    const lines = readFileSync(file, 'utf8')
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line));
    t.deepEqual(
      lines.find(line => line.type === 'presets').records[0].workspaceSeed,
      workspaceSeed,
    );
    t.deepEqual(
      lines.find(line => line.type === 'session').head.config.preset
        .workspaceSeed,
      workspaceSeed,
    );
    await source.stop();
    const target = await startFromTemplate(template, { t });
    const targetSlice = await makeSlice(target);
    const targetBackend = await targetSlice.makeBackend(script);
    const restored = await importState({
      client: target.client,
      file,
      backends: [targetBackend.backend],
    });
    t.is(restored.presets, 1);
    t.is(restored.sessions.length, 1);
  },
);
