// @ts-check
import '../unit/_m1a-prelude.js';
import test from 'ava';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, sliceTemplate } from './_m1a-slice.js';
import { subagentScript, resultFor } from './_subagents.js';

takeIntegrationLock(test, 'subagent tools');
const run = integrationEnabled ? test.serial : test.skip;

run(
  'the parent spawns, asks and stops its child through model tools',
  async t => {
    t.timeout(4 * 60_000);
    const state = await startFromTemplate(await sliceTemplate(), { t });
    const slice = await makeSlice(state);
    const { backend } = await slice.makeBackend(subagentScript);
    const parent = await slice.createSession(backend, 'Research');
    t.regex(
      await resultFor(slice, parent, 'spawn'),
      /Spawned subagent "scout"/,
    );
    t.is(await resultFor(slice, parent, 'ask'), 'Hello!');
    t.regex(await resultFor(slice, parent, 'stop'), /Stopped subagent "scout"/);
  },
);
