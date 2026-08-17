// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { makeCompartmentEvaluate } from '../src/code-mode/compartment.js';
import { makeEvaluateTool } from '../src/code-mode/evaluate-tool.js';
import { toPiAgentTool } from '../src/adapters/pi.js';

test('evaluate omits resultName without a store and does not throw', async t => {
  const evaluate = makeCompartmentEvaluate({ endowments: { answer: 41 } });
  const tool = makeEvaluateTool(evaluate, []);
  const properties = /** @type {{ properties: Record<string, unknown> }} */ (
    tool.parameters
  ).properties;

  t.deepEqual(Object.keys(properties), ['source']);
  t.is(await tool.invoke({ source: 'answer + 1' }), 42);
});

test('evaluate stores and retrieves a completion through an in-memory map', async t => {
  const values = new Map();
  const storeValue = async (valueOrPromise, nameOrPath) => {
    values.set(
      Array.isArray(nameOrPath) ? nameOrPath.join('/') : nameOrPath,
      await valueOrPromise,
    );
  };
  const evaluate = makeCompartmentEvaluate({
    endowments: { answer: 41 },
    storeValue,
  });
  const tool = makeEvaluateTool(evaluate, [], storeValue);
  const properties = /** @type {{ properties: Record<string, unknown> }} */ (
    tool.parameters
  ).properties;

  t.true(Object.hasOwn(properties, 'resultName'));
  t.is(
    await tool.invoke({ source: 'answer + 1', resultName: ['answers', 'one'] }),
    42,
  );
  t.is(values.get('answers/one'), 42);
});

test('outer evaluate completion carries policy while internal values stay exact', async t => {
  const values = new Map();
  const storeValue = async (valueOrPromise, name) => {
    values.set(name, await valueOrPromise);
  };
  const evaluate = makeCompartmentEvaluate({
    endowments: { answer: 41 },
    storeValue,
  });
  const tool = makeEvaluateTool(evaluate, [], storeValue, {
    resultPolicy: { maxBytes: 64 },
  });
  const raw = /** @type {{ answer: number, text: string }} */ (await tool.invoke({
    source: "({ answer: answer + 1, text: 'x'.repeat(200) })",
    resultName: 'answer',
  }));
  t.is(raw.answer, 42);
  t.is(raw.text.length, 200);
  t.deepEqual(values.get('answer'), raw);

  const rendered = await toPiAgentTool(tool).execute('evaluate-1', {
    source: "({ answer: answer + 1, text: 'x'.repeat(200) })",
    resultName: 'answer',
  });
  const renderedText = /** @type {{ text: string }} */ (rendered.content[0]);
  t.true(renderedText.text.includes('[truncated'));
  t.deepEqual(rendered.details, raw);
});

test('evaluate rejects a hidden resultName argument without store authority', async t => {
  const evaluate = makeCompartmentEvaluate({ endowments: {} });
  const tool = makeEvaluateTool(evaluate, []);

  await t.throwsAsync(
    () => tool.invoke({ source: '1', resultName: 'answer' }),
    { message: /without storeValue/ },
  );
});
