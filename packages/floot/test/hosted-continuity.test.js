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

test('a long history is carried, not refused for being long', t => {
  // There is no length ceiling. The one that used to be here refused a
  // conversation for being long, which is the opposite of what continuity is
  // for, and the number was this stack's own rather than one any model or
  // protocol imposes.
  const emptySize = JSON.stringify([{ role: 'user', content: '' }]).length;
  for (const size of [256 * 1024 - emptySize, 256 * 1024, 4 * 1024 * 1024]) {
    const result = makeHostedContinuityOptions([
      { role: 'user', content: 'x'.repeat(size) },
    ]);
    if (!('continuityContext' in result))
      throw Error(`Expected complete context at ${size}`);
    t.is(result.continuityContext?.length, size + emptySize);
  }
  // What remains refused is what the dialogue *is*, never how much there is.
  t.deepEqual(
    makeHostedContinuityOptions([{ role: 'system', content: 'invented role' }]),
    { continuityContextUnavailable: 'history contains an unsupported role' },
  );
  t.deepEqual(makeHostedContinuityOptions([{ role: 'user', content: 42 }]), {
    continuityContextUnavailable: 'history contains non-text dialogue',
  });
});
