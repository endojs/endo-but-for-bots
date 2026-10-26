// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import {
  makeDismissTool,
  makeExecTool,
  makeListMessagesTool,
} from '../src/tool-makers.js';

for (const make of [makeExecTool, makeListMessagesTool, makeDismissTool]) {
  test(`${make.name} exposes lifecycle guidance in discovery and help`, t => {
    const tool = make({});
    for (const text of [tool.schema().function.description, tool.help()]) {
      t.regex(text, /dismissed resolves only after removal/);
      t.regex(text, /settled resolves after resolve\/reject/);
      t.regex(text, /Do not blindly await every field/);
      t.regex(text, /Floot automatically replies and dismisses/);
      t.regex(text, /Early dismissal breaks reply/);
    }
  });
}

test('exec can inspect mailbox data without awaiting lifecycle promises', async t => {
  t.timeout(5000);
  const dismissed = makePromiseKit();
  const settled = makePromiseKit();
  t.teardown(() => {
    dismissed.resolve();
    settled.resolve();
  });
  const powers = Far('Mailbox', {
    listMessages: () =>
      harden([
        {
          number: 0n,
          type: 'request',
          description: 'Research Android',
          done: true,
          dismissed: dismissed.promise,
          settled: settled.promise,
        },
      ]),
  });
  const tool = makeExecTool(powers);
  const result = await tool.execute({
    code: 'return (await E(powers).listMessages()).map(({type, description, done}) => ({type, description, done}));',
  });
  t.deepEqual(JSON.parse(result), [
    { type: 'request', description: 'Research Android', done: true },
  ]);
});
