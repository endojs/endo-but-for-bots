// @ts-check
// The M6 runner and M11 Talk shortcut on the same provisioned state.
import '../unit/_m1a-prelude.js';

import test from 'ava';
import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/guards/factory.js';
/* eslint-enable import/no-relative-packages */
import { steps as environmentSteps } from '../../scripts/provision-steps/60-environments.js';
import { voiceStep } from '../../scripts/provision-steps/70-voice.js';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, sliceTemplate } from './_m1a-slice.js';
import { runTurn, turnRecords } from './_m1b.js';
import {
  commandCall,
  commandTurn,
  environmentsSettings,
  toolResultsOf,
} from './_environments.js';

takeIntegrationLock(test, 'voice preset');

(integrationEnabled ? test.serial : test.skip)(
  'Talk uses the pinned built-in voice preset when its runner is attached',
  async t => {
    t.timeout(5 * 60_000);
    const state = await startFromTemplate(await sliceTemplate(), { t });
    const slice = await makeSlice(state);
    const voice = await E(E(slice.harness).getOperator()).getVoice();
    const preset = await E(voice).getVoicePreset();
    const input = 'check the shell';
    const label = 'Voice backend';
    const modelId = 'voice-pinned';
    const { backend } = await slice.makeBackend(
      harden({
        turns: [commandTurn(input, [[commandCall('printf', ['voice-ok'])]])],
      }),
      { label },
    );
    await E(slice.harness).configure(harden({ backends: [backend] }));
    await voiceStep.run({
      client: state.client,
      options: /** @type {any} */ ({
        voice: { voiceBackend: label, voiceModelId: modelId },
      }),
    });
    t.like(await E(preset).describe(), {
      builtIn: true,
      label: 'voice',
      backend,
      modelId,
      available: false,
      unavailableReason: texts.runnerRequired,
    });
    const launch = harden({ invocationId: 'voice-preset', at: Date.now() });
    const list = () => E(slice.factory).listSessions();
    const before = (await list()).rows.length;
    await t.throwsAsync(() => E(voice).startVoiceSession(launch), {
      message: texts.runnerRequired,
    });
    t.is((await list()).rows.length, before);

    for (const step of environmentSteps) {
      // eslint-disable-next-line no-await-in-loop
      await step.run({
        client: state.client,
        options: /** @type {any} */ ({ environments: environmentsSettings }),
      });
    }
    t.true((await E(preset).describe()).available);
    const made = await E(voice).startVoiceSession(launch);
    t.false(made.duplicate);
    t.is(made.warning, undefined);
    t.like(await E(made.session).getInfo(), { presetLabel: 'voice', modelId });
    const duplicate = await E(voice).startVoiceSession(launch);
    t.true(duplicate.duplicate);
    t.is(duplicate.session, made.session);
    t.is((await list()).rows.length, before + 1);
    const live = await slice.subscribe(made.session);
    t.teardown(() => live.stop());
    const { turn } = await runTurn(slice, made.session, live, input);
    const results = toolResultsOf(await turnRecords(turn));
    t.is(results.length, 1);
    t.false(results[0].failed);
    t.regex(results[0].result, /voice-ok/);
  },
);
