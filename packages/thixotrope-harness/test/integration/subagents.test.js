// @ts-check
import '../unit/_m1a-prelude.js';
import test from 'ava';
import { E } from '@endo/far';
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
    /** @param {any} owner */
    const scoutKey = async owner => {
      const page = await E(owner).getInventoryPage();
      const row = page.rows.find(
        (/** @type {any} */ r) => r.label === 'subagents/scout',
      );
      t.is(row.kind, 'subagent');
      t.is(typeof row.childKey, 'string');
      return row.childKey;
    };
    const key = await scoutKey(parent);
    const operator = E(await E(slice.harness).getOperator());
    t.is(await operator.getFactory(), slice.factory);
    const child = await operator.findSubagentSession(parent, 'scout', key);
    t.is((await E(child).getInfo()).key, key);
    t.true(Array.isArray((await E(child).getInventoryPage()).rows));
    const other = await slice.createSession(backend, 'Other');
    await t.throwsAsync(operator.findSubagentSession(other, 'scout', key));
    await resultFor(slice, other, 'spawn');
    const otherKey = await scoutKey(other);
    t.not(otherKey, key);
    await t.throwsAsync(operator.findSubagentSession(other, 'scout', key));
    t.is(
      (await E(operator.findSubagentSession(other, 'scout')).getInfo()).key,
      otherKey,
    );
    t.is(await resultFor(slice, parent, 'ask'), 'Hello!');
    t.regex(await resultFor(slice, parent, 'stop'), /Stopped subagent "scout"/);
    await t.throwsAsync(operator.findSubagentSession(parent, 'scout', key));
    await resultFor(slice, parent, 'spawn');
    const replacement = await scoutKey(parent);
    t.not(replacement, key);
    await t.throwsAsync(operator.findSubagentSession(parent, 'scout', key));
    t.is(
      (
        await E(
          operator.findSubagentSession(parent, 'scout', replacement),
        ).getInfo()
      ).key,
      replacement,
    );
  },
);
