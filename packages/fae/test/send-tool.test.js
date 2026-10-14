// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import { makeSendTool, assertToolArguments } from '../src/tool-makers.js';

test('send addresses a nested subagent and attaches a nested capability', async t => {
  const calls = [];
  const tool = makeSendTool(
    Far('Powers', {
      send: (...args) => {
        calls.push(args);
      },
    }),
  );
  const args = {
    recipient: ['subagents', 'helper'],
    strings: ['Read this: ', ''],
    edgeNames: ['source'],
    petNames: [['project', 'readonly']],
  };
  assertToolArguments(tool.schema(), args);
  await tool.execute(args);
  t.deepEqual(calls, [
    [
      ['subagents', 'helper'],
      ['Read this: ', ''],
      ['source'],
      [['project', 'readonly']],
    ],
  ]);
  await tool.execute({ recipient: '@host', strings: ['done'] });
  t.deepEqual(calls[1], ['@host', ['done'], [], []]);
});
