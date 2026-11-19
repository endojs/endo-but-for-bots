// @ts-check
import '../unit/_m1a-prelude.js';
import test from 'ava';
import { E } from '@endo/far';
import {
  integrationEnabled,
  killStrays,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, sliceTemplate } from './_m1a-slice.js';
import { subagentScript, resultFor } from './_subagents.js';

takeIntegrationLock(test, 'subagent restart');
const run = integrationEnabled ? test.serial : test.skip;

run('the restored parent can ask and stop its existing child', async t => {
  t.timeout(4 * 60_000);
  const state = await startFromTemplate(await sliceTemplate(), { t });
  let slice = await makeSlice(state);
  const { backend } = await slice.makeBackend(subagentScript);
  const parent = await slice.createSession(backend, 'Research');
  const { key } = await E(parent).getInfo();
  t.regex(await resultFor(slice, parent, 'spawn'), /Spawned subagent/);
  await state.kill();
  await killStrays(state.root);
  await state.restart();
  slice = await slice.refresh();
  const restored = await E(slice.factory).findSession(key);
  t.is(await resultFor(slice, restored, 'ask'), 'Hello!');
  t.regex(await resultFor(slice, restored, 'stop'), /Stopped subagent/);
});
