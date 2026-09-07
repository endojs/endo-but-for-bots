// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeWorkflowService } from '../src/service.js';
import { makeFakeAgent, makeFakeClock, settle } from './fake-agent.js';

const leaf = label =>
  harden({
    name: 'leaf',
    version: 1,
    initial: 'done',
    states: { done: { final: true, output: { label } } },
  });
const middle = harden({
  name: 'middle',
  version: 1,
  initial: 'spawn',
  states: {
    spawn: {
      entry: [{ kind: 'spawn', chart: 'leaf-v1', outcome: 'settled' }],
      on: {
        settled: [
          { target: 'done', assign: { result: { $event: 'value.output' } } },
        ],
      },
    },
    done: { final: true, output: { $ctx: 'result' } },
  },
});
const parent = harden({
  name: 'parent',
  version: 1,
  initial: 'wait',
  states: {
    wait: { on: { go: [{ target: 'spawn' }] } },
    spawn: {
      entry: [{ kind: 'spawn', chart: middle, outcome: 'settled' }],
      on: {
        settled: [
          { target: 'done', assign: { result: { $event: 'value.output' } } },
        ],
      },
    },
    done: { final: true, output: { $ctx: 'result' } },
  },
});

test('inline spawn descendants remain snapshotted across registry replacement and restart', async t => {
  const { powers, controls } = makeFakeAgent();
  const clock = makeFakeClock();
  const h1 = await makeWorkflowService({ powers, clock });
  t.teardown(h1.stop);
  await E(h1.service).install(leaf('original'));
  const { runId } = await E(h1.service).start(parent);
  await E(h1.service).install(leaf('replacement'));
  h1.stop();
  const h2 = await makeWorkflowService({ powers: controls.restart(), clock });
  t.teardown(h2.stop);
  await E(await E(h2.service).control(runId)).signal(harden({ type: 'go' }));
  await settle(500);
  t.deepEqual((await E(await E(h2.service).run(runId)).status()).output, {
    label: 'original',
  });
});
