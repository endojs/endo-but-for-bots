// @ts-check
// R4-70: a development subagent gets a new workspace and shell when it is
// spawned. Stopping the parent keeps its environment withdrawn while the
// operator uses the child's explicitly delegated handle.
import '../unit/_m1a-prelude.js';

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'ava';
import { E } from '@endo/far';

import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice } from './_m1a-slice.js';
import { runTurn, turnRecords } from './_m1b.js';
import {
  commandCall,
  commandTurn,
  environmentKeys,
  environmentsTemplate,
  execCall,
  startEnvironmentSession,
  toolCall,
  toolResultsOf,
} from './_environments.js';

takeIntegrationLock(test, 'subagent environment isolation');
const run = integrationEnabled ? test.serial : test.skip;

run(
  'a child has its own workspace and shell while the parent is stopped',
  async t => {
    t.timeout(5 * 60_000);
  const state = await startFromTemplate(await environmentsTemplate(), { t });
    const slice = await makeSlice(state);
    const script = harden({
      turns: [
        commandTurn('create child', [
          [commandCall('sh', ['-c', 'printf parent > owner'])],
          [toolCall('spawnSubagent', { name: 'helper' })],
          [
            toolCall('send', {
              recipient: 'user',
              strings: ['Helper: '],
              edgeNames: ['helper'],
              petNames: ['subagents/helper'],
            }),
          ],
        ]),
        commandTurn('record ownership', [
          [
            commandCall('sh', [
              '-c',
              'test ! -e owner && printf child > owner',
            ]),
          ],
          [
            execCall(
              "const workspace = await E(powers).lookup('workspace'); await E(workspace).add(['owner']); return E(workspace).commit('child owns this workspace');",
            ),
          ],
        ]),
      ],
    });
    const { backend } = await slice.makeBackend(script);
    const parent = await startEnvironmentSession(slice, backend);
    const live = await slice.subscribe(parent);
    t.teardown(() => live.stop());
    const turn = await runTurn(slice, parent, live, 'create child');
    t.deepEqual(
      toolResultsOf(await turnRecords(turn.turn)).map(result => result.failed),
      [false, false, false],
    );
    const [parentKey] = environmentKeys(state.root);
    const mailbox = await E(E(slice.harness).getOperator()).getMail();
    const { messages } = await E(mailbox).list();
    const helper = await E(messages[0].message).take('helper');
    t.is((await E(parent).emergencyStop()).state, 'stopped');
    const answer = await E(helper).ask(
      harden({ task: 'record ownership', attachments: [], at: Date.now() }),
    );
    t.is(answer.text, 'done');
    const keys = environmentKeys(state.root);
    t.is(keys.length, 2);
    const childKey = keys.find(key => key !== parentKey);
    t.truthy(childKey);
    const workspace = (/** @type {string} */ key) =>
      path.join(state.root, 'environments', 'sessions', key, 'workspace');
    const parentDir = workspace(parentKey);
    const childDir = workspace(/** @type {string} */ (childKey));
    t.is(await readFile(path.join(parentDir, 'owner'), 'utf8'), 'parent');
    t.is(await readFile(path.join(childDir, 'owner'), 'utf8'), 'child');
    const { execFileSync } = await import('node:child_process');
    const subject = (/** @type {string} */ cwd) =>
      execFileSync('git', ['log', '-1', '--format=%s'], {
        cwd,
        encoding: 'utf8',
      }).trim();
    t.is(subject(parentDir), 'Initialize workspace');
    t.is(subject(childDir), 'child owns this workspace');
    t.is((await E(parent).getExecutionState()).state, 'stopped');
  },
);
