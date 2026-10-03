// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/pass-style';
import fc from 'fast-check';

import { makeDaemonEvaluate } from '../src/code-mode/daemon.js';
import { makeEvaluateTool } from '../src/code-mode/evaluate-tool.js';

test('makeDaemonEvaluate forwards source and lexical names to a powers host', async t => {
  /** @type {unknown[]} */
  const calls = [];
  const powers = Far('Powers', {
    evaluate: async (...args) => {
      calls.push(args);
      return 'done';
    },
  });

  const evaluate = makeDaemonEvaluate(powers);
  const result = await evaluate({
    source: 'await E(git).status()',
    resultName: ['results', 'status'],
    globals: [
      { name: 'workspace', petName: ['repo', 'workspace'] },
      { name: 'git', petName: ['repo', 'git'] },
    ],
  });

  t.is(result, 'done');
  t.deepEqual(calls, [
    [
      undefined,
      'await E(git).status()',
      ['workspace', 'git'],
      [
        ['repo', 'workspace'],
        ['repo', 'git'],
      ],
      ['results', 'status'],
    ],
  ]);
});

test('makeDaemonEvaluate passes a string name as one segment, never split', async t => {
  /** @type {unknown[]} */
  const calls = [];
  const powers = Far('Powers', {
    evaluate: async (...args) => {
      calls.push(args);
      return 'done';
    },
  });

  const evaluate = makeDaemonEvaluate(powers);
  await evaluate({
    source: '1',
    resultName: 'results/one',
    globals: [{ name: 'counter' }, { name: 'repo', petName: 'a/b' }],
  });
  await evaluate({ source: '2', resultName: 'one', globals: [] });
  await evaluate({ source: '3', globals: [] });

  t.deepEqual(calls, [
    [
      undefined,
      '1',
      ['counter', 'repo'],
      [['counter'], ['a/b']],
      ['results/one'],
    ],
    [undefined, '2', [], [], ['one']],
    [undefined, '3', [], [], undefined],
  ]);
});

test('makeDaemonEvaluate hardens the paths it passes to the daemon', async t => {
  /** @type {unknown[][]} */
  const calls = [];
  const powers = Far('Powers', {
    evaluate: async (...args) => {
      calls.push(args);
      return 'done';
    },
  });
  await makeDaemonEvaluate(powers)({
    source: '1',
    resultName: 'one',
    globals: [{ name: 'counter' }],
  });
  const [[, , codeNames, petNamePaths, resultNamePath]] = calls;
  t.true(Object.isFrozen(codeNames));
  t.true(Object.isFrozen(petNamePaths));
  t.true(Object.isFrozen(resultNamePath));
});

// No string, however delimiter-like, may be split into a path.
const anyStringArb = fc.string({ unit: 'binary', maxLength: 64 });

const makeRecordingEvaluate = () => {
  /** @type {unknown[][]} */
  const calls = [];
  const powers = Far('Powers', {
    evaluate: async (...args) => {
      calls.push(args);
      return 'done';
    },
  });
  return { calls, evaluate: makeDaemonEvaluate(powers) };
};

test('makeDaemonEvaluate wraps any string name as one segment, never split', async t => {
  await fc.assert(
    fc.asyncProperty(
      anyStringArb,
      anyStringArb,
      anyStringArb,
      async (resultName, globalName, globalPetName) => {
        const { calls, evaluate } = makeRecordingEvaluate();
        await evaluate({
          source: 'x',
          resultName,
          globals: [
            { name: globalName },
            { name: 'other', petName: globalPetName },
          ],
        });
        t.deepEqual(calls, [
          [
            undefined,
            'x',
            [globalName, 'other'],
            [[globalName], [globalPetName]],
            [resultName],
          ],
        ]);
      },
    ),
  );
});

test('makeDaemonEvaluate forwards any array name unchanged', async t => {
  const pathArb = fc.array(anyStringArb, { minLength: 1, maxLength: 6 });
  await fc.assert(
    fc.asyncProperty(pathArb, pathArb, async (resultName, petName) => {
      const { calls, evaluate } = makeRecordingEvaluate();
      await evaluate({
        source: 'x',
        resultName,
        globals: [{ name: 'g', petName }],
      });
      t.deepEqual(calls, [[undefined, 'x', ['g'], [petName], resultName]]);
    }),
  );
});

test('makeDaemonEvaluate always advertises resultName through the tool schema', t => {
  const powers = Far('Powers', {
    evaluate: async () => 'done',
  });
  const evaluate = makeDaemonEvaluate(powers);
  const tool = makeEvaluateTool(evaluate, []);
  const properties = /** @type {{ properties: Record<string, unknown> }} */ (
    tool.parameters
  ).properties;

  t.true(Object.hasOwn(properties, 'resultName'));
});
