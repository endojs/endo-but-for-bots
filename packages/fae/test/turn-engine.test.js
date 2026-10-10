// @ts-check
import '@endo/init';

import test from 'ava';

import { runAgenticTurn } from '../src/turn-engine.js';

test('turn engine commits every complete tool step before the final answer', async t => {
  const trace = [];
  const messages = [
    harden({ id: 'assistant-1', calls: harden(['call-1']) }),
    harden({ id: 'assistant-2', calls: harden([]) }),
  ];
  const outcome = await runAgenticTurn({
    leafId: 'root',
    maxRounds: 3,
    getTools: async round => {
      trace.push(`tools:${round}`);
      return harden({ round });
    },
    getContext: async leafId => {
      trace.push(`context:${leafId}`);
      return harden([leafId]);
    },
    invoke: async (context, tools, round) => {
      trace.push(`invoke:${context[0]}:${tools.round}:${round}`);
      return harden({ message: messages[round] });
    },
    getToolCalls: message => message.calls,
    runTools: async (calls, tools, round) => {
      trace.push(`run:${calls.join(',')}:${tools.round}:${round}`);
      return harden(['result-1']);
    },
    commitStep: async (leafId, message, results) => {
      trace.push(`step:${leafId}:${message.id}:${results.join(',')}`);
      return 'step-1';
    },
    commitFinal: async (leafId, message) => {
      trace.push(`final:${leafId}:${message.id}`);
      return 'final-1';
    },
  });

  t.deepEqual(trace, [
    'tools:0',
    'context:root',
    'invoke:root:0:0',
    'run:call-1:0:0',
    'step:root:assistant-1:result-1',
    'tools:1',
    'context:step-1',
    'invoke:step-1:1:1',
    'final:step-1:assistant-2',
  ]);
  t.deepEqual(outcome, {
    answered: true,
    exhausted: false,
    leafId: 'final-1',
    message: messages[1],
  });
});

test('turn engine reports empty and exhausted outcomes without a false final', async t => {
  let finalCommits = 0;
  const common = {
    leafId: 'root',
    getTools: async () => harden({}),
    getContext: async () => harden([]),
    getToolCalls: message => message.calls,
    runTools: async () => harden([]),
    commitStep: async () => 'next',
    commitFinal: async () => {
      finalCommits += 1;
      return 'final';
    },
  };

  const empty = await runAgenticTurn({
    ...common,
    maxRounds: 1,
    invoke: async () => harden({}),
  });
  t.deepEqual(empty, {
    answered: false,
    exhausted: false,
    leafId: 'root',
  });

  const exhausted = await runAgenticTurn({
    ...common,
    maxRounds: 2,
    invoke: async () => harden({ message: harden({ calls: ['call'] }) }),
  });
  t.deepEqual(exhausted, {
    answered: false,
    exhausted: true,
    leafId: 'next',
  });
  t.is(finalCommits, 0);
});

test('turn engine rejects an invalid round bound', async t => {
  await t.throwsAsync(
    () =>
      runAgenticTurn({
        leafId: 'root',
        maxRounds: 0,
        getTools: async () => undefined,
        getContext: async () => [],
        invoke: async () => ({}),
        getToolCalls: () => [],
        runTools: async () => [],
        commitStep: async () => 'step',
        commitFinal: async () => 'final',
      }),
    { message: /maxRounds must be a positive integer/ },
  );
});
