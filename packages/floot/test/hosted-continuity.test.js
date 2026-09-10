// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import { makeHostedContinuityOptions } from '../src/hosted-continuity.js';

test('empty context is explicit and text/tool evidence survives without powers', t => {
  t.deepEqual(makeHostedContinuityOptions([]), { continuityContext: '' });
  const power = Far('NotDialogue', {
    execute() {
      t.fail('must not execute');
    },
  });
  const history = [
    { role: 'user', content: 'review it', meta: { power } },
    { role: 'tool', name: 'endo_exec', args: '{}', result: 'done' },
    {
      role: 'assistant',
      content: 'reviewed',
      meta: {
        turnState: 'failed',
        resolution: 'verified externally',
        turnStatus: true,
        power,
      },
    },
  ];
  const result = makeHostedContinuityOptions(history);
  if (!('continuityContext' in result))
    throw Error('Expected complete context');
  t.deepEqual(JSON.parse(result.continuityContext || ''), [
    { role: 'user', content: 'review it' },
    { role: 'tool', name: 'endo_exec', args: '{}', result: 'done' },
    {
      role: 'assistant',
      content: 'reviewed',
      turnState: 'failed',
      resolution: 'verified externally',
      turnStatus: true,
    },
  ]);
  t.deepEqual(
    makeHostedContinuityOptions([
      { role: 'tool', name: 'bad', args: '{}', result: power },
    ]),
    { continuityContextUnavailable: 'history contains non-text dialogue' },
  );
});

test('the complete serialized limit is exact and oversized history is not truncated', t => {
  const emptySize = JSON.stringify([{ role: 'user', content: '' }]).length;
  const result = makeHostedContinuityOptions([
    { role: 'user', content: 'x'.repeat(256 * 1024 - emptySize) },
  ]);
  if (!('continuityContext' in result))
    throw Error('Expected complete context');
  t.is(result.continuityContext?.length, 256 * 1024);
  t.deepEqual(
    makeHostedContinuityOptions([
      { role: 'user', content: 'x'.repeat(256 * 1024 - emptySize + 1) },
    ]),
    { continuityContextUnavailable: 'history exceeds replay limit' },
  );
  t.deepEqual(
    makeHostedContinuityOptions([{ role: 'system', content: 'invented role' }]),
    { continuityContextUnavailable: 'history contains an unsupported role' },
  );
});
